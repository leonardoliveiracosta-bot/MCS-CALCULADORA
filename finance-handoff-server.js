'use strict';
const crypto=require('node:crypto');
const COOKIE='mcs_finance_handoff',TTL=30*60*1000;
const PARTNER_URL='https://www.mymetawholesalecars.com/apply-online/';
const validRef=value=>/^[A-HJ-NP-Z2-9]{5}$/.test(String(value||''));
function signature(req,secret,environment,ref,expires){
  return crypto.createHmac('sha256',secret).update(['mcs-finance-handoff-v1',environment,String(req.headers?.host||'').toLowerCase(),ref,expires].join('|')).digest('base64url');
}
function grantCookie(req,secret,environment,ref,now=Date.now()){
  if(!validRef(ref))throw Error('INVALID_FINANCE_REF');
  const expires=now+TTL,value=[ref,expires,signature(req,secret,environment,ref,expires)].join('.');
  return COOKIE+'='+value+'; Path=/api/finance-handoff; HttpOnly; Secure; SameSite=Lax; Max-Age='+TTL/1000;
}
function verifiedRef(req,secret,environment,now=Date.now()){
  const cookie=String(req.headers?.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='));
  if(!cookie)return null;
  const parts=cookie.slice(COOKIE.length+1).split('.');
  if(parts.length!==3||!validRef(parts[0])||!/^\d{13}$/.test(parts[1])||!Number.isSafeInteger(Number(parts[1]))||Number(parts[1])<=now||Number(parts[1])>now+TTL||!/^[A-Za-z0-9_-]{43}$/.test(parts[2]))return null;
  const expected=signature(req,secret,environment,parts[0],parts[1]);
  return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(parts[2]))?parts[0]:null;
}
module.exports={grantCookie,verifiedRef,PARTNER_URL,TTL};
