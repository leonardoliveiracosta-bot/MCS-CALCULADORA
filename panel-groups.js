(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCSGroups = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Contatos em HOJE, ENTRADA e CLIENTES. Só apresentação: nada aqui grava, envia ou muda regra.
  //
  // Seções (um contato fica em uma só): FORA_DO_ASSUNTO > NAO_ATENDIDO > ATENDIDO.
  // Origem (filtro e etiqueta, nunca seção):
  //   Veio pela calculadora · Via WhatsApp | Via SMS
  //   Veio por mensagem     · Via WhatsApp | Via SMS   (+ etiqueta "Financiamento")
  //   Veio pela vitrine     · V1 | V2                  (número novo pelo link V1/V2 de outra pessoa)
  // Regras travadas:
  //   a) financiamento = a primeira mensagem é um dos dois textos prontos do formulário do site;
  //   b) com pedido da calculadora e conversa direta (ou pela vitrine), vale a origem mais recente;
  //   c) próxima ação marcada para o futuro conta como atendido, menos para uma mensagem do cliente
  //      chegada depois do agendamento e ainda sem resposta;
  //   d) nada é relido pela IA por causa desta regra.
  const DAY = 86400000;
  const STALE_DAYS = 7;
  const DIRECT_SOURCES = new Set(['WHATSAPP_DIRECT', 'SMS_DIRECT']);
  // As duas mensagens prontas do formulário de financiamento do site (index.html, bloco 4).
  const FINANCING_RE = /talk about financing a car|want to finance a car/i;

  const ORIGINS = {
    CALCULADORA: { key: 'CALCULADORA', label: 'Veio pela calculadora', subs: { WHATSAPP: 'Via WhatsApp', SMS: 'Via SMS' } },
    MENSAGEM: { key: 'MENSAGEM', label: 'Veio por mensagem', subs: { WHATSAPP: 'Via WhatsApp', SMS: 'Via SMS' } },
    VITRINE: { key: 'VITRINE', label: 'Veio pela vitrine', subs: { V1: 'V1', V2: 'V2' } }
  };
  // The origin filter, mobile-first like "Ordenar": everyone by default, then a group or a sub-group.
  const ORIGIN_OPTIONS = [['all', 'Todas as origens']].concat(...Object.values(ORIGINS).map((group) => [[group.key, group.label]]
    .concat(Object.entries(group.subs).map(([sub, label]) => [group.key + ':' + sub, group.label + ' · ' + label]))
    .concat(group.key === 'MENSAGEM' ? [['MENSAGEM:FINANCIAMENTO', group.label + ' · Financiamento']] : [])));

  const SECTIONS = {
    NAO_ATENDIDO: { key: 'NAO_ATENDIDO', label: 'Não atendidos', hint: 'Mensagem do cliente sem resposta, ou nenhuma ação registrada há 7 dias ou mais', order: 0 },
    ATENDIDO: { key: 'ATENDIDO', label: 'Atendidos', hint: 'Respondidos, com próxima ação marcada ou com ação nos últimos 7 dias', order: 1 },
    FORA_DO_ASSUNTO: { key: 'FORA_DO_ASSUNTO', label: 'Fora do assunto', hint: 'A conversa inteira nunca tratou de carro, compra, financiamento, orçamento ou serviço da MCS · Na dúvida a conversa fica no fluxo principal · \'É sobre carro\' corrige e fica guardado · Nada é apagado', order: 2 }
  };
  const ORDER = ['NAO_ATENDIDO', 'ATENDIDO', 'FORA_DO_ASSUNTO'];
  // Areas inside each section: the two calculator types generate different searches, and direct
  // conversations whose search is still incomplete are apart from those already defined.
  const AREAS = {
    CALC_VALOR: { key: 'CALC_VALOR', label: 'Calculadora · Por valor', hint: 'Calculate My Cost: carro e lance máximo · gera a busca por valor (MMR)' },
    CALC_CARRO: { key: 'CALC_CARRO', label: 'Calculadora · Por carro', hint: 'Find One For Me: carro, faixa de ano e de milhagem · gera a busca por carro' },
    CALC_SEM_TIPO: { key: 'CALC_SEM_TIPO', label: 'Calculadora · referência ou tipo a recuperar', hint: 'Há prova de que veio da calculadora, mas falta a Ref ou o tipo (por valor ou por carro) · nada é inventado: o pedido fica com os dados comprovados até a Ref aparecer' },
    SEM_REF: { key: 'SEM_REF', label: 'Conversas sem Ref', hint: 'Sem calculadora comprovada · reunidas num bloco só e organizadas pelo assunto que o Claude identificou' }
  };
  const AREA_ORDER = ['CALC_VALOR', 'CALC_CARRO', 'CALC_SEM_TIPO', 'SEM_REF'];
  // The subject of a conversation (read by the Claude, or corrected by hand). It is not the origin (where the
  // person came from) nor the channel (WhatsApp or SMS): a person from the calculator who then asked about
  // financing keeps origin Calculadora and has subject Financiamento.
  const SUBJECTS = {
    FINANCIAMENTO: { key: 'FINANCIAMENTO', label: 'Financiamento' },
    PEDIDO_CARRO: { key: 'PEDIDO_CARRO', label: 'Pedido de carro' },
    SO_CUMPRIMENTO: { key: 'SO_CUMPRIMENTO', label: 'Só cumprimentou' },
    OUTROS: { key: 'OUTROS', label: 'Outros assuntos' },
    NAO_IDENTIFICADO: { key: 'NAO_IDENTIFICADO', label: 'Ainda não identificado' }
  };
  // The three states of the Ref, the same everywhere (lists, filters, counters, cards). "Calculadora, referência a recuperar" is
  // origin Calculadora proven by the calculator's message (or the stored identity) when the Ref itself cannot be recovered: it is
  // never downgraded to a direct conversation nor to "sem Ref". "Sem Ref" only when there is no calculator evidence at all.
  const REF_STATES = {
    COM_REF: { key: 'COM_REF', label: 'Com Ref', filter: 'with' },
    A_RECUPERAR: { key: 'A_RECUPERAR', label: 'Calculadora, referência a recuperar', filter: 'recover' },
    SEM_REF: { key: 'SEM_REF', label: 'Sem Ref', filter: 'without' }
  };
  const REF_STATE_ORDER = ['COM_REF', 'A_RECUPERAR', 'SEM_REF'];
  function refStateOf({ hasCalcRef = false, identity = null, template = false } = {}) {
    if (hasCalcRef || (identity && identity.status === 'REF_COMPROVADA')) return 'COM_REF';
    if (template || (identity && (identity.status === 'CALCULADORA_REF_A_RECUPERAR' || identity.calcOrigin === true))) return 'A_RECUPERAR';
    return 'SEM_REF';
  }
  const SUBJECT_ORDER = ['FINANCIAMENTO', 'PEDIDO_CARRO', 'SO_CUMPRIMENTO', 'OUTROS', 'NAO_IDENTIFICADO'];

  const stamp = (value) => { if (typeof value === 'number') return Number.isFinite(value) ? value : 0; const parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? parsed : 0; };
  const iso = (value) => { const at = stamp(value); return at ? new Date(at).toISOString() : null; };
  const isFinancing = (text) => FINANCING_RE.test(String(text || ''));
  // SMS when the message says so (channel, iPhone shortcut or SMS print); every other one is WhatsApp.
  const channelOf = (channel, source) => String(channel || '').toUpperCase() === 'SMS' || /^SMS/.test(String(source || '').toUpperCase()) ? 'SMS' : 'WHATSAPP';
  const messageAt = (message) => stamp(message && (message.occurred_at_utc || message.occurred_at_local || message.created_at));

  // The same summary the database returns (panel_journey_message_facts), built from a message list.
  function summaryFromMessages(messages) {
    const own = (messages || []).filter((message) => message && !message.undone_at && ['CUSTOMER', 'MCS'].includes(message.direction))
      .slice().sort((a, b) => messageAt(a) - messageAt(b) || String(a.id).localeCompare(String(b.id)));
    const customer = own.filter((message) => message.direction === 'CUSTOMER');
    const mcs = own.filter((message) => message.direction === 'MCS');
    const real = own.filter((message) => !message.is_automatic);
    const first = customer[0] || null, lastCustomer = customer.at(-1) || null, lastMcs = mcs.at(-1) || null, latest = real.at(-1) || own.at(-1) || null;
    return {
      message_count: own.length, customer_count: customer.length,
      first_customer_at: first ? iso(messageAt(first)) : null, first_customer_channel: first ? first.channel || null : null, first_customer_source: first ? first.source_kind || null : null, first_customer_text: first ? String(first.body_text || '').slice(0, 300) : null,
      last_customer_id: lastCustomer ? lastCustomer.id : null, last_customer_at: lastCustomer ? iso(messageAt(lastCustomer)) : null, last_customer_text: lastCustomer ? String(lastCustomer.body_text || '').slice(0, 600) : null,
      last_customer_channel: lastCustomer ? lastCustomer.channel || null : null, last_customer_source: lastCustomer ? lastCustomer.source_kind || null : null,
      last_mcs_id: lastMcs ? lastMcs.id : null, last_mcs_at: lastMcs ? iso(messageAt(lastMcs)) : null,
      latest_id: latest ? latest.id : null, latest_direction: latest ? latest.direction : null, latest_at: latest ? iso(messageAt(latest)) : null, latest_text: latest ? String(latest.body_text || '').slice(0, 600) : null, latest_automatic: latest ? Boolean(latest.is_automatic) : null,
      latest_real_mcs_at: (() => { const value = real.filter((message) => message.direction === 'MCS').at(-1); return value ? iso(messageAt(value)) : null; })()
    };
  }

  // The facts every rule below reads. summary: panel_journey_message_facts (or summaryFromMessages).
  // orders: calculator orders of the person (newest simulation first). vitrine: {version, at} when the
  // person is a new number that arrived through someone's V1/V2 link.
  function factsFor({ summary = null, messages = null, orders = [], journey = null, disposition = null, dispositionAt = null, offTopic = null, vitrine = null, situation = null, calcProof = null, identity = null, subject = null, template = false } = {}) {
    const s = summary || summaryFromMessages(messages || []);
    const simulations = (orders || []).filter(Boolean).flatMap((order) => order.simulations && order.simulations.length ? order.simulations : [order])
      .slice().sort((a, b) => stamp(b.occurredAt) - stamp(a.occurredAt));
    const calcModes = [...new Set(simulations.map((item) => item.logicalMode).concat((orders || []).flatMap((order) => (order && order.logicalModes) || [])).filter((mode) => mode === 'CARRO' || mode === 'VALOR'))];
    // The type of the most recent simulation decides the calculator area (one person, one place).
    // A Ref proven by the client's calculator message (panel-ref-proof) is a calculator order even
    // when the simulation is missing from calc_runs; the message says which calculator it was.
    const proofModes = calcProof && calcProof.hasCalcRef ? (calcProof.messageModes || []).filter((mode) => mode === 'CARRO' || mode === 'VALOR') : [];
    proofModes.forEach((mode) => { if (!calcModes.includes(mode)) calcModes.push(mode); });
    const calcMode = (simulations.find((item) => item.logicalMode === 'CARRO' || item.logicalMode === 'VALOR') || {}).logicalMode || (calcModes.length === 1 ? calcModes[0] : null);
    const calcChannel = simulations.map((item) => String(item.contactChannel || item.channel || '').toUpperCase()).find((value) => /SMS|WHATSAPP/.test(value)) || null;
    const off = journey && (journey.enabled === false || journey.status === 'ENCERRADO');
    return {
      // Origin Calculadora is also proven by the stored identity (the client's calculator message without a recoverable Ref).
      hasCalculator: simulations.length > 0 || calcModes.length > 0 || Boolean(calcProof && calcProof.hasCalcRef) || Boolean(identity && identity.calcOrigin) || Boolean(template),
      refState: refStateOf({ hasCalcRef: simulations.length > 0 || calcModes.length > 0 || Boolean(calcProof && calcProof.hasCalcRef), identity, template }),
      identityStatus: identity ? identity.status || null : null, refTie: identity && identity.conflict && Array.isArray(identity.conflict.tie) ? identity.conflict.tie : null, identityState: identity ? identity.state || null : null,
      subject: subject || null,
      calcModes, calcMode, calcAt: simulations[0] ? simulations[0].occurredAt || null : calcProof && calcProof.messageAt || null, calcChannel: calcChannel ? (calcChannel.includes('SMS') ? 'SMS' : 'WHATSAPP') : null,
      source: journey ? journey.source || null : null,
      financing: isFinancing(s.first_customer_text),
      firstCustomerAt: s.first_customer_at || null,
      firstChannel: s.first_customer_at ? channelOf(s.first_customer_channel, s.first_customer_source) : null,
      lastCustomerAt: s.last_customer_at || null,
      lastMcsAt: s.last_mcs_at || null,
      lastActionAt: journey ? journey.last_effective_contact_at || null : null,
      nextActionAt: journey ? journey.next_action_at || null : null,
      nextActionText: journey ? journey.next_action_text || null : null,
      nextActionSetAt: journey ? journey.next_action_set_at || null : null,
      createdAt: journey ? journey.created_at || null : null,
      awaitingReply: s.latest_direction === 'CUSTOMER',
      closed: Boolean(off), closedAt: off ? (Math.max(stamp(journey.closed_at), stamp(journey.switchedAt || journey.switched_at)) ? iso(Math.max(stamp(journey.closed_at), stamp(journey.switchedAt || journey.switched_at))) : null) : null,
      situation: situation || null,
      disposition: disposition || null, dispositionAt: dispositionAt || null,
      vitrine: vitrine && vitrine.version ? { version: vitrine.version === 'V2' ? 'V2' : 'V1', at: vitrine.at || null } : null,
      offTopic: Boolean(offTopic && offTopic.offTopic), offTopicSource: offTopic && offTopic.offTopic ? offTopic.source || null : null
    };
  }

  function originOf(facts) {
    const f = facts || {};
    // The conversation that did not start from the calculator: a vitrine link or a direct message.
    const viaVitrine = f.vitrine ? { group: 'VITRINE', sub: f.vitrine.version, at: stamp(f.vitrine.at) || stamp(f.firstCustomerAt) } : null;
    const direct = viaVitrine || (f.firstCustomerAt && (!f.hasCalculator || f.financing || DIRECT_SOURCES.has(String(f.source || '').toUpperCase()))
      ? { group: 'MENSAGEM', sub: f.firstChannel || (String(f.source || '').toUpperCase() === 'SMS_DIRECT' ? 'SMS' : 'WHATSAPP'), at: stamp(f.firstCustomerAt) } : null);
    const calc = f.hasCalculator ? { group: 'CALCULADORA', sub: f.firstChannel || f.calcChannel || 'WHATSAPP', at: stamp(f.calcAt) } : null;
    // A proven calculator Ref keeps the case in Calculadora: a later WhatsApp or SMS message is only
    // the channel and never changes the origin (a later vitrine link is another origin and still wins).
    let chosen = calc ? (viaVitrine && viaVitrine.at > calc.at ? viaVitrine : calc) : direct;
    if (!chosen) chosen = { group: 'MENSAGEM', sub: String(f.source || '').toUpperCase() === 'SMS_DIRECT' ? 'SMS' : 'WHATSAPP', at: 0 };
    const group = ORIGINS[chosen.group];
    const financing = chosen.group === 'MENSAGEM' && Boolean(f.financing);
    return { group: chosen.group, sub: chosen.sub, key: chosen.group + ':' + chosen.sub, groupLabel: group.label, subLabel: group.subs[chosen.sub], label: group.label + ' · ' + group.subs[chosen.sub], financing };
  }

  function waited(ms) {
    const minutes = Math.max(1, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} dias`;
  }

  // Não atendido: the same "Sem resposta" of PENDÊNCIAS (the latest real message is the customer's),
  // or no action registered for 7 days or more. Never for a concluded case: closed or switched off
  // (unless the customer wrote after it), "sem interesse"/concluded by the reading, treated or
  // discarded after the last customer message. A next action in the future counts as attended (c).
  function unattendedOf(facts, now = Date.now()) {
    const f = facts || {};
    const lastCustomer = stamp(f.lastCustomerAt);
    const disposedAt = f.disposition ? stamp(f.dispositionAt) : 0;
    if (f.closed && !(lastCustomer && lastCustomer > stamp(f.closedAt))) return null;
    if (f.situation === 'CLOSED') return null;
    if (disposedAt && disposedAt >= lastCustomer) return null;
    const next = stamp(f.nextActionAt);
    // c) a next action in the future counts as attended, except for a customer message that arrived
    // after it was scheduled and still has no reply (or when the scheduling time is unknown).
    const scheduledAt = stamp(f.nextActionSetAt);
    const newerMessage = Boolean(f.awaitingReply && lastCustomer && (!scheduledAt || lastCustomer > scheduledAt));
    if (next && next > now && !newerMessage) return null;
    if (f.awaitingReply && lastCustomer) {
      return { since: new Date(lastCustomer).toISOString(), waitedMs: now - lastCustomer, waitedText: waited(now - lastCustomer), reason: 'NO_RESPONSE', reasonText: 'Mensagem do cliente sem resposta', missing: 'Resposta à última mensagem do cliente', next: 'Responder o cliente' };
    }
    if (f.closed) return null;
    const lastAction = Math.max(stamp(f.lastMcsAt), stamp(f.lastActionAt));
    const base = lastAction || stamp(f.createdAt) || stamp(f.firstCustomerAt);
    if (!base || now - base < STALE_DAYS * DAY) return null;
    return {
      since: new Date(base).toISOString(), waitedMs: now - base, waitedText: waited(now - base), reason: 'NO_ACTION', reasonText: `Nenhuma ação registrada há ${STALE_DAYS} dias ou mais`,
      missing: next ? `A próxima ação venceu${f.nextActionText ? ': ' + f.nextActionText : ''}` : lastAction ? 'Nenhuma ação registrada desde o último contato da MCS' : 'Nenhuma ação registrada desde a entrada',
      next: next ? 'Fazer a próxima ação vencida ou marcar outra data' : 'Retomar o contato ou marcar a próxima ação'
    };
  }

  function classify(facts, now = Date.now()) {
    const f = facts || {};
    const origin = originOf(f);
    const unattended = f.offTopic ? null : unattendedOf(f, now);
    const key = f.offTopic ? 'FORA_DO_ASSUNTO' : unattended ? 'NAO_ATENDIDO' : 'ATENDIDO';
    return { key, label: SECTIONS[key].label, origin, unattended, hasCalculator: Boolean(f.hasCalculator), calcMode: f.calcMode || null, offTopic: Boolean(f.offTopic), offTopicSource: f.offTopic ? f.offTopicSource || null : null,
      identityStatus: f.identityStatus || null, refTie: f.refTie || null, refState: f.refState || (f.hasCalculator ? 'COM_REF' : 'SEM_REF'), subject: subjectOf(f.subject) };
  }

  // The area of a listed contact. searchModes: the search types already defined for the ficha
  // (panel-search-stage); a direct conversation without one is still incomplete.
  function areaOf(item) {
    const group = (item && item.group) || {};
    // An unknown calculator type is reviewed, never filed as "por valor" by default.
    if (group.hasCalculator) return group.calcMode === 'CARRO' ? 'CALC_CARRO' : group.calcMode === 'VALOR' ? 'CALC_VALOR' : 'CALC_SEM_TIPO';
    // Everyone else is one block, "Conversas sem Ref"; the subject organizes it. Whether the search is already
    // defined (searchModes) is a separate fact of the card, not a reason to split the block.
    return 'SEM_REF';
  }
  // The subject shown for a person: key, label, where it came from and whether it is known. A source that failed to
  // load is 'indisponível' (never "Ainda não identificado"); a conversation not read yet is "Ainda não identificado".
  function subjectOf(value) {
    const state = value && value.state || 'PENDENTE';
    if (state === 'INDISPONIVEL' || !value) return { key: null, label: 'Assunto indisponível agora', source: null, state: 'INDISPONIVEL', reason: null };
    const known = SUBJECTS[value.key] || SUBJECTS.NAO_IDENTIFICADO;
    return { key: known.key, label: known.label, source: value.source || null, state: state, reason: value.reason || null };
  }
  // The conversations of one block by subject, in order (empty subjects left out; unavailable ones last, apart).
  function bySubject(items) {
    const buckets = new Map(SUBJECT_ORDER.map((key) => [key, []]));
    const unavailable = [];
    (items || []).forEach((item) => {
      const subject = item && item.group && item.group.subject;
      if (subject && subject.state === 'INDISPONIVEL') unavailable.push(item);
      else buckets.get(subject && SUBJECTS[subject.key] ? subject.key : 'NAO_IDENTIFICADO').push(item);
    });
    const out = SUBJECT_ORDER.map((key) => ({ ...SUBJECTS[key], items: buckets.get(key) })).filter((group) => group.items.length);
    if (unavailable.length) out.push({ key: 'INDISPONIVEL', label: 'Assunto indisponível agora', items: unavailable });
    return out;
  }
  // The areas of a list of items, in order (empty ones left out).
  function areas(items) {
    const buckets = new Map(AREA_ORDER.map((key) => [key, []]));
    (items || []).forEach((item) => buckets.get(areaOf(item)).push(item));
    return AREA_ORDER.map((key) => ({ ...AREAS[key], items: buckets.get(key) })).filter((area) => area.items.length);
  }

  // Origin filter: 'all', a group ('MENSAGEM'), a sub-group ('MENSAGEM:SMS') or the financing tag.
  function matchesOrigin(item, value) {
    const filter = String(value || 'all');
    if (filter === 'all') return true;
    const origin = item && item.group && item.group.origin;
    if (!origin) return false;
    if (filter === 'MENSAGEM:FINANCIAMENTO') return origin.group === 'MENSAGEM' && origin.financing;
    return filter.includes(':') ? origin.key === filter : origin.group === filter;
  }

  // The ordered sections (empty ones included, so every label and count is stable).
  function split(items, groupOf = (item) => item && item.group) {
    const buckets = new Map(ORDER.map((key) => [key, []]));
    (items || []).forEach((item) => { const group = groupOf(item); const key = group && buckets.has(group.key) ? group.key : 'ATENDIDO'; buckets.get(key).push(item); });
    // Não atendidos: whoever has waited longest first.
    buckets.get('NAO_ATENDIDO').sort((a, b) => ((groupOf(b) && groupOf(b).unattended && groupOf(b).unattended.waitedMs) || 0) - ((groupOf(a) && groupOf(a).unattended && groupOf(a).unattended.waitedMs) || 0));
    return ORDER.map((key) => ({ ...SECTIONS[key], items: buckets.get(key) }));
  }

  // The card's latest customer message (contacts without a calculator order).
  function latestCustomerMessage(summary) {
    const s = summary || {};
    return s.last_customer_id && String(s.last_customer_text || '').trim() ? { id: s.last_customer_id, text: String(s.last_customer_text).slice(0, 600), at: s.last_customer_at || null } : null;
  }

  return { ORIGINS, ORIGIN_OPTIONS, SECTIONS, ORDER, AREAS, AREA_ORDER, REF_STATES, REF_STATE_ORDER, refStateOf, SUBJECTS, SUBJECT_ORDER, subjectOf, bySubject, areaOf, areas, STALE_DAYS, FINANCING_RE, isFinancing, channelOf, summaryFromMessages, factsFor, originOf, unattendedOf, classify, matchesOrigin, split, waited, latestCustomerMessage };
}));
