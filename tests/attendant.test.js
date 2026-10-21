'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'publica-simulada',SUPABASE_SECRET_KEY:'secreta-simulada'});
const {BASE,createBackend}=require('./fixtures/banco-simulado');
const {enrich,names}=require('../panel-attendant');
const id=n=>`6a220000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const A=id(1),B=id(2),J=id(10),C=id(11),CHAT=id(12),MSG=id(13),AUTH_A='68000000-0000-4000-8000-00000000a001',AUTH_B=id(202);
const seed=`
insert into public.panel_users(id,environment,auth_user_id,email,display_name,role) values
('${A}','preview','${AUTH_A}','leo@example.test','Leo','admin'),
('${B}','preview','${AUTH_B}','ana@example.test','Ana','operator'),
('${id(3)}','production','${id(203)}','outro@example.test','Outro ambiente','operator');
insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${C}','preview','Cliente teste','WHATSAPP_DIRECT',now(),now());
insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${J}','preview','${C}','ATEND','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());
insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at) values('${CHAT}','preview','WHATSAPP','${C}','wa:+13055550123','RESOLVED',false,now(),now());
insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,created_at) values('preview','${C}','+13055550123','+13055550123',true,true,now());
insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${MSG}','preview','${CHAT}','WHATSAPP','CUSTOMER','Hi','hi',now(),'attend-in',1,'WHATSAPP_WEBHOOK',now());
insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${MSG}','${J}','IMPORT',now());`;
let backend;
test.before(async()=>{
  backend=await createBackend({seed});
  globalThis.fetch=async(url,options={})=>{
    if(String(url)===BASE+'/auth/v1/user'&&options.method!=='PUT'){
      const ana=String(options.headers?.authorization).includes('conta-ana');
      return {ok:true,status:200,json:async()=>({id:ana?AUTH_B:AUTH_A,email:ana?'ana@example.test':'leo@example.test'})};
    }
    return backend.fetch(url,options);
  };
});
test.after(async()=>{await backend.db.close();assert.deepEqual(backend.refused,[]);});
async function api(name,token='conta-leo',body=null,query={}){
  const res={setHeader(){},status(n){this.code=n;return this;},json(data){this.data=data;return data;}};
  await require('../api/panel/'+name)({method:body?'POST':'GET',headers:{authorization:'Bearer '+token},body,query},res);
  assert.ok(res.code<400,JSON.stringify(res.data));return res.data;
}
const get=token=>api('lead',token,null,{id:J});
test('a sessão informa o nome do login, sem alterar credenciais',async()=>{
  assert.equal((await api('session')).displayName,'Leo');
  assert.equal((await api('session','conta-ana')).displayName,'Ana');
});
test('abrir ou reler a ficha não cria nem transfere atendimento',async()=>{
  assert.equal((await get()).attendant,null);
  assert.equal((await get('conta-ana')).attendant,null);
  assert.equal((await backend.db.query('select count(*)::integer n from public.lead_events')).rows[0].n,0);
});
test('resultado e anotação usam automaticamente a conta autenticada, mesmo com autor forjado no corpo',async()=>{
  await api('lead','conta-leo',{action:'quick',journeyId:J,type:'ANSWERED',operationId:id(100),created_by:B,actorName:'Ana'});
  assert.equal((await get('conta-ana')).attendant.name,'Leo');
  const event=(await backend.db.query("select created_by from public.lead_events where event_type='QUICK_ANSWERED'")).rows[0];
  assert.equal(event.created_by,A);
  await backend.db.exec("update public.lead_events set occurred_at=now()-interval '1 minute'");
  await api('lead','conta-ana',{action:'note',journeyId:J,note:'Conversei com o cliente',proposal:[],selected:[],confirmationKey:id(101),created_by:A});
  const lead=await get();assert.equal(lead.attendant.name,'Ana');assert.equal(lead.notes[0].actorName,'Ana');
  assert.equal((await get('conta-leo')).attendant.name,'Ana');
  const summary=await api('lead','conta-leo',null,{lastResults:'1'});
  assert.equal(summary.journeys[J].actorName,'Leo');
});
test('desfazer anotação exclui a autoria desfeita e volta ao último atendimento válido',async()=>{
  const lead=await get();await api('lead','conta-ana',{action:'note_remove',journeyId:J,noteId:lead.notes[0].id});
  assert.equal((await get()).attendant.name,'Leo');
});
test('registro de WhatsApp enviado guarda o usuário autenticado, sem chamar o provedor no teste',async()=>{
  const server=require('../panel-server'),reply=require('../api/panel/reply');
  const ctx={environment:'preview',panel:{id:B},config:{url:BASE,secretKey:'secreta-simulada'}};
  const target={journey:{id:J,reference_code:'ATEND'},contactId:C,phone:'+13055550123',name:'Cliente teste'};
  const recorded=await reply.recordSent(ctx,target,'Mensagem de teste','wamid.ATTENDANT',{insert:server.insert,applyMessage:reply.applyMessage,patchRows:server.patchRows},Date.now()+5000);
  const [interaction]=(await backend.db.query('select created_by from public.interactions where message_id=$1',[recorded.messageId])).rows;
  assert.equal(interaction.created_by,B);
  assert.equal((await get()).attendant.name,'Ana');
});
test('mensagem desfeita e usuário de outro ambiente não viram atendente',async()=>{
  const scoped=await names({environment:'preview',config:{url:BASE,secretKey:'secreta-simulada'}},[id(3)]);
  assert.equal(scoped.size,0);
  await backend.db.exec("update public.interactions set undone_at=now() where type in ('CALL_ANSWERED','CALL_ATTEMPT','IN_PERSON')");
  const current=await get();const clone={...current,events:[],notes:[],record:{...current.record,conversation:[]}};
  const result=await enrich({environment:'preview',config:{url:BASE,secretKey:'secreta-simulada'}},clone);
  assert.equal(result.attendant,null);
});
