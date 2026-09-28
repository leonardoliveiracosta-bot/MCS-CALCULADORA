'use strict';
const {allRows,patchRows,rows,supabase}=require('./panel-server');
const {normalizeParsed}=require('./whatsapp-receiver');
const BUCKET='whatsapp-media',LIMIT=25*1024*1024;
const safe=(value)=>String(value||'').replace(/[^A-Za-z0-9._-]/g,'_').slice(0,120);
const encodePath=(value)=>String(value).split('/').map(encodeURIComponent).join('/');

async function enqueueMediaJob(ctx,item,messageId){
  if(!item?.media||(!item.media.id&&!item.media.url)||!messageId)return {queued:false};
  const payload={environment:ctx.environment,message_id:messageId,wa_message_id:item.messageId,media_id:item.media.id||null,source_url:item.media.url||null,media_kind:item.media.kind,mime_type:item.media.mimeType||null,original_filename:item.media.filename||null};
  const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/whatsapp_media_jobs?on_conflict=environment,message_id',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(payload)});
  return {queued:Boolean(result?.length)};
}
async function enqueueRecentMedia(ctx,options={}){
  const cutoff=new Date(Date.now()-30*86400000).toISOString();
  const events=await rows(ctx,'whatsapp_raw_events',{select:'id,event_type,payload_json',environment:'eq.'+ctx.environment,received_at:'gte.'+cutoff,order:'received_at.desc',limit:String(options.maxEvents||1000)});
  let queued=0,found=0,items=[];
  for(const event of events){
    const parsed=normalizeParsed(event.payload_json,{sourceKind:event.event_type==='history'?'WHATSAPP_HISTORY':'WHATSAPP_WEBHOOK'}),media=parsed.items.filter((item)=>item.media&&(item.media.id||item.media.url));found+=media.length;items.push(...media);
  }
  for(let index=0;index<items.length;index+=50){
    if(options.deadlineAt&&Date.now()>=options.deadlineAt)break;
    const chunk=items.slice(index,index+50),filter='in.('+chunk.map((item)=>'"'+item.messageId.replaceAll('"','')+'"').join(',')+')';
    const ids=await rows(ctx,'whatsapp_message_ids',{select:'wa_message_id,message_id',environment:'eq.'+ctx.environment,wa_message_id:filter}),messageByWamid=new Map(ids.map((item)=>[item.wa_message_id,item.message_id]));
    const jobs=chunk.flatMap((item)=>{const messageId=messageByWamid.get(item.messageId);return messageId?[{environment:ctx.environment,message_id:messageId,wa_message_id:item.messageId,media_id:item.media.id||null,source_url:item.media.url||null,media_kind:item.media.kind,mime_type:item.media.mimeType||null,original_filename:item.media.filename||null}]:[];});
    if(jobs.length){const inserted=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/whatsapp_media_jobs?on_conflict=environment,message_id',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(jobs)});queued+=inserted?.length||0;}
  }
  return {found,queued};
}
function mediaUrl(url){const parsed=new URL(url);return 'https://waba-v2.360dialog.io'+parsed.pathname+parsed.search;}
async function fetchMedia(job,key){
  let source=job.source_url,mime=job.mime_type,size=null;
  if(job.media_id){
    const metadata=await fetch('https://waba-v2.360dialog.io/'+encodeURIComponent(job.media_id),{headers:{'D360-API-KEY':key},signal:AbortSignal.timeout(8000)});
    if(!metadata.ok)throw Error('MEDIA_METADATA_'+metadata.status);
    const value=await metadata.json();source=value.url;mime=value.mime_type||mime;size=Number(value.file_size)||null;
  }
  if(!source)throw Error('MEDIA_URL_MISSING');if(size&&size>LIMIT)throw Error('MEDIA_TOO_LARGE');
  const response=await fetch(mediaUrl(source),{headers:{'D360-API-KEY':key},redirect:'follow',signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('MEDIA_DOWNLOAD_'+response.status);
  const length=Number(response.headers.get('content-length'))||size||0;if(length>LIMIT)throw Error('MEDIA_TOO_LARGE');
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>LIMIT)throw Error('MEDIA_TOO_LARGE');
  return {bytes,mime:response.headers.get('content-type')||mime||'application/octet-stream'};
}
async function storeMedia(ctx,job,key){
  const file=await fetchMedia(job,key),extension=(job.original_filename||'').split('.').pop(),name=job.original_filename?safe(job.original_filename):`${job.media_kind}${extension&&extension!==job.original_filename?'.'+safe(extension):''}`;
  const path=`${ctx.environment}/${job.message_id}/${name||job.media_kind}`;
  const uploaded=await fetch(`${ctx.config.url}/storage/v1/object/${BUCKET}/${encodePath(path)}`,{method:'POST',headers:{apikey:ctx.config.secretKey,authorization:'Bearer '+ctx.config.secretKey,'content-type':file.mime,'x-upsert':'false'},body:file.bytes,signal:AbortSignal.timeout(15000)});
  if(!uploaded.ok&&uploaded.status!==409)throw Error('MEDIA_STORAGE_'+uploaded.status);
  await patchRows(ctx,'messages',{id:'eq.'+job.message_id,environment:'eq.'+ctx.environment},{media_storage_path:path,media_kind:job.media_kind,media_mime_type:file.mime,media_byte_size:file.bytes.length,media_status:'STORED'});
  await patchRows(ctx,'whatsapp_media_jobs',{id:'eq.'+job.id,environment:'eq.'+ctx.environment},{status:'STORED',error_code:null,updated_at:new Date().toISOString()});
  return {stored:true};
}
async function processMediaJobs(ctx,options={}){
  const key=process.env.D360_API_KEY;if(!key)return {stored:0,failed:0,skipped:'D360_API_KEY_MISSING'};
  const jobs=await rows(ctx,'whatsapp_media_jobs',{select:'*',environment:'eq.'+ctx.environment,status:'in.(PENDING,FAILED)',attempts:'lt.3',next_attempt_at:'lte.'+new Date().toISOString(),order:'created_at.asc',limit:String(options.maxJobs||8)});
  const result={stored:0,failed:0};
  for(const job of jobs){
    if(options.deadlineAt&&Date.now()>=options.deadlineAt)break;
    const attempt=Number(job.attempts||0)+1,claimed=await patchRows(ctx,'whatsapp_media_jobs',{id:'eq.'+job.id,environment:'eq.'+ctx.environment,status:'eq.'+job.status,attempts:'eq.'+job.attempts},{status:'PROCESSING',attempts:attempt,updated_at:new Date().toISOString()},true);if(!claimed.length)continue;
    try{await storeMedia(ctx,{...job,attempts:attempt},key);result.stored++;}
    catch(error){const final=attempt>=3,code=String(error?.message||'MEDIA_FAILED').slice(0,120);await patchRows(ctx,'whatsapp_media_jobs',{id:'eq.'+job.id,environment:'eq.'+ctx.environment},{status:final?'FAILED':'PENDING',error_code:code,next_attempt_at:new Date(Date.now()+attempt*5*60000).toISOString(),updated_at:new Date().toISOString()});await patchRows(ctx,'messages',{id:'eq.'+job.message_id,environment:'eq.'+ctx.environment},{media_kind:job.media_kind,media_mime_type:job.mime_type||null,media_status:final?'FAILED':'PENDING'});result.failed++;if(/_(401|403|429)$/.test(code))break;}
    if(options.deadlineAt&&Date.now()>=options.deadlineAt)break;
  }
  return result;
}
async function recoverMediaJobs(ctx){const stale=new Date(Date.now()-120000).toISOString();await patchRows(ctx,'whatsapp_media_jobs',{environment:'eq.'+ctx.environment,status:'eq.PROCESSING',updated_at:'lt.'+stale,attempts:'lt.3'},{status:'PENDING',error_code:'WORKER_INTERRUPTED',next_attempt_at:new Date().toISOString(),updated_at:new Date().toISOString()});await patchRows(ctx,'whatsapp_media_jobs',{environment:'eq.'+ctx.environment,status:'eq.PROCESSING',updated_at:'lt.'+stale,attempts:'gte.3'},{status:'FAILED',error_code:'WORKER_INTERRUPTED',updated_at:new Date().toISOString()});}
async function mediaStats(ctx){const jobs=await allRows(ctx,'whatsapp_media_jobs',{select:'status,error_code',environment:'eq.'+ctx.environment});return {total:jobs.length,stored:jobs.filter((x)=>x.status==='STORED').length,failed:jobs.filter((x)=>x.status==='FAILED').length,pending:jobs.filter((x)=>!['STORED','FAILED'].includes(x.status)).length,reasons:Object.entries(jobs.filter((x)=>x.status==='FAILED').reduce((all,x)=>{const key=x.error_code||'MEDIA_FAILED';all[key]=(all[key]||0)+1;return all;},{})).map(([reason,count])=>({reason,count}))};}
module.exports={BUCKET,LIMIT,enqueueMediaJob,enqueueRecentMedia,fetchMedia,mediaStats,processMediaJobs,recoverMediaJobs,storeMedia};
