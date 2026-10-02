(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MCSAttend = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // ATENDIMENTO: as pendências de HOJE e as decisões da antiga ENTRADA numa fila só.
  // Um caso por pessoa (ficha); os motivos de um caso ficam reunidos nele. Contador, filtro e
  // lista saem deste mesmo cálculo. Só apresentação: nada aqui grava nem envia.
  //  depende  → o que depende de você (responder, retorno vencido, confirmar vínculo, revisar
  //             conversa, pedido de vitrine, itens da IA para confirmar...)
  //  completar → pedido incompleto de quem não tem outro motivo na fila (falta um dado)
  //  aguardando → você respondeu e espera o cliente
  //  agendado → próxima ação marcada para depois
  //  fora      → fora do assunto (fica recolhido, nunca na fila)
  const BUCKETS = Object.freeze([
    { key: 'depende', label: 'Depende de você', unit: 'casos' },
    { key: 'completar', label: 'Completar pedido', unit: 'pedidos' },
    { key: 'aguardando', label: 'Aguardando cliente', unit: 'casos' },
    { key: 'agendado', label: 'Agendados', unit: 'casos' },
    { key: 'todos', label: 'Todos', unit: 'casos' }
  ]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuid = (value) => UUID.test(String(value || '')) ? String(value) : null;
  const stamp = (value) => { const at = Date.parse(value || ''); return Number.isFinite(at) ? at : 0; };

  // The ficha of a HOJE item (an order card carries the ficha it is linked to, if any).
  const journeyOf = (item) => uuid(item && (item.journeyId || (item.kind === 'CALCULATOR_ORDER' ? null : item.id)));
  const caseKeyOf = (item) => journeyOf(item) ? 'ficha:' + journeyOf(item) : 'item:' + String(item && (item.id || item.key || item.ref) || '');

  // Why a HOJE item depends on you (empty when it does not).
  function reasonsOf(item, now) {
    const out = [];
    const group = item && item.group || {};
    const next = stamp(item.next_action_at || item.nextActionAt);
    if (group.key === 'NAO_ATENDIDO' && group.unattended) out.push({ kind: 'NAO_ATENDIDO', text: group.unattended.reasonText });
    // A message that came before the next action was scheduled is handled by that schedule
    // (agendado); a message after it makes the case unattended (above).
    else if (item.awaitingReply && !(next > now)) out.push({ kind: 'RESPONDER', text: 'Responder o cliente' });
    (item.todayReasons || []).forEach((reason) => out.push({ kind: reason.kind || 'RETORNO', text: reason.detail ? `${reason.label} · ${reason.detail}` : reason.label }));
    if (item.wantsCar) out.push({ kind: 'QUER_CARRO', text: 'Quer este carro' });
    if (item.promiseToday) out.push({ kind: 'PROMESSA', text: 'Retorno prometido para hoje' });
    if (item.returnedToTalk) out.push({ kind: 'VOLTOU', text: 'Voltou a falar' });
    if (item.pendingAiCount) out.push({ kind: 'IA', text: `${item.pendingAiCount} itens da IA para confirmar` });
    if (item.aiLinkSuggested) out.push({ kind: 'VINCULO', text: 'Confirmar vínculo sugerido' });
    if (next && next <= now && !out.some((reason) => reason.kind === 'NEXT_ACTION')) out.push({ kind: 'NEXT_ACTION', text: 'Próxima ação vencida' });
    return out;
  }

  // todayItems: /api/panel/today items. decisions: [{ key, kind, journeyId, label }] (vínculo,
  // revisão de conversa, triagem, vitrine). incomplete: [{ key, journeyId, contactId, lacksText }]
  // (pedidos que precisam de detalhe). Returns the cases with their bucket and the counts.
  function model({ todayItems = [], decisions = [], incomplete = [], now = Date.now() } = {}) {
    const cases = new Map();
    const add = (key, base) => { if (!cases.has(key)) cases.set(key, { key, journeyId: null, item: null, reasons: [], decisions: [], requests: [], ...base }); return cases.get(key); };
    (todayItems || []).forEach((item) => {
      const entry = add(caseKeyOf(item), { journeyId: journeyOf(item) });
      // Two HOJE items of the same ficha (order + ficha) are one case: the ficha card wins.
      if (!entry.item || (entry.item.kind === 'CALCULATOR_ORDER' && item.kind !== 'CALCULATOR_ORDER')) entry.item = item;
      reasonsOf(item, now).forEach((reason) => { if (!entry.reasons.some((other) => other.kind === reason.kind && other.text === reason.text)) entry.reasons.push(reason); });
    });
    (decisions || []).forEach((decision) => {
      const journeyId = uuid(decision.journeyId);
      const entry = add(journeyId ? 'ficha:' + journeyId : 'decisao:' + decision.key, { journeyId });
      entry.decisions.push(decision);
      entry.reasons.push({ kind: decision.kind, text: decision.label });
    });
    (incomplete || []).forEach((request) => {
      const journeyId = uuid(request.journeyId);
      const key = journeyId ? 'ficha:' + journeyId : 'pedido:' + request.key;
      const entry = add(key, { journeyId });
      entry.requests.push(request);
    });
    const list = [...cases.values()].map((entry) => {
      const item = entry.item;
      const off = item && item.group && item.group.key === 'FORA_DO_ASSUNTO' && !entry.decisions.length;
      let bucket;
      if (off) bucket = 'fora';
      else if (entry.reasons.length) bucket = 'depende';
      else if (!item && entry.requests.length) bucket = 'completar';
      else if (item && stamp(item.next_action_at || item.nextActionAt) > now) bucket = 'agendado';
      else bucket = 'aguardando';
      return { ...entry, bucket };
    });
    return { cases: list, counts: countsOf(list) };
  }
  // The chip numbers of a list of cases (the same cases the list shows after Ref, Origem and Período).
  function countsOf(list) {
    const counts = { depende: 0, completar: 0, aguardando: 0, agendado: 0, fora: 0, todos: 0 };
    (list || []).forEach((entry) => { counts[entry.bucket] += 1; if (entry.bucket !== 'fora') counts.todos += 1; });
    return counts;
  }
  const inBucket = (entry, bucket) => bucket === 'todos' ? entry.bucket !== 'fora' : entry.bucket === bucket;

  return { BUCKETS, model, countsOf, inBucket, reasonsOf, caseKeyOf, journeyOf };
}));
