'use strict';

const crypto=require('node:crypto');
const {anthropicJson,reserveCall}=require('./panel-ai');
const {normalizePhone}=require('./panel-phone');
const {validateAttachment}=require('./api/panel/attachments');
const IMAGE_MIMES=new Set(['image/jpeg','image/png','image/webp']);
function detectedImage(name,mime,size,head){const detected=validateAttachment(name,mime,size,head);return IMAGE_MIMES.has(detected)?detected:null;}
function clean(value,max=25000){return String(value||'').normalize('NFC').trim().slice(0,max);}
function ref(value){const found=clean(value,20).toUpperCase().match(/\b[A-HJ-NP-Z2-9]{5}\b/);return found?found[0]:null;}
function name(value){const result=clean(value,160);return [...result.matchAll(/[\p{L}]/gu)].length>=2?result:'';}
function candidate(value){const source=value&&typeof value==='object'?value:{};return {phone:normalizePhone(source.phone)||'',name:name(source.name),ref:ref(source.ref)||'',message:clean(source.message||source.body,25000),translation:clean(source.translation,25000)};}
async function readPrint(ctx,bytes,mime,fetchImpl=fetch){
  if(!IMAGE_MIMES.has(mime)||!Buffer.isBuffer(bytes)||bytes.length>5*1024*1024)throw new Error('SMS_PRINT_INVALID_IMAGE');
  await reserveCall(ctx);
  try {
    const parsed=await anthropicJson(
      'Você lê UM print de SMS da My Car Scout. Responda SOMENTE JSON. Não invente nem complete dados que não estejam visíveis.',
      [{type:'image',source:{type:'base64',media_type:mime,data:bytes.toString('base64')}},{type:'text',text:'Extraia exatamente {phone,name,ref,message,translation}. phone em E.164 se estiver visível; name é o nome exibido; ref são 5 caracteres quando visível; message é a mensagem COMPLETA recebida do cliente, sem resumir. translation é a tradução integral em português apenas se a mensagem não estiver em português. Use string vazia no que não estiver visível.'}],
      fetchImpl
    );
    return candidate(parsed);
  } catch(error) { if(error.message==='SMS_PRINT_INVALID_IMAGE')throw error; throw new Error(error.message==='AI_DAILY_LIMIT'?'AI_DAILY_LIMIT':'AI_UNAVAILABLE'); }
}
function sha256(bytes){return crypto.createHash('sha256').update(bytes).digest('hex');}
module.exports={IMAGE_MIMES,detectedImage,candidate,readPrint,sha256};
