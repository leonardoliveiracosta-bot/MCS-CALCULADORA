'use strict';

// Registro leve das rotas do painel para a auditoria do assistente ("tem algo quebrado?"): só o que
// importa para achar defeito, nunca conteúdo de cliente. Grava erro de servidor (5xx) e resposta
// lenta (mais de SLOW_MS); o resto não ocupa o banco. Nunca atrasa nem derruba a resposta.
const SLOW_MS = 2500;
const START = Symbol('mcsRequestStart');

function pathOf(req) {
  const raw = String((req && (req.url || req.path)) || '');
  return raw.split('?')[0].slice(0, 120) || null;
}

function start(req, res) {
  if (!res || typeof res !== 'object') return;
  res[START] = { at: Date.now(), path: pathOf(req), method: String((req && req.method) || 'GET').toUpperCase().slice(0, 8) };
}

function config() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  const environment = process.env.VERCEL_ENV === 'production' ? 'production' : process.env.VERCEL_ENV === 'preview' ? 'preview' : null;
  return url && key && environment ? { url: url.replace(/\/$/, ''), key, environment } : null;
}

// Grava fora do modo simulação (o registro do teste também é verdade) e sem esperar.
function write(row) {
  const cfg = config();
  if (!cfg) return null;
  const dryRun = require('./panel-dry-run');
  const task = dryRun.storage.exit(() => fetch(cfg.url + '/rest/v1/panel_request_log', {
    method: 'POST',
    headers: { apikey: cfg.key, authorization: 'Bearer ' + cfg.key, 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ environment: cfg.environment, ...row })
  }).catch(() => null));
  try { require('@vercel/functions').waitUntil(task); } catch (_) {}
  return task;
}

function finish(res, status, payload) {
  const begun = res && res[START];
  if (!begun) return null;
  res[START] = null;
  const ms = Date.now() - begun.at;
  if (Number(status) < 500 && ms < SLOW_MS) return null;
  const code = payload && typeof payload === 'object' && typeof payload.error === 'string' ? payload.error.slice(0, 80) : null;
  const dry = require('./panel-dry-run').active();
  return write({ source: 'server', path: begun.path, method: begun.method, status: Number(status) || null, ms, code, detail: dry ? { dryRun: true } : {} });
}

// Falhas vistas no navegador (pedido que falhou, erro de tela), enviadas pelo painel em lote.
function clientRows(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map((item) => {
    const entry = item && typeof item === 'object' ? item : {};
    const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
    return {
      source: 'client', path: text(entry.path, 120), method: text(entry.method, 8), status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : null,
      ms: Number.isFinite(Number(entry.ms)) ? Math.round(Number(entry.ms)) : null, code: text(entry.code, 80),
      detail: { kind: text(entry.kind, 20), view: text(entry.view, 40), label: text(entry.label, 80), message: text(entry.message, 300), version: text(entry.version, 40) }
    };
  });
}

module.exports = { SLOW_MS, start, finish, write, clientRows };
