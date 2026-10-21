'use strict';
// Temporary, narrowly scoped setup handler. Removed after the four authorized accounts are verified.
// Only the digest is in source; the one-time capability and passwords never enter the repository.
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,jsonBody,rows,insert,patchRows,supabase,send}=require('../../panel-server');
const CAPABILITY_HASH='f070bca70b7afa6b212fe207ef3386e67a23cc1649681edc35580475ffff1c2f';
const DEADLINE=1792618920511;
module.exports=async(req,res)=>{
  const token=String(req.headers?.authorization||'').replace(/^Bearer /,'');
  const hash=crypto.createHash('sha256').update(token).digest();
  if(req.method!=='POST'||SERVER_ENVIRONMENT!=='production'||Date.now()>DEADLINE||!crypto.timingSafeEqual(hash,Buffer.from(CAPABILITY_HASH,'hex')))return send(res,404,{error:'NOT_FOUND'});
  const config=configuration();if(!config)return send(res,503,{error:'NOT_CONFIGURED'});
  const ctx={config,environment:'production'};
  let step='validate';
  try{
    const configured=await rows(ctx,'panel_users',{select:'username',environment:'eq.production',username:'in.(leonardo,renan,tiago,alex)'});
    if(new Set(configured.map(user=>user.username)).size===4)return send(res,409,{error:'SETUP_COMPLETED'});
    const body=await jsonBody(req,4096),password=typeof body.password==='string'?body.password:'';
    if(password.length<8||password.length>256)return send(res,400,{error:'PASSWORD_INVALID'});
    const result=[];
    for(const [username,name] of [['leonardo','Leonardo'],['renan','Renan'],['tiago','Tiago'],['alex','Alex']]){
      step=username;
      const email=username==='leonardo'?'leonardoliveiracosta@gmail.com':username+'@login.mycarscout.net';
      const [panel]=await rows(ctx,'panel_users',{select:'id,auth_user_id,role',environment:'eq.production',email:'eq.'+email,limit:'1'});
      if(username==='leonardo'&&(!panel||panel.role!=='admin'))return send(res,409,{error:'OWNER_NOT_FOUND'});
      let authId=panel?.auth_user_id;
      if(authId){
        await supabase(config.url,config.secretKey,'/auth/v1/admin/users/'+authId,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({password})});
        await patchRows(ctx,'panel_users',{environment:'eq.production',id:'eq.'+panel.id},{username,display_name:name,active:true,must_change_password:false,updated_at:new Date().toISOString()});
      }else{
        const created=await supabase(config.url,config.secretKey,'/auth/v1/admin/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,email_confirm:true})});
        authId=created?.id||created?.user?.id;
        if(!authId)throw Error('AUTH_CREATE_FAILED');
        try{await insert(ctx,'panel_users',{environment:'production',auth_user_id:authId,email,username,display_name:name,role:'operator',active:true,must_change_password:false});}
        catch(error){await supabase(config.url,config.secretKey,'/auth/v1/admin/users/'+authId,{method:'DELETE'}).catch(()=>{});throw error;}
      }
      result.push({username,name,authId,role:username==='leonardo'?'admin':'operator'});
    }
    return send(res,200,{ok:true,accounts:result});
  }catch(error){return send(res,500,{error:'ACCOUNT_SETUP_FAILED',step,status:error?.status||null});}
};
