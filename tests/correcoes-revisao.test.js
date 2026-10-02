'use strict';

// Correções da revisão independente (R1/R3/R4 e decisões M3, M5, A8 mantidas). Os handlers reais
// rodam contra o banco PGlite com o caso de demonstração e casos extras (sem rede, nada enviado).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const demo = require('./fixtures/caso-demonstracao');

const id = (n) => `6c200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HOUR = 3600 * 1000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const ACTOR = demo.IDS.ACTOR;
let serial = 0;

// One person: contact + chat + ficha (+ optional toggle, disposition, messages, Ref events).
function person(n, name, options = {}) {
  const contactId = id(n * 10), journeyId = id(n * 10 + 1), chatId = id(n * 10 + 2);
  const status = options.closed ? 'ENCERRADO' : 'ATIVO';
  const sql = [
    `insert into public.contacts(id,environment,display_name,source,is_lead,created_at,updated_at) values('${contactId}','preview',${q(name)},'WHATSAPP_DIRECT',${options.notLead ? 'false' : 'true'},now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chatId}','preview','WHATSAPP','${contactId}',${q('chat-' + n)},'RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,reference_code,next_action_at,closed_at,closed_reason,created_at,updated_at) values('${journeyId}','preview','${contactId}','${options.source || 'WHATSAPP_DIRECT'}','NOVO','${status}','{}'::jsonb,${options.ref ? q(options.ref) : 'null'},${options.nextActionHoursAgo ? q(at(options.nextActionHoursAgo)) : 'null'},${options.closed ? q(at(options.closed)) : 'null'},${options.closed ? "'GAVE_UP'" : 'null'},${q(at(options.createdHoursAgo || 200))},now());`
  ];
  if (options.ref && options.linkRef) sql.push(`insert into public.journey_refs(environment,journey_id,ref_code,created_at) values('preview','${journeyId}',${q(options.ref)},now());`);
  if (options.off) sql.push(`insert into public.journey_toggle_states(environment,journey_id,enabled,off_reason,switched_at,switched_by) values('preview','${journeyId}',false,'GAVE_UP',${q(at(options.off))},'${ACTOR}');`);
  if (options.disposition) sql.push(`insert into public.panel_item_dispositions(environment,item_kind,item_key,status,discard_reason,updated_by,updated_at) values('preview','JOURNEY','${journeyId}','${options.disposition.status}',${options.disposition.status === 'DISCARDED' ? "'PRICE'" : 'null'},'${ACTOR}',${q(at(options.disposition.hoursAgo))});`);
  if (options.wantCarHoursAgo) sql.push(`insert into public.lead_events(environment,ref_code,journey_id,event_type,occurred_at) values('preview',${q(options.ref)},'${journeyId}','WANT_CAR',${q(at(options.wantCarHoursAgo))});`);
  for (const [direction, text, hoursAgo] of options.messages || []) {
    const messageId = id(9000 + (++serial));
    sql.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${messageId}','preview','${chatId}','WHATSAPP','${direction}',${q(text)},'x',${q(at(hoursAgo))},${q('rev' + messageId)},1,'WHATSAPP_WEBHOOK',${q(at(hoursAgo))});`);
    sql.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${messageId}','${journeyId}','IMPORT',now());`);
  }
  if (options.triageOut) sql.push(`insert into public.conversation_triage(environment,chat_id,journey_id,source,category,decision,content_hash,rule_version,created_by) values('preview','${chatId}','${journeyId}','MANUAL','PESSOAL','FORA_DO_FUNIL','${'c'.repeat(64)}','v1','${ACTOR}');`);
  return { contactId, journeyId, chatId, sql: sql.join('\n') };
}

const P = {
  wantOff: person(1, 'Quer carro desligado', { ref: 'WQFFA', off: 48, wantCarHoursAgo: 2, messages: [['CUSTOMER', 'Oi, quero um carro', 60]] }),
  wantClosed: person(2, 'Quer carro encerrado', { ref: 'WQCLA', closed: 48, wantCarHoursAgo: 2, messages: [['CUSTOMER', 'Oi, quero um carro', 60]] }),
  discardedOverdue: person(3, 'Descartado com retorno vencido', { nextActionHoursAgo: 20, disposition: { status: 'DISCARDED', hoursAgo: 72 }, messages: [['CUSTOMER', 'Quero um Civic', 120]] }),
  discardedWant: person(4, 'Descartado quer carro', { ref: 'DQWNA', wantCarHoursAgo: 2, disposition: { status: 'DISCARDED', hoursAgo: 72 }, messages: [['CUSTOMER', 'Quero um Civic', 120]] }),
  discardedWrote: person(5, 'Descartado escreveu depois', { disposition: { status: 'DISCARDED', hoursAgo: 72 }, messages: [['CUSTOMER', 'Quero um Civic', 120], ['CUSTOMER', 'Voltei, ainda quero o Civic', 2]] }),
  treatedOverdue: person(6, 'Tratado com retorno vencido', { nextActionHoursAgo: 20, disposition: { status: 'TREATED', hoursAgo: 72 }, messages: [['CUSTOMER', 'Quero um Civic', 120]] }),
  optOut: person(7, 'Pediu para parar', { messages: [['CUSTOMER', 'Quero um Civic', 5], ['MCS', 'Temos opções', 4], ['CUSTOMER', 'STOP', 2]] }),
  optOutEs: person(8, 'Pidió no escribir', { messages: [['CUSTOMER', 'Hola', 5], ['CUSTOMER', 'No me escribas más por favor', 2]] }),
  optBack: person(9, 'Parou e voltou', { messages: [['CUSTOMER', 'STOP', 5], ['CUSTOMER', 'Desculpe, ainda quero o Civic', 2]] }),
  offContacted: person(10, 'Desligado que escreveu', { off: 1, messages: [['CUSTOMER', 'Quero um carro', 60]] }),
  offSilent: person(11, 'Desligado sem mensagem', { off: 1 }),
  notLead: person(12, 'Não é lead', { notLead: true, messages: [['CUSTOMER', 'Sou fornecedor', 3]] }),
  weeklySilent: person(13, 'Ficha nova sem mensagem do cliente', { createdHoursAgo: 24, messages: [['MCS', 'Oi, tudo bem?', 20]] }),
  weeklyWrote: person(14, 'Ficha nova que escreveu', { createdHoursAgo: 24, messages: [['CUSTOMER', 'Oi, quero um carro', 20]] }),
  weeklyTriage: person(15, 'Ficha fora do funil', { createdHoursAgo: 24, triageOut: true, messages: [['CUSTOMER', 'Oi, é a sua tia', 20]] })
};
// The demo Ref SHRAB belongs to two fichas (SHARED_A by reference_code, SHARED_B by journey_refs):
// both clients wrote, so each one must appear on its own and the Ref is nobody's context.
const sharedMessages = [demo.IDS.SHARED_A, demo.IDS.SHARED_B].map((journeyId, index) => {
  const chatId = id(800 + index), contactId = index ? demo.IDS.SHARED_CONTACT_B : demo.IDS.SHARED_CONTACT_A, messageId = id(810 + index);
  return [`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chatId}','preview','WHATSAPP','${contactId}','shared-${index}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${messageId}','preview','${chatId}','WHATSAPP','CUSTOMER','Oi, Ref SHRAB','x',${q(at(3))},'shared${index}',1,'WHATSAPP_WEBHOOK',${q(at(3))});`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${messageId}','${journeyId}','IMPORT',now());`].join('\n');
});
// Vitrine requests: one per case, all untreated.
const VIT = { vitrine: (n) => id(700 + n), car: (n) => id(750 + n), request: (n) => id(780 + n) };
function vitrineRequest(n, owner, options = {}) {
  return [`insert into public.vitrines(id,environment,token,journey_id,contact_id,reference_code,customer_name,version,expires_at) values('${VIT.vitrine(n)}','preview',${q('tok' + n + 'x'.repeat(40))},'${owner.journeyId}','${owner.contactId}','VTRNA','Dono','V2',${q(new Date(Date.now() + 30 * 86400000).toISOString())});`,
    `insert into public.vitrine_cars(id,environment,vitrine_id,short_code,vehicle_snapshot,customer_limit_cents) values('${VIT.car(n)}','preview','${VIT.vitrine(n)}',${q('MCS-' + n)},'{"year":2021,"make":"BMW","model":"X3"}'::jsonb,1800000);`,
    `insert into public.vitrine_requests(id,environment,vitrine_id,vitrine_car_id,contact_id,journey_id,request_kind,referred) values('${VIT.request(n)}','preview','${VIT.vitrine(n)}','${VIT.car(n)}',${options.contactId ? q(options.contactId) : `'${owner.contactId}'`},null,'BID',${options.referred ? 'true' : 'false'});`].join('\n');
}
const vitrineSeed = [
  vitrineRequest(1, P.optBack),                                   // actionable: stays
  vitrineRequest(2, P.offContacted),                              // ficha switched off: out
  vitrineRequest(3, P.wantClosed),                                // ficha ENCERRADO: out
  vitrineRequest(4, P.discardedWrote),                            // person discarded: out
  vitrineRequest(5, P.notLead),                                   // contact not-lead: out
  vitrineRequest(6, P.offContacted, { referred: true, contactId: P.weeklyWrote.contactId }) // referred, no ficha of its own: stays
].join('\n');

let backend;
test.before(async () => {
  backend = await createBackend({ seed: [demo.seed, ...Object.values(P).map((item) => item.sql), ...sharedMessages, vitrineSeed].join('\n') });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['OPENAI_API_KEY', 'D360_API_KEY', 'ENTRADA_OPENAI_ENABLED', 'SEARCH_EXTRACTION_AI_ENABLED', 'MANHEIM_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

async function call(name, url) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method: 'GET', url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams) }, res);
  assert.equal(res.statusCode, 200, name + ' ' + JSON.stringify(res.payload).slice(0, 300));
  return res.payload;
}
const todayIds = async () => new Set((await call('today', '/api/panel/today?sort=recent')).items.map((item) => item.journeyId || item.id));

test('fix 2: a Ref owned by two fichas is nobody\'s context; each ficha shows on its own', async () => {
  const today = await call('today', '/api/panel/today?sort=recent');
  const ids = new Set(today.items.map((item) => item.journeyId || item.id));
  assert.ok(ids.has(demo.IDS.SHARED_A) && ids.has(demo.IDS.SHARED_B), 'both fichas that share the Ref appear in HOJE');
  assert.ok(!today.items.some((item) => item.kind === 'CALCULATOR_ORDER' && item.ref === demo.SHARED_REF), 'the ambiguous order is not shown as one client\'s');
  // The explicit lookup never answers with the order attached to one of the owners.
  const looked = (await call('orders', '/api/panel/orders?ref=' + demo.SHARED_REF)).items;
  assert.equal(looked.length, 1, '#pedido/REF still answers');
  assert.ok(!looked.some((item) => item.kind !== 'DIRECT' && [demo.IDS.SHARED_A, demo.IDS.SHARED_B].includes(item.journeyId)), 'the order is not attached to the last owner');
  // The orders list does not borrow one owner's messages to list the ambiguous order as contacted.
  const all = await call('orders', '/api/panel/orders?filter=Todos&period=all&limit=100');
  assert.ok(!all.items.some((item) => item.ref === demo.SHARED_REF && item.kind !== 'DIRECT'), 'the orders list does not show it as contacted');
  assert.ok(all.items.some((item) => item.kind === 'DIRECT' && item.journeyId === demo.IDS.SHARED_A), 'the ficha itself still shows');
});

test('fix 3a: "quero este carro" never brings back a switched-off or ENCERRADO ficha', async () => {
  const ids = await todayIds();
  assert.ok(!ids.has(P.wantOff.journeyId), 'switched-off ficha with WANT_CAR stays out of HOJE');
  assert.ok(!ids.has(P.wantClosed.journeyId), 'ENCERRADO ficha with WANT_CAR stays out of HOJE');
});

test('fix 3b: DISCARDED comes back only through a customer message after the discard; TREATED unchanged', async () => {
  const ids = await todayIds();
  assert.ok(!ids.has(P.discardedOverdue.journeyId), 'an overdue next action does not bring a discarded person back');
  assert.ok(!ids.has(P.discardedWant.journeyId), 'WANT_CAR does not bring a discarded person back');
  assert.ok(ids.has(P.discardedWrote.journeyId), 'a customer message after the discard does (M3)');
  assert.ok(ids.has(P.treatedOverdue.journeyId), 'TREATED keeps coming back through an overdue next action');
});

test('fix 3c: a client whose latest message is an opt-out is not actionable in HOJE', async () => {
  const ids = await todayIds();
  assert.ok(!ids.has(P.optOut.journeyId), 'STOP');
  assert.ok(!ids.has(P.optOutEs.journeyId), 'no me escribas más');
  assert.ok(ids.has(P.optBack.journeyId), 'wrote again after the opt-out: back in HOJE');
});

test('fix 4: vitrine requests in the HOJE badge exclude closed, switched-off, discarded and not-lead; referred stays', async () => {
  const { requests } = await call('vitrine-requests', '/api/panel/vitrine-requests');
  assert.deepEqual(requests.map((item) => item.id).sort(), [VIT.request(1), VIT.request(6)].sort());
});

test('fix 5: report counts only switched-off fichas of the contacted set', async () => {
  const report = await call('report', '/api/panel/report?view=records&period=today');
  // offContacted (wrote) counts; offSilent (never wrote) does not; wantOff was switched off 48 h ago.
  assert.equal(report.summary.disabled, 1, JSON.stringify(report.summary));
});

test('fix 6: weekly counts only fichas whose client wrote and never a triage out-of-funnel ficha', async () => {
  const weekly = await call('weekly', '/api/panel/weekly');
  // New WhatsApp leads in the last 7 days: Marina (demo), the two clients of the shared Ref and
  // weeklyWrote. Never the twin contact nor weeklySilent (no customer message) nor weeklyTriage
  // (out of the funnel): before the fix this read 7.
  assert.equal(weekly.leads.whatsapp.current, 4, JSON.stringify(weekly.leads));
  const { buildWeeklySummary } = require('../panel-weekly');
  const now = Date.now();
  const silent = buildWeeklySummary({ journeys: [{ id: 'j', contact_id: 'c', source: 'WHATSAPP_DIRECT', status: 'ATIVO', created_at: new Date(now - HOUR).toISOString() }], messageLinks: [{ journey_id: 'j', message_id: 'm' }], messages: [{ id: 'm', direction: 'MCS', created_at: new Date(now - HOUR).toISOString() }], units: [], dispositions: [] }, now);
  assert.equal(silent.leads.whatsapp.current, 0, 'a ficha without a customer message is not a lead');
  const js = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.match(js, /clientsOverdue24=true;\$\('clients-situation'\)\.value='all';if\(\$\('clients-activity'\)\)\$\('clients-activity'\)\.value='all'/, 'the weekly shortcut opens CLIENTES with period "Tudo"');
});

test('fix 10: "Ligar a um lead" offers neither not-lead nor switched-off fichas', async () => {
  const entry = await call('entry', '/api/panel/entry');
  const linkable = new Map(entry.journeys.map((item) => [item.id, item.linkable]));
  assert.equal(linkable.get(P.offContacted.journeyId), false);
  assert.equal(linkable.get(P.notLead.journeyId), false);
  assert.equal(linkable.get(P.optBack.journeyId), true);
  const js = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.match(js, /journeys\.filter\(\(journey\)=>journey\.linkable!==false\)\.forEach\(\(journey\)=>select\.append/);
});

test('fixes 1 and 7 (painel.js): ENTRADA hides triage out-of-funnel chats; CLIENTES keeps a Tratado/Descartado card', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  // ATENDIMENTO lists only conversations still waiting for a decision, never one out of the funnel.
  assert.match(js, /const entryReviewChats = \(entry\) => \(entry && entry\.chats \|\| \[\]\)\.filter\(\(chat\) => !chat\.triageOut/);
  assert.match(js, /hide=Boolean\(status\)&&!currentDetail&&currentView==='today';/);
  assert.doesNotMatch(js, /\['today','clients'\]\.includes\(currentView\)/);
});

test('fix 9: PEDIDOS report names message channels, not clicks', async () => {
  const report = await call('report', '/api/panel/report?view=orders&period=30');
  assert.doesNotMatch(report.text, /clicado/);
  assert.match(report.text, /WhatsApp \d+; SMS \d+/);
  assert.deepEqual(backend.refused, []);
});
