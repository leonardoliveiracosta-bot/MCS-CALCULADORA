'use strict';

// Assistente do painel: uma conversa onde a Leo escreve do jeito dela e o assistente responde,
// encontra, explica e propõe. Ele lê o painel livremente (funções de leitura que rodam aqui, com os
// dados completos que a pergunta precisa; a IA pede cada leitura no mesmo formato JSON que o resto do
// painel já usa com a OpenAI). Qualquer ação volta só como PROPOSTA: nada é executado neste servidor; a ação roda no navegador, pelo mesmo caminho do botão normal, depois do toque da
// Leo em "Autorizar". "Não funcionou" só diagnostica e propõe. O chamado nasce apenas após autorização.
//   POST { action: 'chat', message, history, context }    -> { reply, proposal, unavailable? }
//   POST { action: 'report', context, note }               -> { incident, diagnosis, reply, proposal }
//   POST { action: 'event', type, acao, payload, reason }  -> { ok }
//   POST { action: 'incident_status', id, status, prUrl }  -> { ok }
//   GET  ?incidents=1                                      -> { incidents }
const { allRows, isUuid, jsonBody, requirePanel, rows, rpc, insert, patchRows, safeText, send } = require('../../panel-server');
const openAiBudget = require('../../panel-openai-budget');
const vehicleMatch = () => require('../../vehicle-match');
const manheimOffer = () => require('../../manheim-offer');
const v1sent = () => require('../../panel-v1-sent');

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
  'REGRA PRINCIPAL: a ÚLTIMA mensagem da Leo é a tarefa atual e tem prioridade absoluta. Identifique primeiro o pedido atual. Histórico e telemetria servem apenas para cumprir esse pedido; nunca continue a tarefa anterior quando a última mensagem iniciou outra.',
  'Se a Leo enviar lista, checklist, auditoria ou instrução com vários itens, trate como nova tarefa completa. Não responda usando só o erro técnico anterior.',
  'Use as funções para ler o painel antes de responder quando a pergunta depender de dados; nunca invente dado. Se não achar, diga que não achou.',
  'Não confunda sintoma com causa. Request lento prova lentidão, não prova a causa. Só diga identifiquei a causa quando houver evidência da causa específica.',
  'Antes de responder, confira se a resposta atende diretamente a última mensagem da Leo. Se não atender, corrija antes de entregar.'
  'Para fazer algo (abrir ficha, abrir aba, voltar, recarregar, selecionar ou remover carro, gerar V1, comparar de novo, registrar chamado), chame propor_acao: a Leo vê a proposta e autoriza com um toque. Uma ação por vez. Você nunca fala com cliente.',
  'Quando algo não funcionou, use o contexto. Nunca diga que virou chamado antes da Leo autorizar. Se precisar, proponha registrar_chamado uma única vez.',
  'FORMATO: responda sempre só o JSON pedido. tipo "ler" para consultar o painel (funcao + argumentos); o resultado volta na mensagem seguinte. tipo "propor" para uma ação (acao + argumentos; texto = frase curta para a Leo). tipo "responder" para a resposta final em texto.',
  'Funções de leitura: buscar_cliente (termo: nome, Ref de 5 letras ou telefone; devolve journey_id, nome, Ref, telefones, status); ficha (journey_id: dados, telefones, critérios, calculadora, últimas mensagens); opcoes (journey_id: carros do lote ativo com match_id, VIN, MMR, Lane/Run ou Buy Now, leilão e se está selecionado); vitrines (journey_id: V1/V2 criadas, carros, expirada, toques); lote (estado do lote ativo); chamados (chamados abertos); diagnosticar_opcoes (journey_id + termo opcional: por que cada carro do lote não aparece para a pessoa, agrupado por motivo); diagnosticar_falha (aplica as regras do "Não funcionou" no contexto atual, só explica); eventos (tipo opcional: PERGUNTA, PROPOSTA, AUTORIZADA, RECUSADA, CHAMADO, ERRO; lê o histórico do assistente); conferir_harmonia (journey_id opcional: divergências entre abas, só leitura).',
  'Ações: abrir_ficha (journey_id), abrir_aba (aba: today|v1|v2|requests|searches|imports|settings), voltar, recarregar, selecionar_carro (match_id), remover_carro (match_id), gerar_v1 (journey_id + match_ids dos carros já selecionados), retomar_busca (journey_id: compara de novo a pessoa com o lote), registrar_chamado (termo: resumo do defeito; registra o chamado).'
].join(' ');

// One step of the conversation, in the json_schema format every other panel feature already uses
// (strict: every field present, null when unused). No native OpenAI tools.
const STEP_SCHEMA = { name: 'assistente_passo', strict: true, schema: { type: 'object', additionalProperties: false,
  required: ['tipo', 'texto', 'funcao', 'acao', 'journey_id', 'match_id', 'match_ids', 'aba', 'termo'],
  properties: {
    tipo: { type: 'string', enum: ['responder', 'ler', 'propor'] },
    texto: { type: 'string' },
    funcao: { type: ['string', 'null'], enum: ['buscar_cliente', 'ficha', 'opcoes', 'vitrines', 'lote', 'chamados', 'diagnosticar_opcoes', 'diagnosticar_falha', 'eventos', 'conferir_harmonia', null] },
    acao: { type: ['string', 'null'], enum: ['abrir_ficha', 'abrir_aba', 'voltar', 'recarregar', 'selecionar_carro', 'remover_carro', 'gerar_v1', 'retomar_busca', 'registrar_chamado', null] },
    journey_id: { type: ['string', 'null'] }, match_id: { type: ['string', 'null'] },
    match_ids: { type: ['array', 'null'], items: { type: 'string' } }, aba: { type: ['string', 'null'] }, termo: { type: ['string', 'null'] }
  } } };

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

// Primeiro portão que barra o carro, na ordem do painel. Devolve o motivo curto ou null se passa.
function diagnoseExclusion(parsed, demands, acceptAny, vm, offer) {
  const vehicle = parsed || {};
  if (offer.carExpired(vehicle)) return 'leilão passado';
  if (!vm.hasValidMmr(vehicle)) return 'sem MMR para comparar';
  if (!vm.qualityEligible(vehicle, { acceptAnyTitleCondition: acceptAny })) {
    if (!vm.saleEligible(vehicle)) return 'sem Lane/Run (não está à venda)';
    const grade = vm.conditionGrade(vehicle);
    if (grade !== null && grade < 1.9) return 'CR abaixo de 1.9';
    return 'título bloqueia (salvage/rebuilt)';
  }
  const matchC = vm.matchDemand(vehicle, demands.CARRO);
  const matchV = vm.matchDemand(vehicle, demands.VALOR);
  if (matchC || matchV) return null;
  return diagnoseCriteria(vehicle, demands.CARRO.wishes, vm);
}
function diagnoseCriteria(vehicle, wishes, vm) {
  for (const wish of wishes || []) {
    if (!vm.sameVehicle(vehicle, wish)) continue;
    const year = vm.positive(vehicle.year);
    const yearMin = vm.positive(wish.yearMin);
    const yearMax = vm.positive(wish.yearMax);
    if (year && yearMin && year < yearMin) return `ano ${year} abaixo do pedido (${yearMin}-${yearMax || '?'})`;
    if (year && yearMax && year > yearMax) return `ano ${year} acima do pedido (${yearMin || '?'}-${yearMax})`;
    const miles = vm.integer(vehicle.miles);
    const minMiles = vm.integer(wish.minMiles);
    const maxMiles = vm.integer(wish.maxMiles);
    if (miles !== null && minMiles !== null && miles < minMiles) return `milhas ${miles} abaixo do pedido (mín ${minMiles})`;
    if (miles !== null && maxMiles !== null && miles > maxMiles) return `milhas ${miles} acima do pedido (máx ${maxMiles})`;
    return 'bate no modelo mas não nos critérios (ver ficha)';
  }
  return 'modelo não combina com o pedido';
}

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
  },
  async diagnosticar_opcoes(ctx, s, args) {
    const journeyId = args.journey_id;
    if (!isUuid(journeyId)) return { erro: 'journey_id inválido' };
    const found = await journeyWithContact(ctx, s, journeyId);
    if (!found) return { erro: 'ficha não encontrada' };
    const upload = await latestUpload(ctx, s);
    if (!upload) return { erro: 'sem lote ativo' };
    const criteria = found.journey.criteria_json || {};
    const wishlists = Array.isArray(criteria.wishlists) ? criteria.wishlists : [];
    if (!wishlists.length) return { erro: 'sem critérios na ficha' };
    const vm = vehicleMatch();
    const offer = manheimOffer();
    const bidCents = found.journey.budget_cents || null;
    const acceptAny = criteria.acceptAnyTitleCondition === true;
    const demands = { CARRO: { mode: 'CARRO', wishes: wishlists, bidCents }, VALOR: { mode: 'VALOR', wishes: wishlists, bidCents } };
    const demandKeys = [`journey:${journeyId}:CARRO`, `journey:${journeyId}:VALOR`];
    const syncs = await s.allRows(ctx, 'manheim_demand_syncs', { select: 'demand_key,synced_at', environment: env(ctx), upload_id: 'eq.' + upload.id, demand_key: 'in.(' + demandKeys.join(',') + ')' }).catch(() => []);
    const syncByKey = new Map(syncs.map((r) => [r.demand_key, r.synced_at]));
    const journeyUpdated = found.journey.updated_at || null;
    const sincronia = demandKeys.map((key) => {
      const syncedAt = syncByKey.get(key);
      const modo = key.endsWith(':CARRO') ? 'CARRO' : 'VALOR';
      if (!syncedAt) return { modo, estado: 'ainda não comparado · use "Comparar de novo"' };
      const changed = journeyUpdated && Date.parse(journeyUpdated) > Date.parse(syncedAt);
      return { modo, estado: 'comparado em ' + syncedAt + (changed ? ' · ficha alterada depois, compare de novo' : '') };
    });
    const termo = String(args.termo || '').trim().toLowerCase();
    const matches = await s.allRows(ctx, 'manheim_matches', { select: 'id,mmr_cents,vehicle_json', environment: env(ctx), upload_id: 'eq.' + upload.id, undone_at: 'is.null', order: 'created_at.desc', limit: '500' }).catch(() => []);
    let cars = matches.map((m) => {
      const parsed = (m.vehicle_json && m.vehicle_json.parsed) || {};
      return { parsed: { ...parsed, mmrCents: parsed.mmrCents ?? m.mmr_cents ?? null } };
    });
    if (termo) {
      cars = cars.filter((c) => {
        const p = c.parsed;
        return [p.year, p.make, p.model, p.trim, p.vin].filter(Boolean).join(' ').toLowerCase().includes(termo);
      });
    }
    const limited = cars.slice(0, 60);
    const byReason = new Map();
    for (const car of limited) {
      const reason = diagnoseExclusion(car.parsed, demands, acceptAny, vm, offer);
      if (!reason) continue;
      if (!byReason.has(reason)) byReason.set(reason, { total: 0, exemplos: [] });
      const entry = byReason.get(reason);
      entry.total += 1;
      if (entry.exemplos.length < 3) entry.exemplos.push({ carro: carName(car.parsed), vin: car.parsed.vin || null });
    }
    return {
      pessoa: { nome: found.contact?.display_name || null, ref: found.journey.reference_code || null },
      lote: upload.id, sincronia, carros_analisados: limited.length,
      ...(termo && !limited.length ? { aviso: 'nenhum carro do lote bate com o termo' } : {}),
      por_motivo: [...byReason.entries()].map(([motivo, v]) => ({ motivo, total: v.total, exemplos: v.exemplos }))
    };
  },
  async diagnosticar_falha(ctx, s, args, context) {
    const LERDO_MS = 8000;
    const rules = rulesDiagnosis(context);
    if (rules.categoria === 'TECNICO' || String(rules.categoria).startsWith('RECUSADO')) {
      return { categoria: rules.categoria, texto: rules.texto, clique: rules.click ? { acao: rules.click.action, rotulo: rules.click.label || null } : null };
    }
    const actions = (context && context.actions) || [];
    const slow = actions.filter((a) => a.kind === 'request' && Number(a.ms) > LERDO_MS).slice(-5);
    if (slow.length) {
      return { categoria: 'LERDO', texto: 'Resposta lenta do servidor (mais de 8 segundos)', requests_lentos: slow.map((r) => ({ path: r.path || null, method: r.method || null, ms: r.ms, status: r.status || r.code || null })), clique: rules.click ? { acao: rules.click.action, rotulo: rules.click.label || null } : null };
    }
    return { categoria: rules.categoria, texto: rules.texto, clique: rules.click ? { acao: rules.click.action, rotulo: rules.click.label || null } : null };
  },
  async eventos(ctx, s, args) {
    const tipo = String(args.termo || '').trim().toUpperCase();
    const valid = ['PERGUNTA', 'PROPOSTA', 'AUTORIZADA', 'RECUSADA', 'CHAMADO', 'ERRO'];
    const list = await s.allRows(ctx, 'panel_assistant_events', { select: 'event_type,action,created_at,payload', environment: env(ctx), ...(valid.includes(tipo) ? { event_type: 'eq.' + tipo } : {}), order: 'created_at.desc', limit: '30' }).catch(() => []);
    return { eventos: list.map((e) => ({ tipo: e.event_type, acao: e.action || null, quando: e.created_at, detalhe: e.payload || null })) };
  },
  async conferir_harmonia(ctx, s, args) {
    const journeyId = args.journey_id;
    const upload = await latestUpload(ctx, s);
    if (!upload) return { erro: 'sem lote ativo' };
    const offer = manheimOffer();
    const divergencias = [];
    if (journeyId && isUuid(journeyId)) {
      const keys = [`journey:${journeyId}:CARRO`, `journey:${journeyId}:VALOR`];
      const [selections, optionsLists] = await Promise.all([
        s.allRows(ctx, 'manheim_option_selections', { select: 'match_id,demand_key', environment: env(ctx), upload_id: 'eq.' + upload.id, status: 'eq.SELECTED', demand_key: 'in.(' + keys.join(',') + ')' }).catch(() => []),
        Promise.all(keys.map((key) => s.rpc(ctx, 'panel_manheim_demand_options', { p_environment: ctx.environment, p_upload_id: upload.id, p_demand_key: key, p_after_rank: null, p_after_miles: null, p_after_id: null, p_limit: 50 }).catch(() => [])))
      ]);
      const optionIds = new Set(optionsLists.flat().map((m) => String(m.id)));
      for (const sel of selections) {
        if (optionIds.has(String(sel.match_id))) continue;
        const [m] = await s.rows(ctx, 'manheim_matches', { select: 'vehicle_json', environment: env(ctx), id: 'eq.' + sel.match_id, limit: '1' }).catch(() => []);
        const parsed = (m && m.vehicle_json && m.vehicle_json.parsed) || {};
        divergencias.push({ tipo: 'selecao_sem_opcao', carro: carName(parsed), vin: parsed.vin || null, motivo: offer.carExpired(parsed) ? 'leilão passado' : 'não é mais opção válida' });
        if (divergencias.length >= 20) break;
      }
      const found = await journeyWithContact(ctx, s, journeyId);
      if (found) {
        const vitrines = await s.allRows(ctx, 'vitrines', { select: 'id,token,version,created_at,expires_at', environment: env(ctx), journey_id: 'eq.' + journeyId, order: 'created_at.desc', limit: '10' }).catch(() => []);
        if (vitrines.length) {
          const idsIn = 'in.(' + vitrines.map((v) => v.id).join(',') + ')';
          const [cars, links] = await Promise.all([
            s.allRows(ctx, 'vitrine_cars', { select: 'vitrine_id,vehicle_snapshot', environment: env(ctx), vitrine_id: idsIn }).catch(() => []),
            s.allRows(ctx, 'message_journeys', { select: 'message_id', environment: env(ctx), journey_id: 'eq.' + journeyId, undone_at: 'is.null' }).catch(() => [])
          ]);
          const messageIds = [...new Set(links.map((l) => l.message_id).filter(Boolean))].slice(-200);
          const messages = messageIds.length ? await s.allRows(ctx, 'messages', { select: 'id,direction,body_text,occurred_at_utc', environment: env(ctx), id: 'in.(' + messageIds.join(',') + ')' }).catch(() => []) : [];
          const sent = v1sent().sentByLink({ messages, vitrines, cars });
          const sentIds = new Set(sent.map((x) => x.vitrineId));
          const now = Date.now();
          for (const v of vitrines) {
            if (Date.parse(v.expires_at || 0) <= now) divergencias.push({ tipo: 'vitrine_expirada', versao: v.version, criada: v.created_at });
            else if (!sentIds.has(v.id)) divergencias.push({ tipo: 'vitrine_nao_enviada', versao: v.version, criada: v.created_at });
            if (divergencias.length >= 20) break;
          }
        }
        const syncs = await s.allRows(ctx, 'manheim_demand_syncs', { select: 'demand_key', environment: env(ctx), upload_id: 'eq.' + upload.id, demand_key: 'in.(' + keys.join(',') + ')' }).catch(() => []);
        const synced = new Set(syncs.map((r) => r.demand_key));
        for (const key of keys) {
          if (!synced.has(key)) divergencias.push({ tipo: 'criterio_nao_comparado', modo: key.endsWith(':CARRO') ? 'CARRO' : 'VALOR' });
        }
      }
    } else {
      const { staleDemandKeys } = require('../../panel-rematch');
      const stale = await staleDemandKeys(ctx).catch(() => null);
      return { resumo: true, lote: upload.id, demandas_nao_comparadas: stale ? stale.keys.length : null, detalhe: 'informe a pessoa (journey_id) para as divergências dela' };
    }
    return { divergencias: divergencias.slice(0, 20) };
  }
};

// ------------------------------------------------------------------ propostas (nunca executadas aqui)
async function buildProposal(ctx, s, args) {
  const answer = (proposal) => ({ ...proposal, acao: args.acao, resposta: safeText(args.resposta, 300) || null });
  const who = (found) => `${found.contact?.display_name || 'Cliente'} (Ref ${found.journey.reference_code || '—'})`;
  if (args.acao === 'recarregar') return answer({ linha: 'Recarregar a aba atual', grava: false, params: {} });
  if (args.acao === 'voltar') return answer({ linha: 'Voltar para a tela anterior', grava: false, params: {} });
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
  if (args.acao === 'retomar_busca') {
    const found = await journeyWithContact(ctx, s, args.journey_id);
    if (!found) return null;
    const upload = await latestUpload(ctx, s);
    if (!upload) return null;
    const keys = [`journey:${found.journey.id}:CARRO`, `journey:${found.journey.id}:VALOR`];
    const existing = await s.allRows(ctx, 'manheim_matches', { select: 'demand_key', environment: env(ctx), upload_id: 'eq.' + upload.id, demand_key: 'in.(' + keys.join(',') + ')', limit: '2' }).catch(() => []);
    const demandKeys = [...new Set(existing.map((r) => r.demand_key))];
    if (!demandKeys.length) return null;
    return answer({ linha: `Comparar de novo · ${who(found)}`, grava: true, params: { journeyId: found.journey.id, demandKeys } });
  }
  if (args.acao === 'registrar_chamado') {
    const note = safeText(args.termo || args.texto, 300) || 'defeito diagnosticado no chat';
    return answer({ linha: `Registrar chamado · ${note.slice(0, 80)}`, grava: true, params: { note } });
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
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const failure = await (budget.openAiFailure || openAiBudget.openAiFailure)({ status: response.status, text: async () => detail });
        throw Object.assign(failure, { status: response.status, detail: String(detail).slice(0, 500) });
      }
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
const TECHNICAL_FOLLOWUP = /^(identifique|investigue|continue|aprofund|qual .*causa|por que|porque|o que aconteceu|isso quebrou|esta quebrado|está quebrado)/i;
const NEW_TASK_HINT = /(?:verifique|confira|audite|analise|faça|faca|crie|corrija|procure|liste|compare|execute|preciso|quero|o que precisa conferir|todo botão|toda tela|listas grandes)/i;
function currentIntent(message) {
  const text = String(message || '').trim();
  const numbered = /(?:^|\n)\s*\d+[.)]\s+/m.test(text);
  const multiLine = text.split(/\n/).filter((line) => line.trim()).length >= 4;
  const explicitNewTask = NEW_TASK_HINT.test(text) || numbered || multiLine || text.length > 450;
  return { explicitNewTask, technicalFollowup: !explicitNewTask && TECHNICAL_FOLLOWUP.test(text), numbered, multiLine };
}
function relevantHistory(history, message) { return currentIntent(message).explicitNewTask ? [] : history; }
function responseAnswersCurrent(message, reply) {
  const intent = currentIntent(message), text = String(reply || '').trim();
  if (!text) return false;
  if (intent.numbered) {
    const requested = (String(message).match(/(?:^|\n)\s*\d+[.)]\s+/gm) || []).length;
    const covered = (text.match(/(?:^|\n)\s*\d+[.)]\s+/gm) || []).length;
    if (requested >= 3 && covered === 0 && text.length < 300) return false;
  }
  return true;
}
const event = (ctx, s, type, extra = {}) => s.insert(ctx, 'panel_assistant_events', { environment: ctx.environment, created_by: ctx.panel?.id || null, event_type: type, ...extra }, false).catch(() => null);

async function chat(ctx, body, services = {}) {
  const s = svc(services);
  const message = safeText(body && body.message, 2000);
  if (!message) return { error: 'ASSISTANT_MESSAGE_REQUIRED' };
  const context = cleanContext(body.context);
  const rawHistory = Array.isArray(body.history) ? body.history.slice(-12).filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string').map((h) => ({ role: h.role, content: h.content.slice(0, 2000) })) : [];
  const intent = currentIntent(message);
  const history = relevantHistory(rawHistory, message);
  const telemetry = intent.explicitNewTask ? [] : context.actions;
  const messages = [{ role: 'system', content: SYSTEM }, ...history, { role: 'user', content: JSON.stringify({ tarefa_atual: message, nova_tarefa: intent.explicitNewTask, tela_atual: context.view ? VIEWS[context.view] || context.view : null, ficha_aberta: context.detail, telemetria_relevante: telemetry, regra: 'Responda a tarefa_atual. Não continue assunto anterior salvo se tarefa_atual pedir isso.' }) }];
  const budget = s.budget || openAiBudget;
  const guard = budget.guard ? budget.guard(ctx, 'ASSISTENTE', 'chat:' + (ctx.panel?.id || '-'), s.budgetServices) : null;
  let cost = 0;
  try {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const out = await callOpenAi(ctx, s, guard, { model: MODEL, messages, response_format: { type: 'json_schema', json_schema: STEP_SCHEMA } });
      cost += Number(out.costUsd) || 0;
      const content = out.payload?.choices?.[0]?.message?.content || '';
      let stepOut = null;
      try { stepOut = JSON.parse(content); } catch (_) { stepOut = null; }
      if (!stepOut || typeof stepOut !== 'object') stepOut = { tipo: 'responder', texto: content };
      messages.push({ role: 'assistant', content: String(content || JSON.stringify(stepOut)) });
      if (stepOut.tipo === 'ler') {
        const reader = READERS[stepOut.funcao];
        const result = reader ? await reader(ctx, s, stepOut, context).catch(() => ({ erro: 'leitura falhou' })) : { erro: 'função desconhecida' };
        messages.push({ role: 'user', content: 'RESULTADO de ' + stepOut.funcao + ': ' + JSON.stringify(result).slice(0, MAX_TOOL_CHARS) });
        continue;
      }
      if (stepOut.tipo === 'propor') {
        const proposal = await buildProposal(ctx, s, { ...stepOut, resposta: stepOut.texto }).catch(() => null);
        if (proposal) {
          await event(ctx, s, 'PERGUNTA', { payload: { message }, cost_usd: cost });
          await event(ctx, s, 'PROPOSTA', { action: proposal.acao, payload: proposal });
          return { reply: proposal.resposta || proposal.linha, proposal };
        }
        messages.push({ role: 'user', content: 'RESULTADO: ação não reconhecida ou dados não encontrados; leia o painel antes de propor de novo, ou responda.' });
        continue;
      }
      const text = safeText(stepOut.texto, 4000) || 'Não consegui responder agora';
      if (!responseAnswersCurrent(message, text) && round + 1 < MAX_ROUNDS) {
        messages.push({ role: 'user', content: 'CORREÇÃO OBRIGATÓRIA: a resposta anterior não respondeu à tarefa atual. Ignore o assunto anterior e responda exatamente ao pedido: ' + message.slice(0, 1800) });
        continue;
      }
      await event(ctx, s, 'PERGUNTA', { payload: { message, reply: text, intent }, cost_usd: cost });
      return { reply: text, proposal: null };
    }
    return { reply: 'Não consegui concluir agora · tente perguntar de outro jeito', proposal: null };
  } catch (failure) {
    await event(ctx, s, 'ERRO', { payload: { message, code: failure && failure.code || 'OPENAI_FAILED', status: failure && failure.status || null, detail: failure && failure.detail || null }, cost_usd: cost || null });
    return { reply: 'Assistente indisponível agora', proposal: null, unavailable: true };
  }
}

// ------------------------------------------------------------------ "Não funcionou"
const P0 = new Set(['v1-generate', 'v1-send', 'v2-build', 'v2-send', 'deposit']);
const P1 = new Set(['ficha-open', 'search', 'import-csv', 'refresh', 'select', 'remove', 'offer-select', 'offer-remove', 'today', 'v1', 'v2', 'requests', 'searches', 'imports']);
const severityOf = (action) => P0.has(action) ? 'P0' : P1.has(action) || /^offer-/.test(String(action || '')) ? 'P1' : 'P2';
const TECH_CODES = new Set(['REQUEST_TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR']);
const SLOW_MS = 8000;
const RULE_TEXT = { TECNICO: 'O servidor falhou ou a conexão caiu', LENTIDAO: 'O servidor respondeu, mas demorou mais de 8 segundos', DEFEITO_TELA: 'Clique sem nenhuma resposta depois: provável defeito de tela', ERRO_JS: 'A tela deu erro depois do clique', NAO_SABEMOS: 'O servidor respondeu normalmente; causa ainda não identificada' };
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
  const slow = requests.filter((r) => Number(r.ms) > SLOW_MS);
  if (slow.length) return { categoria: 'LENTIDAO', texto: RULE_TEXT.LENTIDAO, click, slow };
  if (after.some((a) => a.kind === 'error')) return { categoria: 'ERRO_JS', texto: RULE_TEXT.ERRO_JS, click };
  if (click && !requests.length && !after.some((a) => a.kind === 'view')) return { categoria: 'DEFEITO_TELA', texto: RULE_TEXT.DEFEITO_TELA, click };
  return { categoria: 'NAO_SABEMOS', texto: RULE_TEXT.NAO_SABEMOS, click };
}
async function report(ctx, body, services = {}) {
  const s = svc(services);
  const context = cleanContext(body && body.context);
  const rules = rulesDiagnosis(context);
  const slow = rules.slow && rules.slow[0];
  const detail = slow ? ' · ' + (slow.method || 'GET') + ' ' + (slow.path || '') + ' levou ' + (Number(slow.ms) / 1000).toFixed(1).replace('.0','') + ' s' : '';
  const note = slow ? 'Resposta lenta: ' + (slow.method || 'GET') + ' ' + (slow.path || '') + ' levou ' + slow.ms + ' ms (HTTP ' + (slow.status || '—') + ')' : rules.texto;
  const proposal = await buildProposal(ctx, s, { acao: 'registrar_chamado', termo: note, texto: '' });
  if (proposal) proposal.params = { ...(proposal.params || {}), context };
  await event(ctx, s, 'PERGUNTA', { payload: { message: 'Não funcionou', diagnosis: { categoria: rules.categoria, texto: rules.texto } } });
  if (proposal) await event(ctx, s, 'PROPOSTA', { action: proposal.acao, payload: proposal });
  return { diagnosis: { categoria: rules.categoria, texto: rules.texto }, reply: rules.texto + detail, proposal };
}
async function createIncident(ctx, body, services = {}) {
  const s = svc(services);
  const context = cleanContext(body && body.context);
  const rules = rulesDiagnosis(context);
  const action = rules.click?.action || (rules.slow?.[0]?.path ? String(rules.slow[0].path).replace(/^\/api\/panel\//, '') : 'sem-clique');
  const view = context.view || rules.click?.view || 'painel';
  const severity = severityOf(action);
  const fingerprint = (view + '|' + action + '|' + rules.categoria).slice(0,300);
  const diagnosis = { categoria: rules.categoria, texto: rules.texto, nota: safeText(body && body.note,500) || null };
  const incident = await s.rpc(ctx,'panel_incident_report',{p_environment:ctx.environment,p_actor_id:ctx.panel?.id||null,p_fingerprint:fingerprint,p_severity:severity,p_version:context.version,p_context:context,p_diagnosis:diagnosis});
  await event(ctx,s,'CHAMADO',{incident_id:incident?.id||null,action,payload:{fingerprint,severity,categoria:rules.categoria}});
  return { incident, reply: 'Chamado registrado (' + severity + (incident?.count > 1 ? ', ' + incident.count + 'ª ocorrência' : '') + ') · ' + rules.texto };
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
        : body.action === 'create_incident' ? await createIncident(ctx, body)
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
module.exports.createIncident = createIncident;
module.exports.rulesDiagnosis = rulesDiagnosis;
module.exports.severityOf = severityOf;
module.exports.buildProposal = buildProposal;
module.exports.recordEvent = recordEvent;
module.exports.READERS = READERS;
module.exports.currentIntent = currentIntent;
module.exports.relevantHistory = relevantHistory;
module.exports.responseAnswersCurrent = responseAnswersCurrent;
