'use strict';

const { consolidateCalcRuns, groupCalculatorByRef, journeyLogicalMode, standardBudget, time } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');
const { sortItems } = require('../../panel-sort');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const filter = String((req.query && req.query.filter) || 'Todos');
    const period = String((req.query && req.query.period) || '30');
    const exactRef = String((req.query && req.query.ref) || '').trim().toUpperCase();
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query && req.query.limit, 10) || 30));
    const offset = Math.max(0, Number.parseInt(req.query && req.query.offset, 10) || 0);
    const sort=String(req.query?.sort||'recent');
    if (!['Todos', 'Calculadora', 'WhatsApp direto', 'Carro', 'Valor', 'Pendentes'].includes(filter)) return send(res, 400, { error: 'ORDER_FILTER_INVALID' });
    if (!['7', '30', '90', 'all'].includes(period)) return send(res, 400, { error: 'ORDER_PERIOD_INVALID' });
    if (exactRef && !/^[A-HJ-NP-Z2-9]{5}$/.test(exactRef)) return send(res, 400, { error: 'ORDER_REF_INVALID' });

    const [calcRuns, links, dispositions, data, meta] = await Promise.all([
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment }),
      operational(ctx),
      panelMeta(ctx)
    ]);

    const journeys = new Map(data.journeys.map((item) => [item.id, item]));
    const journeyByRef=new Map(data.journeys.filter(x=>x.reference_code).map(x=>[String(x.reference_code).trim().toUpperCase(),x]));
    for(const ref of data.refs||[]){const journey=journeys.get(ref.journey_id);if(journey)journeyByRef.set(String(ref.ref_code).trim().toUpperCase(),journey);}
    const latestByJourney = new Map();
    for (const message of data.messages) {
      const current = latestByJourney.get(message.journey_id);
      const stamp = Date.parse(message.occurred_at_utc || message.occurred_at_local || message.created_at) || 0;
      const currentStamp = current ? Date.parse(current.occurred_at_utc || current.occurred_at_local || current.created_at) || 0 : -1;
      if (stamp >= currentStamp) latestByJourney.set(message.journey_id, message);
    }

    const calcModes = consolidateCalcRuns(calcRuns, links).map((item) => {
      const journey = item.link && item.link.journeyId ? journeys.get(item.link.journeyId) : null;
      const latest = journey ? latestByJourney.get(journey.id) : null;
      return {
        ...item,
        sourceLabel: 'Calculadora',
        status: item.link && latest ? (latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO') : item.eventStatus,
        contactName: journey && journey.contact ? journey.contact.display_name : item.contactName
      };
    });
    const calculator = groupCalculatorByRef(calcModes, dispositions).filter((item)=>!(data.excludedRefs||[]).includes(item.ref)).flatMap((item) => {const linked=journeyByRef.get(item.ref);return [{
      ...item,journeyId:linked?.id||item.journeyId,contactName:linked?.contact?.display_name||item.contactName,phones:linked?.phones||[],confirmed_total_ceiling_cents:linked?.confirmed_total_ceiling_cents,
      sourceLabel: 'Calculadora',
      status: item.disposition === 'TREATED' ? 'TRATADO' : item.disposition === 'DISCARDED' ? 'DESCARTADO' : item.status,
      standardBudget: standardBudget(item.budgetCents)
    }];});

    const dispositionByJourney = new Map(dispositions.filter((item) => item.item_kind === 'JOURNEY').map((item) => [item.item_key, item]));
    const direct = data.journeys.filter((item) => ['WHATSAPP_DIRECT', 'SMS_DIRECT'].includes(item.source)).map((item) => {
      const latest = latestByJourney.get(item.id);
      const disposition = dispositionByJourney.get(item.id) || null;
      return {
        key: 'direct:' + item.id, kind: 'DIRECT', journeyId: item.id,
        sourceLabel: item.source === 'SMS_DIRECT' ? 'SMS direto' : 'WhatsApp direto',
        logicalMode: journeyLogicalMode(item), logicalModes: [journeyLogicalMode(item)],
        simulationCount: 0, simulations: [],
        vehicleText: item.vehicle_text, budgetCents: item.budget_cents,
        paymentText: item.payment_text, deadlineText: item.customer_deadline_text,
        referenceCode: item.reference_code, ref: item.reference_code,
        occurredAt: item.created_at, contactName: item.contact && item.contact.display_name,
        disposition: disposition ? disposition.status : null,
        dispositionUpdatedAt: disposition ? disposition.updated_at : null,
        pending: !disposition,
        outOfStandard: !standardBudget(item.budget_cents),
        status: disposition ? (disposition.status === 'TREATED' ? 'TRATADO' : 'DESCARTADO') : latest && latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO',
        phones:item.phones||[],confirmed_total_ceiling_cents:item.confirmed_total_ceiling_cents
      };
    });

    const cutoff = filter === 'Pendentes' || period === 'all' ? null : Date.now() - Number(period) * 24 * 60 * 60 * 1000;
    let filtered = calculator.concat(direct);
    if (exactRef) filtered = filtered.filter((item) => String(item.ref || item.referenceCode || '').toUpperCase() === exactRef);
    else {
      filtered = filtered.filter((item) => {
        if (filter === 'Calculadora') return item.kind === 'CALCULATOR';
        if (filter === 'WhatsApp direto') return item.kind === 'DIRECT';
        if (filter === 'Carro') return (item.logicalModes || [item.logicalMode]).includes('CARRO');
        if (filter === 'Valor') return (item.logicalModes || [item.logicalMode]).includes('VALOR');
        if (filter === 'Pendentes') return item.pending;
        return true;
      }).filter((item) => cutoff === null || (time(item.occurredAt) || 0) >= cutoff);
    }
    filtered=sortItems(filtered,sort,'recent');

    const items = exactRef ? filtered.slice(0, 1) : filtered.slice(offset, offset + limit);
    const linkTargets = data.journeys.filter((item) => item.status !== 'ENCERRADO' && item.stage !== 'QUALIFICADO').map((item) => ({
      journeyId: item.id, contactId: item.contact_id,
      label: `${item.contact && item.contact.display_name ? item.contact.display_name : 'Contato sem nome'} · Ref ${item.reference_code || '—'} — ${item.vehicle_text || 'busca sem veículo'}`
    }));
    return send(res, 200, {
      environment: ctx.environment, filter, period, items, linkTargets, meta,
      page: { offset, limit, total: filtered.length, hasMore: !exactRef && offset + items.length < filtered.length }
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_ORDERS_ERROR' });
  }
};
