'use strict';

// Ferramentas do assistente (function calling da OpenAI). Leituras rodam na hora; ações NUNCA rodam
// aqui: viram uma PROPOSTA gravada (parâmetros reais, autor, validade de 10 min, uso único) com o
// cartão montado pelo servidor a partir dos dados do banco (Ref, telefone, carros, VIN), nunca do
// texto do modelo. Só a rota de confirmação, pelo clique no cartão, executa (panel-assistant-exec).
const { allRows, rows, insert, isUuid, safeText } = require('./panel-server');
const D = require('./panel-assistant-data');
const routes = require('./panel-assistant-routes');

const VIEW_LABELS = { today: 'Atendimento (TODOS)', v1: 'V1', v2: 'V2', requests: 'BUSCAR CARROS', searches: 'ENVIAR OPÇÕES', imports: 'IMPORTAÇÕES', settings: 'Configurações', ficha: 'Ficha' };
const SUBJECT_LABELS = { FINANCIAMENTO: 'Financiamento', PEDIDO_CARRO: 'Pedido de carro', SO_CUMPRIMENTO: 'Só cumprimentou', OUTROS: 'Outros assuntos', NAO_IDENTIFICADO: 'Ainda não identificado' };
const OFF_REASONS = { MCS_PURCHASE: 'comprou com a MCS', OTHER_PURCHASE: 'comprou em outro lugar', GAVE_UP: 'desistiu', NO_RESPONSE: 'sem resposta' };
const env = (ctx) => 'eq.' + ctx.environment;
const carName = (p = {}) => [p.year, p.make, p.model, p.trim].filter(Boolean).join(' ');
const vinTail = (vin) => String(vin || '').trim().toUpperCase().slice(-6);
const money = (cents) => (Number(cents) > 0 ? 'US$ ' + Math.round(Number(cents) / 100).toLocaleString('en-US') : null);
const hoursSince = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 36e5)) : null; };

// ------------------------------------------------------------------ definições (strict)
const S = (type, description, extra = {}) => ({ type, description, ...extra });
const N = (type, description, extra = {}) => ({ type: [type, 'null'], description, ...extra });
const fn = (name, description, properties = {}) => ({ type: 'function', name, description, strict: true,
  parameters: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) } });
const LEAD = S('string', 'O lead: Ref de 5 letras, telefone, nome ou journey_id (use o journey_id quando já tiver)');

const TOOLS = [
  fn('ver_tela_atual', 'Aba e item abertos no painel agora.'),
  fn('buscar_leads', 'Acha leads por nome, Ref, telefone, carro ou texto das conversas (inclusive Sem Ref). Tolera acento, maiúscula e erro de digitação.', { termo: S('string', 'O que procurar'), limite: N('integer', 'Máximo de leads (padrão 15)') }),
  fn('sem_resposta', 'Leads cuja última mensagem é do cliente (esperando a MCS), com o tempo de espera. Só leads ativos do Atendimento.', { horas_minimas: N('number', 'Só quem espera há pelo menos estas horas'), limite: N('integer', 'Máximo (padrão 30)') }),
  fn('prontos_para_ligar', 'Leads do Atendimento na ordem de prontidão do painel (pontuação, bom horário, prazo de compra).', { limite: N('integer', 'Máximo (padrão 15)') }),
  fn('ver_lead', 'Ficha completa de um lead: dados, telefones, pedidos da calculadora, critérios, lance, temperatura, V1/V2 enviadas e tocadas, observações.', { lead: LEAD }),
  fn('ler_conversa', 'Mensagens reais de um lead (WhatsApp e SMS), em ordem.', { lead: LEAD, periodo: N('string', '"hoje", "ontem", "semana", "mes", "24h", "3d", "AAAA-MM-DD" ou "AAAA-MM-DD..AAAA-MM-DD"; null = tudo'), limite: N('integer', 'Últimas N mensagens (padrão 80)') }),
  fn('conversas_por_periodo', 'Com quem houve conversa no período, quem falou por último e as últimas falas de cada uma (para achar o que ficou pendente).', { periodo: S('string', '"hoje", "ontem", "semana", "24h"…') }),
  fn('contar', 'Contagens reais.', { o_que: S('string', 'O que contar', { enum: ['mensagens', 'leads_novos', 'sem_resposta', 'por_estado', 'por_marca'] }), periodo: N('string', 'Período (para mensagens e leads_novos); padrão hoje') }),
  fn('pedidos', 'Pedidos da calculadora do Atendimento, com filtros.', { modo: N('string', 'CARRO (Find One For Me) ou VALOR (Calculate My Cost)', { enum: ['CARRO', 'VALOR', null] }), busca_manheim: N('string', '"sem" = busca ainda não salva no Manheim; "com" = salva ou V1 enviada', { enum: ['sem', 'com', null] }), limite: N('integer', 'Máximo (padrão 30)') }),
  fn('lote_manheim', 'Lote Manheim ativo: resumo, ou os carros que batem com um lead (com match_id, VIN, MMR, leilão e se está selecionado).', { lead: N('string', 'Lead para ver os carros dele; null = resumo do lote') }),
  fn('por_que_carro_nao_aparece', 'Explica por que carros do lote não aparecem para um lead, agrupado por motivo.', { lead: LEAD, termo: N('string', 'Filtra carros (modelo, ano, VIN)') }),
  fn('sem_ref_por_assunto', 'Conversas Sem Ref do Atendimento agrupadas por assunto, com contagem e exemplos.', { exemplos_por_assunto: N('integer', 'Quantos exemplos por assunto (padrão 5)') }),
  fn('ler_anexo', 'Conteúdo de um anexo que o Leo mandou nesta conversa (texto de TXT/ZIP do WhatsApp; imagens e PDF já chegam junto da mensagem). Também lista telefones e Refs achados.', { indice: S('integer', 'Número do anexo, começando em 1') }),
  fn('auditoria', 'Lê o que está quebrado ou lento: erros do servidor nas últimas 24 h, rotas lentas, falhas vistas no navegador e chamados abertos.'),
  fn('testar_botoes', 'Pede ao navegador o teste ativo dos botões do painel (navegação de verdade numa área isolada; gravação e envio só em simulação, nada é gravado nem enviado). O resultado volta na próxima mensagem.'),
  fn('mostrar_leads', 'Mostra uma lista de leads na tela (cada linha com Ref e telefone juntos e abre a ficha). Use sempre que a resposta listar leads.', {
    titulo: N('string', 'Título curto da lista'),
    itens: S('array', 'Leads', { items: { type: 'object', additionalProperties: false, required: ['lead', 'detalhe', 'etiqueta', 'tom'], properties: {
      lead: S('string', 'journey_id do lead'), detalhe: N('string', 'Linha curta: carro, pedido ou pendência'), etiqueta: N('string', 'Etiqueta curta à direita: "18 h", "pendente", "ok"'), tom: N('string', 'cor da etiqueta', { enum: ['vermelho', 'amarelo', 'verde', null] }) } } }) }),
  fn('abrir_tela', 'Abre uma aba ou a ficha de um lead no painel, na hora (sem confirmação).', { destino: S('string', 'O que abrir', { enum: ['aba', 'ficha'] }), aba: N('string', 'Aba', { enum: ['today', 'v1', 'v2', 'requests', 'searches', 'imports', 'settings', null] }), lead: N('string', 'Lead (para ficha)') }),
  fn('ligar_desligar_lead', 'Propõe ligar ou desligar um lead (cartão de confirmação).', { lead: LEAD, ligar: S('boolean', 'true liga, false desliga'), motivo: N('string', 'Motivo ao desligar', { enum: ['MCS_PURCHASE', 'OTHER_PURCHASE', 'GAVE_UP', 'NO_RESPONSE', null] }) }),
  fn('acao_em_lote', 'Propõe ligar ou desligar vários leads de uma vez (lista completa num único cartão).', { ligar: S('boolean', 'true liga, false desliga'), motivo: N('string', 'Motivo ao desligar', { enum: ['MCS_PURCHASE', 'OTHER_PURCHASE', 'GAVE_UP', 'NO_RESPONSE', null] }), leads: S('array', 'journey_id de cada lead', { items: { type: 'string' } }) }),
  fn('anexar_na_ficha', 'Propõe anexar um anexo desta conversa na ficha certa (imagem ou PDF como arquivo; um print de SMS também pode virar mensagem SMS na conversa). Se não tiver certeza do lead, pergunte antes.', {
    lead: LEAD, anexo: S('integer', 'Número do anexo (1, 2…)'),
    sms: N('object', 'Quando o anexo é um print de SMS: o texto lido para virar mensagem na conversa', { additionalProperties: false, required: ['texto', 'de', 'data_hora'], properties: {
      texto: S('string', 'Texto exato do SMS'), de: S('string', 'Quem escreveu', { enum: ['cliente', 'mcs'] }), data_hora: N('string', 'Data e hora do SMS no fuso de Nova York, AAAA-MM-DDTHH:MM') } }) }),
  fn('atualizar_ficha', 'Propõe acrescentar uma informação nas observações da ficha (ex.: cor preferida, troca). Mostra antes o que muda.', { lead: LEAD, informacao: S('string', 'O que acrescentar, curto, em português') }),
  fn('montar_v1', 'Propõe montar a V1 de um lead com carros do lote (match_id vindos de lote_manheim). Seleciona os carros e cria a V1; nada é enviado.', { lead: LEAD, match_ids: S('array', 'match_id dos carros (1 a 10)', { items: { type: 'string' } }) }),
  fn('montar_v2', 'Propõe montar a V2 de um carro pelo VIN (o carro precisa estar numa V1 do lead). Nada é enviado.', { lead: LEAD, vin: S('string', 'VIN completo ou os 6+ últimos'), fotos: N('array', 'Números dos anexos com fotos do carro', { items: { type: 'integer' } }) }),
  fn('gerar_pdf', 'Propõe gerar o PDF (página da V1) com carros do lote para o lead.', { lead: LEAD, match_ids: S('array', 'match_id dos carros', { items: { type: 'string' } }) }),
  fn('enviar_v1', 'Propõe ENVIAR a V1 ao cliente. Só quando a última mensagem do Leo pede explicitamente para enviar. Cartão "Vou enviar" com Ref, telefone e canal.', { lead: LEAD }),
  fn('enviar_v2', 'Propõe ENVIAR a V2 ao cliente pelo caminho do painel (WhatsApp com a mensagem e o link). Só com pedido explícito de envio.', { lead: LEAD, vin: N('string', 'VIN do carro da V2; null = a V2 mais recente') }),
  fn('ligar_sem_ref_ao_lead', 'Propõe ligar uma conversa Sem Ref à Ref da calculadora do lead certo.', { conversa_sem_ref: S('string', 'journey_id da ficha Sem Ref'), ref: S('string', 'Ref de 5 letras da calculadora') })
];

// ------------------------------------------------------------------ apoio
async function today(ctx, state) {
  if (!state.today) state.today = routes.call(ctx, 'today', { method: 'GET', query: { sort: 'ready' } }).then((out) => (out.status === 200 && out.body && Array.isArray(out.body.items) ? out.body.items : []));
  return state.today;
}
async function lead(ctx, state, value) {
  const data = await D.snapshot(ctx);
  const found = D.resolveLead(data, value);
  if (found.journey) return { data, journey: found.journey, info: D.leadOf(data, found.journey) };
  return { data, candidatas: (found.candidatas || []).slice(0, 8).map((j) => D.leadOf(data, j)) };
}
const notFound = (found, value) => (found.candidatas && found.candidatas.length ? { erro: 'mais de um lead combina, pergunte qual', candidatas: found.candidatas } : { erro: `não achei o lead "${value}"` });
const itemJourney = (item) => item.journeyId || (item.kind === 'JOURNEY' ? item.id : null);
async function itemLeads(ctx, items) {
  const data = await D.snapshot(ctx);
  return items.map((item) => { const jid = itemJourney(item); const journey = jid && data.journeyById.get(jid); return { item, info: journey ? D.leadOf(data, journey) : { journey_id: null, linha: [item.ref || item.calcRef || 'Sem Ref', item.name, (item.phones || [])[0] ? D.phoneText(item.phones[0]) : 'sem telefone'].filter(Boolean).join(' · ') } }; });
}
async function latestUpload(ctx) {
  const { latestActiveUpload } = require('./panel-manheim-state');
  return latestActiveUpload(ctx, 'id,uploaded_at,vehicle_count,matched_vehicle_count,lead_count').catch(() => null);
}
async function demandOptions(ctx, journeyId, uploadId, limit = 15) {
  const keys = ['CARRO', 'VALOR'].map((mode) => `journey:${journeyId}:${mode}`);
  const [lists, chosen] = await Promise.all([
    Promise.all(keys.map((key) => rpcRead(ctx, 'panel_manheim_demand_options', { p_environment: ctx.environment, p_upload_id: uploadId, p_demand_key: key, p_after_rank: null, p_after_miles: null, p_after_id: null, p_limit: limit }).catch(() => []))),
    allRows(ctx, 'manheim_option_selections', { select: 'match_id', environment: env(ctx), upload_id: 'eq.' + uploadId, status: 'eq.SELECTED', demand_key: 'in.(' + keys.join(',') + ')' }).catch(() => [])
  ]);
  return { keys, lists, selected: new Set(chosen.map((r) => String(r.match_id))) };
}
const rpcRead = (ctx, name, args) => require('./panel-server').rpc(ctx, name, args);
const carOf = (m, selected) => { const p = (m.vehicle_json && m.vehicle_json.parsed) || {}; const members = p.memberMatchIds || [m.id]; return { match_id: m.id, carro: carName(p), vin: p.vin || null, milhas: p.miles ?? null, mmr: money(m.mmr_cents), lane_run: p.lane && p.run ? `${p.lane}/${p.run}` : null, buy_now: p.buyNowPrice || null, leilao: p.startsAt || p.saleDate || null, local: p.locationDisplay || p.location || null, selecionado: members.some((id) => selected.has(String(id))) }; };
async function vitrinesOf(ctx, journeyId) {
  const list = await allRows(ctx, 'vitrines', { select: 'id,token,version,created_at,expires_at', environment: env(ctx), journey_id: 'eq.' + journeyId, order: 'created_at.desc' }).catch(() => []);
  if (!list.length) return [];
  const idsIn = 'in.(' + list.slice(0, 20).map((v) => v.id).join(',') + ')';
  const [cars, events, sends] = await Promise.all([
    allRows(ctx, 'vitrine_cars', { select: 'id,vitrine_id,vehicle_snapshot', environment: env(ctx), vitrine_id: idsIn }).catch(() => []),
    allRows(ctx, 'vitrine_events', { select: 'vitrine_id,event_type,created_at', environment: env(ctx), vitrine_id: idsIn }).catch(() => []),
    allRows(ctx, 'v1_sends', { select: 'vitrine_id,status,simulated,created_at', environment: env(ctx), vitrine_id: idsIn }).catch(() => [])
  ]);
  const now = Date.now();
  return list.slice(0, 20).map((v) => ({ id: v.id, token: v.token, tipo: v.version === 'V2' ? 'V2' : 'V1', criada: D.nyText(v.created_at), expirada: Date.parse(v.expires_at || 0) <= now,
    carros: cars.filter((c) => c.vitrine_id === v.id).map((c) => ({ vitrine_car_id: c.id, carro: carName(c.vehicle_snapshot || {}), vin: (c.vehicle_snapshot || {}).vin || null })),
    enviada_pelo_painel: sends.filter((s) => s.vitrine_id === v.id && ['SENT', 'UNCONFIRMED'].includes(s.status) && !s.simulated).map((s) => D.nyText(s.created_at))[0] || null,
    aberturas: events.filter((e) => e.vitrine_id === v.id && e.event_type === 'OPEN').length, toques: events.filter((e) => e.vitrine_id === v.id && e.event_type === 'TAP').length }));
}
// Pedido explícito de envio na última mensagem do Leo (e não uma negação).
function asksToSend(text) {
  const t = D.fold(text);
  if (/\b(nao|sem)\s+(envi|mand|dispar)/.test(t)) return false;
  return /\b(envi\w*|mand\w*|dispar\w*|send)\b/.test(t);
}

// ------------------------------------------------------------------ propostas
const CARD = { fazer: 'Vou fazer · precisa do seu ok', enviar: 'Vou enviar · confira antes' };
async function propose(ctx, state, kind, params, card) {
  const [row] = await insert(ctx, 'panel_assistant_proposals', { environment: ctx.environment, created_by: ctx.panel.id, kind, params, card });
  // Os anexos que o clique precisa reenviar (o servidor confere que são os mesmos bytes lidos).
  const files = params.file ? [params.file.index] : (params.photos || []).map((photo) => photo.index);
  const block = { type: 'proposal', id: row.id, kind, title: card.title, lines: card.lines, button: card.button, expiresAt: row.expires_at, files, opensWhatsApp: card.button === 'Abrir no WhatsApp' || kind === 'send_v1' };
  state.blocks.push(block);
  return { proposta_criada: true, proposta_id: row.id, cartao: card.lines, aviso: 'Nada foi feito ainda. O Leo confirma no cartão.' };
}

// ------------------------------------------------------------------ execução das ferramentas
const READS = {
  async ver_tela_atual(ctx, state) {
    const c = state.context || {};
    const out = { aba: VIEW_LABELS[c.view] || c.view || null, itens_na_tela: Number.isFinite(c.count) ? c.count : null, aberto: c.detail || null };
    const [kind, key] = String(c.detail || '').split(':');
    if (kind === 'ficha' && isUuid(key)) { const found = await lead(ctx, state, key); if (found.info) out.lead_aberto = found.info; }
    if (kind === 'order' && key) { const found = await lead(ctx, state, key); if (found.info) out.lead_aberto = found.info; }
    state.step(`Vi a tela · ${out.aba || 'painel'}`);
    return out;
  },
  async buscar_leads(ctx, state, a) {
    const data = await D.snapshot(ctx);
    const out = D.search(data, a.termo, Math.min(Number(a.limite) || 15, 40));
    state.step(`Procurei "${String(a.termo).slice(0, 40)}" · ${out.total} lead(s)`);
    return out;
  },
  async sem_resposta(ctx, state, a) {
    const items = await today(ctx, state);
    const min = Number(a.horas_minimas) || 0;
    const waiting = items.filter((i) => i.awaitingReply).map((i) => ({ i, h: hoursSince(i.lastCustomerAt || (i.latestMessage && (i.latestMessage.occurred_at_utc || i.latestMessage.created_at))) })).filter((x) => (x.h ?? 0) >= min).sort((x, y) => (y.h || 0) - (x.h || 0));
    state.step(`Li Atendimento · ${items.length} conversas`);
    const rowsOut = await itemLeads(ctx, waiting.slice(0, Math.min(Number(a.limite) || 30, 60)).map((x) => x.i));
    return { atendimento_total: items.length, esperando: waiting.length, leads: rowsOut.map(({ item, info }) => ({ ...info, espera_horas: hoursSince(item.lastCustomerAt), janela_whatsapp_ate: item.whatsappWindowUntil ? D.nyText(item.whatsappWindowUntil) : null, carro: (item.cardFacts && item.cardFacts.vehicleText) || item.vehicleText || null, ultima_do_cliente: String((item.latestMessage && item.latestMessage.body_text) || '').replace(/\s+/g, ' ').slice(0, 160) })) };
  },
  async prontos_para_ligar(ctx, state, a) {
    const items = (await today(ctx, state)).filter((i) => i.enabled !== false);
    const ranked = items.slice().sort((x, y) => Number(Boolean(y.goodHour)) - Number(Boolean(x.goodHour)) || (Number(y.score) || 0) - (Number(x.score) || 0));
    state.step(`Li Atendimento · ${items.length} conversas`);
    const rowsOut = await itemLeads(ctx, ranked.slice(0, Math.min(Number(a.limite) || 15, 40)));
    const windowText = { NOW: 'quer comprar agora', '30D': 'em 30 dias', '3M': 'em 3 meses', NONE: 'sem prazo' };
    return { leads: rowsOut.map(({ item, info }) => ({ ...info, pontuacao: item.score || 0, bom_horario_agora: Boolean(item.goodHour), prazo_de_compra: windowText[item.purchaseWindow] || null, temperatura: item.heat || null, esperando_resposta: Boolean(item.awaitingReply), carro: (item.cardFacts && item.cardFacts.vehicleText) || item.vehicleText || null, lance: money((item.cardFacts && item.cardFacts.budgetCents) || item.budgetCents) })) };
  },
  async ver_lead(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const { leadData } = require('./panel-lead');
    const [full, vitrines, items] = await Promise.all([
      leadData(ctx, { query: {} }, null, found.journey.id).catch(() => null),
      vitrinesOf(ctx, found.journey.id),
      today(ctx, state).catch(() => [])
    ]);
    const item = items.find((i) => itemJourney(i) === found.journey.id) || null;
    const msgs = found.data.messagesByJourney.get(found.journey.id) || [];
    const contact = found.data.contactById.get(found.journey.contact_id) || {};
    state.step(`Li a ficha · ${found.info.linha}`);
    const windowText = { NOW: 'quer comprar agora', '30D': 'em 30 dias', '3M': 'em 3 meses', NONE: 'sem prazo' };
    return {
      ...found.info, etapa: found.journey.stage, observacoes: contact.notes || null,
      pedidos_calculadora: full && full.searchRequests ? full.searchRequests.map((r) => ({ modo: r.mode, carros: (r.wishes || []).map((w) => [w.make, w.model, w.trim, w.yearMin || w.yearMax ? `${w.yearMin || ''}-${w.yearMax || ''}` : '', w.maxMiles ? `até ${w.maxMiles} mi` : ''].filter(Boolean).join(' ')), lance: money(r.bidCents) })) : [],
      lance_maximo: money(full && full.maxBidCents) || money(found.journey.budget_cents), teto_total: money(full && full.totalCeilingCents), pagamento: (full && full.payment) || found.journey.payment_text || null,
      estado: (full && full.state) || null, cidade: (full && full.city) || null, prazo: (full && full.deadlineKnown) || found.journey.customer_deadline_text || null,
      temperatura: item ? item.heat : null, prazo_de_compra: item ? windowText[item.purchaseWindow] || null : null, resumo_ia: item && item.aiSummary ? item.aiSummary : null,
      no_atendimento: Boolean(item), esperando_resposta: item ? Boolean(item.awaitingReply) : null, busca_manheim: item ? item.searchStageLabel || null : null,
      proxima_acao: found.journey.next_action_text ? `${found.journey.next_action_text} (${D.nyText(found.journey.next_action_at) || 'sem data'})` : null,
      mensagens: { total: msgs.length, ultima: msgs.length ? `${msgs[msgs.length - 1].direction === 'CUSTOMER' ? 'cliente' : 'MCS'} em ${D.nyText(D.at(msgs[msgs.length - 1]))}` : null },
      vitrines
    };
  },
  async ler_conversa(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const range = a.periodo ? D.period(a.periodo) : null;
    const out = D.conversation(found.data, found.journey, range, Math.min(Number(a.limite) || 80, 200));
    state.step(`Li a conversa de ${found.info.linha} · ${out.mensagens.length} mensagens`);
    return { lead: found.info, periodo: range ? range.label : 'tudo', ...out };
  },
  async conversas_por_periodo(ctx, state, a) {
    const data = await D.snapshot(ctx);
    const out = D.conversationsIn(data, D.period(a.periodo));
    state.step(`Li ${out.conversas} conversas de ${out.periodo}`);
    return out;
  },
  async contar(ctx, state, a) {
    const data = await D.snapshot(ctx);
    const range = D.period(a.periodo || 'hoje');
    if (a.o_que === 'mensagens') { const out = D.countMessages(data, range); state.step(`Contei as mensagens de ${out.periodo}`); return out; }
    if (a.o_que === 'leads_novos') { const out = D.newLeads(data, range); state.step(`Contei os leads novos de ${out.periodo}`); return out; }
    const items = await today(ctx, state);
    state.step(`Li Atendimento · ${items.length} conversas`);
    if (a.o_que === 'sem_resposta') return { esperando_resposta: items.filter((i) => i.awaitingReply).length, atendimento_total: items.length };
    const catalog = require('./vehicle-catalog');
    const tally = (pick) => { const map = new Map(); items.forEach((i) => { const key = pick(i) || 'não informado'; map.set(key, (map.get(key) || 0) + 1); }); return [...map.entries()].sort((x, y) => y[1] - x[1]).map(([chave, total]) => ({ chave, total })); };
    if (a.o_que === 'por_estado') return { por_estado: tally((i) => i.state || i.estado || (/,\s*([A-Za-z .]+)$/.exec(String((i.cardFacts && i.cardFacts.zipText) || '')) || [])[1] || null) };
    return { por_marca: tally((i) => { const text = String((i.cardFacts && i.cardFacts.vehicleText) || i.vehicleText || '').trim(); const first = text.split(/\s+/)[0]; return first ? (catalog.canonicalMake(first) || first) : null; }) };
  },
  async pedidos(ctx, state, a) {
    const items = (await today(ctx, state)).filter((i) => i.hasCalculatorOrder || i.kind === 'CALCULATOR_ORDER' || (i.calcRefs || []).length);
    const modeOf = (i) => [...new Set([...(i.searchModes || []), ...((i.cardFacts && i.cardFacts.modes) || []), ...(i.logicalModes || [])])];
    const list = items.filter((i) => (!a.modo || modeOf(i).includes(a.modo)) && (!a.busca_manheim || (a.busca_manheim === 'sem' ? i.searchStage === 'MISSING' : ['SAVED', 'SENT'].includes(i.searchStage))));
    state.step(`Li os pedidos da calculadora · ${list.length} de ${items.length}`);
    const rowsOut = await itemLeads(ctx, list.slice(0, Math.min(Number(a.limite) || 30, 60)));
    return { total: list.length, leads: rowsOut.map(({ item, info }) => ({ ...info, modos: modeOf(item), busca_manheim: item.searchStageLabel || null, carro: (item.cardFacts && item.cardFacts.vehicleText) || item.vehicleText || null, lance: money((item.cardFacts && item.cardFacts.budgetCents) || item.budgetCents) })) };
  },
  async lote_manheim(ctx, state, a) {
    const upload = await latestUpload(ctx);
    if (!upload) { state.step('Sem lote Manheim ativo'); return { lote: null }; }
    if (!a.lead) { state.step('Li o lote Manheim'); return { lote: upload.id, subiu_em: D.nyText(upload.uploaded_at), carros: upload.vehicle_count ?? null, carros_com_combinacao: upload.matched_vehicle_count ?? null, pessoas_com_carros: upload.lead_count ?? null }; }
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const opts = await demandOptions(ctx, found.journey.id, upload.id, 15);
    const porCarro = (opts.lists[0] || []).map((m) => carOf(m, opts.selected)), porValor = (opts.lists[1] || []).map((m) => carOf(m, opts.selected));
    state.step(`Li o lote Manheim · ${porCarro.length + porValor.length} carros batem com ${found.info.linha}`);
    return { lead: found.info, lote: upload.id, busca_por_carro: porCarro, busca_por_valor: porValor };
  },
  async por_que_carro_nao_aparece(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    state.step(`Conferi o lote para ${found.info.linha}`);
    return require('./panel-assistant-diagnose').diagnoseOptions(ctx, found.journey.id, a.termo);
  },
  async sem_ref_por_assunto(ctx, state, a) {
    const items = (await today(ctx, state)).filter((i) => i.group && i.group.refState === 'SEM_REF');
    const ids = items.map(itemJourney).filter(Boolean);
    const classes = ids.length ? await allRows(ctx, 'panel_conversation_class', { select: 'journey_id,subject,manual_subject', environment: env(ctx) }).catch(() => []) : [];
    const subjectOf = new Map(classes.map((c) => [c.journey_id, c.manual_subject || c.subject]));
    const groups = new Map();
    items.forEach((i) => { const key = subjectOf.get(itemJourney(i)) || 'NAO_IDENTIFICADO'; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(i); });
    state.step(`Li ${items.length} conversas Sem Ref`);
    const per = Math.min(Number(a.exemplos_por_assunto) || 5, 15);
    const out = [];
    for (const [key, list] of [...groups.entries()].sort((x, y) => y[1].length - x[1].length)) {
      const examples = await itemLeads(ctx, list.slice(0, per));
      out.push({ assunto: SUBJECT_LABELS[key] || key, total: list.length, exemplos: examples.map(({ item, info }) => ({ ...info, ultima_do_cliente: String((item.latestMessage && item.latestMessage.body_text) || '').replace(/\s+/g, ' ').slice(0, 120) })) });
    }
    return { sem_ref_total: items.length, por_assunto: out };
  },
  async ler_anexo(ctx, state, a) {
    const file = (state.attachments || [])[Number(a.indice) - 1];
    if (!file) return { erro: 'anexo não encontrado' };
    state.step(`Li o anexo ${file.name}`);
    const text = file.text || '';
    const phones = [...new Set((text.match(/\+?1?[\s(.-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{4}/g) || []).map((p) => D.phoneText('+1' + D.digits(p).slice(-10))))].slice(0, 10);
    const refs = [...new Set((text.match(/\b[A-HJ-NP-Z2-9]{5}\b/g) || []))].slice(0, 10);
    return { nome: file.name, tipo: file.kind, ...(file.kind === 'imagem' || file.kind === 'pdf' ? { conteudo: 'o arquivo já está na mensagem do Leo; leia direto' } : { texto: text.slice(0, 15000), cortado: text.length > 15000 }), telefones_achados: phones, refs_achadas: refs };
  },
  async auditoria(ctx, state) {
    const out = await require('./panel-assistant-audit').serverFindings(ctx);
    state.audit = out;
    state.step('Li os erros do servidor das últimas 24 h');
    return out;
  },
  async testar_botoes(ctx, state) {
    state.clientTask = 'audit_buttons';
    return { pedido: 'o navegador vai testar os botões agora; o resultado chega na próxima mensagem. Encerre esta resposta em uma linha curta.' };
  },
  async mostrar_leads(ctx, state, a) {
    const data = await D.snapshot(ctx);
    const items = (a.itens || []).slice(0, 60).map((it) => { const found = D.resolveLead(data, it.lead); if (!found.journey) return null; const info = D.leadOf(data, found.journey); return { journeyId: info.journey_id, line: info.linha, detail: safeText(it.detalhe, 160) || '', badge: safeText(it.etiqueta, 20) || '', tone: it.tom || null }; }).filter(Boolean);
    state.blocks.push({ type: 'leads', title: safeText(a.titulo, 80) || null, items });
    return { mostrados: items.length };
  },
  async abrir_tela(ctx, state, a) {
    if (a.destino === 'aba') {
      if (!VIEW_LABELS[a.aba] || a.aba === 'ficha') return { erro: 'aba inválida' };
      state.blocks.push({ type: 'open', view: a.aba });
      state.step(`Abri ${VIEW_LABELS[a.aba]}`);
      return { aberto: VIEW_LABELS[a.aba] };
    }
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    state.blocks.push({ type: 'open', journeyId: found.journey.id });
    state.step(`Abri a ficha · ${found.info.linha}`);
    return { aberto: found.info.linha };
  }
};

const ACTIONS = {
  async ligar_desligar_lead(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const reason = a.ligar ? null : a.motivo || null;
    return propose(ctx, state, 'toggle', { journeyIds: [found.journey.id], enabled: a.ligar === true, reason }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`${a.ligar ? 'Ligar' : 'Desligar'} ${found.info.linha}`, `Hoje: ${found.info.situacao}`, ...(reason ? ['Motivo: ' + OFF_REASONS[reason]] : [])] });
  },
  async acao_em_lote(ctx, state, a) {
    const data = await D.snapshot(ctx);
    const journeys = [...new Set(a.leads || [])].map((v) => D.resolveLead(data, v).journey).filter(Boolean).slice(0, 80);
    if (!journeys.length) return { erro: 'nenhum lead válido na lista' };
    const reason = a.ligar ? null : a.motivo || null;
    const infos = journeys.map((j) => D.leadOf(data, j));
    return propose(ctx, state, 'toggle', { journeyIds: journeys.map((j) => j.id), enabled: a.ligar === true, reason }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`${a.ligar ? 'Ligar' : 'Desligar'} ${infos.length} lead(s)${reason ? ' · motivo: ' + OFF_REASONS[reason] : ''}:`, ...infos.map((i) => i.linha)] });
  },
  async atualizar_ficha(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const info = safeText(a.informacao, 400);
    if (!info) return { erro: 'informação vazia' };
    const contact = found.data.contactById.get(found.journey.contact_id) || {};
    const before = String(contact.notes || '').trim();
    const stamp = new Intl.DateTimeFormat('pt-BR', { timeZone: D.ZONE, day: '2-digit', month: '2-digit' }).format(new Date());
    const after = (before ? before + '\n' : '') + `${stamp} · ${info}`;
    if (after.length > 4000) return { erro: 'as observações passariam do limite de 4000 caracteres' };
    return propose(ctx, state, 'note', { journeyId: found.journey.id, contactId: found.journey.contact_id, before, after }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`Atualizar a ficha de ${found.info.linha}`, `Acrescenta nas observações: ${info}`, before ? 'O que já estava lá continua' : 'As observações estavam vazias'] });
  },
  async anexar_na_ficha(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const file = (state.attachments || [])[Number(a.anexo) - 1];
    if (!file) return { erro: 'anexo não encontrado' };
    const isFile = ['imagem', 'pdf'].includes(file.kind);
    const sms = a.sms && safeText(a.sms.texto, 4000) ? { text: safeText(a.sms.texto, 4000), direction: a.sms.de === 'mcs' ? 'MCS' : 'CUSTOMER', local: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(a.sms.data_hora || '')) ? a.sms.data_hora : null } : null;
    if (!isFile && !sms) return { erro: 'só imagem ou PDF viram arquivo da ficha; texto vira SMS só com o campo sms' };
    return propose(ctx, state, 'attach', { journeyId: found.journey.id, contactId: found.journey.contact_id, file: isFile ? { name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, index: Number(a.anexo) } : null, sms }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`Anexar na ficha de ${found.info.linha}`, ...(isFile ? [`Arquivo: ${file.name}`] : []), ...(sms ? [`SMS ${sms.direction === 'CUSTOMER' ? 'do cliente' : 'da MCS'}${sms.local ? ' de ' + sms.local.replace('T', ' ') : ''}: "${sms.text.slice(0, 140)}${sms.text.length > 140 ? '…' : ''}"`] : [])] });
  },
  async montar_v1(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const ids = [...new Set((a.match_ids || []).filter(isUuid))].slice(0, 10);
    if (!ids.length) return { erro: 'informe os match_id (use lote_manheim antes)' };
    const matches = await rows(ctx, 'manheim_matches', { select: 'id,journey_id,demand_key,vehicle_json,upload_id', environment: env(ctx), id: 'in.(' + ids.join(',') + ')' });
    if (matches.length !== ids.length || matches.some((m) => m.journey_id !== found.journey.id)) return { erro: 'algum carro não é do lote deste lead; leia lote_manheim de novo' };
    const keys = [...new Set(matches.map((m) => m.demand_key).filter((k) => /^journey:[0-9a-f-]{36}:(VALOR|CARRO)$/.test(String(k))))];
    if (keys.length > 1) return { erro: 'os carros são de buscas diferentes (por carro e por valor); monte uma V1 por busca' };
    return propose(ctx, state, 'v1', { journeyId: found.journey.id, matchIds: ids, demandKey: keys[0] || null }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`Montar a V1 de ${found.info.linha}`, `${ids.length} carro(s): ${matches.map((m) => `${carName((m.vehicle_json && m.vehicle_json.parsed) || {})} · VIN …${vinTail(((m.vehicle_json && m.vehicle_json.parsed) || {}).vin)}`).join('; ')}`, 'Nada é enviado ao cliente'] });
  },
  async montar_v2(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const car = await carByVin(ctx, found.journey.id, a.vin);
    if (car.erro) return car;
    const photos = (a.fotos || []).map((n) => ({ index: Number(n), file: (state.attachments || [])[Number(n) - 1] })).filter((p) => p.file && p.file.kind === 'imagem').slice(0, 12).map((p) => ({ index: p.index, name: p.file.name, sha256: p.file.sha256 }));
    return propose(ctx, state, 'v2', { journeyId: found.journey.id, vitrineId: car.vitrineId, vitrineCarId: car.vitrineCarId, photos }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`Montar a V2 de ${found.info.linha}`, `${car.carro} · VIN …${vinTail(car.vin)}`, photos.length ? `${photos.length} foto(s) anexada(s)` : 'Sem fotos (dá para acrescentar depois na V2)', 'Nada é enviado ao cliente'] });
  },
  async gerar_pdf(ctx, state, a) {
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const ids = [...new Set((a.match_ids || []).filter(isUuid))].slice(0, 60);
    if (!ids.length) return { erro: 'informe os match_id (use lote_manheim antes)' };
    return propose(ctx, state, 'pdf', { journeyId: found.journey.id, matchIds: ids, ref: found.info.ref || found.journey.reference_code || null }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`Gerar o PDF de ${found.info.linha}`, `${ids.length} carro(s) do lote`, 'Nada é enviado ao cliente'] });
  },
  async enviar_v1(ctx, state, a) {
    if (!asksToSend(state.userText)) return { erro: 'envio só com pedido explícito do Leo nesta mensagem ("envia", "manda"); pergunte se ele quer enviar' };
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const v1 = (await vitrinesOf(ctx, found.journey.id)).find((v) => v.tipo === 'V1' && !v.expirada);
    if (!v1) return { erro: 'este lead não tem V1 válida; monte a V1 antes' };
    const prep = await routes.call(ctx, 'v1-send', { body: { action: 'prepare', token: v1.token, baseUrl: state.baseUrl } });
    if (prep.status >= 400 || !prep.body || prep.body.error) return { erro: 'não consegui preparar o envio: ' + ((prep.body && prep.body.error) || prep.status) };
    const p = prep.body;
    const direct = p.eligible && p.windowOpen && p.mode !== 'OFF';
    const lines = [`Para ${found.info.linha} pelo WhatsApp`, `V1 com ${v1.carros.length} carro(s): ${v1.carros.map((c) => c.carro).join('; ')}`, p.last && p.last.status ? `Já houve envio desta V1 (${p.last.status}); só reenviar se for isso` : null,
      direct ? 'Mensagem padrão do painel com o link da V1' : 'Fora da janela de 24 h do WhatsApp: não dá para enviar daqui. O botão abre o WhatsApp com a mensagem pronta para você enviar'].filter(Boolean);
    return propose(ctx, state, 'send_v1', { journeyId: found.journey.id, token: v1.token, demandKey: null, direct, resend: Boolean(p.last && ['SENT', 'UNCONFIRMED'].includes(p.last.status)), whatsappLink: p.whatsappLink || null }, { title: CARD.enviar, button: direct ? 'Enviar' : 'Abrir no WhatsApp', lines });
  },
  async enviar_v2(ctx, state, a) {
    if (!asksToSend(state.userText)) return { erro: 'envio só com pedido explícito do Leo nesta mensagem ("envia", "manda"); pergunte se ele quer enviar' };
    const found = await lead(ctx, state, a.lead);
    if (!found.journey) return notFound(found, a.lead);
    const list = (await vitrinesOf(ctx, found.journey.id)).filter((v) => v.tipo === 'V2' && !v.expirada);
    const wanted = a.vin ? String(a.vin).toUpperCase().replace(/[^A-Z0-9]/g, '') : null;
    const v2 = wanted ? list.find((v) => v.carros.some((c) => c.vin && String(c.vin).toUpperCase().endsWith(wanted.slice(-8)))) : list[0];
    if (!v2) return { erro: 'não achei V2 válida deste lead' + (wanted ? ' com esse VIN' : '') + '; monte a V2 antes' };
    if (!found.info.telefones.length) return { erro: 'o lead não tem telefone' };
    return propose(ctx, state, 'send_v2', { journeyId: found.journey.id, token: v2.token, vitrineId: v2.id }, { title: CARD.enviar, button: 'Abrir no WhatsApp',
      lines: [`Para ${found.info.linha} pelo WhatsApp`, `V2 do ${v2.carros.map((c) => `${c.carro} · VIN …${vinTail(c.vin)}`).join('; ')}`, 'Mesmo caminho do painel: abre a conversa com a mensagem da V2 e o link para você enviar'] });
  },
  async ligar_sem_ref_ao_lead(ctx, state, a) {
    const found = await lead(ctx, state, a.conversa_sem_ref);
    if (!found.journey) return notFound(found, a.conversa_sem_ref);
    const ref = String(a.ref || '').toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(ref)) return { erro: 'Ref inválida' };
    if (!found.data.runRefs.has(ref)) return { erro: `a Ref ${ref} não tem simulação na calculadora` };
    return propose(ctx, state, 'link_ref', { journeyId: found.journey.id, contactId: found.journey.contact_id, ref }, { title: CARD.fazer, button: 'Confirmar',
      lines: [`Ligar a conversa ${found.info.linha}`, `à Ref ${ref} da calculadora`, 'Os pedidos dessa Ref passam a valer para esta ficha'] });
  }
};

// O carro de uma V1 do lead pelo VIN (completo ou final).
async function carByVin(ctx, journeyId, vin) {
  const wanted = String(vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (wanted.length < 6) return { erro: 'informe o VIN completo ou os 6 últimos' };
  const cars = (await vitrinesOf(ctx, journeyId)).filter((v) => v.tipo === 'V1').flatMap((v) => v.carros.map((c) => ({ ...c, vitrineId: v.id })));
  const found = cars.filter((c) => c.vin && (String(c.vin).toUpperCase() === wanted || String(c.vin).toUpperCase().endsWith(wanted)));
  if (!found.length) return { erro: 'este VIN não está em nenhuma V1 deste lead; monte a V1 com o carro antes' };
  if (new Set(found.map((c) => c.vin)).size > 1) return { erro: 'mais de um carro termina assim; peça o VIN completo' };
  return { vitrineId: found[0].vitrineId, vitrineCarId: found[0].vitrine_car_id, carro: found[0].carro, vin: found[0].vin };
}

async function run(ctx, state, name, args) {
  const impl = READS[name] || ACTIONS[name];
  if (!impl) return { erro: 'ferramenta desconhecida' };
  try { return await impl(ctx, state, args || {}); }
  catch (error) { return { erro: 'falhou ao ler: ' + String((error && (error.code || error.message)) || 'erro').slice(0, 120) }; }
}
const ACTION_NAMES = new Set(Object.keys(ACTIONS));

module.exports = { TOOLS, READS, ACTIONS, ACTION_NAMES, run, asksToSend, carByVin, vitrinesOf, VIEW_LABELS };
