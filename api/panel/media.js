'use strict';
const {requirePanel,rows,send}=require('../../panel-server');
const {BUCKET}=require('../../whatsapp-media');
const encodePath=(value)=>String(value).split('/').map(encodeURIComponent).join('/');
module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const ctx=await requirePanel(req,res);if(!ctx)return;
  const id=String(req.query?.messageId||'');if(!/^[0-9a-f-]{36}$/i.test(id))return send(res,400,{error:'MESSAGE_ID_INVALID'});
  try{
    const message=(await rows(ctx,'messages',{select:'media_storage_path,media_mime_type,media_byte_size',environment:'eq.'+ctx.environment,id:'eq.'+id,media_status:'eq.STORED',limit:'1'}))[0];
    if(!message?.media_storage_path)return send(res,404,{error:'MEDIA_NOT_AVAILABLE'});
    const response=await fetch(`${ctx.config.url}/storage/v1/object/authenticated/${BUCKET}/${encodePath(message.media_storage_path)}`,{headers:{apikey:ctx.config.secretKey,authorization:'Bearer '+ctx.config.secretKey}});
    if(!response.ok)return send(res,response.status===404?404:502,{error:'MEDIA_NOT_AVAILABLE'});
    const body=Buffer.from(await response.arrayBuffer());res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Content-Type',message.media_mime_type||response.headers.get('content-type')||'application/octet-stream');res.setHeader('Content-Length',String(body.length));return res.status(200).send(body);
  }catch(_){return send(res,500,{error:'MEDIA_DOWNLOAD_FAILED'});}
};
