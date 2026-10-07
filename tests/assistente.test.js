'use strict';
// Assistente do painel (api/panel/assistant.js): conversa com leitura livre do painel, ação só como
// proposta (nada executa no servidor), "Não funcionou" com regras fixas + chamado, e a OpenAI fora
// do ar nunca trava nada. OpenAI e banco simulados.
process.env.VERCEL_ENV = 'preview';
process.env.OPENAI_API_KEY = 'sk-chave-secreta-teste';
process.env.SUPABASE_SECRET_KEY = 'sb-secreta-teste';
const test = require('node:test');
const assert = require('node:assert/strict');
const assistant = require('../api/panel/assistant');

const ids = { journey: '11111111-1111-4111-8111-111111111111', contact: '22222222-2222-4222-8222-222222222222', match: '33333333-3333-4333-8333-333333333333', upload: '44444444-4444-4444-8444-444444444444' };
const ctx = { environment: 'preview', panel: { id: '55555555-5555-4555-8555-555555555555' } };
const tables = {
  contacts: [{ id: ids.contact, display_name: 'Maria Souza', is_lead: true }],
  contact_phones: [{ contact_id: ids.contact, phone_e164: '+13055550199', phone_raw: '+13055550199', is_current: true }],
  journeys: [{ id: ids.journey, contact_id: ids.contact, reference_code: 'ABCDE', status: 'ATIVO', stage: 'RESPONDIDO', budget_cents: 3000000, criteria_json: { wishlists: [{ make: 'Jeep', model: 'Wrangler' }] } }],
  calc_runs: [{ id: 1, created_at: '2026-10-01T10:00:00Z', zip: '33101', estado: 'FL', lance: 30000, total: 34000, pagamento: 'cash', idioma: 'pt', dados: { ref: 'ABCDE' } }],
  manheim_matches: [{ id: ids.match, upload_id: ids.upload, journey_id: ids.journey, demand_key: `journey:${ids.journey}:CARRO`, vehicle_json: { parsed: { year: 2022, make: 'Jeep', model: 'Wrangler', trim: 'Rubicon', vin: '1C4HJXFG0NW000123', lane: 'B', run: '7' } } }],
  vitrines: [], journey_refs: [], message_journeys: [], messages: [], manheim_option_selections: [], panel_incidents: []
};
const match = (row, params) => Object.entries(params || {}).every(([key, value]) => {
  if (['select', 'order', 'limit', 'or', 'environment'].includes(key) || value === undefined) return true;
  const actual = row[key];
  if (String(value).startsWith('eq.')) return String(actual) === String(value).slice(3);
  if (String(value).startsWith('in.(')) return String(value).slice(4, -1).split(',').includes(String(actual));
  if (String(value).startsWith('ilike.')) return new RegExp('^' + String(value).slice(6).replace(/\*/g, '.*') + '$', 'i').test(String(actual || ''));
  if (value === 'is.null') return actual === null || actual === undefined;
  return true;
});
function services(replies, extra = {}) {
  const sent = [], rpcs = [], writes = [];
  const read = async (_, table, params) => {
    if (table === 'calc_runs' && params && params['dados->>ref']) return tables.calc_runs.filter((row) => new RegExp('^' + params['dados->>ref'].slice(6) + '$', 'i').test(row.dados.ref));
    return (tables[table] || []).filter((row) => match(row, params));
  };
  return {
    sent, rpcs, writes,
    rows: read, allRows: read,
    insert: async (_, table, body) => { writes.push({ table, body }); return [{ id: 'ev', ...body }]; },
    rpc: async (_, name, args) => { rpcs.push({ name, args }); if (name === 'panel_incident_report') return { id: 'inc-1', status: 'ABERTO', count: 1, severity: args.p_severity, reopened: false }; return []; },
    latestUpload: async () => ({ id: ids.upload, uploaded_at: '2026-10-05T12:00:00Z', vehicle_count: 58138, matched_vehicle_count: 900, lead_count: 385 }),
    budget: { guard: () => ({}), paidCall: async (_, { body, send }) => send(body), recorded: async () => {} },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body); sent.push(body);
      const reply = replies.shift();
      if (!reply || reply.fail) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, json: async () => ({ usage: { prompt_tokens: 100, completion_tokens: 20 }, choices: [{ message: reply }] }) };
    },
    ...extra
  };
}
// The model answers in the same JSON format the rest of the panel already uses (no native tools).
const step = (fields) => ({ role: 'assistant', content: JSON.stringify({ tipo: 'responder', texto: '', funcao: null, acao: null, journey_id: null, match_id: null, match_ids: null, aba: null, termo: null, ...fields }) });
const toolCall = (name, args) => name === 'propor_acao'
  ? step({ tipo: 'propor', texto: args.resposta || '', acao: args.acao, journey_id: args.journey_id || null, match_id: args.match_id || null, match_ids: args.match_ids || null, aba: args.aba || null })
  : step({ tipo: 'ler', funcao: name, journey_id: args.journey_id || null, termo: args.termo || null });
const answer = (text) => step({ texto: text });

test('pergunta: lê o painel (inclusive dado da calculadora) e responde; nenhuma chave do sistema vai para a OpenAI', async () => {
  const svc = services([toolCall('buscar_cliente', { termo: 'Maria' }), toolCall('ficha', { journey_id: ids.journey }), answer('Maria (Ref ABCDE), lance $30.000, ZIP 33101.')]);
  const out = await assistant.chat(ctx, { message: 'qual o lance da Maria?', context: { view: 'today', actions: [] } }, svc);
  assert.equal(out.reply, 'Maria (Ref ABCDE), lance $30.000, ZIP 33101.');
  assert.equal(out.proposal, null);
  const all = JSON.stringify(svc.sent);
  assert.match(all, /\+13055550199/, 'telefone pode ir: a Leo liberou os dados do cliente');
  assert.match(all, /33101/, 'dado da calculadora chega');
  assert.doesNotMatch(all, /sk-chave-secreta-teste|sb-secreta-teste/, 'nunca uma chave do sistema');
  assert.ok(svc.writes.some((w) => w.table === 'panel_assistant_events' && w.body.event_type === 'PERGUNTA'));
});

test('ação vira só proposta, com linha montada dos dados reais; nada executa no servidor', async () => {
  const svc = services([toolCall('propor_acao', { acao: 'selecionar_carro', match_id: ids.match, resposta: 'Posso selecionar esse Wrangler.' })]);
  const out = await assistant.chat(ctx, { message: 'seleciona o wrangler da Maria', context: { view: 'searches', actions: [] } }, svc);
  assert.equal(out.proposal.acao, 'selecionar_carro');
  assert.equal(out.proposal.grava, true);
  assert.equal(out.proposal.linha, 'Selecionar carro · Maria Souza (Ref ABCDE) · 2022 Jeep Wrangler Rubicon · VIN final 000123');
  assert.deepEqual(out.proposal.params, { matchId: ids.match });
  assert.ok(!svc.rpcs.some((r) => /select/.test(r.name)), 'a seleção não é chamada no servidor');
  assert.ok(svc.writes.some((w) => w.table === 'panel_assistant_events' && w.body.event_type === 'PROPOSTA'));
});

test('ação desconhecida ou com dado que não existe não vira proposta', async () => {
  const svc = services([toolCall('propor_acao', { acao: 'apagar_tudo' }), answer('Não posso fazer isso.')]);
  const out = await assistant.chat(ctx, { message: 'apaga tudo', context: {} }, svc);
  assert.equal(out.proposal, null);
  const svc2 = services([toolCall('propor_acao', { acao: 'selecionar_carro', match_id: '99999999-9999-4999-8999-999999999999' }), answer('Não achei esse carro.')]);
  assert.equal((await assistant.chat(ctx, { message: 'seleciona', context: {} }, svc2)).proposal, null);
});

test('OpenAI fora do ar: resposta "assistente indisponível agora", sem erro, e o motivo fica gravado', async () => {
  const svc = services([{ fail: true }]);
  const out = await assistant.chat(ctx, { message: 'oi', context: {} }, svc);
  assert.equal(out.unavailable, true);
  assert.equal(out.reply, 'Assistente indisponível agora');
  const erro = svc.writes.find((w) => w.table === 'panel_assistant_events' && w.body.event_type === 'ERRO');
  assert.equal(erro.body.payload.status, 500);
  assert.equal(erro.body.payload.detail, 'boom');
});

test('pede a resposta no formato JSON que o painel já usa, sem ferramentas nativas da OpenAI', async () => {
  const svc = services([answer('oi')]);
  await assistant.chat(ctx, { message: 'oi', context: {} }, svc);
  assert.equal(svc.sent[0].tools, undefined);
  assert.equal(svc.sent[0].response_format.type, 'json_schema');
  assert.ok(svc.sent[0].messages.every((m) => ['system', 'user', 'assistant'].includes(m.role) && typeof m.content === 'string'));
});

test('regras fixas do "Não funcionou"', () => {
  const t = Date.parse('2026-10-05T20:00:00Z');
  const click = { kind: 'click', action: 'ficha-open', view: 'v1', at: t };
  assert.equal(assistant.rulesDiagnosis({ actions: [click] }).categoria, 'DEFEITO_TELA');
  assert.equal(assistant.rulesDiagnosis({ actions: [click, { kind: 'request', path: '/api/panel/lead', status: 502, at: t + 50 }] }).categoria, 'TECNICO');
  assert.equal(assistant.rulesDiagnosis({ actions: [click, { kind: 'request', path: '/api/panel/lead', code: 'REQUEST_TIMEOUT', at: t + 50 }] }).categoria, 'TECNICO');
  assert.equal(assistant.rulesDiagnosis({ actions: [click, { kind: 'request', path: '/api/panel/vitrines', status: 409, code: 'MANHEIM_SALE_ENDED', at: t + 50 }] }).categoria, 'RECUSADO:MANHEIM_SALE_ENDED');
  assert.equal(assistant.rulesDiagnosis({ actions: [click, { kind: 'request', path: '/api/panel/lead', status: 200, at: t + 50 }] }).categoria, 'NAO_SABEMOS');
  assert.equal(assistant.rulesDiagnosis({ actions: [click, { kind: 'request', path: '/api/panel/boot', method: 'POST', status: 200, ms: 13000, at: t + 50 }] }).categoria, 'LENTIDAO');
  assert.equal(assistant.severityOf('v1-generate'), 'P0');
  assert.equal(assistant.severityOf('ficha-open'), 'P1');
  assert.equal(assistant.severityOf('outra-coisa'), 'P2');
});

test('"Não funcionou" só diagnostica; chamado nasce uma vez após autorização', async () => {
  const svc = services([]);
  const context = { view: 'v1', version: 'v9', actions: [{ kind: 'click', action: 'ficha-open', label: 'Abrir ficha', view: 'v1', at: Date.now() }] };
  const out = await assistant.report(ctx, { context }, svc);
  assert.equal(svc.rpcs.some((r) => r.name === 'panel_incident_report'), false);
  assert.equal(out.diagnosis.categoria, 'DEFEITO_TELA');
  assert.equal(out.proposal.acao, 'registrar_chamado');
  const saved = await assistant.createIncident(ctx, { context, note: out.proposal.params.note }, svc);
  const calls = svc.rpcs.filter((r) => r.name === 'panel_incident_report');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_fingerprint, 'v1|ficha-open|DEFEITO_TELA');
  assert.match(saved.reply, /Chamado registrado/);
});


test('nova tarefa tem prioridade sobre histórico técnico anterior', () => {
  const msg = 'O que precisa conferir:\n1. Todo botão funciona\n2. Toda tela tem voltar\n3. Nenhuma ação fica sem resposta\n4. Tudo que é criado tem destino';
  assert.equal(assistant.currentIntent(msg).explicitNewTask, true);
  assert.deepEqual(assistant.relevantHistory([{ role: 'assistant', content: '/boot está lento' }], msg), []);
});

test('follow-up técnico curto preserva contexto', () => {
  const history = [{ role: 'assistant', content: '/boot está lento' }];
  assert.equal(assistant.currentIntent('identifique').technicalFollowup, true);
  assert.deepEqual(assistant.relevantHistory(history, 'identifique'), history);
});

test('guardrail rejeita resposta curta que ignora checklist', () => {
  const msg = 'Confira:\n1. botões\n2. voltar\n3. excluir\n4. listas';
  assert.equal(assistant.responseAnswersCurrent(msg, '/api/panel/boot levou 13 s'), false);
  assert.equal(assistant.responseAnswersCurrent(msg, '1. Botões: conferir\n2. Voltar: conferir\n3. Excluir: conferir\n4. Listas: conferir'), true);
});
