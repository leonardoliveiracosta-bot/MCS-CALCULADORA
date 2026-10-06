'use strict';

// Contexto do cliente em todas as abas: campo por campo, com a origem de cada valor, o que está
// confirmado, ausente, ambíguo ou só lido pela IA, a etapa, de quem depende e a próxima ação.
// Nada é ligado por suposição. Handlers reais contra o banco simulado (PGlite); nada é gravado.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const demo = require('./fixtures/caso-demonstracao');
const context = require('../panel-client-context');

const src = (kind, value, extra = {}) => ({ kind, value, ...extra });
const byKey = (fields, key) => fields.find((item) => item.key === key);

test('campo: calculadora e ficha iguais = informado pelo cliente; ficha diferente prevalece e a divergência aparece', () => {
  const agree = context.field('carro', [src('CALCULADORA', 'Toyota Corolla'), src('FICHA', 'toyota corolla')]);
  assert.equal(agree.status, 'CLIENTE');
  assert.equal(agree.statusLabel, 'Informado pelo cliente');
  assert.equal(agree.sources.length, 2);
  const differ = context.field('valor', [src('CALCULADORA', 'US$ 18,000'), src('FICHA', 'US$ 20,000')]);
  assert.equal(differ.status, 'EQUIPE');
  assert.equal(differ.value, 'US$ 20,000');
  assert.equal(differ.divergent, true);
  assert.match(differ.note, /Calculadora — US\$ 18,000.*A busca usa o valor da ficha/);
});

test('campo: fontes sem ficha que discordam = ambíguo, sem escolher valor', () => {
  const clash = context.field('prazo', [src('CALCULADORA', '30 dias', { ref: 'AAAAA' }), src('CALCULADORA', '90 dias', { ref: 'BBBBB' })]);
  assert.equal(clash.status, 'AMBIGUO');
  assert.equal(clash.value, null);
  assert.equal(clash.sources.length, 2);
});

test('campo: só a IA leu = nunca aparece como confirmado pelo cliente', () => {
  const ai = context.field('anos', [src('CONVERSA_IA', 'a partir de 2019', { messages: [{ id: 'm1', text: 'Prefiro 2019' }] })]);
  assert.equal(ai.status, 'IA');
  assert.equal(ai.statusLabel, 'Lido pela IA · não confirmado');
  assert.equal(ai.sources[0].messages[0].id, 'm1');
  assert.notEqual(ai.statusLabel, context.STATUS.CLIENTE);
  assert.equal(context.field('anos', []).status, 'AUSENTE');
  assert.equal(context.field('teto', [src('FICHA', 'US$ 25,000', { confirmed: true })]).status, 'CONFIRMADO');
});

test('uso do carro: não coletado em lugar nenhum, dito como está', () => {
  const uso = byKey(context.buildFields([]), 'uso');
  assert.equal(uso.status, 'AUSENTE');
  assert.equal(uso.statusLabel, 'Não coletado');
  assert.match(uso.note, /não tem campo/);
});

test('próxima ação: não pergunta o que já está no histórico; a da equipe vem primeiro', () => {
  const owner = { who: 'CLIENTE', label: 'Cliente' };
  const fields = context.buildFields([{ carro: [src('CALCULADORA', 'Mazda CX-5')] }, { anos: [src('CONVERSA_IA', '2018 a 2021')] }]);
  const read = context.nextStep({ owner, fields, modes: ['CARRO'], conversationCount: 3, conversationRead: true });
  assert.deepEqual(read.missing, ['Milhagem']);
  assert.equal(read.action.text, 'Perguntar ao cliente: Milhagem');
  assert.ok(!/Anos/.test(read.action.text), 'anos já respondido na conversa não é perguntado de novo');
  const unread = context.nextStep({ owner, fields, modes: ['CARRO'], conversationCount: 3, conversationRead: false });
  assert.match(unread.action.text, /^Ver na conversa se o cliente já respondeu/);
  const onlyAi = context.nextStep({ owner, fields: context.buildFields([{ carro: [src('CALCULADORA', 'Mazda CX-5')], milhas: [src('FICHA', 'até 80,000 mi')] }, { anos: [src('CONVERSA_IA', '2018 a 2021')] }]), modes: ['CARRO'] });
  assert.equal(onlyAi.action.text, 'Conferir na conversa e registrar na ficha: Anos');
  const team = context.nextStep({ journey: { next_action_text: 'Ligar amanhã às 10h', next_action_at: new Date(Date.now() + 86400000).toISOString() }, owner, fields, modes: ['CARRO'] });
  assert.equal(team.action.kind, 'EQUIPE');
  assert.equal(team.action.label, 'Definida pela equipe');
  assert.equal(read.action.label, 'Sugestão do painel');
});

let backend, ctx;
async function call(body) {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/client-context')({ method: 'POST', url: '/api/panel/client-context', headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res);
  return res;
}

test.before(async () => {
  backend = await createBackend({ seed: demo.seed, maxRows: 1000 });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = (url, options) => backend.fetch(url, options);
  require('../panel-manheim-state').resetUndoSupport();
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: demo.IDS.ACTOR, role: 'admin' } };
});

test('caso completo: dados do cliente com origem, conversa, etapa, de quem depende e próxima ação', async () => {
  const before = (await backend.db.query('select (select count(*) from public.journeys) j, (select count(*) from public.vehicle_requests where journey_id is not null) r, (select count(*) from public.calculator_request_links) l')).rows[0];
  const res = await call({ journeyIds: [demo.IDS.JOURNEY] });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const item = res.payload.journeys[demo.IDS.JOURNEY];
  assert.equal(item.name, 'Marina Demonstração');
  assert.deepEqual(item.contact.phones, ['+13055550142']);
  assert.equal(item.listMessage.direction, 'CUSTOMER');
  assert.equal(item.listMessage.channel, 'WHATSAPP');
  assert.equal(item.listMessage.at, item.conversation.lastAt);
  assert.equal(item.origin.label, 'Veio pela calculadora · Via WhatsApp');
  assert.equal(item.origin.calculator, true);
  assert.equal(item.ref, demo.REF);
  const f = (key) => byKey(item.fields, key);
  assert.equal(f('carro').status, 'CLIENTE');
  assert.deepEqual(f('carro').sources.map((s) => s.kind).sort(), ['CALCULADORA', 'CONVERSA_IA', 'FICHA']);
  assert.equal(f('valor').status, 'CLIENTE');
  assert.equal(f('valor').value, 'US$ 18,000');
  // "22 mil no total" is not the bid: never a divergence, but kept visible with its message.
  assert.equal(f('valor').divergent, false);
  const aiBudget = f('valor').sources.find((s) => s.kind === 'CONVERSA_IA');
  assert.equal(aiBudget.value, 'US$ 22,000');
  assert.match(aiBudget.detail, /total ou o lance/);
  assert.equal(aiBudget.messages[0].id, demo.IDS.MSG1);
  assert.equal(f('anos').status, 'IA');
  assert.equal(f('anos').sources[0].messages[0].id, demo.IDS.MSG3);
  assert.equal(f('pagamento').value, 'Financiado');
  assert.equal(f('prazo').value, 'Até 30 dias');
  assert.equal(f('prazo').sources.find((s) => s.kind === 'CALCULADORA').raw, '30 dias');
  assert.equal(f('placa').value, 'Transferir placa');
  assert.equal(f('local').status, 'CLIENTE');
  assert.equal(f('uso').statusLabel, 'Não coletado');
  assert.equal(item.stage.label, 'Em busca');
  assert.equal(item.conversation.lastFrom, 'CUSTOMER');
  assert.equal(item.owner.who, 'MCS');
  assert.equal(item.nextAction.text, 'Responder o cliente');
  assert.equal(item.nextAction.label, 'Sugestão do painel');
  assert.deepEqual(item.missing, []);
  assert.equal(item.links.orders[0].ref, demo.REF);
  assert.equal(item.links.requests.length, 1);
  assert.equal(item.searches[0].mode, 'VALOR');
  const after = (await backend.db.query('select (select count(*) from public.journeys) j, (select count(*) from public.vehicle_requests where journey_id is not null) r, (select count(*) from public.calculator_request_links) l')).rows[0];
  assert.deepEqual(after, before, 'só leitura: nada é ligado nem gravado');
  assert.deepEqual(backend.refused, []);
});

test('sem vínculo seguro: contato com duas fichas, Ref em duas fichas e Ref sem ficha', async () => {
  const res = await call({ contactIds: [demo.IDS.TWIN_CONTACT, demo.IDS.CONTACT], refs: [demo.SHARED_REF, demo.LOOSE_REF, demo.REF] });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const { contacts, refs, journeys } = res.payload;
  assert.equal(contacts[demo.IDS.TWIN_CONTACT].journeyId, null);
  assert.match(contacts[demo.IDS.TWIN_CONTACT].reason, /mais de uma ficha/);
  assert.equal(contacts[demo.IDS.CONTACT].journeyId, demo.IDS.JOURNEY);
  assert.equal(refs[demo.REF].journeyId, demo.IDS.JOURNEY);
  assert.equal(refs[demo.SHARED_REF].journeyId, null);
  assert.deepEqual(refs[demo.SHARED_REF].ambiguousOwners.sort(), [demo.IDS.SHARED_A, demo.IDS.SHARED_B].sort());
  assert.equal(refs[demo.SHARED_REF].nextAction.text, 'Conferir a qual ficha esta Ref pertence');
  // The shared Ref is not the order of either ficha.
  assert.deepEqual(journeys[demo.IDS.SHARED_A].links.orders, []);
  assert.deepEqual(journeys[demo.IDS.SHARED_A].sharedRefs, [demo.SHARED_REF]);
  const loose = refs[demo.LOOSE_REF];
  // Only clicked in the calculator, no message: waiting for the client, not "asked for contact".
  assert.equal(loose.stage.label, 'Aguardando contato do cliente');
  assert.equal(loose.contact.note, 'A calculadora não guarda telefone.');
  assert.equal(byKey(loose.fields, 'anos').value, '2018 a 2021');
  assert.equal(byKey(loose.fields, 'milhas').value, 'até 80,000 mi');
  assert.match(loose.nextAction.text, /^Se a conversa do cliente chegou sem a Ref, ligar o pedido à ficha/);
  // The two fichas of one contact: conversation requests are linked to neither.
  assert.deepEqual(journeys[demo.IDS.TWIN_A].links.requests, []);
});

test('Ref em duas fichas: pedida uma ficha só, a Ref continua sem dono (não vira dado do cliente)', async () => {
  const res = await call({ journeyIds: [demo.IDS.SHARED_B] });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const item = res.payload.journeys[demo.IDS.SHARED_B];
  assert.deepEqual(item.links.orders, []);
  assert.deepEqual(item.sharedRefs, [demo.SHARED_REF]);
  assert.ok(item.fields.every((f) => f.sources.every((source) => source.kind !== 'CALCULADORA')), 'nenhum valor da calculadora da Ref compartilhada');
});

test('prazo: os quatro códigos aparecem como texto claro e o valor original fica guardado', () => {
  const expected = { now: 'Imediatamente', '30d': 'Até 30 dias', '3m': '30 a 90 dias', none: 'Sem prazo definido' };
  for (const [code, label] of Object.entries(expected)) {
    assert.equal(context.deadlineLabel(code), label, code);
    const fromCalculator = context.field('prazo', context.calculatorSources([{ ref: 'AAAAA', logicalMode: 'VALOR', deadlineText: code, wishlists: [] }]).prazo);
    assert.equal(fromCalculator.value, label, 'calculadora ' + code);
    assert.equal(fromCalculator.sources[0].raw, code, 'o código original continua nos dados');
    const fromFicha = context.field('prazo', context.fichaSources({ customer_deadline_text: code, criteria_json: {} }, null, []).prazo);
    assert.equal(fromFicha.value, label, 'ficha ' + code);
  }
  // "3mo" (calculadora) e "3m" (ficha) são o mesmo prazo: nada de ambíguo.
  const both = context.field('prazo', [...context.calculatorSources([{ ref: 'AAAAA', logicalMode: 'VALOR', deadlineText: '3mo', wishlists: [] }]).prazo, ...context.fichaSources({ customer_deadline_text: '3m', criteria_json: {} }, null, []).prazo]);
  assert.equal(both.status, 'CLIENTE');
  assert.equal(both.value, '30 a 90 dias');
  assert.equal(both.divergent, false);
});

test('pedido sem ficha com critérios completos: critérios completos, mas bloqueado e com próxima ação coerente', async () => {
  const res = await call({ refs: [demo.LOOSE_REF, demo.SIMULATED_REF] });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const contacted = res.payload.refs[demo.LOOSE_REF];
  const waiting = res.payload.refs[demo.SIMULATED_REF];
  for (const item of [contacted, waiting]) {
    assert.equal(item.journeyId, null, 'nunca ligado a uma ficha por suposição');
    assert.deepEqual(item.criteria, { complete: true, text: 'Completos' });
    assert.ok(item.blocker, 'critérios completos não liberam o fluxo: há bloqueio');
    assert.equal(item.nextAction.kind, 'SUGESTAO');
    const said = JSON.stringify(item);
    assert.doesNotMatch(said, /Nada falta para buscar|Salvar a busca|Escolher carros/, 'nada sugere que a busca está liberada');
  }
  // A click in the calculator is not contact: the order that only clicked waits like the one that
  // only simulated (no message, no phone).
  for (const item of [contacted, waiting]) {
    assert.equal(item.situation.code, 'AWAITING');
    assert.equal(item.situation.label, 'Aguardando contato do cliente');
    assert.match(item.situation.detail, /nenhuma mensagem do cliente ligada/);
    assert.equal(item.owner.who, 'CLIENTE');
    assert.match(item.blocker, /ainda não entrou em contato/);
    assert.match(item.nextAction.text, /^Se a conversa do cliente chegou sem a Ref, ligar o pedido à ficha/);
  }
  assert.equal(waiting.fields.find((f) => f.key === 'prazo').value, '30 a 90 dias');
  assert.equal(waiting.fields.find((f) => f.key === 'prazo').sources[0].raw, '3mo');
});

test('entrada inválida: sem ids, ids demais e ids malformados', async () => {
  assert.equal((await call({})).statusCode, 400);
  assert.equal((await call({ journeyIds: Array.from({ length: 101 }, (_, n) => demo.IDS.JOURNEY.slice(0, -3) + String(n).padStart(3, '0')) })).statusCode, 400);
  const bad = await call({ journeyIds: ["x' or 1=1"], refs: ['IOIOI'] });
  assert.equal(bad.statusCode, 200);
  assert.deepEqual(bad.payload.journeys, {});
  assert.deepEqual(bad.payload.refs, {});
});
