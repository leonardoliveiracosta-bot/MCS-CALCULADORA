'use strict';

// Triagem da ENTRADA com OpenAI (testes 10 a 25 do comando). Tudo local: banco PGlite com todas as
// migrações e respostas simuladas da OpenAI. Nenhuma chamada externa real, nenhuma mensagem enviada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The server environment is read when panel-server loads: set it before any require.
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const triage = require('../panel-triage');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const id = (n) => `6c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const ENV = { ENTRADA_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'chave-simulada', ENTRADA_OPENAI_MODEL: 'gpt-6-luna', ENTRADA_OPENAI_SINCE: '2026-01-01T00:00:00Z' };

// People: each conversation (chat) has its own ficha. Paula has two conversations and two fichas.
const PEOPLE = {
  compra: { n: 10, name: 'Cliente Compra', text: ['Quero comprar um Toyota RAV4 pela MCS, qual o processo?', 'Is it sold? The white one you sent'] },
  posvenda: { n: 20, name: 'Cliente Pós-venda', text: ['O carro que vocês compraram pra mim chegou com o documento errado'] },
  pessoal: { n: 30, name: 'Amigo Pessoal', text: ['E aí, vamos no churrasco sábado?'] },
  vendido: { n: 40, name: 'Revenda Paralela', text: ['Vendi aquele Civic na minha loja, fecha o atacado amanhã?'] },
  fornecedor: { n: 50, name: 'Fornecedor Guincho', text: ['Segue a nota fiscal do reboque do mês'] },
  spam: { n: 60, name: 'Número Errado', text: ['Promoção imperdível, clique no link'] },
  duvida: { n: 70, name: 'Contato Ambíguo', text: ['Oi, tudo bem?'] },
  paulaPessoal: { n: 80, name: 'Paula', contact: 81, text: ['Oi prima, feliz aniversário!'] },
  paulaCompra: { n: 90, name: 'Paula', contact: 81, text: ['Agora quero uma Honda CR-V pela MCS'] }
};

function seed() {
  const rows = [`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`];
  const contacts = new Set();
  Object.values(PEOPLE).forEach((person) => {
    const contact = id(person.contact || person.n + 1), journey = id(person.n), chat = id(person.n + 2);
    if (!contacts.has(contact)) { contacts.add(contact); rows.push(`insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${person.name}','WHATSAPP_DIRECT',now(),now());`); }
    rows.push(`insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`);
    rows.push(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','t-${person.n}','RESOLVED',false,now(),now(),now(),now());`);
    person.text.forEach((text, index) => {
      const message = id(person.n * 100 + index);
      rows.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','${text.replace(/'/g, "''")}','x',now()-interval '${3 - index} hours','s${person.n}-${index}',1,'WHATSAPP_WEBHOOK',now()-interval '${3 - index} hours');`);
      rows.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`);
    });
  });
  return rows.join('\n');
}

// Simulated OpenAI: answers by the chat text; records every request it receives.
function fakeOpenAI(answers, calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, model: body.model, body });
    const messages = JSON.parse(body.messages[1].content).mensagens;
    const text = messages.map((item) => item.texto).join(' ');
    const answer = typeof answers === 'function' ? answers(text, messages) : answers;
    if (answer instanceof Error) throw answer;
    if (answer && answer.status) return { ok: false, status: answer.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 400, completion_tokens: 60 }, choices: [{ message: { content: typeof answer === 'string' ? answer : JSON.stringify({ ...answer, evidence_ids: answer.evidence_ids || [messages.at(-1).id] }) } }] }) };
  };
}
const byText = (text) => {
  if (/\bcomprar\b|quero uma|is it sold/i.test(text)) return { category: 'PRE_COMPRA_MCS', confidence: 'alta', reason: 'Quer comprar um veículo pela MCS' };
  if (/documento errado/.test(text)) return { category: 'POS_VENDA', confidence: 'alta', reason: 'Problema com carro já comprado' };
  if (/churrasco|aniversário/.test(text)) return { category: 'PESSOAL', confidence: 'alta', reason: 'Conversa pessoal' };
  if (/atacado/.test(text)) return { category: 'OUTRO_NEGOCIO', confidence: 'alta', reason: 'Negociação paralela de revenda' };
  if (/nota fiscal/.test(text)) return { category: 'OUTRO_NEGOCIO', confidence: 'alta', reason: 'Fornecedor' };
  if (/Promoção/.test(text)) return { category: 'NAO_CLIENTE', confidence: 'alta', reason: 'Spam' };
  return { category: 'REVISAR', confidence: 'baixa', reason: 'Contexto insuficiente' };
};

let backend, ctx;
const handler = (name) => require('../api/panel/' + name);
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await handler(name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const snapshot = async () => (await backend.db.query(`select
  (select md5(string_agg(id::text||body_text||coalesce(undone_at::text,''),',' order by id)) from public.messages) m,
  (select md5(string_agg(id::text||coalesce(is_lead::text,'')||display_name,',' order by id)) from public.contacts) c,
  (select md5(string_agg(id::text||status::text||coalesce(closed_at::text,'')||criteria_json::text,',' order by id)) from public.journeys) j,
  (select count(*) from public.manheim_matches) mm`)).rows[0];
const listedIds = async () => (await call('records', '/api/panel/records?sort=ready')).payload.items.map((item) => item.id);
const activeFor = async (person) => (await backend.db.query("select source,category,decision,status,reason,error_code,attempts from public.conversation_triage where chat_id=$1 and status='ACTIVE'", [id(PEOPLE[person].n + 2)])).rows[0];

test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.ENTRADA_OPENAI_ENABLED;
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview' };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('nasce desligada: sem flag, sem chave, sem modelo da allowlist ou sem data de corte nada é chamado', async () => {
  assert.equal(triage.status({}), 'DESLIGADA');
  assert.equal(triage.status({ ...ENV, OPENAI_API_KEY: '' }), 'SEM_CHAVE');
  assert.equal(triage.status({ ...ENV, ENTRADA_OPENAI_MODEL: 'gpt-5.5' }), 'MODELO_INVALIDO');
  assert.equal(triage.status({ ...ENV, ENTRADA_OPENAI_MODEL: '' }), 'MODELO_INVALIDO', 'sem modelo não há padrão silencioso');
  assert.equal(triage.status({ ...ENV, ENTRADA_OPENAI_SINCE: '' }), 'SEM_DATA_DE_CORTE');
  assert.equal(triage.status(ENV), 'LIGADA');
  const calls = [];
  assert.deepEqual(await triage.runTriage(ctx, { env: {}, fetchImpl: fakeOpenAI(byText, calls) }), { skipped: 'DESLIGADA', processed: 0 });
  assert.deepEqual(await triage.runTriage(ctx, { env: { ...ENV, ENTRADA_OPENAI_MODEL: 'gpt-4o' }, fetchImpl: fakeOpenAI(byText, calls) }), { skipped: 'MODELO_INVALIDO', processed: 0 });
  assert.equal(calls.length, 0);
});

test('acervo: conversas anteriores à data de corte nunca são lidas automaticamente', async () => {
  const future = { ...ENV, ENTRADA_OPENAI_SINCE: new Date(Date.now() + 3600000).toISOString() };
  assert.equal((await triage.candidates(ctx, { env: future })).length, 0);
  assert.equal((await triage.candidates(ctx, { env: ENV })).length, Object.keys(PEOPLE).length);
});

test('10 a 17 · classificação pela OpenAI simulada: pré-compra no funil, fora do funil some de CLIENTES e BUSCAS, ambíguo em REVISAR', async () => {
  const before = await snapshot();
  assert.equal((await listedIds()).length, Object.keys(PEOPLE).length);
  const calls = [];
  const result = await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI(byText, calls), limit: 20 });
  assert.equal(result.processed, Object.keys(PEOPLE).length);
  assert.equal(calls.length, Object.keys(PEOPLE).length);
  assert.ok(calls.every((entry) => entry.url === 'https://api.openai.com/v1/chat/completions' && entry.model === 'gpt-6-luna'));
  assert.ok(calls.every((entry) => entry.body.response_format.json_schema.strict === true), 'saída estruturada');
  const expected = { compra: 'PRE_COMPRA_MCS', posvenda: 'POS_VENDA', pessoal: 'PESSOAL', vendido: 'OUTRO_NEGOCIO', fornecedor: 'OUTRO_NEGOCIO', spam: 'NAO_CLIENTE', duvida: 'REVISAR', paulaPessoal: 'PESSOAL', paulaCompra: 'PRE_COMPRA_MCS' };
  for (const [person, category] of Object.entries(expected)) {
    const row = await activeFor(person);
    assert.equal(row.category, category, person);
    assert.equal(row.decision, triage.decisionOf(category), person);
  }
  // 10 and 17: purchase intent (with "Is it sold?") stays in the funnel; 11 to 15 leave CLIENTES.
  const listed = new Set(await listedIds());
  assert.ok(listed.has(id(10)), 'pré-compra continua em CLIENTES');
  for (const person of ['posvenda', 'pessoal', 'vendido', 'fornecedor', 'spam']) assert.ok(!listed.has(id(PEOPLE[person].n)), person + ' sai de CLIENTES');
  assert.ok(listed.has(id(70)), '16: REVISAR continua visível');
  // BUSCAS (searches) and HOJE also leave them out; the global search still finds them.
  const searches = await call('searches', '/api/panel/searches');
  assert.equal(searches.statusCode, 200);
  assert.ok(!(searches.payload.items || []).some((item) => item.journeyId === id(20)));
  const today = await call('today', '/api/panel/today');
  assert.equal(today.statusCode, 200);
  assert.ok(!(today.payload.items || []).some((item) => item.id === id(20) || item.journeyId === id(20)));
  const search = await call('search', '/api/panel/search?q=' + encodeURIComponent('Cliente Pós-venda'));
  assert.equal(search.statusCode, 200);
  assert.match(JSON.stringify(search.payload), /Cliente Pós-venda/);
  // 16: the ENTRADA review list shows the ambiguous case with its short reason.
  const panel = await call('triage', '/api/panel/triage');
  assert.deepEqual(panel.payload.review.map((item) => item.name), ['Contato Ambíguo']);
  assert.match(panel.payload.review[0].reason, /Classificação insegura|Contexto insuficiente/);
  assert.equal(panel.payload.out.length, 6);
  // 23: nothing deleted, no contact marked as non-lead, no ficha closed, no match touched.
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(backend.refused, []);
  // Every run records provider, model, category, decision, reason, evidence, rule version, tokens and cost.
  const stored = (await backend.db.query("select provider,model,category,decision,reason,evidence_message_ids,rule_version,input_tokens,output_tokens,cost_usd,created_at from public.conversation_triage where chat_id=$1", [id(22)])).rows[0];
  assert.deepEqual([stored.provider, stored.model, stored.rule_version, stored.input_tokens, stored.output_tokens, Number(stored.cost_usd)], ['openai', 'gpt-6-luna', triage.RULE_VERSION, 400, 60, 0.00007]);
  assert.equal(stored.evidence_message_ids.length, 1);
  assert.ok(stored.created_at);
});

test('18 · a classificação de uma conversa não mexe em outra jornada da mesma pessoa', async () => {
  const listed = new Set(await listedIds());
  assert.ok(!listed.has(id(80)), 'a conversa pessoal da Paula saiu');
  assert.ok(listed.has(id(90)), 'a jornada de compra da Paula continua');
  const contact = (await backend.db.query('select is_lead from public.contacts where id=$1', [id(81)])).rows[0];
  assert.notEqual(contact.is_lead, false, 'o contato nunca vira não-lead');
});

test('22 · mesmo conteúdo e mesma versão da regra: nenhuma chamada repetida', async () => {
  const calls = [];
  const result = await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI(byText, calls), limit: 20 });
  assert.equal(result.processed, 0);
  assert.equal(calls.length, 0);
  // Recording the same AI result twice is a no-op in the database too.
  const chat = id(12), row = (await backend.db.query("select content_hash from public.conversation_triage where chat_id=$1 and status='ACTIVE'", [chat])).rows[0];
  const again = await triage.record(ctx, { chatId: chat, journeyId: id(10), source: 'AI', category: 'PESSOAL', reason: 'x', evidence: [], contentHash: row.content_hash, model: 'gpt-6-luna' });
  assert.equal(again.duplicate, true);
  assert.equal((await activeFor('compra')).category, 'PRE_COMPRA_MCS');
});

test('20 · correção manual prevalece: a IA não sobrescreve, nem com mensagem nova de outro tipo', async () => {
  // The operator says the ambiguous contact is pre-purchase.
  const set = await call('triage', '/api/panel/triage', 'POST', { action: 'set', chatId: id(72), category: 'PRE_COMPRA_MCS' });
  assert.equal(set.statusCode, 200);
  assert.equal((await activeFor('duvida')).source, 'MANUAL');
  // A new message arrives and the AI reads it as personal: recorded, never applied.
  await backend.db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(7099)}','preview','${id(72)}','WHATSAPP','CUSTOMER','Vamos no churrasco?','x',now(),'n1',1,'WHATSAPP_WEBHOOK',now())`);
  await backend.db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(7099)}','${id(70)}','IMPORT',now())`);
  const calls = [];
  await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI(byText, calls) });
  assert.equal(calls.length, 1);
  const active = await activeFor('duvida');
  assert.deepEqual([active.source, active.category], ['MANUAL', 'PRE_COMPRA_MCS']);
  const notApplied = (await backend.db.query("select category from public.conversation_triage where chat_id=$1 and status='NOT_APPLIED'", [id(72)])).rows;
  assert.deepEqual(notApplied.map((row) => row.category), ['PESSOAL'], 'o resultado da IA fica registrado para auditoria');
});

test('19 · nova intenção de compra depois de uma decisão fora do funil traz a jornada de volta; desfazer devolve a decisão anterior', async () => {
  // The operator confirms the personal conversation is out of the funnel.
  const set = await call('triage', '/api/panel/triage', 'POST', { action: 'set', chatId: id(32), category: 'PESSOAL' });
  assert.equal(set.payload.decision, 'FORA_DO_FUNIL');
  assert.ok(!(await listedIds()).includes(id(30)));
  // Undo: the previous (AI) decision comes back.
  const manual = (await backend.db.query("select id from public.conversation_triage where chat_id=$1 and status='ACTIVE'", [id(32)])).rows[0];
  const undone = await call('triage', '/api/panel/triage', 'POST', { action: 'undo', triageId: manual.id });
  assert.equal(undone.statusCode, 200);
  assert.equal((await activeFor('pessoal')).source, 'AI');
  await call('triage', '/api/panel/triage', 'POST', { action: 'set', chatId: id(32), category: 'PESSOAL' });
  // Days later the same person writes to buy a car.
  await backend.db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(3099)}','preview','${id(32)}','WHATSAPP','CUSTOMER','Agora quero comprar um carro pela MCS','x',now()+interval '1 minute','n2',1,'WHATSAPP_WEBHOOK',now()+interval '1 minute')`);
  await backend.db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(3099)}','${id(30)}','IMPORT',now())`);
  await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI(byText, []) });
  const active = await activeFor('pessoal');
  assert.deepEqual([active.source, active.category], ['AI', 'PRE_COMPRA_MCS']);
  assert.ok((await listedIds()).includes(id(30)), 'a jornada volta para CLIENTES');
});

test('21 · falha, tempo esgotado ou resposta inválida mantém a conversa pendente em REVISAR, com no máximo 3 tentativas', async () => {
  const addMessage = async (n, text) => {
    await backend.db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n)}','preview','${id(62)}','WHATSAPP','CUSTOMER','${text}','x',now()+interval '2 minutes','f${n}',1,'WHATSAPP_WEBHOOK',now()+interval '2 minutes')`);
    await backend.db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(n)}','${id(60)}','IMPORT',now())`);
  };
  await addMessage(6098, 'Nova mensagem');
  const calls = [];
  const timeout = Object.assign(new Error('timeout'), { name: 'AbortError' });
  const first = await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI(timeout, calls) });
  assert.equal(first.failed, 1);
  let row = await activeFor('spam');
  assert.deepEqual([row.category, row.decision, row.error_code, row.attempts], ['REVISAR', 'PENDENTE', 'OPENAI_TIMEOUT', 1]);
  await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI({ status: 500 }, calls) });
  await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI('não é json', calls) });
  row = await activeFor('spam');
  assert.equal(row.category, 'REVISAR');
  assert.equal(row.attempts, 3);
  await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI(byText, calls) });
  assert.equal(calls.length, 3, 'depois de 3 tentativas a mesma conversa não é chamada de novo');
  assert.equal((await activeFor('spam')).category, 'REVISAR');
  // Invalid structured answers never decide.
  assert.equal(triage.validated({ category: 'X' }, []).category, 'REVISAR');
  assert.equal(triage.validated({ category: 'PESSOAL', confidence: 'alta', reason: 'ok', evidence_ids: ['inventado'] }, [{ id: 'a' }]).category, 'REVISAR');
  assert.equal(triage.validated({ category: 'PESSOAL', confidence: 'media', reason: 'talvez', evidence_ids: ['a'] }, [{ id: 'a' }]).category, 'REVISAR');
});

test('23 a 25 · nenhuma mensagem enviada, nenhum dado apagado, Anthropic fora desta função e nenhuma chamada externa real', () => {
  const code = (file) => read(file).split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const source = code('panel-triage.js') + code('api/panel/triage.js');
  assert.doesNotMatch(source, /anthropic/i);
  assert.doesNotMatch(source, /graph\.facebook|360dialog|\/reply|sendMessage|whatsapp_send/i);
  assert.doesNotMatch(read('supabase/migrations/20261004010000_panel_conversation_triage.sql').split('\n').filter((line) => !line.trim().startsWith('--')).join('\n'), /\bdelete\b|\btruncate\b|drop table|update public\.(messages|contacts|journeys|manheim_matches)/i);
  // Only OpenAI appears as provider; the prompt carries the "Is it sold?" warning (17).
  assert.match(triage.INSTRUCTIONS, /Is it sold\?/);
  assert.deepEqual(backend.refused, []);
  // Personal data never leaves: phones, e-mails and links are removed before the call.
  assert.equal(triage.redact('Me liga +1 (305) 555-0199 ou maria@example.com https://x.test/a'), 'Me liga [telefone] ou [email] [link]');
});

test('estimativa do acervo: conta conversas, tokens e custo sem chamar ninguém', async () => {
  const res = await call('triage', '/api/panel/triage?estimate=1');
  assert.equal(res.statusCode, 200);
  const luna = res.payload.estimate['gpt-6-luna'].todas, nano = res.payload.estimate['gpt-5.4-nano'].todas;
  assert.equal(luna.conversations, Object.keys(PEOPLE).length);
  assert.ok(luna.inputTokens > 0 && luna.outputTokens > 0);
  assert.ok(nano.costUsd > luna.costUsd);
  assert.deepEqual(backend.refused, []);
});

test('Ref da calculadora vinculada mantém a ficha no funil; o código interno da ficha não conta', () => {
  const out = [{ journey_id: id(1001), decision: 'FORA_DO_FUNIL' }, { journey_id: id(1002), decision: 'FORA_DO_FUNIL' }, { journey_id: id(1003), decision: 'FORA_DO_FUNIL' }, { journey_id: id(1003), decision: 'PENDENTE' }];
  const journeys = [{ id: id(1001), reference_code: 'ABCDE' }, { id: id(1002), reference_code: 'FGHJK' }, { id: id(1003), reference_code: 'LMNPQ' }];
  const result = triage.outOfFunnelJourneys(out, journeys, [{ journey_id: id(1002), ref_code: 'FGHJK' }]);
  assert.deepEqual([...result], [id(1001)]);
});
