'use strict';

// Comando 2: o resumo das conversas calculado no banco (CLIENTES) bate com o cálculo em JS, e o
// desfazer de "ligar pedido à ficha" volta exatamente ao estado anterior (o de "apresentar" está
// em tests/desfazer-apresentar.test.js). Banco PGlite local com todas as migrações; nada é enviado, nada vai ao Supabase.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migratedDatabase } = require('./sql/run');
const groups = require('../panel-groups');

const id = (n) => `7c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), OTHER = id(2);
let db;

test.before(async () => {
  ({ db } = await migratedDatabase());
  await db.exec(`
    insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values
      ('${ACTOR}','preview','${id(901)}','a@example.test','admin',true,false),('${OTHER}','preview','${id(902)}','b@example.test','admin',true,false);
    insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(11)}','preview','Cliente','WHATSAPP_DIRECT',now(),now());
    insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(10)}','preview','${id(11)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now()-interval '3 days',now());
    insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${id(11)}','t-12','RESOLVED',false,now(),now(),now(),now());
  `);
});
test.after(async () => { if (db) await db.close(); });

test('resumo das mensagens no banco = resumo em JS (primeira, última do cliente, última da MCS, mais recente real)', async () => {
  const messages = [
    { n: 100, direction: 'CUSTOMER', text: "Hi! I'd like to talk about financing a car with you", hours: 50, source: 'WHATSAPP_WEBHOOK', auto: false },
    { n: 101, direction: 'MCS', text: 'Olá!', hours: 49, source: 'PANEL', auto: false },
    { n: 102, direction: 'CUSTOMER', text: 'Quero um Camry', hours: 5, source: 'WHATSAPP_WEBHOOK', auto: false },
    { n: 103, direction: 'MCS', text: 'Mensagem automática', hours: 4, source: 'WHATSAPP_WEBHOOK', auto: true }
  ];
  for (const m of messages) {
    await db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,is_automatic,created_at)
      values($1,'preview',$2,'WHATSAPP',$3,$4,'x',now()-($5||' hours')::interval,$6,1,$7,$8,now())`, [id(m.n), id(12), m.direction, m.text, String(m.hours), 's' + m.n, m.source, m.auto]);
    await db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'IMPORT',now())`, [id(m.n), id(10)]);
  }
  const fromDb = (await db.query(`select * from public.panel_journey_message_facts('preview',500,0)`)).rows.find((row) => row.journey_id === id(10));
  const rows = (await db.query(`select m.id,m.direction,m.body_text,m.occurred_at_utc,m.source_kind,m.is_automatic,m.channel from public.messages m where m.chat_id=$1`, [id(12)])).rows
    .map((row) => ({ ...row, occurred_at_utc: new Date(row.occurred_at_utc).toISOString() }));
  const fromJs = groups.summaryFromMessages(rows);
  const iso = (value) => value ? new Date(value).toISOString() : null;
  assert.equal(Number(fromDb.message_count), fromJs.message_count);
  assert.equal(Number(fromDb.customer_count), fromJs.customer_count);
  assert.equal(iso(fromDb.first_customer_at), fromJs.first_customer_at);
  assert.equal(fromDb.first_customer_text, fromJs.first_customer_text);
  assert.equal(fromDb.last_customer_id, fromJs.last_customer_id);
  assert.equal(fromDb.last_customer_text, fromJs.last_customer_text);
  assert.equal(fromDb.last_mcs_id, fromJs.last_mcs_id);
  assert.equal(fromDb.latest_id, fromJs.latest_id, 'a automática nunca é a mais recente real');
  assert.equal(fromDb.latest_direction, 'CUSTOMER');
  // The same rules read the same facts: financing origin and "não atendido".
  const facts = groups.factsFor({ summary: fromDb, journey: { source: 'WHATSAPP_DIRECT' } });
  assert.equal(groups.originOf(facts).financing, true);
  assert.equal(groups.classify(facts).key, 'NAO_ATENDIDO');
  // Paged: the limit and offset walk every journey once.
  assert.equal((await db.query(`select * from public.panel_journey_message_facts('preview',1,0)`)).rows.length, 1);
  const latest = (await db.query(`select * from public.panel_journey_chat_latest('preview',500,0)`)).rows.find((row) => row.journey_id === id(10));
  assert.equal(latest.chat_id, id(12));
  assert.equal(latest.message_id, id(102), 'a última mensagem real da conversa');
});

test('ligar pedido à ficha → desfazer tira a Ref, devolve os vínculos da calculadora e a sugestão volta a pendente', async () => {
  await db.exec(`update public.journeys set reference_code=null where id='${id(10)}';
    insert into public.calculator_request_links(id,environment,calc_sid,calc_ref,logical_mode,contact_id,journey_id,linked_at,linked_by) values('${id(50)}','preview','sid-1','KXQ7P','VALOR',null,null,now()-interval '1 day','${OTHER}');
    insert into public.whatsapp_link_suggestions(id,environment,source_contact_id,source_journey_id,source_chat_id,target_ref,phone_e164,status,suggestion_kind) values('${id(60)}','preview','${id(11)}','${id(10)}','${id(12)}','KXQ7P','+14075550100','PENDING','AI');`);
  const linked = (await db.query(`select public.panel_whatsapp_resolve_suggestion_undoable('preview',$1,$2,true) r`, [id(60), ACTOR])).rows[0].r;
  assert.equal(linked.status, 'LINKED');
  assert.equal(linked.undoable, true);
  assert.equal((await db.query(`select reference_code from public.journeys where id=$1`, [id(10)])).rows[0].reference_code, 'KXQ7P');
  assert.equal((await db.query(`select journey_id from public.calculator_request_links where id=$1`, [id(50)])).rows[0].journey_id, id(10));
  await assert.rejects(db.query(`select public.panel_whatsapp_link_ref_undo('preview',$1,$2)`, [id(60), OTHER]), /UNDO_NOT_ALLOWED/);
  const undone = (await db.query(`select public.panel_whatsapp_link_ref_undo('preview',$1,$2) r`, [id(60), ACTOR])).rows[0].r;
  assert.equal(undone.undone, true);
  assert.equal((await db.query(`select reference_code from public.journeys where id=$1`, [id(10)])).rows[0].reference_code, null);
  assert.equal((await db.query(`select count(*)::int n from public.journey_refs where journey_id=$1 and ref_code='KXQ7P'`, [id(10)])).rows[0].n, 0);
  const link = (await db.query(`select journey_id,linked_by from public.calculator_request_links where id=$1`, [id(50)])).rows[0];
  assert.equal(link.journey_id, null);
  assert.equal(link.linked_by, OTHER);
  const suggestion = (await db.query(`select status,undo_json from public.whatsapp_link_suggestions where id=$1`, [id(60)])).rows[0];
  assert.equal(suggestion.status, 'PENDING');
  assert.equal(suggestion.undo_json, null);
  // Undo only once: nothing left to undo.
  await assert.rejects(db.query(`select public.panel_whatsapp_link_ref_undo('preview',$1,$2)`, [id(60), ACTOR]), /UNDO_UNAVAILABLE/);
  // Rejecting a suggestion is not undoable here (it has its own way back in the panel).
  const rejected = (await db.query(`select public.panel_whatsapp_resolve_suggestion_undoable('preview',$1,$2,false) r`, [id(60), ACTOR])).rows[0].r;
  assert.equal(rejected.undoable, false);
});
