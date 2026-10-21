'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'publica-simulada',SUPABASE_SECRET_KEY:'secreta-simulada'});
const {BASE,createBackend}=require('./fixtures/banco-simulado');
const id=n=>`6a240000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const people=['leonardo','renan','tiago','alex'];
const seed=people.map((username,i)=>`insert into public.panel_users(id,environment,auth_user_id,email,username,display_name,role) values('${id(i+1)}','preview','${id(i+101)}','${username}@example.test','${username}','${username[0].toUpperCase()+username.slice(1)}','${i?'operator':'admin'}');`).join('\n')+
`insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(20)}','preview','Cliente','WHATSAPP_DIRECT',now(),now());
insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(21)}','preview','${id(20)}','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());`;
const password='senha-ficticia-123';
const token=(index,iat=Math.floor(Date.now()/1000))=>'test.'+Buffer.from(JSON.stringify({sub:id(index+101),iat})).toString('base64url')+'.test';
let backend,providerCalls=0,down=false;
test.before(async()=>{
  backend=await createBackend({seed});
  globalThis.fetch=async(url,options={})=>{
    if(String(url).startsWith(BASE+'/auth/v1/token')){
      providerCalls++;if(down)throw Error('OFFLINE');
      const body=JSON.parse(options.body),i=people.findIndex(name=>body.email===name+'@example.test');
      const ok=i>=0&&body.password===password;
      return {ok,status:ok?200:400,json:async()=>ok?{access_token:token(i),refresh_token:'test-refresh-'+i,expires_in:3600,user:{id:id(i+101)}}:{error:'invalid_credentials'}};
    }
    if(String(url)===BASE+'/auth/v1/user'){
      const payload=JSON.parse(Buffer.from(String(options.headers.authorization).split('.')[1],'base64url').toString());
      return {ok:true,status:200,json:async()=>({id:payload.sub})};
    }
    return backend.fetch(url,options);
  };
});
test.after(async()=>{await backend.db.close();assert.deepEqual(backend.refused,[]);});
async function api(name,{body=null,bearer=null,query={},ip='127.0.0.1'}={}){
  const res={setHeader(){},status(n){this.code=n;return this;},json(data){this.data=data;return data;}};
  await require('../api/panel/'+name)({method:body?'POST':'GET',headers:{'x-forwarded-for':ip,...(bearer?{authorization:'Bearer '+bearer}:{})},query,body},res);return res;
}
test('os quatro nomes entram sem e-mail e recebem a identidade e o papel corretos',async()=>{
  for(const [i,username]of people.entries()){
    const logged=await api('login',{body:{username:' '+username.toUpperCase()+' ',password,role:'admin'}});
    assert.equal(logged.code,200);assert.ok(logged.data.access_token);assert.equal(logged.data.user,undefined);assert.equal(logged.data.email,undefined);
    const session=await api('session',{bearer:logged.data.access_token});
    assert.equal(session.code,200);assert.equal(session.data.username,username);assert.equal(session.data.role,i?'operator':'admin');
  }
});
test('nome desconhecido, e-mail e senha errada têm a mesma resposta; conta inativa não entra',async()=>{
  const expected={error:'INVALID_CREDENTIALS'};
  for(const body of [{username:'ninguem',password},{username:'leonardo@example.test',password},{username:'alex',password:'senha-errada'}]){
    const reply=await api('login',{body});assert.equal(reply.code,401);assert.deepEqual(reply.data,expected);
  }
  await backend.db.query('update public.panel_users set active=false where username=$1',['alex']);
  const before=providerCalls;assert.equal((await api('login',{body:{username:'alex',password}})).code,401);assert.equal(providerCalls,before);
  await backend.db.query('update public.panel_users set active=true where username=$1',['alex']);
});
test('a identificação automática na ficha registra o nome de login autenticado',async()=>{
  const saved=await api('lead-access',{bearer:token(1),body:{journeyId:id(21),openingId:id(500),login_username:'leonardo'}});
  assert.equal(saved.code,200);
  const history=await api('lead-access',{bearer:token(0),query:{journeyId:id(21)}});
  assert.equal(history.data.items[0].login_username,'renan');assert.equal(history.data.items[0].display_name,'Renan');
});
test('encerrar as sessões rejeita um JWT antigo ainda não expirado e aceita o novo login',async()=>{
  const cutoff=Math.floor(Date.now()/1000);
  const old=token(0,cutoff-120),fresh=token(0,cutoff+1);
  assert.equal((await api('session',{bearer:old})).code,200);
  await backend.db.query('update public.panel_users set sessions_valid_after=$1 where username=$2',[new Date(cutoff*1000).toISOString(),'leonardo']);
  assert.equal((await api('session',{bearer:old})).code,401);
  assert.equal((await api('session',{bearer:fresh})).code,200);
});
test('tentativas são limitadas no servidor e indisponibilidade não é mostrada como senha errada',async()=>{
  for(let i=0;i<30;i++)assert.equal((await api('login',{ip:'192.0.2.99',body:{username:'ninguem',password}})).code,401);
  assert.equal((await api('login',{ip:'192.0.2.99',body:{username:'ninguem',password}})).code,429);
  down=true;const failed=await api('login',{ip:'192.0.2.100',body:{username:'renan',password}});down=false;
  assert.equal(failed.code,503);assert.deepEqual(failed.data,{error:'LOGIN_UNAVAILABLE'});
});
