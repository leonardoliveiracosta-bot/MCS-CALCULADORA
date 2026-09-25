'use strict';

const { consolidateCalcRuns, journeyLogicalMode, time } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const filter = String((req.query && req.query.filter) || 'Todos');
    const period = String((req.query && req.query.period) || '30');
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query && req.query.limit, 10) || 30));
    const offset = Math.max(0, Number.parseInt(req.query && req.query.offset, 10) || 0);
    if (!['Todos', 'Calculadora', 'WhatsApp direto', 'Carro', 'Valor'].includes(filter)) return send(res, 400, { error: 'ORDER_FILTER_INVALID' });
    if (!['7', '30', '90', 'all'].includes(period)) return send(res, 400, { error: 'ORDER_PERIOD_INVALID' });
    const [calcRuns, links, data, meta] = await Promise.all([
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      operational(ctx),
      panelMeta(ctx)
    ]);
    const journeys = new Map(data.journeys.map((item) => [item.id, item]));
    const latestByJourney = new Map();
    for (const message of data.messages) {
      const current = latestByJourney.get(message.journey_id);
      const stamp = Date.parse(message.occurred_at_utc || message.occurred_at_local || message.created_at) || 0;
      const currentStamp = current ? Date.parse(current.occurred_at_utc || current.occurred_at_local || current.created_at) || 0 : -1;
      if (stamp >= currentStamp) latestByJourney.set(message.journey_id, message);
    }
    const calculator = consolidateCalcRuns(calcRuns, links).map((item) => {
      const journey = item.link && item.link.journeyId ? journeys.get(item.link.journeyId) : null;
      const latest = journey ? latestByJourney.get(journey.id) : null;
      return {
        ...item, kind: 'CALCULATOR', sourceLabel: 'Calculadora',
        status: item.link && latest ? (latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO') : item.eventStatus,
        contactName: journey && journey.contact ? journey.contact.display_name : null
      };
    });
    const direct = data.journeys.filter((item) => ['WHATSAPP_DIRECT', 'SMS_DIRECT'].includes(item.source)).map((item) => {
      const latest = latestByJourney.get(item.id);
      return {
        key: 'direct:' + item.id, kind: 'DIRECT', journeyId: item.id,
        sourceLabel: item.source === 'SMS_DIRECT' ? 'SMS direto' : 'WhatsApp direto',
        logicalMode: journeyLogicalMode(item),
        vehicleText: item.vehicle_text, budgetCents: item.budget_cents,
        paymentText: item.payment_text, deadlineText: item.customer_deadline_text,
        occurredAt: item.created_at, contactName: item.contact && item.contact.display_name,
        status: latest && latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO'
      };
    });
    const cutoff = period === 'all' ? null : Date.now() - Number(period) * 24 * 60 * 60 * 1000;
    const filtered = calculator.concat(direct).filter((item) => {
      if (filter === 'Calculadora') return item.kind === 'CALCULATOR';
      if (filter === 'WhatsApp direto') return item.kind === 'DIRECT';
      if (filter === 'Carro') return item.logicalMode === 'CARRO';
      if (filter === 'Valor') return item.logicalMode === 'VALOR';
      return true;
    }).filter((item) => cutoff === null || (time(item.occurredAt) || 0) >= cutoff)
      .sort((left, right) => (time(right.occurredAt) || 0) - (time(left.occurredAt) || 0) || left.key.localeCompare(right.key));
    const items = filtered.slice(offset, offset + limit);
    const linkTargets = data.journeys.filter((item) => item.status !== 'ENCERRADO' && item.stage !== 'QUALIFICADO').map((item) => ({
      journeyId: item.id, contactId: item.contact_id,
      label: `${item.contact && item.contact.display_name ? item.contact.display_name : 'Contato sem nome'} — ${item.vehicle_text || 'busca sem veículo'}`
    }));
    return send(res, 200, {
      environment: ctx.environment, filter, period, items, linkTargets, meta,
      page: { offset, limit, total: filtered.length, hasMore: offset + items.length < filtered.length }
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_ORDERS_ERROR' });
  }
};
