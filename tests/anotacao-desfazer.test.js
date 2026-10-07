'use strict';

// Ficha · "Desfazer" uma anotação do quadro, com o handler real contra o banco simulado (todas as migrações): a anotação
// simples sai (o texto fica guardado no evento, marcado como desfeito); a que distribuiu dados e a de outra ficha não saem.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const id = (n) => `6d300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MINE = id(10), OTHER = id(20), PLAIN = id(31), WITH_ITEMS = id(32), OTHER_NOTE = id(33);
const journey = (journeyId, contact, name) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journeyId}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`
];
const note = (noteId, journeyId, text, items = '[]') => [
  `insert into public.lead_notes(id,environment,journey_id,body_text,distributed_json,created_by) values('${noteId}','preview','${journeyId}','${text}','${items}','${id(1)}');`,
  `insert into public.lead_events(environment,journey_id,event_type,detail_json,created_by) values('preview','${journeyId}','NOTE_CONFIRMED','{"noteId":"${noteId}"}','${id(1)}');`
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...journey(MINE, id(11), 'Cliente Nota'), ...journey(OTHER, id(21), 'Outro Cliente'),
  ...note(PLAIN, MINE, 'ligar'), ...note(WITH_ITEMS, MINE, 'pagamento cash', '[{"type":"payment","value":"cash"}]'), ...note(OTHER_NOTE, OTHER, 'de outra ficha')
].join('\n');

let backend;
const remove = async (noteId) => {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  await require('../api/panel/lead')({ method: 'POST', url: '/api/panel/lead', headers: { authorization: 'Bearer token-simulado' }, query: {}, body: { journeyId: MINE, action: 'note_remove', noteId } }, res);
  return res;
};
const notes = async () => (await backend.db.query(`select id from public.lead_notes order by id`)).rows.map((row) => row.id);

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('anotação de outra ficha e anotação que distribuiu dados não se desfazem; nada muda', async () => {
  assert.equal((await remove(OTHER_NOTE)).statusCode, 404);
  assert.equal((await remove(WITH_ITEMS)).statusCode, 409);
  assert.equal((await remove('nao-e-uuid')).statusCode, 400);
  assert.deepEqual(await notes(), [PLAIN, WITH_ITEMS, OTHER_NOTE].sort());
});

test('anotação simples sai da ficha; o texto fica no evento, marcado como desfeito', async () => {
  const res = await remove(PLAIN);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.body, 'ligar');
  assert.deepEqual(await notes(), [WITH_ITEMS, OTHER_NOTE].sort());
  const [event] = (await backend.db.query(`select undone_at, detail_json from public.lead_events where event_type='NOTE_CONFIRMED' and detail_json->>'noteId'='${PLAIN}'`)).rows;
  assert.ok(event.undone_at);
  assert.equal(event.detail_json.removedBody, 'ligar');
  // A second click finds nothing (no error loop, nothing else removed).
  assert.equal((await remove(PLAIN)).statusCode, 404);
  assert.deepEqual(await notes(), [WITH_ITEMS, OTHER_NOTE].sort());
});
