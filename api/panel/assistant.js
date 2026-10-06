'use strict';

// Assistente do painel: uma conversa onde a Leo escreve do jeito dela e o assistente responde,
// encontra, explica e propõe. Ele lê o painel livremente (funções de leitura que rodam aqui, com os
// dados completos que a pergunta precisa). Qualquer ação volta só como PROPOSTA: nada é executado
// neste servidor; a ação roda no navegador, pelo mesmo caminho do botão normal, depois do toque da
// Leo em "Autorizar". "Não funcionou" aplica regras fixas, registra o chamado (panel_incidents) e
// pede a explicação à IA. Se a OpenAI falhar, o painel segue e o chamado é registrado mesmo assim.
//   POST { action: 'chat', message, history, context }    -> { reply, proposal, unavailable? }
//   POST { action: 'report', context, note }               -> { incident, diagnosis, reply, proposal }
//   POST { action: 'event', type, acao, payload, reason }  -> { ok }
//   POST { action: 'incident_status', id, status, prUrl }  -> { ok }
//   GET  ?incidents=1                                      -> { incidents }
const { allRows, isUuid, jsonBody, requirePanel, rows, rpc, insert, patchRows, safeText, send } = require('../../panel-server');
const openAiBudget = require('../../panel-openai-budget');

const MODEL = 'gpt-6-luna';
const PRICE = { input: 0.10, output: 0.50 };
const TIMEOUT_MS = 20000;
const MAX_ROUNDS = 5;
const MAX_TOOL_CHARS = 15000;
const VIEWS = { today: 'ATENDER AGORA', v1: 'V1', v2: 'V2', requests: 'BUSCAR CARROS', searches: 'ENVIAR OPÇÕES', imports: 'IMPORTAÇÕES', settings: 'Configurações' };

const SYSTEM = [
  'Você é o assistente do painel da My Car Scout, que compra carros em leilões de dealers nos EUA (Manheim) para clientes.',
  'Quem fala com você é a Leo, dona da empresa e única operadora. Responda em português, curto e direto, sem enrolação.',
  'Abas: ATENDER AGORA (quem responder agora), V1 e V2 (vitrines enviadas: V1 é o link simples com "Show me this car", V2 é o detalhado com "I want to bid"), BUSCAR CARROS, ENVIAR OPÇÕES (fila de quem tem carros do lote para receber V1), IMPORTAÇÕES (CSV do Manheim) e Configurações.',
  'Busca POR CARRO: carro + anos + milhas. POR VALOR: carro + lance máximo. Carro com leilão passado sai sozinho das opções e da seleção.',
  'Use as funções para ler o painel antes de responder; nunca invente dado. Se não achar, diga que não achou.',
  'Para fazer algo (abrir ficha, abrir aba, recarregar, selecionar ou remover carro, gerar V1), chame propor_acao: a Leo vê a proposta e autoriza com um toque. Uma ação por vez. Você nunca fala com cliente.',
  'Quando algo não funcionou, use o contexto (últimos cliques e respostas do servidor). Na dúvida, é defeito do painel: diga em uma linha que é defeito e que virou chamado para o Claude.'
].join(' ');

const TOOLS = [
  { name: 'buscar_cliente', description: 'Procura clientes por nome, Ref (5 letras) ou telefone. Devolve journey_id, nome, Ref, telefone, status e etapa.', parameters: { type: 'object', properties: { termo: { type: 'string' } }, required: ['termo'], additionalProperties: false } },
  { name: 'ficha', description: 'Tudo da ficha de um cliente: dados, telefones, pedidos e critérios, dados da calculadora e as últimas mensagens de WhatsApp/SMS.', parameters: { type: 'object', properties: { journey_id: { type: 'string' } }, required: ['journey_id'], additionalProperties: false } },
  { name: 'opcoes', description: 'Carros do lote ativo que combinam com o pedido do cliente (POR CARRO e POR VALOR), com match_id, VIN, MMR, Lane/Run ou Buy Now, data do leilão e se está selecionado.', parameters: { type: 'object', properties: { journey_id: { type: 'string' } }, required: ['journey_id'], additionalProperties: false } },
  { name: 'vitrines', description: 'V1 e V2 já criadas para o cliente: quando, carros, se expirou e toques do cliente.', parameters: { type: 'object', properties: { journey_id: { type: 'string' } }, required: ['journey_id'], additionalProperties: false } },
  { name: 'lote', description: 'Estado do lote ativo do Manheim: quando subiu, quantos carros, quantos com combinação.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'chamados', description: 'Chamados abertos do painel ("Não funcionou").', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'propor_acao', description: 'Propõe uma ação para a Leo autorizar. acao: abrir_ficha (journey_id), abrir_aba (aba: today|v1|v2|requests|searches|imports|settings), recarregar, selecionar_carro (match_id), remover_carro (match_id), gerar_v1 (journey_id + match_ids dos carros já selecionados). resposta: uma frase curta para a Leo.',
    parameters: { type: 'object', properties: { acao: { type: 'string', enum: ['abrir_ficha', 'abrir_aba', 'recarregar', 'selecionar_carro', 'remover_carro', 'gerar_v1'] }, journey_id: { type: 'string' }, match_id: { type: 'string' }, match_ids: { type: 'array', items: { type: 'string' } }, aba: { type: 'string' }, resposta: { type: 'string' } }, required: ['acao'], additionalProperties: false } }
].map((fn) => ({ type: 'function', function: fn }));

const svc = (services = {}) => ({ rows: services.rows || rows, allRows: services.allRows || allRows, rpc: services.rpc || ((ctx, name, args) => rpc(ctx, name, args)), insert: services.insert || insert, ...services });
const env = (ctx) => 'eq.' + ctx.environment;
const carName = (p = {}) => [p.year, p.make, p.model, p.trim].filter(Boolean).join(' ');
const vinTail = (vin) => String(vin || '').trim().toUpperCase().slice(-6);

async function latestUpload(ctx, s) {
  if (s.latestUpload) return s.latestUpload(ctx);
  const { latestActiveUpload } = require('../../panel-manheim-state');
  return latestActiveUpload(ctx, 'id,uploaded_at,vehicle_count,matched_vehicle_count,lead_count').catch(() => null);
}

// ------------------------------------------------------------------ leituras
async function journeyWithContact(ctx, s, journeyId) {
  if (!isUuid(journeyId)) return null;
  const [journey] = await s.rows(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,stage,budget_cents,criteria_json,payment_text,created_at,updated_at', environment: env(ctx), id: 'eq.' + journeyId, limit: '1' });
  if (!journey) return null;
  const [contact] = journey.contact_id ? await s.rows(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: env(ctx), id: 'eq.' + journey.contact_id, limit: '1' }) : [];
  return { journey, contact: contact || null };
}
const phonesOf = async (ctx, s, contactIds) => contactIds.length ? s.allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current,retired_at', environment: env(ctx), contact_id: 'in.(' + contactIds.join(',') + ')' }) : [];

const READERS = {
  async buscar_cliente(ctx, s, args) {
    const term = String(args.termo || '').trim().slice(0, 80);
    if (!term) return { clientes: [] };
    const digits = term.replace(/\D/g, '');
    const ref = /^[A-Za-z0-9]{5}$/.test(term) ? term.toUpperCase() : null;
    const [byName, byRef, byAlias, byPhone] = await Promise.all([
      s.rows(ctx, 'contacts', { select: 'id,display_name', environment: env(ctx), display_name: 'ilike.*' + term.replace(/[*,()]/g, '') + '*', limit: '20' }).catch(() => []),
      ref ? s.rows(ctx, 'journeys', { select: 'id,contact_id', environment: env(ctx), reference_code: 'eq.' + ref, limit: '10' }).catch(() => []) : [],
      ref ? s.rows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env(ctx), ref_code: 'eq.' + ref, limit: '10' }).catch(() => []) : [],
      digits.length >= 4 ? s.rows(ctx, 'contact_phones', { select: 'contact_id', environment: env(ctx), phone_e164: 'ilike.*' + digits + '*', limit: '20' }).catch(() => []) : []
    ]);
    const contactIds = [...new Set([...byName.map((r) => r.id), ...byRef.map((r) => r.contact_id), ...byPhone.map((r) => r.contact_id)].filter(Boolean))].slice(0, 20);
    const journeyIds = new Set([...byRef.map((r) => r.id), ...byAlias.map((r) => r.journey_id)]);
    const journeys = (await Promise.all([
      contactIds.length ? s.allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,stage', environment: env(ctx), contact_id: 'in.(' + contactIds.join(',') + ')' }) : [],
      journeyIds.size ? s.allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,stage', environment: env(ctx), id: 'in.(' + [...journeyIds].join(',') + ')' }) : []
    ])).flat();
    const unique = [...new Map(journeys.map((j) => [j.id, j])).values()].slice(0, 10);
    const allContacts = [...new Set(unique.map((j) => j.contact_id).filter(Boolean))];
    const [contacts, phones] = await Promise.all([
      allContacts.length ? s.allRows(ctx, 'contacts', { select: 'id,display_name', environment: env(ctx), id: 'in.(' + allContacts.join(',') + ')' }) : [],
      phonesOf(ctx, s, allContacts)
    ]);
    const name = new Map(contacts.map((c) => [c.id, c.display_name]));
    return { clientes: unique.map((j) => ({ journey_id: j.id, nome: name.get(j.contact_id) || null, ref: j.reference_code || null, telefones: phones.filter((p) => p.contact_id === j.contact_id && !p.retired_at).map((p) => p.phone_e164 || p.phone_raw), status: j.status, etapa: j.stage })) };
  },
  async ficha(ctx, s, args) {
    const found = await journeyWithContact(ctx, s, args.journey_id);
    if (!found) return { erro: 'ficha não encontrada' };
    const { journey, contact } = found;
    const ref = journey.reference_code || null;
    const [phones, calc, links] = await Promise.all([
      phonesOf(ctx, s, contact ? [contact.id] : []),
      ref ? s.allRows(ctx, 'calc_runs', { select: 'created_at,zip,estado,lance,total,pagamento,idioma,whatsapp,origem,dados', 'dados->>ref': 'ilike.' + ref, order: 'created_at.desc' }).catch(() => []) : [],
      s.allRows(ctx, 'message_journeys', { select: 'message_id', environment: env(ctx), journey_id: 'eq.' + journey.id, undone_at: 'is.null' }).catch(() => [])
    ]);
    const messageIds = [...new Set(links.map((l) => l.message_id).filter(Boolean))].slice(-300);
    const messages = messageIds.length ? await s.allRows(ctx, 'messages', { select: 'direction,channel,body_text,occurred_at_utc', environment: env(ctx), id: 'in.(' + messageIds.join(',') + ')', order: 'occurred_at_utc.desc', limit: '30' }).catch(() => []) : [];
    return {
      journey_id: journey.id, nome: contact?.display_name || null, ref, status: journey.status, etapa: journey.stage,
      lance_maximo_usd: journey.budget_cents ? Math.round(journey.budget_cents / 100) : null, pagamento: journey.payment_text || null, criterios: journey.criteria_json || null,
      telefones: phones.filter((p) => !p.retired_at).map((p) => p.phone_e164 || p.phone_raw),
      calculadora: calc.slice(0, 5),
      mensagens: messages.slice(0, 30).reverse().map((m) => ({ de: m.direction === 'CUSTOMER' ? 'cliente' : 'MCS', canal: m.channel, quando: m.occurred_at_utc, texto: String(m.body_text || '').slice(0, 400) }))
    };
  },
  async opcoes(ctx, s, args) {
    if (!isUuid(args.journey_id)) return { erro: 'journey_id inválido' };
    const upload = await latestUpload(ctx, s);
    if (!upload) return { erro: 'sem lote ativo' };
    const keys = ['CARRO', 'VALOR'].map((mode) => `journey:${args.journey_id}:${mode}`);
    const [lists, chosen] = await Promise.all([
      Promise.all(keys.map((key) => s.rpc(ctx, 'panel_manheim_demand_options', { p_environment: ctx.environment, p_upload_id: upload.id, p_demand_key: key, p_after_rank: null, p_after_miles: null, p_after_id: null, p_limit: 15 }).catch(() => []))),
      s.allRows(ctx, 'manheim_option_selections', { select: 'match_id', environment: env(ctx), upload_id: 'eq.' + upload.id, status: 'eq.SELECTED', demand_key: 'in.(' + keys.join(',') + ')' }).catch(() => [])
    ]);
    const selected = new Set(chosen.map((r) => String(r.match_id)));
    const car = (m) => { const p = m.vehicle_json?.parsed || {}; const members = p.memberMatchIds || [m.id]; return { match_id: m.id, carro: carName(p), vin: p.vin || null, milhas: p.miles ?? null, mmr_usd: m.mmr_cents ? Math.round(m.mmr_cents / 100) : null, lane_run: p.lane && p.run ? `${p.lane}/${p.run}` : null, buy_now: p.buyNowPrice || null, leilao: p.startsAt || p.saleDate || null, local: p.locationDisplay || p.location || null, selecionado: members.some((id) => selected.has(String(id))) }; };
    return { lote: upload.id, por_carro: (lists[0] || []).map(car), por_valor: (lists[1] || []).map(car) };
  },
  async vitrines(ctx, s, args) {
    if (!isUuid(args.journey_id)) return { erro: 'journey_id inválido' };
    const list = await s.allRows(ctx, 'vitrines', { select: 'id,token,version,created_at,expires_at', environment: env(ctx), journey_id: 'eq.' + args.journey_id, order: 'created_at.desc', limit: '20' });
    if (!list.length) return { vitrines: [] };
    const idsIn = 'in.(' + list.map((v) => v.id).join(',') + ')';
    const [cars, events] = await Promise.all([
      s.allRows(ctx, 'vitrine_cars', { select: 'vitrine_id,vehicle_snapshot', environment: env(ctx), vitrine_id: idsIn }).catch(() => []),
      s.allRows(ctx, 'vitrine_events', { select: 'vitrine_id,event_type,created_at', environment: env(ctx), vitrine_id: idsIn }).catch(() => [])
    ]);
    const now = Date.now();
    return { vitrines: list.map((v) => ({ versao: v.version, criada: v.created_at, expirada: Date.parse(v.expires_at || 0) <= now, link: '/v/' + v.token, carros: cars.filter((c) => c.vitrine_id === v.id).map((c) => carName(c.vehicle_snapshot || {})), toques: events.filter((e) => e.vitrine_id === v.id && e.event_type === 'TAP').length, aberturas: events.filter((e) => e.vitrine_id === v.id && e.event_type === 'OPEN').length })) };
  },
  async lote(ctx, s) {
    const upload = await latestUpload(ctx, s);
    return upload ? { lote: upload.id, subiu_em: upload.uploaded_at || null, carros: upload.vehicle_count ?? null, carros_com_combinacao: upload.matched_vehicle_count ?? null, pessoas: upload.lead_count ?? null } : { lote: null };
  },
  async chamados(ctx, s) {
    const list = await s.allRows(ctx, 'panel_incidents', { select: 'id,fingerprint,severity,status,count,last_seen_at,diagnosis', environment: env(ctx), status: 'in.(ABERTO,EM_CORRECAO)', order: 'last_seen_at.desc', limit: '30' }).catch(() => []);
    return { chamados: list };
  }
};

// ------------------------------------------------------------------ propostas (nunca executadas aqui)
async function buildProposal(ctx, s, args) {
  const answer = (proposal) => ({ ...proposal, acao: args.acao, resposta: safeText(args.resposta, 300) || null });
  const who = (found) => `${found.contact?.display_name || 'Cliente'} (Ref ${found.journey.reference_code || '—'})`;
  if (args.acao === 'recarregar') return answer({ linha: 'Recarregar a aba atual', grava: false, params: {} });
  if (args.acao === 'abrir_aba') return VIEWS[args.aba] ? answer({ linha: 'Abrir a aba ' + VIEWS[args.aba], grava: false, params: { view: args.aba } }) : null;
  if (args.acao === 'abrir_ficha') {
    const found = await journeyWithContact(ctx, s, args.journey_id);
    return found ? answer({ linha: 'Abrir ficha · ' + who(found), grava: false, params: { journeyId: found.journey.id } }) : null;
  }
  if (args.acao === 'selecionar_carro' || args.acao === 'remover_carro') {
    if (!isUuid(args.match_id)) return null;
    const [m] = await s.rows(ctx, 'manheim_matches', { select: 'id,journey_id,demand_key,vehicle_json', environment: env(ctx), id: 'eq.' + args.match_id, limit: '1' });
    if (!m) return null;
    const found = m.journey_id ? await journeyWithContact(ctx, s, m.journey_id) : null;
    const p = m.vehicle_json?.parsed || {};
    return answer({ linha: `${args.acao === 'selecionar_carro' ? 'Selecionar carro' : 'Remover da seleção'} · ${found ? who(found) + ' · ' : ''}${carName(p)} · VIN final ${vinTail(p.vin)}`, grava: true, params: { matchId: m.id } });
  }
  if (args.acao === 'gerar_v1') {
    const found = await journeyWithContact(ctx, s, args.journey_id);
    const matchIds = Array.isArray(args.match_ids) ? [...new Set(args.match_ids.filter(isUuid))].slice(0, 12) : [];
    if (!found || !matchIds.length) return null;
    const matches = await s.rows(ctx, 'manheim_matches', { select: 'id,journey_id,demand_key,vehicle_json', environment: env(ctx), id: 'in.(' + matchIds.join(',') + ')', limit: String(matchIds.length) });
    if (matches.length !== matchIds.length || matches.some((m) => m.journey_id !== found.journey.id)) return null;
    const demandKey = matches[0].demand_key && /^journey:[0-9a-f-]{36}:(VALOR|CARRO)$/.test(matches[0].demand_key) ? matches[0].demand_key : null;
    const cars = matches.map((m) => `${carName(m.vehicle_json?.parsed || {})} (VIN final ${vinTail(m.vehicle_json?.parsed?.vin)})`);
    return answer({ linha: `Gerar V1 · ${who(found)} · ${cars.length} carro(s): ${cars.join(', ')}`, grava: true, params: { journeyId: found.journey.id, matchIds, ...(demandKey ? { demandKey } : {}) } });
  }
  return null;
}

// ------------------------------------------------------------------ OpenAI
async function callOpenAi(ctx, s, guard, body) {
  const budget = s.budget || openAiBudget;
  return budget.paidCall(guard, { modelId: MODEL, body, send: async (capped) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); if (timer.unref) timer.unref();
    try {
      const response = await (s.fetchImpl || fetch)('https://api.openai.com/v1/chat/completions', { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: JSON.stringify(capped) });
      if (!response.ok) throw await budget.openAiFailure(response);
      const payload = await response.json();
      const usage = { input: Number(payload?.usage?.prompt_tokens) || 0, output: Number(payload?.usage?.completion_tokens) || 0 };
      return { payload, costUsd: Math.ceil((usage.input * PRICE.input + usage.output * PRICE.output)) / 1e6 };
    } catch (failure) { if (failure && failure.name === 'AbortError') throw Object.assign(new Error('OPENAI_TIMEOUT'), { code: 'OPENAI_TIMEOUT' }); throw failure; }
    finally { clearTimeout(timer); }
  } });
}
// Only plain, short context from the browser: the last clicks and server answers.
function cleanContext(context) {
  const c = context && typeof context === 'object' ? context : {};
  const actions = Array.isArray(c.actions) ? c.actions.slice(-20).map((a) => Object.fromEntries(Object.entries(a || {}).filter(([k, v]) => ['kind', 'action', 'label', 'view', 'path', 'method', 'status', 'code', 'ms', 'at', 'message', 'disabled'].includes(k) && ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 300) : v]))) : [];
  return { view: safeText(c.view, 40) || null, version: safeText(c.version, 80) || null, detail: safeText(c.detail, 120) || null, actions };
}
const event = (ctx, s, type, extra = {}) => s.insert(ctx, 'panel_assistant_events', { environment: ctx.environment, created_by: ctx.panel?.id || null, event_type: type, ...extra }, false).catch(() => null);

async function chat(ctx, body, services = {}) {
  const s = svc(services);
  const message = safeText(body && body.message, 2000);
  if (!message) return { error: 'ASSISTANT_MESSAGE_REQUIRED' };
  const context = cleanContext(body.context);
  const history = Array.isArray(body.history) ? body.history.slice(-12).filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').map((h) => ({ role: h.role, content: h.content.slice(0, 2000) })) : [];
  const messages = [{ role: 'system', content: SYSTEM }, ...history, { role: 'user', content: JSON.stringify({ tela_atual: context.view ? VIEWS[context.view] || context.view : null, ficha_aberta: context.detail, ultimas_acoes: context.actions, mensagem: message }) }];
  const budget = s.budget || openAiBudget;
  const guard = budget.guard ? budget.guard(ctx, 'ASSISTENTE', 'chat:' + (ctx.panel?.id || '-'), s.budgetServices) : null;
  let cost = 0;
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const out = await callOpenAi(ctx, s, guard, { model: MODEL, messages, tools: TOOLS });
      cost += Number(out.costUsd) || 0;
      const reply = out.payload?.choices?.[0]?.message || {};
      const calls = Array.isArray(reply.tool_calls) ? reply.tool_calls : [];
      if (!calls.length) {
        const text = safeText(reply.content, 4000) || 'Não consegui responder agora';
        await event(ctx, s, 'PERGUNTA', { payload: { message, reply: text }, cost_usd: cost });
        return { reply: text, proposal: null };
      }
      messages.push({ role: 'assistant', content: reply.content || null, tool_calls: calls });
      for (const callItem of calls) {
        let args = {};
        try { args = JSON.parse(callItem.function?.arguments || '{}'); } catch (_) { args = {}; }
        const name = callItem.function?.name;
        if (name === 'propor_acao') {
          const proposal = await buildProposal(ctx, s, args).catch(() => null);
          if (proposal) {
            await event(ctx, s, 'PERGUNTA', { payload: { message }, cost_usd: cost });
            await event(ctx, s, 'PROPOSTA', { action: proposal.acao, payload: proposal });
            return { reply: proposal.resposta || safeText(reply.content, 2000) || proposal.linha, proposal };
          }
          messages.push({ role: 'tool', tool_call_id: callItem.id, content: JSON.stringify({ erro: 'ação não reconhecida ou dados não encontrados; não proponha de novo sem ler o painel' }) });
          continue;
        }
        const reader = READERS[name];
        const result = reader ? await reader(ctx, s, args).catch(() => ({ erro: 'leitura falhou' })) : { erro: 'função desconhecida' };
        messages.push({ role: 'tool', tool_call_id: callItem.id, content: JSON.stringify(result).slice(0, MAX_TOOL_CHARS) });
      }
    }
    return { reply: 'Não consegui concluir agora · tente perguntar de outro jeito', proposal: null };
  } catch (failure) {
    await event(ctx, s, 'ERRO', { payload: { message, code: failure && failure.code || 'OPENAI_FAILED' }, cost_usd: cost || null });
    return { reply: 'Assistente indisponível agora', proposal: null, unavailable: true };
  }
}

// ------------------------------------------------------------------ "Não funcionou"
const P0 = new Set(['v1-generate', 'v1-send', 'v2-build', 'v2-send', 'deposit']);
const P1 = new Set(['ficha-open', 'search', 'import-csv', 'refresh', 'select', 'remove', 'offer-select', 'offer-remove', 'today', 'v1', 'v2', 'requests', 'searches', 'imports']);
const severityOf = (action) => P0.has(action) ? 'P0' : P1.has(action) || /^offer-/.test(String(action || '')) ? 'P1' : 'P2';
const TECH_CODES = new Set(['REQUEST_TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR']);
const RULE_TEXT = { TECNICO: 'O servidor falhou ou demorou demais (falha técnica)', DEFEITO_TELA: 'Clique sem nenhuma resposta depois: provável defeito de tela', ERRO_JS: 'A tela deu erro depois do clique', NAO_SABEMOS: 'O servidor respondeu normalmente; causa ainda não identificada' };
function rulesDiagnosis(context) {
  const actions = (context && context.actions) || [];
  let index = -1;
  for (let i = actions.length - 1; i >= 0; i -= 1) if (actions[i].kind === 'click') { index = i; break; }
  const click = index >= 0 ? actions[index] : null;
  const after = index >= 0 ? actions.slice(index + 1) : actions;
  const requests = after.filter((a) => a.kind === 'request');
  if (requests.some((r) => Number(r.status) >= 500 || TECH_CODES.has(r.code))) return { categoria: 'TECNICO', texto: RULE_TEXT.TECNICO, click };
  const refused = requests.find((r) => Number(r.status) >= 400 && Number(r.status) !== 401 && r.code);
  if (refused) return { categoria: 'RECUSADO:' + String(refused.code).slice(0, 60), texto: 'O servidor recusou: ' + refused.code, click };
  if (after.some((a) => a.kind === 'error')) return { categoria: 'ERRO_JS', texto: RULE_TEXT.ERRO_JS, click };
  if (click && !requests.length && !after.some((a) => a.kind === 'view')) return { categoria: 'DEFEITO_TELA', texto: RULE_TEXT.DEFEITO_TELA, click };
  return { categoria: 'NAO_SABEMOS', texto: RULE_TEXT.NAO_SABEMOS, click };
}
async function report(ctx, body, services = {}) {
  const s = svc(services);
  const context = cleanContext(body && body.context);
  const rules = rulesDiagnosis(context);
  const action = rules.click?.action || 'sem-clique';
  const view = context.view || rules.click?.view || 'painel';
  const severity = severityOf(action);
  const fingerprint = `${view}|${action}|${rules.categoria}`.slice(0, 300);
  const diagnosis = { categoria: rules.categoria, texto: rules.texto, nota: safeText(body && body.note, 500) || null };
  const incident = await s.rpc(ctx, 'panel_incident_report', { p_environment: ctx.environment, p_actor_id: ctx.panel?.id || null, p_fingerprint: fingerprint, p_severity: severity, p_version: context.version, p_context: context, p_diagnosis: diagnosis });
  await event(ctx, s, 'CHAMADO', { incident_id: incident?.id || null, action, payload: { fingerprint, severity, categoria: rules.categoria } });
  const head = `Chamado registrado (${severity}${incident?.reopened ? ', reaberto' : incident?.count > 1 ? ', ' + incident.count + 'ª vez' : ''}) · ${rules.texto}`;
  const label = rules.click ? `cliquei em "${rules.click.label || rules.click.action}" na aba ${VIEWS[view] || view}` : 'algo não funcionou';
  const ai = await chat(ctx, { message: `Não funcionou: ${label}. ${diagnosis.nota || ''} Diagnóstico das regras: ${rules.texto}. Explique em até 2 frases e, se der para resolver agora, proponha a ação.`, context: body.context }, services);
  return { incident, diagnosis, reply: ai.unavailable ? head + ' · Assistente indisponível agora' : head + '\n' + ai.reply, proposal: ai.proposal || null };
}

// ------------------------------------------------------------------ eventos e chamados
async function recordEvent(ctx, body, services = {}) {
  const s = svc(services);
  const type = body && body.type;
  if (!['AUTORIZADA', 'RECUSADA'].includes(type)) return { error: 'ASSISTANT_EVENT_INVALID' };
  await s.insert(ctx, 'panel_assistant_events', { environment: ctx.environment, created_by: ctx.panel?.id || null, event_type: type, action: safeText(body.acao, 60) || null, payload: { proposal: body.payload && typeof body.payload === 'object' ? body.payload : null, reason: safeText(body.reason, 300) || null, result: safeText(body.result, 300) || null } }, false);
  return { ok: true };
}
async function incidents(ctx, services = {}) {
  const s = svc(services);
  const list = await s.allRows(ctx, 'panel_incidents', { select: 'id,fingerprint,severity,status,count,reopened_count,first_seen_at,last_seen_at,last_version,context,diagnosis,pr_url', environment: env(ctx), order: 'last_seen_at.desc', limit: '200' });
  return { incidents: list };
}
async function incidentStatus(ctx, body) {
  if (!isUuid(body.id) || !['ABERTO', 'EM_CORRECAO', 'CORRIGIDO', 'NAO_ERA_DEFEITO'].includes(body.status)) return { error: 'INCIDENT_INVALID' };
  const pr = typeof body.prUrl === 'string' && /^https:\/\/github\.com\//.test(body.prUrl) ? body.prUrl.slice(0, 300) : undefined;
  await patchRows(ctx, 'panel_incidents', { environment: env(ctx), id: 'eq.' + body.id }, { status: body.status, updated_at: new Date().toISOString(), ...(pr ? { pr_url: pr } : {}) });
  return { ok: true };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  try {
    if (req.method === 'GET') return send(res, 200, await incidents(ctx));
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 256 * 1024);
    const out = body.action === 'chat' ? await chat(ctx, body)
      : body.action === 'report' ? await report(ctx, body)
        : body.action === 'event' ? await recordEvent(ctx, body)
          : body.action === 'incident_status' ? await incidentStatus(ctx, body)
            : { error: 'ASSISTANT_ACTION_INVALID' };
    return send(res, out.error ? 400 : 200, out);
  } catch (error) {
    return send(res, 500, { error: 'ASSISTANT_UNAVAILABLE' });
  }
};
module.exports.chat = chat;
module.exports.report = report;
module.exports.rulesDiagnosis = rulesDiagnosis;
module.exports.severityOf = severityOf;
module.exports.buildProposal = buildProposal;
module.exports.recordEvent = recordEvent;
module.exports.TOOLS = TOOLS;
