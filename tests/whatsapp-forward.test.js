'use strict';
// Cópia das mensagens do WhatsApp para o n8n do Rene. O caminho comum não muda: sem as variáveis nada é copiado
// e o webhook responde igual; com elas, a cópia sai em segundo plano e nenhuma falha dela chega ao webhook ou ao envio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const forward = require('../whatsapp-forward');

const URL_N8N = 'https://n8n.example.test/webhook/mcs';
const SECRET = 'segredo-de-teste';
const event = { object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.1', from: '13055550122', timestamp: '1790431200', type: 'text', text: { body: 'Hi' } }] } }] }] };

function loadWith(relative, mocks) {
  const file = path.join(root, relative), mod = { exports: {} };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  return mod.exports;
}
function response() { return { code: 0, payload: null, setHeader() {}, status(n) { this.code = n; return this; }, json(v) { this.payload = v; return v; } }; }
function withEnv(values, run) {
  const old = {};
  for (const key of Object.keys(values)) { old[key] = process.env[key]; if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  const restore = () => { for (const key of Object.keys(old)) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } };
  return Promise.resolve().then(run).finally(restore);
}
// fetch global falso: registra tudo e responde conforme o destino.
function stubFetch(handler) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => { calls.push({ url: String(url), options }); return handler(String(url), options); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });
function webhookHandler(rawEvent = async () => ({ id: 'row' })) {
  return loadWith('api/whatsapp/webhook.js', {
    '../../panel-server': { SERVER_ENVIRONMENT: 'preview', configuration: () => ({ url: 'u', secretKey: 'k' }), jsonBody: async (req) => req.body, send: (res, code, data) => res.status(code).json(data) },
    '../../whatsapp-receiver': { rawEvent, processRaw: async () => ({}) }
  });
}
async function callWebhook(handler, headers = { 'x-mcs-webhook-secret': 'segredo-webhook' }) {
  const scheduled = [], res = response();
  await handler({ method: 'POST', headers, body: event, waitUntil: (task) => scheduled.push(task) }, res);
  return { res, scheduled };
}

test('caminho comum: sem RENE_FORWARD_URL/SECRET o webhook responde igual e nada é copiado', () => withEnv({ WHATSAPP_WEBHOOK_SECRET: 'segredo-webhook', RENE_FORWARD_URL: undefined, RENE_FORWARD_SECRET: undefined }, async () => {
  const net = stubFetch(async () => ok());
  try {
    const { res, scheduled } = await callWebhook(webhookHandler());
    assert.deepEqual([res.code, res.payload], [200, { received: true }]);
    assert.equal(scheduled.length, 1, 'só o processamento de sempre');
    await Promise.all(scheduled);
    assert.equal(net.calls.length, 0);
    // Só uma das variáveis também não copia.
    process.env.RENE_FORWARD_URL = URL_N8N;
    assert.equal(forward.forwardInbound(event, null), null);
    assert.equal(forward.forwardOutbound({ to: '1', text: 'x', messageId: 'm' }), null);
    assert.equal(net.calls.length, 0);
  } finally { net.restore(); }
}));

test('recebida: o JSON autenticado e guardado vai igual para o n8n, com o segredo, em segundo plano', () => withEnv({ WHATSAPP_WEBHOOK_SECRET: 'segredo-webhook', RENE_FORWARD_URL: URL_N8N, RENE_FORWARD_SECRET: SECRET }, async () => {
  const net = stubFetch(async () => ok());
  try {
    const { res, scheduled } = await callWebhook(webhookHandler());
    assert.deepEqual([res.code, res.payload], [200, { received: true }]);
    assert.equal(scheduled.length, 2, 'processamento + cópia');
    await Promise.all(scheduled);
    assert.equal(net.calls.length, 1);
    const [call] = net.calls;
    assert.equal(call.url, URL_N8N);
    assert.equal(call.options.method, 'POST');
    assert.deepEqual(call.options.headers, { 'content-type': 'application/json', 'x-mcs-secret': SECRET });
    assert.deepEqual(JSON.parse(call.options.body), event);
    assert.ok(call.options.signal, 'com limite de tempo');
  } finally { net.restore(); }
}));

test('recebida: sem autenticação ou evento repetido não é copiado', () => withEnv({ WHATSAPP_WEBHOOK_SECRET: 'segredo-webhook', RENE_FORWARD_URL: URL_N8N, RENE_FORWARD_SECRET: SECRET }, async () => {
  const net = stubFetch(async () => ok());
  try {
    const denied = await callWebhook(webhookHandler(), { 'x-mcs-webhook-secret': 'errado' });
    assert.equal(denied.res.code, 401);
    const repeated = await callWebhook(webhookHandler(async () => null));
    assert.deepEqual([repeated.res.code, repeated.scheduled.length], [200, 0]);
    assert.equal(net.calls.length, 0);
  } finally { net.restore(); }
}));

test('falha no n8n (erro, HTTP 500 ou travado) nunca muda a resposta do webhook', () => withEnv({ WHATSAPP_WEBHOOK_SECRET: 'segredo-webhook', RENE_FORWARD_URL: URL_N8N, RENE_FORWARD_SECRET: SECRET }, async () => {
  const errors = [], originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    for (const behavior of [async () => { throw new Error('ECONNREFUSED'); }, async () => ({ ok: false, status: 500 })]) {
      const net = stubFetch(behavior);
      try {
        const { res, scheduled } = await callWebhook(webhookHandler());
        assert.deepEqual([res.code, res.payload], [200, { received: true }]);
        await Promise.all(scheduled);
      } finally { net.restore(); }
    }
    // Travado: o webhook já respondeu; a cópia desiste sozinha no limite de 3 segundos.
    const net = stubFetch((url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))));
    try {
      const started = Date.now();
      const { res, scheduled } = await callWebhook(webhookHandler());
      assert.equal(res.code, 200);
      assert.ok(Date.now() - started < 500, 'a resposta não esperou a cópia');
      await Promise.all(scheduled);
      assert.ok(Date.now() - started >= forward.TIMEOUT_MS - 100 && Date.now() - started < forward.TIMEOUT_MS + 2000);
    } finally { net.restore(); }
    assert.equal(errors.length, 3);
    assert.ok(errors.every((line) => line.startsWith('[rene-forward]') && line.length < 90), 'erro curto, sem conteúdo da mensagem');
  } finally { console.error = originalError; }
}));

test('enviada pelo painel (resposta e V1): cópia mcs_outbound só depois do envio confirmado', () => withEnv({ RENE_FORWARD_URL: URL_N8N, RENE_FORWARD_SECRET: SECRET, D360_API_KEY: 'chave-360' }, async () => {
  const reply = require('../api/panel/reply');
  const net = stubFetch(async () => ok());
  try {
    const sent = await reply.d360Send('+13055550122', 'Hi, this is Leo', async () => ok({ messages: [{ id: 'wamid.out1' }] }));
    assert.deepEqual(sent, { messageId: 'wamid.out1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(net.calls.length, 1);
    const copy = JSON.parse(net.calls[0].options.body).mcs_outbound;
    assert.deepEqual({ ...copy, sent_at: undefined }, { to: '13055550122', type: 'text', text: 'Hi, this is Leo', message_id: 'wamid.out1', sent_at: undefined });
    assert.ok(!Number.isNaN(Date.parse(copy.sent_at)));
    // Envio que falhou não é copiado; o resultado do envio é o de sempre.
    assert.deepEqual(await reply.d360Send('+13055550122', 'x', async () => ({ ok: false, status: 400 })), { error: 'D360_HTTP_400' });
    assert.deepEqual(await reply.d360Send('+13055550122', 'x', async () => ok({})), { error: 'D360_RESPONSE_INVALID' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(net.calls.length, 1);
  } finally { net.restore(); }
}));

test('enviada pelo bot (resposta automática e opções automáticas): mesma cópia; n8n fora do ar não muda o envio', () => withEnv({ RENE_FORWARD_URL: URL_N8N, RENE_FORWARD_SECRET: SECRET, D360_API_KEY: 'chave-360', VERCEL_ENV: 'production' }, async () => {
  const { sendMessage } = require('../whatsapp-auto-reply');
  const errors = [], originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const net = stubFetch(async (url) => url === URL_N8N ? Promise.reject(new Error('down')) : ok({ messages: [{ id: 'wamid.bot1' }] }));
  try {
    assert.equal(await sendMessage({ phone: '+13055550122' }, 'Thanks for reaching out'), 'wamid.bot1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const toN8n = net.calls.filter((call) => call.url === URL_N8N);
    assert.equal(toN8n.length, 1);
    assert.deepEqual({ ...JSON.parse(toN8n[0].options.body).mcs_outbound, sent_at: undefined }, { to: '13055550122', type: 'text', text: 'Thanks for reaching out', message_id: 'wamid.bot1', sent_at: undefined });
    assert.equal(errors.length, 1);
  } finally { net.restore(); console.error = originalError; }
}));

test('os três pontos chamam o helper só depois do sucesso', () => {
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('api/whatsapp/webhook.js'), /waitUntil\)\(bounded\);\n\s+\/\/ Cópia[^\n]*\n\s+try\{require\('\.\.\/\.\.\/whatsapp-forward'\)\.forwardInbound\(payload,req\);\}catch\(_\)\{\}/);
  assert.match(read('api/panel/reply.js'), /return \{ error: 'D360_RESPONSE_INVALID' \};\n[^\n]*\n\s+try \{ require\('\.\.\/\.\.\/whatsapp-forward'\)\.forwardOutbound/);
  assert.match(read('whatsapp-auto-reply.js'), /if\(!messageId\)throw Error\('D360_RESPONSE_INVALID'\);\n[^\n]*\n\s+try\{require\('\.\/whatsapp-forward'\)\.forwardOutbound/);
});
