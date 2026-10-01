'use strict';

// Sugestões de resposta, fila de conversas antigas e travas do V1, com dados fictícios contra o
// banco PGlite. Nada é enviado: nenhum 360dialog, nenhuma mensagem gravada, nenhuma V1 criada.
// A IA real nunca é chamada: fora de produção a sugestão é simulada; o modo IA é testado com uma
// OpenAI falsa e a reserva do teto de US$ 50 simulada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const fixture = require('./fixtures/conversas-sugestao');
const suggest = require('../panel-reply-suggest');
const budget = require('../panel-openai-budget');
const v1Send = require('../api/panel/v1-send');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let backend, ctx;
const count = async (sql) => Number((await backend.db.query(sql)).rows[0].n);
async function call(method, url, body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/suggestions')({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const sends = async () => ({
  messages: await count("select count(*) n from public.messages where source_kind='PANEL' or direction='MCS' and created_at > now() - interval '1 minute'"),
  raw: await count("select count(*) n from public.whatsapp_raw_events"),
  v1: await count('select count(*) n from public.v1_sends')
});

test.before(async () => {
  backend = await createBackend({ seed: fixture.seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['D360_API_KEY', 'V1_DIRECT_SEND_ENABLED', 'OPENAI_API_KEY', 'REPLY_SUGGESTION_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: fixture.ACTOR, role: 'admin' } };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('idioma, opt-out e revisão do texto', () => {
  assert.equal(suggest.detectLanguage("Hi, I'm looking for a Honda CR-V, budget 22k"), 'en');
  assert.equal(suggest.detectLanguage('Hola, busco un Corolla, presupuesto 15 mil por favor'), 'es');
  assert.equal(suggest.detectLanguage('Oi, quero um carro para o meu filho'), 'pt');
  const opt = (text) => Boolean(suggest.optOutOf([{ direction: 'CUSTOMER', body_text: text, occurred_at_utc: '2026-09-01T00:00:00Z' }]));
  for (const text of ['STOP', "Please don't text me again", 'não me mande mais mensagens', 'No me escribas más', 'unsubscribe']) assert.equal(opt(text), true, text);
  for (const text of ["I'll stop by tomorrow", 'Can you stop at 20k?', 'Quero parar de pagar aluguel']) assert.equal(opt(text), false, text);
  const reviewed = suggest.review('Absolutely — this one is really clean. Does that make sense? We will find one next week.');
  assert.doesNotMatch(reviewed.text, /[—–]/);
  assert.equal(reviewed.warnings.length, 4);
  const open = suggest.pathFor({ allowed: true, openUntil: '2026-10-01T12:00:00.000Z' });
  const closed = suggest.pathFor({ allowed: false });
  assert.equal(open.api, 'ALLOWED');
  assert.equal(closed.api, 'BLOCKED');
  assert.match(closed.text, /modelo aprovado/);
  assert.match(closed.manual, /você mesmo escreve e envia/);
});

test('inglês recente: tradução, resposta no idioma do cliente, janela aberta, fatos e nada enviado', async () => {
  const before = await sends();
  const res = await call('POST', '/api/panel/suggestions', { action: 'suggest', journeyId: fixture.people.english.journey });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const out = res.payload;
  assert.equal(out.simulated, true, 'fora de produção: simulada, sem IA e sem custo');
  assert.equal(out.costUsd, 0);
  assert.equal(out.mode, 'RESPOSTA');
  assert.equal(out.language.code, 'en');
  assert.equal(out.received.text, 'Mileage under 60k please');
  assert.ok(out.received.translationPt);
  assert.ok(out.suggestion.translationPt);
  assert.equal(out.path.open, true);
  assert.equal(out.reachable, true);
  assert.equal(out.whatsappBase, 'https://wa.me/13055550111');
  assert.ok(out.facts.length);
  assert.deepEqual(await sends(), before, 'gerar sugestão não envia nem grava mensagem');
  assert.deepEqual(backend.refused, []);
});

test('espanhol antigo: retomada, janela encerrada, API bloqueada e caminho manual explicado', async () => {
  const res = await call('POST', '/api/panel/suggestions', { action: 'suggest', journeyId: fixture.people.spanish.journey });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.mode, 'RETOMADA');
  assert.equal(res.payload.language.code, 'es');
  assert.equal(res.payload.path.open, false);
  assert.equal(res.payload.path.api, 'BLOCKED');
  assert.match(res.payload.suggestion.text, /^Hola/);
});

test('opt-out e número inválido: sem sugestão ou só copiar, sempre com o motivo', async () => {
  const opt = await call('POST', '/api/panel/suggestions', { action: 'suggest', journeyId: fixture.people.optOut.journey });
  assert.equal(opt.statusCode, 409);
  assert.equal(opt.payload.error, 'SUGGESTION_BLOCKED');
  assert.equal(opt.payload.reason.code, 'OPT_OUT');
  const invalid = await call('POST', '/api/panel/suggestions', { action: 'suggest', journeyId: fixture.people.invalid.journey });
  assert.equal(invalid.statusCode, 200);
  assert.equal(invalid.payload.reachable, false);
  assert.equal(invalid.payload.whatsappBase, null);
  const notLead = await call('POST', '/api/panel/suggestions', { action: 'suggest', journeyId: fixture.people.notLead.journey, mode: 'RETOMADA' });
  assert.equal(notLead.statusCode, 409);
  assert.equal(notLead.payload.reason.code, 'NOT_LEAD');
});

test('clique duplo: a segunda sugestão da mesma conversa espera a primeira', async () => {
  const [a, b] = await Promise.all([
    call('POST', '/api/panel/suggestions', { action: 'suggest', journeyId: fixture.people.answered.journey }),
    call('POST', '/api/panel/suggestions', { action: 'suggest', journeyId: fixture.people.answered.journey })
  ]);
  assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
});

test('fila de conversas antigas: das mais antigas, exclusões com motivo, recente fora', async () => {
  const res = await call('GET', '/api/panel/suggestions?minDays=14');
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const names = res.payload.eligible.map((item) => item.name);
  assert.deepEqual(names, ['Sofía Ejemplo', 'Paulo Exemplo'], 'só as elegíveis, a mais antiga primeiro');
  assert.ok(res.payload.eligible.every((item) => item.windowOpen === false));
  const reasons = Object.fromEntries(res.payload.excluded.map((item) => [item.name, item.reason.code]));
  assert.deepEqual(reasons, { 'Nina Naolead': 'NOT_LEAD', 'Ivan Invalido': 'INVALID_NUMBER', 'Olivia Optout': 'OPT_OUT' });
  assert.ok(!names.includes('Rita Recente') && !reasons['Rita Recente'], 'conversa recente não entra');
});

test('modo IA: pergunta já respondida vai no histórico, reserva RESPOSTA no teto de US$ 50, custo gravado, nada enviado', async () => {
  const calls = [], rpc = [];
  const env = { VERCEL_ENV: 'production', REPLY_SUGGESTION_ENABLED: '1', OPENAI_API_KEY: 'chave-falsa', ENTRADA_OPENAI_MODEL: 'gpt-6-luna' };
  const fakeOpenAi = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ usage: { prompt_tokens: 900, completion_tokens: 120 }, choices: [{ message: { content: JSON.stringify({
      idioma_cliente: 'pt', traducao_recebida_pt: '', resposta: 'Paulo, com 2019 ou mais novo o Civic fica na faixa — vale olhar o mercado antes. Absolutely.', traducao_resposta_pt: '',
      fatos_usados: [{ fato: 'Civic 2019 ou mais novo', situacao: 'CONFIRMADO' }, { fato: 'Orçamento', situacao: 'DESCONHECIDO' }], pergunta_finalidade: '', alertas: [] }) } }] }) };
  };
  const before = await sends();
  const out = await suggest.suggest(ctx, { journeyId: fixture.people.answered.journey }, {
    env, fetchImpl: fakeOpenAi, modelCheck: async () => ({ ok: true }),
    budgetServices: { rpc: async (name, args) => { rpc.push([name, args]); return name === 'panel_openai_budget_hold' ? { held: true, id: '6d200000-0000-4000-8000-0000000000aa' } : { settled: true }; } }
  });
  assert.equal(out.status, 200, JSON.stringify(out));
  assert.equal(out.simulated, false);
  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.model, 'gpt-6-luna');
  assert.equal(sent.max_completion_tokens, budget.OUTPUT_CAP.RESPOSTA, 'saída limitada pelo teto');
  const input = JSON.parse(sent.messages[1].content);
  assert.ok(input.conversa.some((message) => message.texto === '2019 ou mais novo'), 'a resposta já dada vai para a IA');
  assert.match(sent.messages[0].content, /Não repita perguntas já respondidas/);
  assert.match(sent.messages[0].content, /no máximo UMA pergunta/);
  const hold = rpc.find(([name]) => name === 'panel_openai_budget_hold');
  assert.equal(hold[1].p_feature, 'RESPOSTA');
  assert.deepEqual(rpc.map(([name, args]) => name === 'panel_openai_budget_settle' ? args.p_status : name), ['panel_openai_budget_hold', 'PAGA', 'REGISTRADA']);
  const logged = (await backend.db.query("select after_json from public.audit_log where entity_type='reply_suggestion_openai'")).rows;
  assert.equal(logged.length, 1);
  assert.ok(logged[0].after_json.costUsd > 0);
  assert.doesNotMatch(out.suggestion.text, /[—–]/, 'travessão removido');
  assert.ok(out.warnings.some((item) => /Absolutely/.test(item)), 'frase proibida avisada');
  assert.deepEqual(out.facts.map((fact) => fact.status), ['CONFIRMADO', 'DESCONHECIDO']);
  assert.deepEqual(await sends(), before, 'nenhuma mensagem enviada ou gravada');
  const spent = await budget.spentUsd(ctx);
  assert.ok(spent.byFeature.resposta > 0, 'o custo entra no teto compartilhado');
});

test('teto da OpenAI esgotado: nada é chamado e o motivo aparece', async () => {
  let called = 0;
  const out = await suggest.suggest(ctx, { journeyId: fixture.people.answered.journey }, {
    env: { VERCEL_ENV: 'production', REPLY_SUGGESTION_ENABLED: '1', OPENAI_API_KEY: 'chave-falsa', ENTRADA_OPENAI_MODEL: 'gpt-6-luna' },
    fetchImpl: async () => { called += 1; throw new Error('não deveria chamar'); }, modelCheck: async () => ({ ok: true }),
    budgetServices: { rpc: async () => ({ held: false, reason: 'OPENAI_LIMIT', remaining: 0 }) }
  });
  assert.equal(out.status, 402);
  assert.equal(out.error, 'OPENAI_BUDGET_LIMIT');
  assert.equal(called, 0);
});

test('sugestões nunca enviam: nenhum caminho até o 360dialog nem a V1', () => {
  for (const file of ['panel-reply-suggest.js', 'api/panel/suggestions.js', 'painel/sugestoes.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /d360Send|waba-v2\.360dialog|\/api\/panel\/v1-send|recordSent|applyMessage|action: ?'send'/, file);
  }
  // From the reply module only the read-only lookups are used (destination and 24 h window).
  const used = [...new Set(read('panel-reply-suggest.js').match(/reply\.[a-zA-Z]+/g))].sort();
  assert.deepEqual(used, ['reply.resolveTarget', 'reply.windowState']);
  // No cron or AI routine reaches the V1 send or the suggestions.
  const cronFiles = fs.readdirSync(path.join(root, 'api/panel')).filter((name) => /cron/.test(name)).map((name) => 'api/panel/' + name);
  for (const file of cronFiles) assert.doesNotMatch(read(file), /v1-send|panel-reply-suggest|\/suggestions'|api\/panel\/suggestions/, file);
});

test('V1: só pessoa no painel, uma por pedido, e o envio direto segue desligado sem a flag', async () => {
  assert.equal(v1Send.fromAutomation({ headers: { 'x-vercel-cron': '1' } }), true);
  assert.equal(v1Send.fromAutomation({ headers: { 'user-agent': 'vercel-cron/1.0' } }), true);
  assert.equal(v1Send.fromAutomation({ headers: { 'user-agent': 'Mozilla/5.0 (iPhone)' } }), false);
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await v1Send({ method: 'POST', headers: { 'x-vercel-cron': '1', authorization: 'Bearer token-simulado' }, body: { action: 'send' } }, res);
  assert.deepEqual([res.statusCode, res.payload.error], [403, 'V1_SEND_HUMAN_ONLY']);
  const batch = await v1Send.handle(ctx, { action: 'send', token: ['a', 'b'], text: 'x', requestKey: '6d200000-0000-4000-8000-0000000000bb', confirmed: true });
  assert.deepEqual([batch.status, batch.error], [400, 'V1_BATCH_NOT_ALLOWED']);
  assert.equal(v1Send.sendMode({ VERCEL_ENV: 'production' }), 'OFF');
  assert.equal(v1Send.sendMode({ VERCEL_ENV: 'production', V1_DIRECT_SEND_ENABLED: '1' }), 'LIVE');
  assert.equal(v1Send.sendMode({ VERCEL_ENV: 'preview', V1_DIRECT_SEND_ENABLED: '1' }), 'SIMULATED', 'Preview nunca envia de verdade');
  // The approved messages of the calculator and Find One stay exactly the same.
  assert.equal(v1Send.TEMPLATES.VALOR('Ana', 'L'), 'Hi Ana,\n\nI put together a first look at what the current auction market supports within the range we are working with\n\nYou can view it here: L\n\nThis is a practical reference point for what is realistic right now\n\nIf an option makes sense, we can review the details before deciding whether to pursue it');
  assert.equal(v1Send.TEMPLATES.CARRO('Ana', 'L'), 'Hi Ana,\n\nI reviewed the current auction listings against the vehicle details you provided and pulled together the options that match\n\nYou can view them here: L\n\nThis reflects what is available right now\n\nThe next step is to review each vehicle individually before any decision is made');
});

test('V1 em produção: um envio real por vez por pessoa, outra V1 em segundos é recusada', async () => {
  const now = Date.now();
  const rowsSeen = [];
  const services = {
    rows: async (_ctx, table, params) => {
      rowsSeen.push([table, params]);
      if (table === 'vitrines') return [{ id: 'v2', token: params.token.slice(3), journey_id: fixture.people.english.journey, version: 'V1' }];
      if (table === 'v1_sends' && params.created_by) return [{ id: 'old', vitrine_id: 'v1', created_at: new Date(now - 2000).toISOString() }];
      return [];
    },
    insert: async () => { throw new Error('não deveria gravar'); }, patchRows: async () => [], d360Send: async () => { throw new Error('não deveria enviar'); }
  };
  const out = await v1Send.handle(ctx, { action: 'send', token: 'tok' + 'x'.repeat(40), text: 'Hi /v/' + 'tok' + 'x'.repeat(40), requestKey: '6d200000-0000-4000-8000-0000000000cc', confirmed: true }, services, { VERCEL_ENV: 'production', V1_DIRECT_SEND_ENABLED: '1' }, now);
  assert.deepEqual([out.status, out.error], [429, 'V1_SEND_TOO_FAST']);
  const gapQuery = rowsSeen.find(([table, params]) => table === 'v1_sends' && params.created_by);
  assert.equal(gapQuery[1].simulated, 'is.false');
});
