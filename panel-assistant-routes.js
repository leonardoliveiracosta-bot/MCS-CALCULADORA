'use strict';

// O assistente usa as rotas que o painel já usa, chamadas aqui dentro com a sessão já conferida
// (req.__mcsCtx, o mesmo caminho do /api/panel/boot): mesmas regras, mesmas travas, mesmo registro.
// Nenhuma regra de negócio é copiada para o assistente.
const ROUTES = {
  today: '/api/panel/today', lead: '/api/panel/lead', actions: '/api/panel/actions', entry: '/api/panel/entry',
  vitrines: '/api/panel/vitrines', 'v1-send': '/api/panel/v1-send', 'vitrine-funnel': '/api/panel/vitrine-funnel',
  'v2-draft': '/api/panel/v2-draft', 'manheim-options': '/api/panel/manheim-options', attachments: '/api/panel/attachments',
  'vitrine-photos': '/api/panel/vitrine-photos'
};
const handlers = {};
const handlerOf = (name) => { if (!handlers[name]) handlers[name] = require('./api/panel/' + name); return handlers[name]; };

// Uma rota em memória: a resposta dela (status e corpo), sem passar pela rede.
function call(ctx, name, { method = 'POST', query = {}, body = undefined, headers = {} } = {}) {
  if (!ROUTES[name]) return Promise.reject(Object.assign(new Error('ASSISTANT_ROUTE_UNKNOWN'), { code: 'ASSISTANT_ROUTE_UNKNOWN' }));
  return new Promise((resolve) => {
    const search = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
    const req = { method, url: ROUTES[name] + (search ? '?' + search : ''), query, headers: { ...headers }, body, __mcsCtx: { ...ctx, __assistantData: undefined } };
    const res = {
      statusCode: 200, headers: {},
      setHeader(key, value) { this.headers[key] = value; return this; },
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
      end(payload) { let parsed = null; try { parsed = payload ? JSON.parse(String(payload)) : null; } catch (_) { parsed = null; } resolve({ status: this.statusCode, body: parsed }); return this; }
    };
    Promise.resolve(handlerOf(name)(req, res)).catch((error) => resolve({ status: 500, body: { error: (error && error.code) || 'ROUTE_FAILED' } }));
  });
}
// Igual a call, mas falha com o código da rota quando ela recusa.
async function must(ctx, name, options) {
  const out = await call(ctx, name, options);
  if (out.status >= 400 || !out.body || out.body.error) throw Object.assign(new Error((out.body && out.body.error) || 'ROUTE_FAILED'), { code: (out.body && out.body.error) || 'ROUTE_FAILED', status: out.status, body: out.body });
  return out.body;
}

module.exports = { ROUTES, call, must };
