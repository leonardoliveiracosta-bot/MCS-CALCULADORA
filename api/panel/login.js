'use strict';
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,jsonBody,rows,send,supabase}=require('../../panel-server');

module.exports=async(req,res)=>{
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const config=configuration();
  if(!config||!SERVER_ENVIRONMENT)return send(res,503,{error:'PANEL_NOT_CONFIGURED'});
  try{
    const input=await jsonBody(req,4096);
    const username=typeof input.username==='string'?input.username.trim().toLowerCase():'';
    const password=typeof input.password==='string'?input.password:'';
    const ip=String(req.headers?.['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim();
    const key=crypto.createHash('sha256').update(SERVER_ENVIRONMENT+':'+ip).digest('hex');
    const allowed=await supabase(config.url,config.secretKey,'/rest/v1/rpc/panel_login_allow',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:SERVER_ENVIRONMENT,p_key:key})});
    if(!allowed)return send(res,429,{error:'LOGIN_RATE_LIMITED'});
    if(!/^[a-z][a-z0-9_]{2,31}$/.test(username)||password.length<8||password.length>256)return send(res,401,{error:'INVALID_CREDENTIALS'});
    const [panel]=await rows({config,environment:SERVER_ENVIRONMENT},'panel_users',{select:'auth_user_id,email',environment:'eq.'+SERVER_ENVIRONMENT,username:'eq.'+username,active:'is.true',limit:'1'});
    if(!panel)return send(res,401,{error:'INVALID_CREDENTIALS'});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    let auth,data;
    try{
      auth=await fetch(config.url+'/auth/v1/token?grant_type=password',{method:'POST',signal:controller.signal,
        headers:{apikey:config.publishableKey,'content-type':'application/json'},body:JSON.stringify({email:panel.email,password})});
      data=await auth.json().catch(()=>null);
    }finally{clearTimeout(timer);}
    if(!auth.ok||!data?.access_token||data.user?.id!==panel.auth_user_id){
      if(auth.status===429)return send(res,429,{error:'LOGIN_RATE_LIMITED'});
      return send(res,auth.status>=500?503:401,{error:auth.status>=500?'LOGIN_UNAVAILABLE':'INVALID_CREDENTIALS'});
    }
    return send(res,200,{access_token:data.access_token,refresh_token:data.refresh_token,expires_in:data.expires_in,token_type:data.token_type||'bearer'});
  }catch(error){return send(res,error?.message==='PAYLOAD_TOO_LARGE'?413:503,{error:'LOGIN_UNAVAILABLE'});}
};
