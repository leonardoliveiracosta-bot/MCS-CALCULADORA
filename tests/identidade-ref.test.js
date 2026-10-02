'use strict';

// Identidade dos contatos: Ref da calculadora comprovada (simulação ou mensagem da calculadora) ×
// código interno da ficha; origem Calculadora mantida; ATENDIMENTO sem corte de 24 h.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const proof = require('../panel-ref-proof');
const groups = require('../panel-groups');

const IVAN = 'Hi My Car Scout! I want you to find a car for me. · FIND · 2019 Toyota Camry · Year range 2018-2020 · Mileage range up to 80k · ZIP 33166 · Ref: WSR3X';

test('Ref explícita: só na mensagem da calculadora, formato estrito, sem "Reference"', () => {
  assert.deepEqual(proof.explicitRefs(IVAN), ['WSR3X']);
  assert.deepEqual(proof.explicitRefs('My Car Scout · Ref:wsr3x e Ref: FMLNA'), ['WSR3X', 'FMLNA']);
  assert.deepEqual(proof.explicitRefs('My Car Scout Reference ERENC'), []);
  assert.deepEqual(proof.explicitRefs('Ref: WSR3X'), [], 'sem "My Car Scout" não é mensagem da calculadora');
  assert.deepEqual(proof.explicitRefs('My Car Scout · Ref: WSR3XY'), [], 'seis caracteres não é Ref');
  assert.deepEqual(proof.explicitRefs('My Car Scout · Ref: WSR1X'), [], '1 não existe no alfabeto da Ref');
  assert.equal(proof.messageMode(IVAN), 'CARRO');
  assert.equal(proof.messageMode('My Car Scout · Maximum bid $9,000 · Ref: FMLNA'), 'VALOR');
  assert.equal(proof.messageMode('My Car Scout · Ref: FMLNA'), null);
});

test('caso Ivan: WSR3X comprovada pela mensagem, sem simulação; nunca troca pela sugestão FMLNA', () => {
  const p = proof.proofFor({ journey: { reference_code: 'WSR3X' }, runRefs: new Set(['FMLNA']), explicit: [{ ref: 'WSR3X', mode: 'CARRO', at: '2026-09-30T12:00:00Z' }] });
  assert.equal(p.hasCalcRef, true);
  assert.equal(p.calcRef, 'WSR3X');
  assert.deepEqual(p.calcRefsWithoutRun, ['WSR3X']);
  assert.equal(p.internalCode, null);
  assert.deepEqual(p.messageModes, ['CARRO']);
  // A sugestão de vínculo para outra Ref contradiz o que o cliente escreveu.
  assert.equal(proof.contradicts({ target_ref: 'FMLNA' }, p.writtenRefs), true);
  assert.equal(proof.contradicts({ target_ref: 'WSR3X' }, p.writtenRefs), false);
  assert.equal(proof.contradicts({ target_ref: 'FMLNA' }, []), false, 'sem Ref escrita, a sugestão não é contradita');
});

test('código interno da ficha não é Ref; Ref com simulação é Ref; Ref escrita e ainda não ligada também', () => {
  const internal = proof.proofFor({ journey: { reference_code: 'K7M2P' }, runRefs: new Set() });
  assert.equal(internal.hasCalcRef, false);
  assert.equal(internal.calcRef, null);
  assert.equal(internal.internalCode, 'K7M2P');
  const run = proof.proofFor({ journey: { reference_code: 'K7M2P' }, linkedRefs: ['ABC23'], runRefs: new Set(['ABC23']) });
  assert.deepEqual(run.calcRefs, ['ABC23']);
  assert.equal(run.internalCode, 'K7M2P');
  assert.deepEqual(run.calcRefsWithoutRun, []);
  const written = proof.proofFor({ journey: { reference_code: null }, explicit: [{ ref: 'QWE45', mode: 'VALOR' }] });
  assert.deepEqual(written.calcRefs, ['QWE45']);
  assert.equal(proof.runRefsOf([{ dados: { ref: 'abc23' } }, { dados: { ref: 'TST22' }, is_test: true }]).has('ABC23'), true);
  assert.equal(proof.runRefsOf([{ dados: { ref: 'TST22' }, is_test: true }]).size, 0);
});

const NOW = Date.parse('2026-10-01T15:00:00Z');
const iso = (hours) => new Date(NOW - hours * 3600000).toISOString();
const msg = (id, direction, hours, body = 'oi') => ({ id, direction, body_text: body, occurred_at_utc: iso(hours), source_kind: 'WHATSAPP_WEBHOOK' });

test('origem: Ref comprovada fica em Calculadora mesmo sem simulação; WhatsApp depois é só canal', () => {
  const calcProof = proof.proofFor({ journey: { reference_code: 'WSR3X' }, explicit: [{ ref: 'WSR3X', mode: 'CARRO', at: iso(48) }] });
  const facts = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 48, IVAN), msg('b', 'CUSTOMER', 2, 'any update?')], journey: { source: 'WHATSAPP_DIRECT' }, calcProof });
  assert.equal(facts.hasCalculator, true);
  assert.deepEqual(facts.calcModes, ['CARRO']);
  assert.equal(groups.originOf(facts).group, 'CALCULADORA');
  // Sem prova (código interno): conversa direta continua "por mensagem".
  const internal = proof.proofFor({ journey: { reference_code: 'K7M2P' } });
  assert.equal(groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 2)], journey: { source: 'WHATSAPP_DIRECT' }, calcProof: internal })).group, 'MENSAGEM');
});

// ----- ATENDIMENTO (api/panel/today.js) com o banco simulado -----
const root = path.join(__dirname, '..');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function loadWith(relative, mocks) {
  const file = path.join(root, relative); const mod = { exports: {} };
  const localRequire = (name) => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(localRequire, mod, mod.exports);
  return mod.exports;
}
const output = () => ({ code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return payload; } });
const JOURNEY = uuid(900), CONTACT = uuid(901);
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
let seq = 0;
const customer = (hours, body = 'oi') => ({ id: uuid(1000 + (seq += 1)), journey_id: JOURNEY, direction: 'CUSTOMER', body_text: body, occurred_at_utc: ago(hours), source_kind: 'SMS_IMPORT' });
function hoje({ journey = {}, messages = [], dispositions = [], calcRuns = [] } = {}) {
  const base = { id: JOURNEY, contact_id: CONTACT, reference_code: 'WSR3X', source: 'SMS_DIRECT', stage: 'RESPONDIDO', status: 'ATIVO', enabled: true, created_at: '2026-09-01T00:00:00Z', criteria_json: {}, contact: { display_name: 'Ivan' }, phones: [], ...journey };
  const server = { requirePanel: async () => ({ environment: 'preview', panel: { id: uuid(1) }, config: {} }), send: (res, code, payload) => res.status(code).json(payload), panelMeta: async () => ({}),
    allRows: async (_ctx, table) => ({ calc_runs: calcRuns, panel_item_dispositions: dispositions })[table] || [] };
  const handler = loadWith('api/panel/today.js', { '../../panel-server': server, '../../panel-manheim-state': { activeFilter: async () => ({ undone_at: 'is.null' }), undoSupported: async () => true, latestActiveUpload: async () => null },
    '../../panel-read-model': { operational: async () => ({ journeys: [base], refs: [], messages, checklist: [], promises: [], excludedRefs: [] }) },
    '../../panel-search-stage': { loadSearchStageIndex: async () => new Map(), decorateWithSearchStage: (item) => item } });
  return (async () => { const res = output(); await handler({ method: 'GET', query: {} }, res); return res.payload; })();
}

test('ATENDIMENTO: contato aberto continua depois de 24 h; encerrado, desligado e tratado depois não', async () => {
  const old = await hoje({ messages: [customer(240, 'still looking?')] });
  assert.equal(old.items.length, 1, 'contato aberto de 10 dias continua acessível');
  assert.equal((await hoje({ journey: { status: 'ENCERRADO' }, messages: [customer(240)] })).items.length, 0);
  assert.equal((await hoje({ journey: { enabled: false }, messages: [customer(240)] })).items.length, 0);
  const treated = [{ item_kind: 'JOURNEY', item_key: JOURNEY, status: 'TREATED', updated_at: ago(100) }];
  assert.equal((await hoje({ messages: [customer(240)], dispositions: treated })).items.length, 0, 'tratado depois do último contato fica fora');
  assert.equal((await hoje({ messages: [customer(50)], dispositions: treated })).items.length, 1, 'mensagem nova depois do tratado traz de volta');
});

test('ATENDIMENTO: Ivan tem Ref WSR3X (mensagem da calculadora), origem Calculadora, simulação não registrada', async () => {
  const payload = await hoje({ messages: [customer(60, IVAN), customer(3, 'any news?')], calcRuns: [{ id: uuid(77), created_at: ago(70), dados: { ref: 'FMLNA' } }] });
  const item = payload.items.find((entry) => entry.id === JOURNEY);
  assert.ok(item);
  assert.equal(item.hasCalcRef, true);
  assert.equal(item.calcRef, 'WSR3X');
  assert.deepEqual(item.calcRefsWithoutRun, ['WSR3X']);
  assert.equal(item.internalCode, null);
  assert.equal(item.group.origin.group, 'CALCULADORA');
  // Código da ficha sem prova: não é Ref.
  const internal = await hoje({ journey: { reference_code: 'K7M2P' }, messages: [customer(3, 'hello, I need a car')] });
  const other = internal.items.find((entry) => entry.id === JOURNEY);
  assert.equal(other.hasCalcRef, false);
  assert.equal(other.internalCode, 'K7M2P');
  assert.equal(other.group.origin.group, 'MENSAGEM');
});
