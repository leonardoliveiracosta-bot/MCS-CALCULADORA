'use strict';
const {configuration,insert,rows,supabase}=require('../panel-server');
const {isExpired,publicResponse}=require('../vitrine-domain');
const WHATSAPP_NUMBER='13055400742';
const EVENT_DEDUPE_MS=10*60*1000;
function noStore(res,status,payload){res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Content-Type','application/json; charset=utf-8');return res.status(status).json(payload);}
const pathForApi=(value)=>String(value).split('/').map(encodeURIComponent).join('/');
// Storage answers {signedURL:"/object/sign/..."} relative to /storage/v1: the page needs an absolute URL.
async function signed(config,paths){
  const urls=await Promise.all((Array.isArray(paths)?paths:[]).slice(0,12).map(async(path)=>{
    if(typeof path!=='string'||!path)return null;
    try{
      const result=await supabase(config.url,config.secretKey,'/storage/v1/object/sign/vitrine-photos/'+pathForApi(path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expiresIn:900})});
      const relative=String(result?.signedURL||result?.signedUrl||'');
      if(!relative)return null;
      return /^https:\/\//i.test(relative)?relative:config.url+'/storage/v1'+(relative.startsWith('/')?'':'/')+relative;
    }catch(_){return null;}
  }));
  return urls.filter(Boolean);
}
// The vitrine follows its journey: ENCERRADO or switched off means closed, like /t.
async function journeyClosed(ctx,vitrine){
  if(!vitrine.journey_id)return false;
  const [journey]=await rows(ctx,'journeys',{select:'id,status',environment:'eq.'+ctx.environment,id:'eq.'+vitrine.journey_id,limit:'1'});
  if(!journey)return false;
  if(journey.status==='ENCERRADO')return true;
  const [toggle]=await rows(ctx,'journey_toggle_states',{select:'enabled',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,limit:'1'});
  return Boolean(toggle&&toggle.enabled===false);
}
async function recordEvent(ctx,vitrine,car,event,now=Date.now()){
  const recent=await rows(ctx,'vitrine_events',{select:'id',environment:'eq.'+ctx.environment,vitrine_id:'eq.'+vitrine.id,event_type:'eq.'+event,
    vitrine_car_id:car?'eq.'+car.id:'is.null',created_at:'gte.'+new Date(now-EVENT_DEDUPE_MS).toISOString(),limit:'1'});
  if(recent[0])return {status:200,payload:{ok:true,duplicate:true}};
  await insert(ctx,'vitrine_events',{environment:ctx.environment,vitrine_id:vitrine.id,vitrine_car_id:car?.id||null,event_type:event},false);
  return {status:201,payload:{ok:true}};
}
module.exports=async(req,res)=>{
  const config=configuration();if(!config)return noStore(res,503,{error:'UNAVAILABLE'});
  const token=String(req.query?.token||'').trim();if(!/^[A-Za-z0-9_-]{32,80}$/.test(token))return noStore(res,404,{error:'NOT_FOUND'});
  if(!['GET','POST'].includes(req.method))return noStore(res,405,{error:'METHOD_NOT_ALLOWED'});
  const environment=process.env.VERCEL_ENV==='production'?'production':'preview';
  try{
    const vitrine=(await rows({config,environment},'vitrines',{select:'*',token:'eq.'+token,environment:'eq.'+environment,limit:'1'}))[0];
    if(!vitrine)return noStore(res,404,{error:'NOT_FOUND'});
    const ctx={config,environment:vitrine.environment};
    const closed=isExpired(vitrine)||await journeyClosed(ctx,vitrine);
    if(req.method==='POST'){
      const event=String(req.body?.event||'').toUpperCase();const code=String(req.body?.code||'').toUpperCase();
      if(!['OPEN','TAP'].includes(event))return noStore(res,400,{error:'EVENT_INVALID'});
      if(closed)return noStore(res,410,{error:'VITRINE_EXPIRED'});
      const cars=await rows(ctx,'vitrine_cars',{select:'id,short_code',environment:'eq.'+ctx.environment,vitrine_id:'eq.'+vitrine.id});
      const car=event==='TAP'?cars.find((item)=>item.short_code===code):null;
      if(event==='TAP'&&!car)return noStore(res,400,{error:'EVENT_INVALID'});
      const out=await recordEvent(ctx,vitrine,car,event);
      return noStore(res,out.status,out.payload);
    }
    if(closed)return noStore(res,200,{...publicResponse(vitrine,[],[],{closed:true}),whatsAppNumber:WHATSAPP_NUMBER});
    const cars=await rows(ctx,'vitrine_cars',{select:'id,short_code,vehicle_snapshot,customer_limit_cents,note_text,photo_paths',environment:'eq.'+ctx.environment,vitrine_id:'eq.'+vitrine.id,order:'created_at.asc'});
    const urls=await Promise.all(cars.map((car)=>signed(config,car.photo_paths)));
    return noStore(res,200,{...publicResponse(vitrine,cars,urls),whatsAppNumber:WHATSAPP_NUMBER});
  }catch(_){return noStore(res,500,{error:'UNAVAILABLE'});}
};
module.exports.WHATSAPP_NUMBER=WHATSAPP_NUMBER;
module.exports.signed=signed;
