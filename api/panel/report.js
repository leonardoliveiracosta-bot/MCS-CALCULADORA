'use strict';

const { consolidateCalcRuns, groupCalculatorByRef, time } = require('../../panel-domain');
const { allRows, requirePanel, send } = require('../../panel-server');

function newYorkBoundary(dateString, end) {
  const match = String(dateString || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const hour = end ? 23 : 0;
  const minute = end ? 59 : 0;
  const second = end ? 59 : 0;
  const wanted = `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
  const localMillis = Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute, second, end ? 999 : 0);
  const localKey = (date) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).reduce((all, part) => { all[part.type] = part.value; return all; }, {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  return [4, 5].map((offset) => new Date(localMillis + offset * 3600000)).find((date) => localKey(date) === wanted) || null;
}

function range(query) {
  const now = new Date();
  const period = String(query.period || 'today');
  let start;
  let end = now;
  if (period === 'today') {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).reduce((all, part) => { all[part.type] = part.value; return all; }, {});
    start = newYorkBoundary(`${parts.year}-${parts.month}-${parts.day}`, false);
  } else if (period === '7' || period === '30') {
    start = new Date(now.getTime() - Number(period) * 24 * 60 * 60 * 1000);
  } else if (period === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || ''))) {
    start = newYorkBoundary(query.from, false);
    end = newYorkBoundary(query.to, true);
  } else return null;
  if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return null;
  return { period, start: start.getTime(), end: end.getTime() };
}

const inside = (value, selected) => {
  const stamp = time(value);
  return stamp !== null && stamp >= selected.start && stamp <= selected.end;
};

function budgetBucket(cents) {
  const dollars = Number(cents || 0) / 100;
  if (dollars <= 10000) return 'até 10k';
  if (dollars <= 25000) return '10–25k';
  if (dollars <= 50000) return '25–50k';
  return '50k+';
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  const selected = range(req.query || {});
  if (!selected) return send(res, 400, { error: 'REPORT_PERIOD_INVALID' });
  const view = String((req.query && req.query.view) || 'today');
  if (!['today', 'entry', 'orders', 'qualification', 'records', 'manheim'].includes(view)) return send(res, 400, { error: 'REPORT_VIEW_INVALID' });

  try {
    const [calcRuns, links, dispositions, journeys, toggles, uploads] = await Promise.all([
      allRows(ctx, 'calc_runs', { select: 'id,created_at,lance,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journeys', { select: 'id,reference_code,source,stage,status,budget_cents,created_at,qualified_at,closed_at,closed_reason', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'manheim_uploads', { select: 'id,source_file_count,vehicle_count,matched_vehicle_count,lead_count,uploaded_at', environment: 'eq.' + ctx.environment, order: 'uploaded_at.asc' })
    ]);

    const orders = groupCalculatorByRef(consolidateCalcRuns(calcRuns, links), dispositions);
    let summary = {};
    let text = '';

    if (view === 'today') {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const orderRefs = new Set(orders.filter((item) => (time(item.occurredAt) || 0) >= cutoff).map((item) => item.ref));
      const newJourneys = journeys.filter((item) => (time(item.created_at) || 0) >= cutoff && (!item.reference_code || !orderRefs.has(String(item.reference_code).toUpperCase())));
      const recentOrders = orders.filter((item) => (time(item.occurredAt) || 0) >= cutoff);
      const items = recentOrders.length + newJourneys.length;
      const treated = recentOrders.filter((item) => item.disposition === 'TREATED').length
        + newJourneys.filter((item) => dispositions.some((d) => d.item_kind === 'JOURNEY' && d.item_key === item.id && d.status === 'TREATED')).length;
      const discarded = recentOrders.filter((item) => item.disposition === 'DISCARDED').length
        + newJourneys.filter((item) => dispositions.some((d) => d.item_kind === 'JOURNEY' && d.item_key === item.id && d.status === 'DISCARDED')).length;
      summary = { enteredLast24h: items, treated, discarded, pending: Math.max(0, items - treated - discarded) };
      text = `HOJE — últimas 24h: ${items} entraram; ${treated} tratados; ${discarded} descartados; ${summary.pending} pendentes.`;
    } else if (view === 'orders') {
      const scoped = orders.filter((item) => inside(item.occurredAt, selected));
      const byValue = scoped.filter((item) => (item.logicalModes || [item.logicalMode]).includes('VALOR')).length;
      const byCar = scoped.filter((item) => (item.logicalModes || [item.logicalMode]).includes('CARRO')).length;
      const whatsapp = scoped.filter((item) => item.contactChannel === 'WHATSAPP').length;
      const sms = scoped.filter((item) => item.contactChannel === 'SMS').length;
      const pending = scoped.filter((item) => !item.disposition).length;
      const budgetRanges = { 'até 10k': 0, '10–25k': 0, '25–50k': 0, '50k+': 0 };
      scoped.forEach((item) => { budgetRanges[budgetBucket(item.budgetCents)] += 1; });
      summary = { total: scoped.length, byValue, byCar, whatsappClicked: whatsapp, smsClicked: sms, pending, budgetRanges };
      text = `PEDIDOS: ${scoped.length} total; por valor ${byValue}; carro ideal ${byCar}; WhatsApp clicado ${whatsapp}; SMS clicado ${sms}; pendentes ${pending}; orçamento — até 10k: ${budgetRanges['até 10k']}, 10–25k: ${budgetRanges['10–25k']}, 25–50k: ${budgetRanges['25–50k']}, 50k+: ${budgetRanges['50k+']}.`;
    } else if (view === 'qualification' || view === 'records') {
      const scoped = journeys.filter((item) => inside(item.created_at, selected) || inside(item.qualified_at, selected) || inside(item.closed_at, selected));
      const qualified = scoped.filter((item) => item.stage === 'QUALIFICADO' || item.qualified_at).length;
      const disabled = toggles.filter((item) => item.enabled === false && inside(item.switched_at, selected));
      const disabledByReason = {};
      disabled.forEach((item) => { const reason = item.off_reason || 'SEM MOTIVO'; disabledByReason[reason] = (disabledByReason[reason] || 0) + 1; });
      summary = { leads: scoped.length, qualified, disabled: disabled.length, disabledByReason };
      const reasons = Object.entries(disabledByReason).map(([reason, count]) => `${reason}: ${count}`).join(', ') || 'nenhum';
      text = `${view === 'qualification' ? 'QUALIFICAÇÃO' : 'FICHAS'}: ${scoped.length} leads; ${qualified} qualificados; ${disabled.length} desligados (${reasons}).`;
    } else if (view === 'manheim') {
      const scoped = uploads.filter((item) => inside(item.uploaded_at, selected));
      summary = {
        csvsProcessed: scoped.reduce((sum, item) => sum + Number(item.source_file_count || 0), 0),
        uploads: scoped.length,
        compatibleCars: scoped.reduce((sum, item) => sum + Number(item.matched_vehicle_count || 0), 0)
      };
      text = `MANHEIM: ${summary.csvsProcessed} CSV(s) processados em ${summary.uploads} importação(ões); ${summary.compatibleCars} carro(s) compatível(is).`;
    } else {
      summary = { imports: 0 };
      text = 'ENTRADA: relatório operacional não solicitado para esta aba.';
    }

    return send(res, 200, {
      environment: ctx.environment,
      view,
      range: { from: new Date(selected.start).toISOString(), to: new Date(selected.end).toISOString() },
      summary,
      text
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_REPORT_ERROR' });
  }
};

module.exports.range = range;
module.exports.newYorkBoundary = newYorkBoundary;
