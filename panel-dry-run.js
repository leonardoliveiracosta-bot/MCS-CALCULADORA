'use strict';

// Modo simulação (dryRun) das rotas do painel: a rota roda de verdade (entrada, sessão, permissão e
// leituras), mas nada é gravado nem enviado. Liga com o cabeçalho "x-mcs-dry-run: 1" (o teste de
// botões do assistente e o teste das ações). Um único ponto barra tudo, sem lógica por rota:
// - toda chamada de rede que não é leitura (fetch com método diferente de GET/HEAD) para na hora,
//   menos as funções do banco que o Postgres garante que só leem (STABLE/IMMUTABLE, lista abaixo);
// - push e fila (que não usam fetch) checam active() antes de enviar;
// - send() do panel-server devolve o que a rota faria ({ dryRun, wouldDo }) em vez de gravar.
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const HEADER = 'x-mcs-dry-run';

// Funções do banco que só leem (STABLE/IMMUTABLE no Postgres, que proíbe escrita nelas). Qualquer
// outra função é tratada como gravação.
const READ_ONLY_RPCS = new Set(('calc_public_stats,panel_ai_balance_state,panel_ai_spent_since,panel_anthropic_today_spend,panel_boot_history_batch,'
  + 'panel_boot_table_rows,panel_calc_name,panel_calc_route_pending,panel_calc_run_candidates,panel_calc_template_text,panel_identity_evidence,'
  + 'panel_journey_calc_templates,panel_journey_chat_latest,panel_journey_explicit_refs,panel_journey_message_facts,panel_journey_names,'
  + 'panel_manheim_active_upload_id,panel_manheim_audit_selected_options,panel_manheim_batch_cars,panel_manheim_batch_demand_options,'
  + 'panel_manheim_batch_overview,panel_manheim_batch_people,panel_manheim_batch_summary,panel_manheim_batch_summary_v2,panel_manheim_batch_top_options,'
  + 'panel_manheim_complement_check,panel_manheim_complement_guard,panel_manheim_complement_items,panel_manheim_complement_result,'
  + 'panel_manheim_demand_options,panel_manheim_grouped_light,panel_manheim_grouped_matches,panel_manheim_grouped_options,panel_manheim_manifest_valid,'
  + 'panel_manheim_offer_cr,panel_manheim_offer_cr_min,panel_manheim_offer_default_pct,panel_manheim_offer_expired,panel_manheim_offer_group,'
  + 'panel_manheim_offer_ids,panel_manheim_offer_ids_v2,panel_manheim_offer_mmr,panel_manheim_offer_page,panel_manheim_offer_page_bundle,'
  + 'panel_manheim_offer_page_sorted,panel_manheim_offer_page_trim,panel_manheim_offer_summary,panel_manheim_offer_trims,panel_manheim_sale_active,'
  + 'panel_manheim_score_mmr,panel_manheim_trim_key,panel_message_at,panel_model_dictionary,panel_name_link_candidates,panel_normalize_phone,'
  + 'panel_openai_budget_state,panel_openai_spent_usd,panel_request_patch,panel_sms_print_moment,panel_subject_candidates').split(','));

const requested = (req) => String((req && req.headers && (req.headers[HEADER] || req.headers[HEADER.toUpperCase()])) || '') === '1';
const active = () => Boolean(storage.getStore());
const store = () => storage.getStore() || null;

// Chamado no começo síncrono do requirePanel: o resto do pedido (inclusive depois do await) roda no modo.
function begin(req) {
  if (!requested(req)) return null;
  const state = { wouldDo: [], stopped: false };
  storage.enterWith(state);
  return state;
}

function describe(method, url) {
  try {
    const parsed = new URL(url);
    const rest = parsed.pathname.match(/^\/rest\/v1\/rpc\/([a-z0-9_]+)/i);
    if (rest) return { tipo: 'funcao_do_banco', alvo: rest[1], metodo: method };
    const table = parsed.pathname.match(/^\/rest\/v1\/([a-z0-9_]+)/i);
    if (table) return { tipo: method === 'DELETE' ? 'apagar' : method === 'PATCH' ? 'alterar' : 'gravar', alvo: table[1], metodo: method };
    if (/\/storage\/v1\//.test(parsed.pathname)) return { tipo: 'arquivo', alvo: parsed.pathname.split('/').slice(4, 6).join('/'), metodo: method };
    return { tipo: 'envio_externo', alvo: parsed.host, metodo: method };
  } catch (_) { return { tipo: 'envio_externo', alvo: String(url).slice(0, 80), metodo: method }; }
}

// Para a operação e anota o que seria feito.
function stop(state, what) {
  state.stopped = true;
  if (state.wouldDo.length < 20) state.wouldDo.push(what);
  return Object.assign(new Error('DRY_RUN_STOP'), { code: 'DRY_RUN_STOP', dryRun: true });
}

// Envio sem fetch (push, fila): chama antes de enviar.
function guard(label) {
  const state = store();
  if (!state) return false;
  stop(state, { tipo: 'envio_externo', alvo: label, metodo: 'SEND' });
  return true;
}

let installed = false;
function install() {
  if (installed || typeof globalThis.fetch !== 'function') return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    const state = storage.getStore();
    if (!state) return original.call(this, input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return original.call(this, input, init);
    const rpcName = (/\/rest\/v1\/rpc\/([a-z0-9_]+)/i.exec(url) || [])[1];
    if (rpcName && READ_ONLY_RPCS.has(rpcName)) return original.call(this, input, init);
    return Promise.reject(stop(state, describe(method, url)));
  };
}
install();

// A resposta do pedido em modo simulação: o que faria (parou na primeira gravação ou envio) ou o
// motivo pelo qual recusaria (a própria resposta da rota, com status).
function response(status, payload) {
  const state = store();
  if (!state) return null;
  // A rota caiu na gravação barrada: chegou até ela, então entrada, sessão e leituras passaram.
  if (state.stopped && Number(status) >= 500) return { status: 200, payload: { dryRun: true, ok: true, validated: true, wouldDo: state.wouldDo } };
  // A rota respondeu (com ou sem gravação acessória barrada no caminho): a resposta dela, marcada.
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { data: payload };
  return { status, payload: { ...body, dryRun: true, ok: Number(status) < 400, validated: Number(status) < 400, wouldDo: state.wouldDo.slice() } };
}

module.exports = { HEADER, READ_ONLY_RPCS, active, begin, guard, install, requested, response, storage, store };
