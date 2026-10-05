'use strict';

// Itens da leitura da IA e "Distribuir o que conversei" confirmados numa ficha SEM Ref da
// calculadora (cliente direto do WhatsApp/SMS), com os handlers reais contra o banco PGlite com
// todas as migrações. O caminho com Ref continua igual; ficha encerrada continua recusada; o teto
// vai só para confirmed_total_ceiling_cents (R2). Nenhuma rede externa é usada.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { digest } = require('../panel-note');

const id = (n) => `6cb00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = id(1);
// One ficha with its WhatsApp chat and one customer message; reference_code set to null after the
// insert (the trigger gives new fichas an operational code; old production fichas have none).
const ficha = (n, { name, ref = null, status = 'ATIVO', text }) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(10 + n)}','preview','${name}','${ref ? 'CALCULATOR' : 'WHATSAPP_DIRECT'}',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,reference_code,closed_at,closed_reason,created_at,updated_at) values('${id(20 + n)}','preview','${id(10 + n)}','${ref ? 'CALCULATOR' : 'WHATSAPP_DIRECT'}','NOVO','${status}','{}',1500000,${ref ? `'${ref}'` : 'null'},${status === 'ENCERRADO' ? "now(),'GAVE_UP'" : 'null,null'},now(),now());`,
  ref ? '' : `update public.journeys set reference_code=null where id='${id(20 + n)}';`,
  `insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) select 'preview','${id(20 + n)}',k,'Ponto '||k,'OPEN',now(),now() from generate_series(1,6) k;`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(30 + n)}','preview','WHATSAPP','${id(10 + n)}','wa:+1305556${String(n).padStart(4, '0')}','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(40 + n)}','preview','${id(30 + n)}','WHATSAPP','CUSTOMER','${text}','x',now(),'sr${n}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(40 + n)}','${id(20 + n)}','IMPORT',now());`
].filter(Boolean);
const entry = (fingerprint, item, manualReview = false) => ({ fingerprint: fingerprint.repeat(64), evidence: item.evidence, manualReview, item });
const reading = (n, items) => `select public.panel_ai_replace_reading('preview','${id(20 + n)}','${id(30 + n)}','{}','${JSON.stringify(items).replace(/'/g, "''")}',1,'${id(40 + n)}',now(),'${USER}');`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${USER}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','operator',true,false);`,
  ...ficha(1, { name: 'Direto WhatsApp', text: 'Vou financiar um Honda Civic, teto total 22000' }),
  reading(1, [
    entry('1', { type: 'payment', value: 'fin', evidence: 'Vou financiar' }),
    entry('2', { type: 'wishlist', value: { operation: 'include', car: { make: 'Honda', model: 'Civic' } }, finalWishes: [{ make: 'Honda', model: 'Civic' }], evidence: 'Honda Civic' }),
    entry('3', { type: 'budget', value: 22000, evidence: 'teto total 22000' }, true)
  ]),
  ...ficha(2, { name: 'Com Ref', ref: 'KQ7XP', text: 'Pago à vista' }),
  `insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados) values(now(),'33101','FL',10000,'cash','${JSON.stringify({ quando: new Date().toISOString(), sid: 's-KQ7XP', ref: 'KQ7XP', evento: 'whatsapp', logical_mode: 'VALOR', marca: 'Honda', modelo: 'Accord', lance: 10000, nome: 'Com Ref' })}');`,
  reading(2, [entry('4', { type: 'payment', value: 'cash', evidence: 'Pago à vista' })]),
  ...ficha(3, { name: 'Encerrado', status: 'ENCERRADO', text: 'Pago à vista' }),
  reading(3, [entry('5', { type: 'payment', value: 'cash', evidence: 'Pago à vista' })]),
  ...ficha(4, { name: 'Direto Anotacao', text: 'Oi' })
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const q = async (sql, params = []) => (await backend.db.query(sql, params)).rows;
const pending = async (n) => q(`select i.id,i.item_json->>'type' as type,i.reading_id from public.conversation_ai_items i where i.journey_id=$1 and i.status='PENDING' order by i.item_fingerprint`, [id(20 + n)]);
const confirm = async (n, items) => call('ai-conversations', '/api/panel/ai-conversations', 'POST', { action: 'confirm', journeyId: id(20 + n), readingId: items[0].reading_id, itemIds: items.map((item) => item.id), confirmationKey: require('node:crypto').randomUUID() });

test.before(async () => {
  backend = await createBackend({ seed });
  process.env.SUPABASE_URL = BASE;
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('ficha sem Ref: pagamento e lista de desejo confirmados pela jornada, com auditoria', async () => {
  const items = (await pending(1)).filter((item) => item.type !== 'budget');
  assert.deepEqual(items.map((item) => item.type), ['payment', 'wishlist']);
  const result = await confirm(1, items);
  assert.equal(result.statusCode, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.journeyId, id(21));
  assert.equal(result.payload.confirmed, 2);
  const [journey] = await q(`select payment_text,criteria_json,confirmed_total_ceiling_cents,budget_cents from public.journeys where id=$1`, [id(21)]);
  assert.equal(journey.payment_text, 'fin');
  assert.deepEqual(journey.criteria_json.wishlists, [{ make: 'Honda', model: 'Civic' }]);
  // Confirming the payment also ticks "Pagamento confirmado" (point 3), like the ceiling ticks point 2.
  const [paid] = await q(`select status from public.journey_checklist where journey_id=$1 and point_number=3`, [id(21)]);
  assert.equal(paid.status, 'COMPLETE');
  const [deadlinePoint] = await q(`select status from public.journey_checklist where journey_id=$1 and point_number=4`, [id(21)]);
  assert.equal(deadlinePoint.status, 'OPEN', 'only the confirmed item ticks its point');
  assert.equal(journey.criteria_json.wishlistOverride, true);
  const notes = await q(`select ref_code,body_text,created_by,jsonb_array_length(distributed_json) n from public.lead_notes where journey_id=$1`, [id(21)]);
  assert.deepEqual(notes, [{ ref_code: null, body_text: 'Leitura da IA', created_by: USER, n: 2 }]);
  const events = await q(`select ref_code,event_type,created_by from public.lead_events where journey_id=$1`, [id(21)]);
  assert.deepEqual(events, [{ ref_code: null, event_type: 'NOTE_CONFIRMED', created_by: USER }]);
  const decided = await q(`select status,decided_by from public.conversation_ai_items where id = any($1::uuid[])`, [items.map((item) => item.id)]);
  assert.ok(decided.every((item) => item.status === 'CONFIRMED' && item.decided_by === USER));
  // The ficha (opened by its id) shows the note and no longer counts these items as pending.
  const lead = await call('lead', '/api/panel/lead?id=' + id(21));
  assert.equal(lead.statusCode, 200, JSON.stringify(lead.payload));
  assert.equal(lead.payload.hasCalculatorRef, false);
  assert.equal(lead.payload.notes.length, 1);
  assert.deepEqual(lead.payload.ai.reading.items.map((item) => item.type), ['budget']);
});

test('R2: o teto confirmado da IA vai só para confirmed_total_ceiling_cents, nunca para budget_cents', async () => {
  const items = (await pending(1)).filter((item) => item.type === 'budget');
  const result = await confirm(1, items);
  assert.equal(result.statusCode, 201, JSON.stringify(result.payload));
  const [journey] = await q(`select confirmed_total_ceiling_cents,budget_cents from public.journeys where id=$1`, [id(21)]);
  assert.equal(Number(journey.confirmed_total_ceiling_cents), 2200000);
  assert.equal(Number(journey.budget_cents), 1500000);
  const [point] = await q(`select status from public.journey_checklist where journey_id=$1 and point_number=2`, [id(21)]);
  assert.equal(point.status, 'COMPLETE');
});

test('ficha com Ref da calculadora: confirma como antes, gravando a Ref', async () => {
  const items = await pending(2);
  const result = await confirm(2, items);
  assert.equal(result.statusCode, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.journeyId, id(22));
  const [journey] = await q(`select payment_text from public.journeys where id=$1`, [id(22)]);
  assert.equal(journey.payment_text, 'cash');
  const notes = await q(`select ref_code from public.lead_notes where journey_id=$1`, [id(22)]);
  assert.deepEqual(notes.map((note) => String(note.ref_code).trim()), ['KQ7XP']);
  const events = await q(`select ref_code from public.lead_events where journey_id=$1 and event_type='NOTE_CONFIRMED'`, [id(22)]);
  assert.deepEqual(events.map((event) => String(event.ref_code).trim()), ['KQ7XP']);
  // Opened by its Ref, the ficha shows its notes; a note kept by the journey alone (confirmed
  // while it had no Ref) is still shown with them.
  await q(`insert into public.lead_notes(environment,ref_code,journey_id,body_text,created_by,created_at) values('preview',null,$1,'Antes da Ref',$2,now()-interval '1 day')`, [id(22), USER]);
  const lead = await call('lead', '/api/panel/lead?ref=KQ7XP');
  assert.equal(lead.statusCode, 200, JSON.stringify(lead.payload));
  assert.equal(lead.payload.hasCalculatorRef, true);
  assert.deepEqual(lead.payload.notes.map((note) => note.body_text), ['Leitura da IA', 'Antes da Ref']);
});

test('ficha encerrada sem Ref continua recusada e nada é gravado', async () => {
  const items = await pending(3);
  const result = await confirm(3, items);
  assert.equal(result.statusCode, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.error, 'JOURNEY_FROZEN');
  assert.equal((await pending(3)).length, 1);
  assert.equal((await q(`select count(*)::int n from public.lead_notes where journey_id=$1`, [id(23)]))[0].n, 0);
  assert.equal((await q(`select payment_text from public.journeys where id=$1`, [id(23)]))[0].payment_text, null);
});

test('"Distribuir o que conversei" numa ficha sem Ref grava pela jornada', async () => {
  const note = 'Cliente disse que vai pagar à vista';
  const proposal = [{ type: 'payment', value: 'cash', evidence: 'vai pagar à vista' }];
  const lead = await call('lead', '/api/panel/lead?id=' + id(24));
  assert.equal(lead.statusCode, 200, JSON.stringify(lead.payload));
  assert.equal(lead.payload.hasCalculatorRef, false);
  const ref = lead.payload.ref || '';
  const saved = await call('lead', '/api/panel/lead', 'POST', { action: 'note', ref, journeyId: id(24), note, proposal, signature: digest('secreta-simulada', ref, note, proposal), selected: [0], confirmationKey: require('node:crypto').randomUUID() });
  assert.equal(saved.statusCode, 201, JSON.stringify(saved.payload));
  assert.equal(saved.payload.journeyId, id(24));
  assert.equal((await q(`select payment_text from public.journeys where id=$1`, [id(24)]))[0].payment_text, 'cash');
  const notes = await q(`select ref_code,body_text from public.lead_notes where journey_id=$1`, [id(24)]);
  assert.deepEqual(notes, [{ ref_code: null, body_text: note }]);
  const after = await call('lead', '/api/panel/lead?id=' + id(24));
  assert.equal(after.payload.notes.length, 1);
  // A signature for another ficha's Ref is still refused.
  const forged = await call('lead', '/api/panel/lead', 'POST', { action: 'note', ref, journeyId: id(24), note, proposal, signature: digest('secreta-simulada', 'KQ7XP', note, proposal), selected: [0], confirmationKey: require('node:crypto').randomUUID() });
  assert.equal(forged.statusCode, 400);
  assert.deepEqual(backend.refused.filter((url) => !/zippopotam/.test(url)), []);
});
