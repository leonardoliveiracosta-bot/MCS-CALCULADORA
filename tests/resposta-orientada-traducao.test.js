'use strict';

// Ficha › CONVERSA: resposta orientada pelo operador e tradução da conversa. Dados fictícios contra o
// banco PGlite; a IA real nunca é chamada (OpenAI falsa e reserva do teto simulada); nada é enviado.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const fixture = require('./fixtures/conversas-sugestao');
const suggest = require('../panel-reply-suggest');
const guided = require('../panel-reply-guided');
const budget = require('../panel-openai-budget');

let backend, ctx;
const q = async (sql) => (await backend.db.query(sql)).rows;
const count = async (sql) => Number((await q(sql))[0].n);
const sends = async () => ({
  messages: await count('select count(*) n from public.messages'),
  raw: await count('select count(*) n from public.whatsapp_raw_events'),
  v1: await count('select count(*) n from public.v1_sends')
});
const AI_ENV = { VERCEL_ENV: 'production', REPLY_SUGGESTION_ENABLED: '1', OPENAI_API_KEY: 'chave-falsa', ENTRADA_OPENAI_MODEL: 'gpt-6-luna' };
const holds = [];
const budgetServices = { rpc: async (name, args) => { holds.push([name, args]); return name === 'panel_openai_budget_hold' ? { held: true, id: '6d200000-0000-4000-8000-0000000000ab' } : { settled: true }; } };
function fakeOpenAi(answer, calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return { ok: true, json: async () => ({ usage: { prompt_tokens: 800, completion_tokens: 150 }, choices: [{ message: { content: JSON.stringify(typeof answer === 'function' ? answer(body) : answer) } }] }) };
  };
}
const messagesOf = async (journeyId) => q(`select m.id, m.body_text, m.direction from public.messages m join public.message_journeys mj on mj.message_id = m.id where mj.journey_id = '${journeyId}' order by m.occurred_at_utc`);

test.before(async () => {
  backend = await createBackend({ seed: fixture.seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['D360_API_KEY', 'V1_DIRECT_SEND_ENABLED', 'OPENAI_API_KEY', 'REPLY_SUGGESTION_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: fixture.ACTOR, role: 'admin' } };
});
test.after(async () => { if (backend) await backend.db.close(); });

// ------------------------------------------------------------------ resposta orientada
test('orientação vazia: aviso, nenhuma chamada e nenhum custo', async () => {
  let called = 0;
  for (const guidance of ['', '   ', undefined]) {
    const out = await guided.guided(ctx, { journeyId: fixture.people.english.journey, guidance }, { env: AI_ENV, fetchImpl: async () => { called += 1; throw new Error('não deveria chamar'); }, modelCheck: async () => ({ ok: true }), budgetServices });
    assert.equal(out.status, 400);
    assert.equal(out.error, 'GUIDANCE_REQUIRED');
  }
  assert.equal(called, 0);
  assert.equal(holds.length, 0, 'nada reservado no teto');
});

test('orientação com pontos: resposta natural no idioma do cliente + tradução PT, teto RESPOSTA_ORIENTADA, custo registrado, nada enviado', async () => {
  const calls = [];
  const before = await sends();
  const guidance = 'o CR-V 2019 que ele quer aparece bastante; com 22 mil dá para competir; perguntar se pode decidir esta semana';
  const out = await guided.guided(ctx, { journeyId: fixture.people.english.journey, guidance }, {
    env: AI_ENV, modelCheck: async () => ({ ok: true }), budgetServices,
    fetchImpl: fakeOpenAi({ idioma_cliente: 'en', resposta: 'Hi Ethan, 2019 CR-Vs come up often at auction, and around 22k puts you in a good spot. Could you decide this week if the right one shows up?', traducao_resposta_pt: 'Oi Ethan, CR-Vs 2019 aparecem bastante no leilão e por volta de 22 mil você fica bem posicionado. Você consegue decidir esta semana se aparecer o carro certo?', conflitos: [], fatos_usados: [{ fato: 'CR-V 2019', situacao: 'CONFIRMADO' }], alertas: [] }, calls)
  });
  assert.equal(out.status, 200, JSON.stringify(out));
  assert.equal(out.mode, 'ORIENTADA');
  assert.equal(out.simulated, false);
  assert.equal(out.language.code, 'en');
  assert.match(out.suggestion.text, /^Hi Ethan/);
  assert.notEqual(out.suggestion.text, guidance, 'não repete a orientação');
  assert.match(out.suggestion.translationPt, /^Oi Ethan/);
  assert.equal(out.whatsappBase, 'https://wa.me/13055550111', 'abrir no WhatsApp só prepara o texto');
  // What the AI received: the guidance, the whole conversation, the ficha and the Brief.
  assert.equal(calls.length, 1);
  const input = JSON.parse(calls[0].messages[1].content);
  assert.equal(input.orientacao, guidance);
  assert.ok(input.conversa.some((message) => message.texto === 'Mileage under 60k please'));
  assert.match(calls[0].messages[0].content, /MODO ORIENTADO/);
  assert.match(calls[0].messages[0].content, /MESA/, 'o Brief Mestre (regras da sugestão) vai junto');
  assert.equal(calls[0].max_completion_tokens, budget.OUTPUT_CAP.RESPOSTA_ORIENTADA);
  const hold = holds.find(([name, args]) => name === 'panel_openai_budget_hold' && args.p_feature === 'RESPOSTA_ORIENTADA');
  assert.ok(hold, 'reserva no teto de US$ 50 com a função própria');
  const logged = await q("select after_json from public.audit_log where entity_type = 'reply_guided_openai'");
  assert.equal(logged.length, 1);
  assert.ok(logged[0].after_json.costUsd > 0);
  const spent = await budget.spentUsd(ctx);
  assert.ok(spent.byFeature.respostaOrientada > 0, 'o custo entra no teto compartilhado, separado da sugestão');
  assert.deepEqual(await sends(), before, 'gerar não envia nem grava mensagem');
  assert.deepEqual(backend.refused, []);
});

test('orientação que conflita com a ficha e com a conversa: mostra o dado conflitante, sem escolher em silêncio', async () => {
  // Panel check (numbers against the ficha): year outside the ficha's years, bid different from the ficha's bid.
  const fields = [{ key: 'anos', label: 'Anos', value: '2018 a 2020' }, { key: 'valor', label: 'Lance máximo', value: 'US$ 15,000' }, { key: 'milhas', label: 'Milhagem', value: 'até 60,000 milhas' }];
  const found = guided.conflictsOf('mandar o 2022; o lance dele é US$ 18,000; tem um com 90k milhas', fields);
  assert.deepEqual(found.map((item) => item.recorded), ['Anos: 2018 a 2020', 'Milhagem: até 60,000 milhas', 'Lance máximo: US$ 15,000']);
  assert.deepEqual(guided.conflictsOf('mandar o 2019; o lance dele é US$ 15,000', fields), [], 'o que bate com a ficha não é conflito');
  // AI check (against the conversation): shown as it came, with the source.
  const calls = [];
  const out = await guided.guided(ctx, { journeyId: fixture.people.english.journey, guidance: 'dizer que ele pediu até 100k milhas' }, {
    env: AI_ENV, modelCheck: async () => ({ ok: true }), budgetServices,
    fetchImpl: fakeOpenAi({ idioma_cliente: 'en', resposta: 'Hi Ethan, quick check on mileage so we search the right range.', traducao_resposta_pt: 'Oi Ethan, uma confirmação sobre a milhagem para buscarmos na faixa certa.', conflitos: [{ ponto: 'até 100k milhas', dado_registrado: 'Cliente pediu: "Mileage under 60k please"', fonte: 'conversa' }], fatos_usados: [], alertas: [] }, calls)
  });
  assert.equal(out.status, 200, JSON.stringify(out));
  assert.deepEqual(out.conflicts, [{ point: 'até 100k milhas', recorded: 'Cliente pediu: "Mileage under 60k please"', source: 'conversa' }]);
  assert.doesNotMatch(out.suggestion.text, /100k|100,000/, 'nenhum dos valores conflitantes vai na resposta');
  assert.match(calls[0].messages[0].content, /NÃO escolha em silêncio/);
});

test('fora de produção: resposta orientada simulada, sem IA, sem custo e nada enviado', async () => {
  const before = await sends();
  const out = await guided.guided(ctx, { journeyId: fixture.people.spanish.journey, guidance: 'avisar que o Corolla 2018 com 15 mil ainda é possível' }, {});
  assert.equal(out.status, 200, JSON.stringify(out));
  assert.equal(out.simulated, true);
  assert.equal(out.costUsd, 0);
  assert.equal(out.language.code, 'es');
  assert.ok(out.suggestion.translationPt);
  assert.deepEqual(await sends(), before);
});

test('pediu para não ser contatado: sem resposta orientada e sem chamada', async () => {
  let called = 0;
  const out = await guided.guided(ctx, { journeyId: fixture.people.optOut.journey, guidance: 'retomar a Tacoma' }, { env: AI_ENV, fetchImpl: async () => { called += 1; }, modelCheck: async () => ({ ok: true }), budgetServices });
  assert.equal(out.status, 409);
  assert.equal(out.reason.code, 'OPT_OUT');
  assert.equal(called, 0);
});

// ------------------------------------------------------------------ tradução da conversa
test('tradução EN→PT e ES→PT na conversa, guardada por mensagem; reabrir não chama de novo; PT não traduz; originais intactos', async () => {
  const originals = { es: await messagesOf(fixture.people.spanish.journey), en: await messagesOf(fixture.people.english.journey), pt: await messagesOf(fixture.people.answered.journey) };
  const before = await sends();
  const calls = [];
  const services = { env: AI_ENV, modelCheck: async () => ({ ok: true }), budgetServices,
    fetchImpl: fakeOpenAi((body) => ({ traducoes: JSON.parse(body.messages[1].content).mensagens.map((item) => ({ id: item.id, idioma: /hola|busco|quieres/i.test(item.texto) ? 'es' : 'en', texto_pt: 'PT: ' + item.texto })) }), calls) };
  // Opening the conversation: saved translations only, no call.
  const opened = await guided.translations(ctx, { journeyId: fixture.people.spanish.journey }, services);
  assert.equal(opened.status, 200);
  assert.deepEqual(opened.translations, {});
  assert.deepEqual(opened.translatable.sort(), originals.es.map((message) => message.id).sort(), 'as duas mensagens em espanhol podem ser traduzidas');
  assert.equal(calls.length, 0, 'abrir a conversa não traduz sozinho');
  // "Traduzir conversa": one call for the visible messages.
  const es = await guided.translate(ctx, { journeyId: fixture.people.spanish.journey, messageIds: originals.es.map((message) => message.id) }, services);
  assert.equal(es.status, 200, JSON.stringify(es));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].max_completion_tokens, budget.OUTPUT_CAP.TRADUCAO_CONVERSA);
  originals.es.forEach((message) => assert.equal(es.translations[message.id].textPt, 'PT: ' + message.body_text));
  assert.ok(holds.some(([name, args]) => name === 'panel_openai_budget_hold' && args.p_feature === 'TRADUCAO_CONVERSA'), 'reserva no teto com a função própria');
  // Reopening: the same translations, no new call.
  const reopened = await guided.translations(ctx, { journeyId: fixture.people.spanish.journey }, services);
  assert.deepEqual(Object.keys(reopened.translations).sort(), originals.es.map((message) => message.id).sort());
  assert.deepEqual(reopened.translatable, []);
  const again = await guided.translate(ctx, { journeyId: fixture.people.spanish.journey, messageIds: originals.es.map((message) => message.id) }, services);
  assert.equal(again.translated, 0);
  assert.equal(calls.length, 1, 'cache: nenhuma chamada nova');
  // English: only the customer messages and the English MCS message; the call carries only them.
  const en = await guided.translate(ctx, { journeyId: fixture.people.english.journey, messageIds: originals.en.map((message) => message.id) }, services);
  assert.equal(calls.length, 2);
  assert.ok(Object.values(en.translations).every((item) => item.textPt.startsWith('PT: ')));
  // Portuguese conversation: nothing to translate, no call.
  const pt = await guided.translate(ctx, { journeyId: fixture.people.answered.journey, messageIds: originals.pt.map((message) => message.id) }, services);
  assert.equal(pt.translated, 0);
  assert.deepEqual(pt.translations, {});
  assert.equal(calls.length, 2);
  // Another ficha's message id is never translated through this ficha.
  const other = await guided.translate(ctx, { journeyId: fixture.people.answered.journey, messageIds: [originals.es[0].id] }, services);
  assert.deepEqual(other.translations, {});
  assert.equal(calls.length, 2);
  // Cost recorded apart in the same ceiling.
  const spent = await budget.spentUsd(ctx);
  assert.ok(spent.byFeature.traducao > 0);
  // The originals never change; nothing is sent.
  assert.deepEqual(await messagesOf(fixture.people.spanish.journey), originals.es);
  assert.deepEqual(await messagesOf(fixture.people.english.journey), originals.en);
  assert.deepEqual(await sends(), before);
  // A message whose text changes can be translated again (a new or edited message gets its own link).
  await q(`update public.messages set body_text = 'Hola, busco un Corolla 2019 ahora' where id = '${originals.es[0].id}'`);
  const changed = await guided.translations(ctx, { journeyId: fixture.people.spanish.journey }, services);
  assert.ok(!changed.translations[originals.es[0].id], 'a tradução antiga não vale para o texto novo');
  assert.ok(changed.translatable.includes(originals.es[0].id));
  const retranslated = await guided.translate(ctx, { journeyId: fixture.people.spanish.journey, messageIds: [originals.es[0].id] }, services);
  assert.equal(retranslated.translations[originals.es[0].id].textPt, 'PT: Hola, busco un Corolla 2019 ahora');
  assert.equal(calls.length, 3);
  await q(`update public.messages set body_text = ${"'" + originals.es[0].body_text.replaceAll("'", "''") + "'"} where id = '${originals.es[0].id}'`);
});

// ------------------------------------------------------------------ a sugestão automática continua igual
test('a sugestão automática continua igual (mesma resposta e mesmos campos, sem os da resposta orientada)', async () => {
  const out = await suggest.suggest(ctx, { journeyId: fixture.people.english.journey });
  assert.equal(out.status, 200);
  assert.deepEqual(Object.keys(out).sort(), ['contact', 'costUsd', 'facts', 'journeyId', 'language', 'last', 'mode', 'model', 'notice', 'path', 'reachable', 'received', 'simulated', 'status', 'suggestion', 'warnings', 'whatsappBase'].sort());
  assert.equal(out.mode, 'RESPOSTA');
  assert.equal(out.received.text, 'Mileage under 60k please');
  assert.ok(!('conflicts' in out) && !('guidance' in out));
});
