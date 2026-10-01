'use strict';

// Quem não mandou mensagem não aparece em lugar nenhum do painel. A calculadora não pede telefone:
// simulou, clicou em WhatsApp, clicou em SMS ou clicou em "busca" sem escrever = nada a fazer.
// Os handlers reais rodam contra o banco PGlite com o caso de demonstração (sem rede, nada enviado).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const demo = require('./fixtures/caso-demonstracao');

const WHATS_CLICK = 'WCLKA', SMS_CLICK = 'SCLKA';
const calc = (ref, evento, extra = {}) => `insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados,is_test) values(now() - interval '3 hours','33101','FL',20000,null,${"'" + JSON.stringify({ quando: new Date(Date.now() - 3 * 3600000).toISOString(), sid: 's-' + ref, ref, evento, logical_mode: 'VALOR', marca: 'Honda', modelo: 'Accord', lance: 20000, nome: 'Cliente ' + ref, ...extra }) + "'"}::jsonb,false);`;
const NO_MESSAGE = [demo.LOOSE_REF, demo.SIMULATED_REF, WHATS_CLICK, SMS_CLICK];

let backend;
test.before(async () => {
  backend = await createBackend({ seed: [demo.seed, calc(WHATS_CLICK, 'simulacao'), calc(WHATS_CLICK, 'whatsapp'), calc(SMS_CLICK, 'simulacao'), calc(SMS_CLICK, 'sms')].join('\n') });
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
  return JSON.stringify(res.payload);
}

test('sem mensagem não aparece em nenhuma lista; quem escreveu aparece', async () => {
  const screens = {
    'HOJE': await call('today', '/api/panel/today?sort=recent'),
    'Lista de pedidos (relatório)': await call('orders', '/api/panel/orders?filter=Todos&period=all'),
    'CLIENTES': await call('records', '/api/panel/records?sort=recent'),
    'Qualificação': await call('qualification', '/api/panel/qualification?sort=recent'),
    'OPÇÕES · buscas por cliente': await call('searches', '/api/panel/searches'),
    'OPÇÕES · lote e demandas': await call('records', '/api/panel/records?view=manheim'),
    'Quais buscas salvar no Manheim': await call('manheim-searches', '/api/panel/manheim-searches')
  };
  for (const ref of NO_MESSAGE) {
    screens['Busca global por ' + ref] = await call('search', '/api/panel/search?q=' + ref);
  }
  for (const [screen, body] of Object.entries(screens)) {
    for (const ref of NO_MESSAGE) assert.ok(!body.includes(ref), `${screen} mostra ${ref}, que não mandou mensagem`);
  }
  // Control: the client who really wrote is still there.
  assert.ok(screens['CLIENTES'].includes(demo.REF), 'quem escreveu aparece em CLIENTES');
  assert.ok(screens['Lista de pedidos (relatório)'].includes(demo.REF), 'quem escreveu aparece nos pedidos');
  // An explicit link to the order (#pedido/REF, "Abrir pedido" of an AI link suggestion) still opens it.
  assert.ok((await call('orders', '/api/panel/orders?ref=' + demo.LOOSE_REF)).includes(demo.LOOSE_REF), '#pedido/REF continua abrindo o pedido');
  assert.deepEqual(backend.refused, []);
});

test('ENTRADA não tem mais a seção de pedidos sem mensagem', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'painel', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="entry-orders"|id="entry-simulated"|Só simularam/);
});
