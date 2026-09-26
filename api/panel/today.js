'use strict';

const { consolidateCalcRuns, groupCalculatorByRef, standardBudget, time } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');
const { score } = require('../../panel-ready');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    const [data, calcRuns, links, dispositions, meta, responses, archive] = await Promise.all([
      operational(ctx),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment }),
      panelMeta(ctx),
      allRows(ctx, 'lead_events', { select: 'ref_code,unit_id,occurred_at', environment: 'eq.' + ctx.environment, event_type: 'eq.WANT_CAR', undone_at: 'is.null', occurred_at: 'gte.' + new Date(cutoff).toISOString() }),
      allRows(ctx, 'manheim_vehicles', { select: 'vehicle_json', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + new Date(now - 60 * 86400000).toISOString() })
    ]);
    const wanted = new Set(responses.map((event) => String(event.ref_code).trim()));
    const vehicles = archive.map((entry) => entry.vehicle_json);

    const journeyMap = new Map(data.journeys.map((item) => [item.id, item]));
    const latestByJourney = new Map();
    for (const message of data.messages) {
      const current = latestByJourney.get(message.journey_id);
      const stamp = time(message.occurred_at_utc || message.occurred_at_local || message.created_at) || 0;
      const currentStamp = current ? time(current.occurred_at_utc || current.occurred_at_local || current.created_at) || 0 : -1;
      if (stamp >= currentStamp) latestByJourney.set(message.journey_id, message);
    }

    const calcModes = consolidateCalcRuns(calcRuns, links).map((item) => {
      const journey = item.link && item.link.journeyId ? journeyMap.get(item.link.journeyId) : null;
      const latest = journey ? latestByJourney.get(journey.id) : null;
      return {
        ...item,
        status: item.link && latest ? (latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO') : item.eventStatus,
        contactName: journey && journey.contact ? journey.contact.display_name : item.contactName
      };
    });
    const orders = groupCalculatorByRef(calcModes, dispositions)
      .filter((item) => item.pending && ((time(item.occurredAt) || 0) >= cutoff || wanted.has(item.ref)))
      .map((item) => ({
        ...item,
        kind: 'CALCULATOR_ORDER',
        id: item.key,
        name: item.contactName || `Ref ${item.ref}`,
        checklistLabel: item.simulationCount > 1 ? `${item.simulationCount} simulações` : item.logicalMode === 'CARRO' ? 'carro ideal' : 'por valor',
        standardBudget: standardBudget(item.budgetCents)
      }));

    const orderRefs = new Set(orders.map((item) => item.ref).filter(Boolean));
    const dispositionByJourney = new Map(dispositions.filter((item) => item.item_kind === 'JOURNEY').map((item) => [item.item_key, item]));
    const journeys = data.journeys
      .filter((item) => (time(item.created_at) || 0) >= cutoff || wanted.has(String(item.reference_code).trim()))
      .filter((item) => !dispositionByJourney.has(item.id))
      .filter((item) => !item.reference_code || !orderRefs.has(String(item.reference_code).toUpperCase()))
      .map((item) => ({
        ...item,
        kind: 'JOURNEY',
        name: item.contact && item.contact.display_name || 'Contato sem nome',
        referenceCode: item.reference_code,
        occurredAt: item.created_at,
        clickedContact: false,
        contactChannel: null,
        standardBudget: standardBudget(item.budget_cents),
        outOfStandard: !standardBudget(item.budget_cents),
        budgetCents: Number(item.budget_cents) || 0,
        vehicleText: item.vehicle_text || null,
        checklistLabel: 'ficha nova'
      }));

    const items = orders.concat(journeys).map((item) => {
      const journey = journeyMap.get(item.journeyId || item.id);
      return { ...item, ...score(item, journey, data, vehicles, now), wantsCar: wanted.has(item.ref || String(item.referenceCode).trim()) };
    }).sort((left, right) => {
      const wants = Number(Boolean(right.wantsCar)) - Number(Boolean(left.wantsCar));
      if (wants) return wants;
      const promise = Number(Boolean(right.promiseToday)) - Number(Boolean(left.promiseToday));
      if (promise) return promise;
      const ready = Number(right.score || 0) - Number(left.score || 0);
      if (ready) return ready;
      const outlier = Number(Boolean(left.outOfStandard)) - Number(Boolean(right.outOfStandard));
      if (outlier) return outlier;
      const clicked = Number(Boolean(right.clickedContact)) - Number(Boolean(left.clickedContact));
      if (clicked) return clicked;
      const recent = (time(right.occurredAt) || 0) - (time(left.occurredAt) || 0);
      if (recent) return recent;
      return String(left.id).localeCompare(String(right.id));
    });

    return send(res, 200, {
      environment: ctx.environment,
      windowHours: 24,
      generatedAt: new Date(now).toISOString(),
      items,
      meta
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_TODAY_ERROR' });
  }
};
