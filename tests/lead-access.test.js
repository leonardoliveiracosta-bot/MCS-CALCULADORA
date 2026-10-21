'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'publica-simulada',SUPABASE_SECRET_KEY:'secreta-simulada'});
const {BASE,createBackend}=require('./fixtures/banco-simulado');
const id=n=>`6a230000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const A=id(1),B=id(2),P=id(3),J=id(10),J2=id(11),JP=id(12),AUTH_A=id(101),AUTH_B=id(102);
const seed=`
insert into public.panel_users(id,environment,auth_user_id,email,display_name,role) values
('${A}','preview','${AUTH_A}','leo@example.test','Leo','admin'),
('${B}','preview','${AUTH_B}','junior@example.test','Junior','operator'),
('${P}','production','${id(103)}','production@example.test','Produção','admin');
insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values
('${id(20)}','preview','Cliente','WHATSAPP_DIRECT',now(),now()),('${id(21)}','production','Cliente produção','WHATSAPP_DIRECT',now(),now());
insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values
('${J}','preview','${id(20)}','ACSAA','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now()),
('${J2}','preview','${id(20)}','ACSAB','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now()),
('${JP}','production','${id(21)}','ACSAA','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());`;
let backend,failRead=false;
test.before(async()=>{
  backend=await createBackend({seed});
  globalThis.fetch=async(url,options={})=>{
    if(String(url)===BASE+'/auth/v1/user'){
      const token=String(options.headers?.authorization);
      const junior=token.includes('junior'),ok=!token.includes('invalid');
      return {ok,status:ok?200:401,json:async()=>({id:junior?AUTH_B:AUTH_A,email:junior?'junior@example.test':'leo@example.test'})};
    }
    if(failRead&&String(url).includes('/rest/v1/panel_lead_accesses')&&options.method!=='POST')throw Error('BANCO_INDISPONIVEL');
    return backend.fetch(url,options);
  };
});
test.after(async()=>{await backend.db.close();assert.deepEqual(backend.refused,[]);});
async function call({token='leo',body=null,query={},method}={}){
  const res={setHeader(){},status(n){this.code=n;return this;},json(data){this.data=data;return data;}};
  await require('../api/panel/lead-access')({method:method||(body?'POST':'GET'),headers:{authorization:'Bearer '+token},body,query:{journeyId:J,...query}},res);
  return res;
}
const count=async()=>Number((await backend.db.query('select count(*)::int n from public.panel_lead_accesses')).rows[0].n);
test('consultar histórico não cria acesso; sem sessão, ficha inexistente ou de outro ambiente não grava',async()=>{
  assert.deepEqual((await call()).data.items,[]);assert.equal(await count(),0);
  assert.equal((await call({token:'invalid',body:{journeyId:J,openingId:id(1000)}})).code,401);
  for(const journeyId of [id(999),JP,'invalido'])assert.equal((await call({body:{journeyId,openingId:id(1000)}})).code,404);
  assert.equal((await call({body:{journeyId:J}})).code,400);
  assert.equal(await count(),0);
});
test('abertura é automática, com identidade e horário do servidor; repetição do mesmo pedido não duplica',async()=>{
  const body={journeyId:J,openingId:id(1001),created_by:B,login_email:'forjado@example.test',display_name:'Junior',accessed_at:'2001-01-01T00:00:00Z'};
  assert.equal((await call({body})).code,200);
  await Promise.all([call({body}),call({body})]);assert.equal(await count(),1);
  const [row]=(await backend.db.query('select * from public.panel_lead_accesses')).rows;
  assert.equal(row.created_by,A);assert.equal(row.login_email,'leo@example.test');assert.equal(row.display_name,'Leo');
  assert.ok(Math.abs(Date.now()-Date.parse(row.accessed_at))<10000);
  assert.equal((await call({body:{...body,journeyId:J2}})).code,409);
  assert.equal(await count(),1);
});
test('nova abertura e outro login geram registros próprios, visíveis às duas contas do painel',async()=>{
  await call({body:{journeyId:J,openingId:id(1002)}});
  await call({token:'junior',body:{journeyId:J,openingId:id(1001)}});
  assert.equal(await count(),3);
  const leo=(await call()).data,junior=(await call({token:'junior'})).data;
  assert.deepEqual(leo.items,junior.items);assert.deepEqual(new Set(leo.items.map(x=>x.display_name)),new Set(['Leo','Junior']));
  const before=await backend.db.query('select stage,updated_at from public.journeys where id=$1',[J]);
  assert.equal(before.rows[0].stage,'NOVO');
  assert.equal((await backend.db.query('select count(*)::int n from public.lead_events')).rows[0].n,0);
  assert.equal((await backend.db.query('select count(*)::int n from public.interactions')).rows[0].n,0);
  // Same reference in production never leaks into the preview history.
  await backend.db.query('insert into public.panel_lead_accesses(environment,opening_id,journey_id,ref_code,created_by,login_email,display_name) values($1,$2,$3,$4,$5,$6,$7)',
    ['production',id(1003),JP,'ACSAA',P,'production@example.test','Produção']);
  assert.equal((await call()).data.items.length,3);
});
test('histórico preserva a identidade antiga e permite ler todos os acessos em páginas estáveis',async()=>{
  await backend.db.query('update public.panel_users set display_name=$1 where id=$2',['Nome alterado',A]);
  assert.ok((await call()).data.items.some(x=>x.display_name==='Leo'));
  for(let i=0;i<35;i++)await backend.db.query(`insert into public.panel_lead_accesses(environment,opening_id,journey_id,created_by,login_email,display_name,accessed_at) values('preview',$1,$2,$3,'leo@example.test','Leo',now()-($4::int*interval '1 minute'))`,[id(2000+i),J2,A,i+1]);
  const first=(await call({query:{journeyId:J2}})).data;
  assert.equal(first.items.length,30);assert.equal(first.nextOffset,30);
  await backend.db.query(`insert into public.panel_lead_accesses(environment,opening_id,journey_id,created_by,login_email,display_name,accessed_at) values('preview',$1,$2,$3,'junior@example.test','Junior',now()+interval '1 second')`,[id(3000),J2,B]);
  const last=(await call({query:{journeyId:J2,offset:first.nextOffset,until:first.until}})).data;
  assert.equal(last.items.length,5);assert.equal(last.nextOffset,null);
  const all=[...first.items,...last.items];assert.equal(new Set(all.map(x=>x.id)).size,35);
  assert.ok(all.every((x,i)=>!i||Date.parse(all[i-1].accessed_at)>=Date.parse(x.accessed_at)));
});
test('dados de acesso não ficam públicos e falhas de leitura não aparecem como histórico vazio',async()=>{
  for(const role of ['anon','authenticated'])for(const operation of ['SELECT','INSERT','UPDATE','DELETE']){
    assert.equal((await backend.db.query("select has_table_privilege($1,'public.panel_lead_accesses',$2) ok",[role,operation])).rows[0].ok,false);
  }
  const table=(await backend.db.query("select relrowsecurity from pg_class where oid='public.panel_lead_accesses'::regclass")).rows[0];assert.equal(table.relrowsecurity,true);
  failRead=true;const failed=await call();failRead=false;
  assert.equal(failed.code,500);assert.equal(failed.data.items,undefined);
  assert.equal((await call({query:{offset:-1}})).code,400);
});
test('pedido da calculadora sem ficha não cria ficha e mantém o acesso quando a ficha é criada depois',async()=>{
  await backend.db.query("insert into public.calc_runs(dados,is_test,idioma) values($1,false,'en')",[JSON.stringify({ref:'ACSAC',sid:'access-order',canal:'whatsapp',logical_mode:'CARRO',evento:'busca',marca:'Tesla',modelo:'Model 3'})]);
  const before=(await backend.db.query('select count(*)::int n from public.journeys')).rows[0].n;
  const body={ref:'ACSAC',openingId:id(4000)};
  assert.equal((await call({body})).code,200);
  assert.equal((await backend.db.query('select count(*)::int n from public.journeys')).rows[0].n,before);
  await backend.db.query(`insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values($1,'preview',$2,'ACSAC','CALCULATOR','NOVO','ATIVO','{}',now(),now())`,[id(13),id(20)]);
  assert.equal((await call({body:{journeyId:id(13),openingId:id(4000)}})).code,200);
  assert.equal((await call({query:{journeyId:id(13)}})).data.items.length,1);
});
