'use strict';

// Print de SMS: a data da mensagem é o clique no SMS da calculadora (ou o último registro da Ref) antes da confirmação;
// sem Ref, "data original desconhecida" e nunca recente. A mesma função serve o print novo e a correção dos antigos.
// Banco PGlite local com todas as migrações; nada sai da máquina.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migratedDatabase } = require('./sql/run');

const id = (n) => `7e100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), CONTACT = id(2), JOURNEY = id(3), WA = id(4), SMS = id(5);
let db;
const iso = (value) => new Date(value).toISOString();

async function print(n, { ref, confirmedAt, text = 'Hello! I just ran a simulation on the My Car Scout calculator\nName: Ana' }) {
  await db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
    values($1,'preview',$2,'SMS','CUSTOMER',$3,'x',$4,true,$5,1,'SMS_PRINT',$4)`, [id(n), SMS, text, confirmedAt, 'SMS_PRINT:' + n]);
  await db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'SMS_PRINT',$3)`, [id(n), JOURNEY, confirmedAt]);
  await db.query(`insert into public.sms_print_reads(id,environment,status,original_filename,mime_type,byte_size,quarantine_path,sha256,extracted_json,message_id,created_at,updated_at,created_by,updated_by)
    values($1,'preview','CONFIRMED','p.png','image/png',10,$2,$3,$4,$5,$6,$6,$7,$7)`, [id(n + 500), 'q/' + n, 'h' + n, JSON.stringify(ref ? { ref, message: text } : { message: text }), id(n), confirmedAt, ACTOR]);
}
const message = async (n) => (await db.query(`select occurred_at_utc, time_uncertain, original_datetime_text from public.messages where id=$1`, [id(n)])).rows[0];

test.before(async () => {
  ({ db } = await migratedDatabase());
  await db.exec(`
    insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','${id(900)}','a@example.test','admin',true,false);
    insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Ana','WHATSAPP_DIRECT',now(),now());
    insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','NOVO','ATIVO','{}','2026-09-20T00:00:00Z',now());
    insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values
      ('${WA}','preview','WHATSAPP','${CONTACT}','wa-1','RESOLVED',false,now(),now(),now(),now()),('${SMS}','preview','SMS','${CONTACT}','sms-1','RESOLVED',false,'2026-10-03T17:00:00Z','2026-10-03T17:00:00Z',now(),now());
    insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
      values('${id(10)}','preview','${WA}','WHATSAPP','CUSTOMER','oi','oi','2026-09-26T10:00:00Z','wa-10',1,'IMPORT',now());
    insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(10)}','${JOURNEY}','IMPORT',now());
    insert into public.calc_runs(created_at,zip,estado,lance,pagamento,idioma,origem,dados,is_test) values
      ('2026-09-24T09:00:00Z','33101','Florida',10000,'cash','en','t','{"ref":"ABCDE","evento":"simulacao"}',false),
      ('2026-09-25T12:00:00Z','33101','Florida',10000,'cash','en','t','{"ref":"ABCDE","evento":"sms"}',false),
      ('2026-09-27T12:00:00Z','33101','Florida',10000,'cash','en','t','{"ref":"ABCDE","evento":"simulacao"}',false),
      ('2026-10-05T12:00:00Z','33101','Florida',10000,'cash','en','t','{"ref":"ABCDE","evento":"sms"}',false),
      ('2026-09-28T12:00:00Z','33101','Florida',10000,'cash','en','t','{"ref":"FGHJK","evento":"busca","canal":"SMS"}',false),
      ('2026-09-29T12:00:00Z','33101','Florida',10000,'cash','en','t','{"ref":"FGHJK","evento":"sms"}',true),
      ('2026-09-22T12:00:00Z','33101','Florida',10000,'cash','en','t','{"ref":"LMNPQ","evento":"simulacao"}',false);
  `);
});
test.after(async () => { if (db) await db.close(); });

test('Ref com clique no SMS: o último clique antes da confirmação (nunca depois, nunca a simulação)', async () => {
  await print(100, { ref: ' abcde ', confirmedAt: '2026-10-03T17:38:00Z' });
  await db.query(`select public.panel_sms_print_fix_date('preview',$1)`, [id(100)]);
  const row = await message(100);
  assert.equal(iso(row.occurred_at_utc), '2026-09-25T12:00:00.000Z');
  assert.equal(row.time_uncertain, false);
  assert.match(row.original_datetime_text, /clique no SMS da calculadora · Ref ABCDE/);
});

test('busca com canal sms conta como clique; calc_runs de teste não contam', async () => {
  await print(101, { ref: 'FGHJK', confirmedAt: '2026-10-03T17:38:00Z' });
  await db.query(`select public.panel_sms_print_fix_date('preview',$1)`, [id(101)]);
  assert.equal(iso((await message(101)).occurred_at_utc), '2026-09-28T12:00:00.000Z');
});

test('Ref sem clique: o último registro da Ref antes da confirmação', async () => {
  await print(102, { ref: 'LMNPQ', confirmedAt: '2026-10-03T17:38:00Z' });
  await db.query(`select public.panel_sms_print_fix_date('preview',$1)`, [id(102)]);
  const row = await message(102);
  assert.equal(iso(row.occurred_at_utc), '2026-09-22T12:00:00.000Z');
  assert.match(row.original_datetime_text, /registro da calculadora/);
});

test('sem Ref ou Ref sem registro: data original desconhecida, e nunca a última mensagem nem o "visto por último"', async () => {
  await print(103, { confirmedAt: '2026-10-03T17:39:00Z' });
  await print(104, { ref: 'ZZZZZ', confirmedAt: '2026-10-03T17:40:00Z' });
  for (const n of [103, 104]) {
    await db.query(`select public.panel_sms_print_fix_date('preview',$1)`, [id(n)]);
    const row = await message(n);
    assert.equal(row.occurred_at_utc, null);
    assert.equal(row.time_uncertain, true);
    assert.equal(row.original_datetime_text, 'data original desconhecida');
  }
  const chat = (await db.query(`select last_seen_at, first_seen_at from public.chats where id=$1`, [SMS])).rows[0];
  assert.equal(iso(chat.last_seen_at), '2026-09-28T12:00:00.000Z', 'o chat SMS vê só as datas reais');
  const facts = (await db.query(`select * from public.panel_journey_message_facts('preview',500,0) where journey_id=$1`, [JOURNEY])).rows[0];
  assert.equal(facts.message_count, 6);
  assert.equal(iso(facts.last_customer_at), '2026-09-28T12:00:00.000Z', 'a última do cliente é o print com data real mais novo');
  assert.equal(iso(facts.latest_at), '2026-09-28T12:00:00.000Z');
});

test('a leitura de mensagens do painel apaga a hora da confirmação de um print sem data (e só dele)', async () => {
  const { createBackend, BASE } = require('./fixtures/banco-simulado');
  const backend = await createBackend({ seed: '' });
  const before = globalThis.fetch;
  try {
    await backend.db.exec(`
      insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Ana','SMS_DIRECT',now(),now());
      insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at) values('${SMS}','preview','SMS','${CONTACT}','sms-x','RESOLVED',false,now(),now());
      insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,original_datetime_text,signature_base,occurrence_index,source_kind,created_at) values
        ('${id(200)}','preview','${SMS}','SMS','CUSTOMER','a','a',null,true,'data original desconhecida','s200',1,'SMS_PRINT',now()),
        ('${id(201)}','preview','${SMS}','SMS','CUSTOMER','b','b','2026-09-25T12:00:00Z',false,'clique no SMS da calculadora · Ref ABCDE','s201',1,'SMS_PRINT',now());`);
    globalThis.fetch = backend.fetch;
    const server = require('../panel-server');
    const ctx = { environment: 'preview', config: { url: BASE, secretKey: 'secreta-simulada' } };
    const list = await server.allRows(ctx, 'messages', { select: 'id,body_text,created_at', environment: 'eq.preview' });
    const unknown = list.find((row) => row.id === id(200)), known = list.find((row) => row.id === id(201));
    assert.equal(unknown.created_at, null);
    assert.equal(unknown.date_unknown, true);
    assert.ok(known.created_at);
    assert.deepEqual(Object.keys(known).sort(), ['body_text', 'created_at', 'id'], 'os campos lidos a mais não vazam');
  } finally { globalThis.fetch = before; await backend.db.close(); }
});

test('confirmação nova: a mensagem já sai com a data do clique na calculadora, mesmo sem a linha "Ref:" no texto', async () => {
  const read = id(700);
  await db.query(`insert into public.sms_print_reads(id,environment,status,original_filename,mime_type,byte_size,quarantine_path,sha256,extracted_json,created_at,updated_at,created_by,updated_by)
    values($1,'preview','READY','n.png','image/png',10,'q/700','h700',$2,now(),now(),$3,$3)`, [read, JSON.stringify({ ref: 'ABCDE', message: 'Hello, I want a car' }), ACTOR]);
  const result = (await db.query(`select public.panel_sms_print_confirm('preview',$1,$2,null,false,'+13055550199','Ana','ABCDE','Hello, I want a car','',$3,'mcs-panel-attachments','panel/preview/n.png') r`, [ACTOR, read, id(701)])).rows[0].r;
  const row = (await db.query(`select occurred_at_utc, created_at, time_uncertain from public.messages where id=$1`, [result.messageId])).rows[0];
  // The last SMS click of the Ref before this confirmation (it happens now, on the machine's clock).
  const expected = Date.now() >= Date.parse('2026-10-05T12:00:00Z') ? '2026-10-05T12:00:00.000Z' : '2026-09-25T12:00:00.000Z';
  assert.equal(iso(row.occurred_at_utc), expected);
  assert.notEqual(iso(row.occurred_at_utc), iso(row.created_at));
  assert.equal(row.time_uncertain, false);
  const interaction = (await db.query(`select occurred_at from public.interactions where message_id=$1`, [result.messageId])).rows[0];
  assert.equal(iso(interaction.occurred_at), expected);
});
