'use strict';

// Relatório aberto em CLIENTES: mesmo universo da lista (leads com última atividade real dentro do
// período). Data de criação ou de qualificação não conta. O relatório de QUALIFICAÇÃO continua com
// a regra antiga. Banco PGlite local, nenhuma chamada externa.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { insidePeriod } = require('../panel-origin');

const id = (n) => `6f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// name, journey created (days ago), last customer message (days ago), lead?, qualified (days ago)
const PEOPLE = [
  ['Criada antiga, conversa recente', 200, 10, true, null],
  ['Criada ontem, histórico antigo', 1, 100, true, null],
  ['Qualificada ontem, conversa parada', 300, 50, true, 1],
  ['Só histórico de 400 dias', 2, 400, true, null],
  ['Não é lead recente', 3, 5, false, null]
];
function seed() {
  const rows = [`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`];
  PEOPLE.forEach(([name, created, last, lead, qualified], index) => {
    const n = (index + 1) * 10, contact = id(n + 1), journey = id(n), chat = id(n + 2), message = id(n + 3);
    rows.push(`insert into public.contacts(id,environment,display_name,source,is_lead,created_at,updated_at) values('${contact}','preview','${name}','WHATSAPP_DIRECT',${lead},now()-interval '${created} days',now());`);
    rows.push(`insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,qualified_at,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','${qualified ? 'QUALIFICADO' : 'RESPONDIDO'}','ATIVO','{}',${qualified ? `now()-interval '${qualified} days'` : 'null'},now()-interval '${created} days',now());`);
    rows.push(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','r-${n}','RESOLVED',false,now(),now(),now(),now());`);
    rows.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','Oi','oi',now()-interval '${last} days','s${n}',1,'WHATSAPP_WEBHOOK',now());`);
    rows.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`);
  });
  return rows.join('\n');
}

let backend;
async function call(name, url) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method: 'GET', url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams) }, res);
  return res;
}
test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('relatório de CLIENTES conta o mesmo universo da lista em cada período', async () => {
  const list = (await call('records', '/api/panel/records?sort=ready')).payload.items;
  assert.equal(list.length, PEOPLE.length);
  const expected = { 30: ['Criada antiga, conversa recente'], 90: ['Criada antiga, conversa recente', 'Qualificada ontem, conversa parada'],
    '6m': ['Criada antiga, conversa recente', 'Criada ontem, histórico antigo', 'Qualificada ontem, conversa parada'], '12m': ['Criada antiga, conversa recente', 'Criada ontem, histórico antigo', 'Qualificada ontem, conversa parada'],
    all: ['Criada antiga, conversa recente', 'Criada ontem, histórico antigo', 'Qualificada ontem, conversa parada', 'Só histórico de 400 dias'] };
  for (const [activity, names] of Object.entries(expected)) {
    // The list side: exactly what the CLIENTES badge, counters and spreadsheet use.
    const listed = list.filter((item) => item.isLead !== false && insidePeriod(item, activity)).map((item) => item.contact.display_name).sort();
    assert.deepEqual(listed, [...names].sort(), 'lista ' + activity);
    const report = await call('report', `/api/panel/report?view=records&origin=clients&activity=${activity}`);
    assert.equal(report.statusCode, 200);
    assert.equal(report.payload.summary.clients, names.length, 'relatório ' + activity);
    assert.equal(report.payload.summary.qualified, names.includes('Qualificada ontem, conversa parada') ? 1 : 0);
    assert.doesNotMatch(report.payload.text, /\.$/);
  }
  // The browser's own cutoff instant is honored (same moment as the list).
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  assert.equal((await call('report', `/api/panel/report?view=records&origin=clients&activity=90&since=${since}`)).payload.summary.clients, 2);
  assert.equal((await call('report', '/api/panel/report?view=records&origin=clients&activity=15')).statusCode, 400);
});

test('QUALIFICAÇÃO e o relatório de fichas fora de CLIENTES mantêm a regra antiga', async () => {
  const qualification = await call('report', '/api/panel/report?view=qualification&period=30');
  assert.equal(qualification.statusCode, 200);
  // Old rule: created or qualified inside the range, whatever the last activity.
  assert.equal(qualification.payload.summary.qualified, 1);
  assert.ok(qualification.payload.summary.leads >= 2);
  assert.equal(qualification.payload.origin, undefined);
});
