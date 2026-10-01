'use strict';

const { consolidateCalcRuns, effectiveCriteria, groupCalculatorByRef, journeyLogicalMode, standardBudget, time } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');
const { sortItems, lastRealMessageAt } = require('../../panel-sort');
const { contactIndex, decorateContact } = require('../../panel-contact');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');
const { score, loadScoreVehicles } = require('../../panel-ready');
const { dispositionIndex, refKey } = require('../../panel-disposition');

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
    const scope = String((req.query && req.query.scope) || '');
    if (!['Todos', 'Calculadora', 'WhatsApp direto', 'Carro', 'Valor', 'Pendentes'].includes(filter)) return send(res, 400, { error: 'ORDER_FILTER_INVALID' });
    if (!['7', '30', '90', 'all'].includes(period)) return send(res, 400, { error: 'ORDER_PERIOD_INVALID' });
    if (exactRef && !/^[A-HJ-NP-Z2-9]{5}$/.test(exactRef)) return send(res, 400, { error: 'ORDER_REF_INVALID' });

    const [calcRuns, links, dispositions, data, meta, insights] = await Promise.all([
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' }),
      operational(ctx),
      panelMeta(ctx),
      allRows(ctx, 'conversation_pending_insights', { select:'journey_id,heat,summary_text,next_step_text,last_ai_message_id,updated_at', environment:'eq.' + ctx.environment })
    ]);
    const contact=contactIndex({calcRuns,messages:data.messages,messageLinks:data.messages.map((message)=>({journey_id:message.journey_id,message_id:message.id}))});
    const insightByJourney=new Map(insights.map((item)=>[item.journey_id,item]));

    const journeys = new Map(data.journeys.map((item) => [item.id, item]));
    const journeyByRef=new Map(data.journeys.filter(x=>x.reference_code).map(x=>[String(x.reference_code).trim().toUpperCase(),x]));
    for(const ref of data.refs||[]){const journey=journeys.get(ref.journey_id);if(journey)journeyByRef.set(String(ref.ref_code).trim().toUpperCase(),journey);}
    const latestByJourney = new Map();
    const latestCustomerByJourney = new Map();
    for (const message of data.messages) {
      if (message.is_automatic) continue;
      const current = latestByJourney.get(message.journey_id);
      const stamp = Date.parse(message.occurred_at_utc || message.occurred_at_local || message.created_at) || 0;
      const currentStamp = current ? Date.parse(current.occurred_at_utc || current.occurred_at_local || current.created_at) || 0 : -1;
      if (stamp >= currentStamp) latestByJourney.set(message.journey_id, message);
      if (message.direction === 'CUSTOMER') {
        const customer = latestCustomerByJourney.get(message.journey_id);
        const customerStamp = customer ? Date.parse(customer.occurred_at_utc || customer.occurred_at_local || customer.created_at) || 0 : -1;
        if (stamp >= customerStamp) latestCustomerByJourney.set(message.journey_id, message);
      }
    }

    /* ordem Mais recentes/antigas: ultima mensagem real da conversa; sem mensagem, a simulacao; sem nada, fim */
    const messagesByJourney = new Map();
    for (const message of data.messages) { if (!messagesByJourney.has(message.journey_id)) messagesByJourney.set(message.journey_id, []); messagesByJourney.get(message.journey_id).push(message); }
    const lastRealByJourney = (id) => (id ? lastRealMessageAt(messagesByJourney.get(id)) : null);

    const calcModes = consolidateCalcRuns(calcRuns, links).map((item) => {
      // B2: a Ref linked through journey_refs is also a conversation, not only calculator_request_links.
      const journey = item.link && item.link.journeyId ? journeys.get(item.link.journeyId) : journeyByRef.get(refKey(item.ref)) || null;
      const latest = journey ? latestByJourney.get(journey.id) : null;
      return {
        ...item,
        sourceLabel: 'Calculadora',
        status: journey && latest ? (latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO') : item.eventStatus,
        contactName: journey && journey.contact ? journey.contact.display_name : item.contactName
      };
    });
    // A8: one disposition per person (ficha + linked Refs).
    // A9: the same cars as every other screen, so the score matches.
    const scoreVehicles = await loadScoreVehicles(ctx).catch(() => []);
    const personDisposition = dispositionIndex(dispositions);
    const refsOfJourney = (journey) => [journey.reference_code, ...(data.refs || []).filter((row) => row.journey_id === journey.id).map((row) => row.ref_code)].filter(Boolean).map(refKey);
    const calculator = groupCalculatorByRef(calcModes, dispositions).filter((item)=>!(data.excludedRefs||[]).includes(item.ref)).flatMap((item) => {const linked=journeyByRef.get(item.ref);const person=linked?personDisposition(linked.id,[...refsOfJourney(linked),item.ref]):null;const facts=contact.facts({ref:item.ref,journeyId:linked?.id,refs:linked?(data.refs||[]).filter((row)=>row.journey_id===linked.id).map((row)=>row.ref_code):[]});if(!facts.entered&&!(exactRef&&item.ref===exactRef))return [];const ready=score(item,linked,{checklist:data.checklist,promises:data.promises,messages:data.messages},scoreVehicles);return [decorateContact({
      ...item,...(person?{disposition:person.status,discardReason:person.discard_reason||null,dispositionUpdatedAt:person.updated_at||null,pending:false}:{}),journeyId:linked?.id||item.journeyId,latestMessage:linked?latestByJourney.get(linked.id)||null:null,budgetCents:linked?effectiveCriteria(linked,item).bidCents||item.budgetCents:item.budgetCents,contactName:linked?.contact?.display_name||item.contactName,phones:linked?.phones||[],confirmed_total_ceiling_cents:linked?.confirmed_total_ceiling_cents,
      lastCustomerAt: Math.max(time(item.occurredAt)||0, time(latestCustomerByJourney.get(linked?.id)?.occurred_at_utc || latestCustomerByJourney.get(linked?.id)?.occurred_at_local || latestCustomerByJourney.get(linked?.id)?.created_at)||0) || null,
      lastRealMessageAt: lastRealByJourney(linked?.id||item.journeyId), sortAt: lastRealByJourney(linked?.id||item.journeyId) || item.occurredAt || null,
      sourceLabel: 'Calculadora',
      status: (person?person.status:item.disposition) === 'TREATED' ? 'TRATADO' : (person?person.status:item.disposition) === 'DISCARDED' ? 'DESCARTADO' : item.status,
      standardBudget: standardBudget(item.budgetCents),score:ready.score,goodHour:ready.goodHour
    },facts,insightByJourney.get(linked?.id),linked)];});

    const direct = data.journeys.filter((item) => ['WHATSAPP_DIRECT', 'SMS_DIRECT'].includes(item.source)).flatMap((item) => {
      const facts=contact.facts({journeyId:item.id,ref:item.reference_code,refs:(data.refs||[]).filter((row)=>row.journey_id===item.id).map((row)=>row.ref_code)});if(!facts.entered)return [];
      const latest = latestByJourney.get(item.id);
      const disposition = personDisposition(item.id, refsOfJourney(item));
      const complete={...item,phones:item.phones||[]};const ready=score(complete,complete,{checklist:data.checklist,promises:data.promises,messages:data.messages},scoreVehicles);return [decorateContact({
        key: 'direct:' + item.id, kind: 'DIRECT', journeyId: item.id, latestMessage: latest || null,
        sourceLabel: item.source === 'SMS_DIRECT' ? 'SMS direto' : 'WhatsApp direto',
        logicalMode: journeyLogicalMode(item), logicalModes: [journeyLogicalMode(item)],
        simulationCount: 0, simulations: [],
        vehicleText: item.vehicle_text, budgetCents: item.budget_cents,
        paymentText: item.payment_text, deadlineText: item.customer_deadline_text,
        referenceCode: item.reference_code, ref: item.reference_code,
        occurredAt: item.created_at, contactName: item.contact && item.contact.display_name,
        disposition: disposition ? disposition.status : null,
        discardReason: disposition ? disposition.discard_reason : null,
        dispositionUpdatedAt: disposition ? disposition.updated_at : null,
        pending: !disposition,
        outOfStandard: !standardBudget(item.budget_cents),
        status: disposition ? (disposition.status === 'TREATED' ? 'TRATADO' : 'DESCARTADO') : latest && latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO',
        phones:item.phones||[],confirmed_total_ceiling_cents:item.confirmed_total_ceiling_cents,
        lastRealMessageAt: lastRealByJourney(item.id), sortAt: lastRealByJourney(item.id),
        lastCustomerAt: latestCustomerByJourney.get(item.id)?.occurred_at_utc || latestCustomerByJourney.get(item.id)?.occurred_at_local || latestCustomerByJourney.get(item.id)?.created_at || item.created_at,score:ready.score,goodHour:ready.goodHour
      },facts,insightByJourney.get(item.id),complete)];
    });

    // Lote 4 (PEDIDOS fundido em ENTRADA): calculator Refs with no ficha yet, still to handle.
    // "contacted" entered in contact through the calculator; "simulated" only simulated. Counts
    // come with the page so the ENTRADA section shows its own number (never the tab badge).
    if (scope === 'unlinked') {
      const group = String((req.query && req.query.group) || 'contacted');
      if (!['contacted', 'simulated'].includes(group)) return send(res, 400, { error: 'ORDER_GROUP_INVALID' });
      const since = period === 'all' ? null : Date.now() - Number(period) * 24 * 60 * 60 * 1000;
      const open = calculator.filter((item) => !item.journeyId && !item.disposition && (since === null || (time(item.occurredAt) || 0) >= since));
      // "Entered in contact" is the panel's single rule (panel-contact.js): a message that really
      // arrived. An order with no message (simulated or only clicked) is never listed: the calculator
      // has no phone, there is nothing to do with it. Both groups stay for old clients of the API.
      const groups = { contacted: open.filter((item) => item.enteredContact), simulated: [] };
      const listed = sortItems(groups[group], sort, 'recent');
      const page = listed.slice(offset, offset + limit);
      const linkTargets = data.journeys.filter((item) => item.status !== 'ENCERRADO').map((item) => ({
        journeyId: item.id, contactId: item.contact_id,
        label: `${item.contact && item.contact.display_name ? item.contact.display_name : 'Contato sem nome'} · Ref ${item.reference_code || 'sem Ref'} · ${item.vehicle_text || 'busca sem veículo'}`
      }));
      return send(res, 200, {
        environment: ctx.environment, scope, group, period, items: page, linkTargets, meta,
        counts: { contacted: groups.contacted.length, simulated: groups.simulated.length },
        page: { offset, limit, total: listed.length, hasMore: offset + page.length < listed.length }
      });
    }

    const cutoff = filter === 'Pendentes' || period === 'all' ? null : Date.now() - Number(period) * 24 * 60 * 60 * 1000;
    // M4: a direct ficha that also has a calculator order is one person: keep the order card only
    // (except in the "WhatsApp direto" filter, which shows the direct card).
    const orderJourneys=new Set(calculator.map((item)=>item.journeyId).filter(Boolean));
    let filtered = calculator.concat(filter === 'WhatsApp direto' ? direct : direct.filter((item)=>!orderJourneys.has(item.journeyId)));
    if (exactRef) filtered = filtered.filter((item) => String(item.ref || item.referenceCode || '').toUpperCase() === exactRef);
    else {
      filtered = filtered.filter((item) => {
        if (filter === 'Calculadora') return item.kind === 'CALCULATOR';
        if (filter === 'WhatsApp direto') return item.kind === 'DIRECT';
        if (filter === 'Carro') return (item.logicalModes || [item.logicalMode]).includes('CARRO');
        if (filter === 'Valor') return (item.logicalModes || [item.logicalMode]).includes('VALOR');
        if (filter === 'Pendentes') return item.pending;
        return true;
        // B4: the period counts the latest activity (simulation or real message), not only the simulation.
      }).filter((item) => cutoff === null || Math.max(time(item.occurredAt) || 0, time(item.lastRealMessageAt) || 0) >= cutoff);
    }
    filtered=sortItems(filtered,sort,'recent');

    const items = exactRef ? filtered.slice(0, 1) : filtered.slice(offset, offset + limit);
    // QUALIFICADO stays open since "Cliente deu OK" no longer closes: it can still receive a Ref.
    const linkTargets = data.journeys.filter((item) => item.status !== 'ENCERRADO').map((item) => ({
      journeyId: item.id, contactId: item.contact_id,
      label: `${item.contact && item.contact.display_name ? item.contact.display_name : 'Contato sem nome'} · Ref ${item.reference_code || '—'} — ${item.vehicle_text || 'busca sem veículo'}`
    }));
    const stageIndex=await loadSearchStageIndex(ctx);
    return send(res, 200, {
      environment: ctx.environment, filter, period, items:items.map((item)=>decorateWithSearchStage(item,stageIndex)), linkTargets, meta,
      page: { offset, limit, total: filtered.length, hasMore: !exactRef && offset + items.length < filtered.length }
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_ORDERS_ERROR' });
  }
};
