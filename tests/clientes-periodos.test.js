'use strict';

// CLIENTES por período (30 dias, 90 dias, 6 meses, 1 ano, Tudo). O período corta a lista pela
// última atividade real da ficha; a ficha aberta mostra toda a conversa e nada no banco muda.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = require('../panel-origin');
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const NOW = Date.parse('2026-09-29T12:00:00Z');
const ago = (days) => ({ lastActivityAt: new Date(NOW - days * 86400000).toISOString() });
const inside = (days, period) => origin.matchesClientFilters(ago(days), { days: period }, NOW);

test('1 · CLIENTES abre sempre em 30 dias e o período não é restaurado de sessões antigas', () => {
  const html = read('painel/index.html'), js = read('painel/painel.js');
  assert.match(html, /<label>Período<select id="clients-activity"><option value="30" selected>30 dias<\/option><option value="90">90 dias<\/option><option value="6m">6 meses<\/option><option value="12m">1 ano<\/option><option value="all">Tudo<\/option><\/select><\/label>/);
  assert.match(js, /\$\('clients-activity'\)\.value='30';localStorage\.removeItem\('mcs_clients-activity'\)/);
  assert.doesNotMatch(js, /\['clients-situation','clients-checklist','clients-ref','clients-heat','clients-origin','clients-type','clients-activity'\]/);
});

test('2 a 5 · períodos cumulativos: 31 dias fica fora de 30 e entra em 90; mais de 90 em 6 meses; mais de 6 meses em 1 ano; mais de 1 ano só em Tudo', () => {
  assert.deepEqual(['30', '90', '6m', '12m', 'all'].map((period) => inside(29, period)), [true, true, true, true, true]);
  assert.deepEqual(['30', '90', '6m', '12m', 'all'].map((period) => inside(31, period)), [false, true, true, true, true]);
  assert.deepEqual(['30', '90', '6m', '12m', 'all'].map((period) => inside(120, period)), [false, false, true, true, true]);
  assert.deepEqual(['30', '90', '6m', '12m', 'all'].map((period) => inside(200, period)), [false, false, false, true, true]);
  assert.deepEqual(['30', '90', '6m', '12m', 'all'].map((period) => inside(500, period)), [false, false, false, false, true]);
  // Calendar months, not a fixed number of days.
  assert.equal(new Date(origin.periodCutoff('6m', NOW)).toISOString().slice(0, 10), '2026-03-29');
  assert.equal(new Date(origin.periodCutoff('12m', NOW)).toISOString().slice(0, 10), '2025-09-29');
  assert.equal(origin.periodCutoff('all', NOW), null);
  // A ficha without any real activity only appears in Tudo.
  assert.equal(origin.matchesClientFilters({ lastActivityAt: null }, { days: '12m' }, NOW), false);
  assert.equal(origin.matchesClientFilters({ lastActivityAt: null }, { days: 'all' }, NOW), true);
});

test('8 · período combinado com Origem e Tipo', () => {
  const item = { ...ago(40), origins: ['CALCULADORA'], calculatorTypes: ['BUSCA'] };
  assert.equal(origin.matchesClientFilters(item, { days: '90', origin: 'CALCULADORA', type: 'BUSCA' }, NOW), true);
  assert.equal(origin.matchesClientFilters(item, { days: '30', origin: 'CALCULADORA', type: 'BUSCA' }, NOW), false);
  assert.equal(origin.matchesClientFilters(item, { days: '90', origin: 'SMS', type: 'BUSCA' }, NOW), false);
});

test('atividade real: mensagens do cliente ou da MCS e eventos da calculadora; automática, desfeita e leitura de IA não contam', () => {
  const at = (days) => new Date(NOW - days * 86400000).toISOString();
  const { lastRealMessageAt } = require('../panel-sort');
  const last = lastRealMessageAt([
    { direction: 'CUSTOMER', occurred_at_utc: at(40) },
    { direction: 'MCS', occurred_at_utc: at(35) },
    { direction: 'MCS', occurred_at_utc: at(1), is_automatic: true },
    { direction: 'CUSTOMER', occurred_at_utc: at(2), undone_at: at(1) },
    { direction: 'CUSTOMER', created_at: at(0) }
  ]);
  assert.equal(last, at(35));
  const info = origin.clientOrigin({ source: 'WHATSAPP_DIRECT', updated_at: at(0) }, [{ occurredAt: at(20), logicalMode: 'VALOR' }], last);
  assert.equal(info.lastActivityAt, at(20));
  // updated_at of the ficha (internal processing, AI reading, cache) is never used.
  assert.equal(origin.clientOrigin({ source: 'WHATSAPP_DIRECT', updated_at: at(0) }, [], null).lastActivityAt, null);
});

// ------------------------------------------------------------------ servidor: ficha completa
const ACTOR = '6a000000-0000-4000-8000-000000000001';
const id = (n) => `6a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = `
insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);
insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(11)}','preview','Cliente Antigo','WHATSAPP_DIRECT',now()-interval '500 days',now());
insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(10)}','preview','${id(11)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now()-interval '500 days',now());
insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${id(11)}','antigo','RESOLVED',false,now()-interval '500 days',now(),now(),now());
insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values
  ('${id(21)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Mensagem de 480 dias','mensagem 480',now()-interval '480 days','a1',1,'IMPORT',now()),
  ('${id(22)}','preview','${id(12)}','WHATSAPP','MCS','Resposta de 479 dias','resposta 479',now()-interval '479 days','a2',1,'IMPORT',now()),
  ('${id(23)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Voltei a procurar','voltei',now()-interval '400 days','a3',1,'IMPORT',now());
insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values
  ('preview','${id(21)}','${id(10)}','IMPORT',now()),('preview','${id(22)}','${id(10)}','IMPORT',now()),('preview','${id(23)}','${id(10)}','IMPORT',now());
`;

async function call(handler, url) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await handler({ method: 'GET', url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams) }, res);
  return res;
}

test('6 e 9 · ficha com mais de 1 ano: fora de 1 ano, dentro de Tudo, conversa inteira ao abrir e nenhuma mensagem alterada', async () => {
  const backend = await createBackend({ seed });
  const previousFetch = globalThis.fetch;
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  globalThis.fetch = backend.fetch;
  try {
    const before = (await backend.db.query("select md5(string_agg(id::text||body_text||coalesce(occurred_at_utc::text,'')||coalesce(undone_at::text,''), ',' order by id)) h, count(*) n from public.messages")).rows[0];
    const records = require('../api/panel/records');
    const list = await call(records, '/api/panel/records?sort=ready');
    assert.equal(list.statusCode, 200);
    const item = list.payload.items.find((entry) => entry.id === id(10));
    assert.ok(item, 'a ficha antiga continua listada pelo servidor');
    const now = Date.now();
    assert.equal(origin.matchesClientFilters(item, { days: '12m' }, now), false);
    assert.equal(origin.matchesClientFilters(item, { days: 'all' }, now), true);
    const detail = await call(records, `/api/panel/records?id=${id(10)}`);
    assert.equal(detail.statusCode, 200);
    assert.deepEqual(detail.payload.item.conversation.map((message) => message.body_text), ['Mensagem de 480 dias', 'Resposta de 479 dias', 'Voltei a procurar']);
    const after = (await backend.db.query("select md5(string_agg(id::text||body_text||coalesce(occurred_at_utc::text,'')||coalesce(undone_at::text,''), ',' order by id)) h, count(*) n from public.messages")).rows[0];
    assert.deepEqual(after, before);
    assert.deepEqual(backend.refused, []);
  } finally {
    globalThis.fetch = previousFetch;
    await backend.db.close();
  }
});
