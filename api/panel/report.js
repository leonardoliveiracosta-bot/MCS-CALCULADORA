'use strict';

const { buildTodayItems, consolidateCalcRuns, time } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
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
  const candidates = [4, 5].map((offset) => new Date(localMillis + offset * 3600000)).filter((date) => localKey(date) === wanted);
  return candidates[0] || null;
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

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  const selected = range(req.query || {});
  if (!selected) return send(res, 400, { error: 'REPORT_PERIOD_INVALID' });
  const view = String((req.query && req.query.view) || 'today');
  if (!['today', 'entry', 'orders', 'qualification', 'records'].includes(view)) return send(res, 400, { error: 'REPORT_VIEW_INVALID' });
  try {
    const [data, calcRuns, importJobs] = await Promise.all([
      operational(ctx),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,dados', order: 'created_at.asc' }),
      allRows(ctx, 'import_jobs', { select: 'id,created_at', environment: 'eq.' + ctx.environment })
    ]);
    const inside = (value) => {
      const stamp = time(value);
      return stamp !== null && stamp >= selected.start && stamp <= selected.end;
    };
    const simulations = consolidateCalcRuns(calcRuns).filter((item) => inside(item.occurredAt));
    const leads = data.journeys.filter((item) => inside(item.created_at));
    const qualified = data.journeys.filter((item) => inside(item.qualified_at));
    const closed = data.journeys.filter((item) => item.status === 'ENCERRADO' && inside(item.closed_at));
    const responses = [];
    for (const journey of data.journeys) {
      const messages = data.messages.filter((item) => item.journey_id === journey.id).sort((a, b) => (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0) - (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0));
      const inbound = messages.find((item) => item.direction === 'CUSTOMER' && inside(item.occurred_at_utc || item.occurred_at_local || item.created_at));
      if (!inbound) continue;
      const inboundAt = time(inbound.occurred_at_utc || inbound.occurred_at_local || inbound.created_at);
      const outbound = messages.find((item) => item.direction === 'MCS' && (time(item.occurred_at_utc || item.occurred_at_local || item.created_at) || 0) >= inboundAt);
      if (outbound) responses.push((time(outbound.occurred_at_utc || outbound.occurred_at_local || outbound.created_at) - inboundAt) / 60000);
    }
    const budgets = data.journeys.filter((item) => Number(item.budget_cents) > 0);
    const tabItems = view === 'today' ? buildTodayItems(data).length
      : view === 'entry' ? importJobs.filter((item) => inside(item.created_at)).length
        : view === 'orders' ? simulations.length + leads.filter((item) => ['WHATSAPP_DIRECT', 'SMS_DIRECT'].includes(item.source)).length
          : view === 'qualification' ? data.journeys.filter((item) => item.stage === 'QUALIFICADO' || item.status !== 'ENCERRADO').length
            : data.journeys.length;
    const summary = {
      tabItems,
      simulations: simulations.length,
      leads: leads.length,
      averageFirstResponseMinutes: responses.length ? Math.round(responses.reduce((sum, value) => sum + value, 0) / responses.length) : null,
      vehicles: data.journeys.filter((item) => item.vehicle_text).length,
      averageBudgetCents: budgets.length ? Math.round(budgets.reduce((sum, item) => sum + Number(item.budget_cents), 0) / budgets.length) : null,
      qualified: qualified.length,
      closed: closed.length
    };
    const text = `Relatório ${view.toUpperCase()}: ${summary.tabItems} itens na aba; ${summary.simulations} simulações; ${summary.leads} leads; ${summary.vehicles} com veículo; ${summary.qualified} qualificados; ${summary.closed} encerrados.`;
    return send(res, 200, { environment: ctx.environment, view, range: { from: new Date(selected.start).toISOString(), to: new Date(selected.end).toISOString() }, summary, text });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_REPORT_ERROR' });
  }
};

module.exports.range = range;
module.exports.newYorkBoundary = newYorkBoundary;
