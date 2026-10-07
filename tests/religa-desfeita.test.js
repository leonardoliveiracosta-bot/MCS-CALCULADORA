'use strict';

// Destino da calculadora: ligar a uma ficha cuja ligação foi desfeita antes (a fila antiga desfazia a ligação automática)
// reativa a mesma linha; antes a rota dizia "ligada" e a mensagem ficava fora da ficha (4NRJ5, T8PC9, M482Y e 2 manuais).
// Caminho comum: mensagem sem ligação nenhuma ganha a ligação nova, como sempre. Banco PGlite com todas as migrações.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackend } = require('./fixtures/banco-simulado');

const id = (n) => `6f500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const C = id(1), J = id(2), CHAT = id(3), OLD = id(4), FRESH = id(5);
const message = (mid) => `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${mid}','preview','${CHAT}','WHATSAPP','CUSTOMER','Ref: QWRT7','ref: qwrt7',now(),'${mid}',1,'WHATSAPP_WEBHOOK',now());`;
const seed = [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${C}','preview','Mirzet','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${J}','preview','${C}','QWRT7','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${CHAT}','preview','WHATSAPP','${C}','wa:+16166344376','RESOLVED',false,now(),now(),now(),now());`,
  message(OLD), message(FRESH),
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at,undone_at) values('preview','${OLD}','${J}','WHATSAPP_WEBHOOK',now() - interval '5 hours',now() - interval '5 hours');`
].join('\n');

let backend;
test.before(async () => { backend = await createBackend({ seed }); });
test.after(async () => { if (backend) await backend.db.close(); });
const apply = async (mid, manual = false) => (await backend.db.query(`select public.panel_calc_route_apply('preview','${mid}','LIGADA_REF','REF_ENCONTRADA','REF','QWRT7','${J}','{}'::jsonb,1,true,false,${manual},null,false,'TEXTO') r`)).rows[0].r;
const active = async (mid) => (await backend.db.query(`select journey_id, association_source from public.message_journeys where message_id='${mid}' and undone_at is null`)).rows;

test('ligação desfeita antes volta a valer quando a rota liga a mesma ficha', async () => {
  assert.deepEqual(await active(OLD), []);
  const result = await apply(OLD);
  assert.equal(result.linked, true);
  assert.deepEqual((await active(OLD)).map((row) => [row.journey_id, row.association_source]), [[J, 'CALC_ROUTE']]);
  assert.equal((await backend.db.query(`select count(*)::int n from public.message_journeys where message_id='${OLD}'`)).rows[0].n, 1, 'a mesma linha, sem duplicar');
  assert.equal((await apply(OLD)).linked, false, 'repetir não muda nada');
});

test('caminho comum: mensagem sem ligação ganha a ligação nova, uma vez só', async () => {
  assert.equal((await apply(FRESH)).linked, true);
  assert.deepEqual((await active(FRESH)).map((row) => row.journey_id), [J]);
  assert.equal((await apply(FRESH)).linked, false);
});
