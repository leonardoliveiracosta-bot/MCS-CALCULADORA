'use strict';

const { buildTodayItems, consolidateCalcRuns, effectiveCriteria, groupCalculatorByRef, standardBudget, time } = require('../../panel-domain');
const { dispositionIndex, refKey } = require('../../panel-disposition');
const { operational } = require('../../panel-read-model');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');
const { score, loadScoreIndex } = require('../../panel-ready');
const { timezoneForZip } = require('../../panel-lead');
const { sortItems } = require('../../panel-sort');
const { contactIndex, decorateContact } = require('../../panel-contact');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');
const { optOutOf } = require('../../panel-reply-suggest');

function dueToday(promises, ref, zip, now) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezoneForZip(zip), year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = format.format(now);
  return promises.some((item) => String(item.ref_code).trim() === ref && item.status === 'OPEN' && format.format(new Date(item.due_at)) === today);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    // HOJE never reads Manheim cars: the score gets one reference MMR per person from the database
    // (live batches only; an undone or unfinished batch never feeds HOJE).
    const [data, calcRuns, links, dispositions, meta, responses, vehicles, leadPromises, aiItems, aiSuggestions, pendingInsights] = await Promise.all([
      operational(ctx),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' }),
      panelMeta(ctx),
      // A12: "quero este carro" stays until it is handled, not only for 24 hours (30 days at most).
      allRows(ctx, 'lead_events', { select: 'ref_code,journey_id,unit_id,occurred_at', environment: 'eq.' + ctx.environment, event_type: 'eq.WANT_CAR', undone_at: 'is.null', occurred_at: 'gte.' + new Date(now - 30 * 86400000).toISOString() }),
      loadScoreIndex(ctx, now).catch(() => []),
      allRows(ctx, 'lead_promises', { select: 'ref_code,journey_id,promise_text,due_at,status', environment: 'eq.' + ctx.environment, status: 'eq.OPEN' }),
      allRows(ctx, 'conversation_ai_items', { select: 'journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING' }),
      allRows(ctx, 'whatsapp_link_suggestions', { select: 'source_journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING', suggestion_kind: 'eq.AI' })
      ,allRows(ctx, 'conversation_pending_insights', { select: 'journey_id,heat,summary_text,next_step_text,last_ai_message_id,updated_at', environment: 'eq.' + ctx.environment })
    ]);
    const contacts = contactIndex({ calcRuns, messages: data.messages, messageLinks: data.messages.map((message) => ({ journey_id: message.journey_id, message_id: message.id })) });
    const insightByJourney = new Map(pendingInsights.map((item) => [item.journey_id, item]));
    const wantedAtByRef = new Map();
    for (const event of responses) {
      const ref = String(event.ref_code || '').trim().toUpperCase();
      const stamp = time(event.occurred_at) || 0;
      if (ref && stamp >= (wantedAtByRef.get(ref) || 0)) wantedAtByRef.set(ref, stamp);
    }
    const eventAfterDisposition = (eventAt, dispositionAt) => !dispositionAt || Number(eventAt || 0) > (time(dispositionAt) || 0);
    // "Quero este carro" is handled by a disposition or by a real MCS message sent after it.
    const latestMcsAt = new Map();
    for (const message of data.messages) {
      if (message.direction !== 'MCS' || message.is_automatic) continue;
      const stamp = time(message.occurred_at_utc || message.occurred_at_local || message.created_at) || 0;
      if (stamp > (latestMcsAt.get(message.journey_id) || 0)) latestMcsAt.set(message.journey_id, stamp);
    }
    // M3 covers only customer messages: "quero este carro" never brings back a closed or switched-off
    // ficha, nor a discarded person (only a customer message after the discard does), nor a Ref owned
    // by more than one ficha (R3: it is nobody's context).
    const wantedAfterDisposition = (ref, dispositionAt, dispositionStatus) => { const key=refKey(ref);if(dispositionStatus==='DISCARDED'||ambiguousRefs.has(key))return false;const stamp=wantedAtByRef.get(key);if(!stamp||!eventAfterDisposition(stamp,dispositionAt))return false;const journey=journeyByRef.get(key);if(journey&&(journey.enabled===false||journey.status==='ENCERRADO'))return false;return !(journey&&(latestMcsAt.get(journey.id)||0)>stamp); };
    const firstSimulation=new Map(), firstCalculatorEvent=new Map();
    for(const run of calcRuns){
      if(run.is_test===true)continue;
      const data=run.dados&&typeof run.dados==='object'?run.dados:{};
      const ref=String(data.ref||'').trim().toUpperCase(),stamp=time(data.quando||run.created_at);
      if(!ref||!stamp)continue;
      firstCalculatorEvent.set(ref,Math.min(firstCalculatorEvent.get(ref)||Infinity,stamp));
      if(['simulacao','busca'].includes(String(data.evento||'').toLowerCase()))
        firstSimulation.set(ref,Math.min(firstSimulation.get(ref)||Infinity,stamp));
    }

    const journeyMap = new Map(data.journeys.map((item) => [item.id, item]));
    // R3: a Ref owned by more than one ficha is never attached to any of them (no last-owner-wins):
    // its order shows without client context and each ficha shows on its own.
    const refOwners = new Map();
    const addOwner = (ref, journey) => { const key = refKey(ref); if (!key || !journey) return; if (!refOwners.has(key)) refOwners.set(key, new Set()); refOwners.get(key).add(journey.id); };
    data.journeys.forEach((item) => addOwner(item.reference_code, item));
    for (const link of data.refs || []) addOwner(link.ref_code, journeyMap.get(link.journey_id));
    const ambiguousRefs = new Set([...refOwners].filter(([, owners]) => owners.size > 1).map(([ref]) => ref));
    const journeyByRef = new Map([...refOwners].filter(([ref]) => !ambiguousRefs.has(ref)).map(([ref, owners]) => [ref, journeyMap.get([...owners][0])]));
    const latestByJourney = new Map();
    for (const message of data.messages) {
      if (message.is_automatic) continue;
      const current = latestByJourney.get(message.journey_id);
      const stamp = time(message.occurred_at_utc || message.occurred_at_local || message.created_at) || 0;
      const currentStamp = current ? time(current.occurred_at_utc || current.occurred_at_local || current.created_at) || 0 : -1;
      if (stamp >= currentStamp) latestByJourney.set(message.journey_id, message);
    }

    // A client whose latest customer message asks not to be contacted (opt-out) is not actionable in HOJE.
    const lastCustomerByJourney = new Map();
    for (const message of data.messages) {
      if (message.direction !== 'CUSTOMER' || message.is_automatic) continue;
      const current = lastCustomerByJourney.get(message.journey_id);
      if (!current || (time(message.occurred_at_utc || message.created_at) || 0) >= (time(current.occurred_at_utc || current.created_at) || 0)) lastCustomerByJourney.set(message.journey_id, message);
    }
    const optedOut = (journey) => { const last = journey && lastCustomerByJourney.get(journey.id); return Boolean(last && optOutOf([last])); };
    const calcModes = consolidateCalcRuns(calcRuns, links).map((item) => {
      // B2: a Ref linked through journey_refs is also a conversation, not only calculator_request_links.
      const journey = item.link && item.link.journeyId ? journeyMap.get(item.link.journeyId) : journeyByRef.get(refKey(item.ref)) || null;
      const latest = journey ? latestByJourney.get(journey.id) : null;
      return {
        ...item,
        status: journey && latest ? (latest.direction === 'CUSTOMER' ? 'SEM RESPOSTA' : 'RESPONDIDO') : item.eventStatus,
        contactName: journey && journey.contact ? journey.contact.display_name : item.contactName
      };
    });
    // M3: "voltou a falar" only when the customer wrote after the ficha was closed or switched off.
    const returnedForJourney=(journey,dispositionAt)=>{const latest=journey&&latestByJourney.get(journey.id);const stamp=time(latest?.occurred_at_utc||latest?.occurred_at_local||latest?.created_at)||0;const closedAt=Math.max(time(journey?.closed_at)||0,time(journey?.switchedAt)||0);return Boolean(journey&&(journey.enabled===false||journey.status==='ENCERRADO')&&latest?.direction==='CUSTOMER'&&stamp>=cutoff&&stamp>closedAt&&eventAfterDisposition(stamp,dispositionAt));};
    // A12: overdue returns and promises, and a ficha without a next action for 2 days, belong in HOJE.
    const promiseRows=data.promises.concat(leadPromises.map((row)=>({...row,journey_id:row.journey_id||journeyByRef.get(refKey(row.ref_code))?.id||null})));
    const overdueByJourney=new Map(buildTodayItems({journeys:data.journeys,messages:data.messages,promises:promiseRows},new Date(now))
      .map((item)=>[item.id,item.reasons.filter((reason)=>['NEXT_ACTION','PROMISE','MISSING_NEXT_ACTION'].includes(reason.kind))]).filter(([,reasons])=>reasons.length));
    // A discarded person never comes back through an overdue next action or promise (only a customer message).
    const overdueAfter=(journey,dispositionAt,dispositionStatus)=>Boolean(journey&&dispositionStatus!=='DISCARDED'&&(overdueByJourney.get(journey.id)||[]).some((reason)=>eventAfterDisposition(reason.anchor,dispositionAt)));
    // A8: one disposition per person (ficha + linked Refs).
    const personDisposition=dispositionIndex(dispositions);
    const refsOf=(journey)=>journey?[journey.reference_code,...(data.refs||[]).filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code)].filter(Boolean).map(refKey).filter((ref)=>!ambiguousRefs.has(ref)):[];
    const dispositionFor=(journey,ref)=>personDisposition(journey?.id,[...new Set([...refsOf(journey),...(ref?[refKey(ref)]:[])])]);
    // A contact after the disposition brings the person back ("Tratado" means handled until now).
    // DISCARDED: only a customer message after the discard brings the person back; TREATED as before.
    const activeFor=(journey,ref,facts,dispositionAt,dispositionStatus)=>wantedAfterDisposition(ref,dispositionAt,dispositionStatus)||returnedForJourney(journey,dispositionAt)||overdueAfter(journey,dispositionAt,dispositionStatus)
      ||Boolean(facts.entered&&facts.latestAt>=cutoff&&eventAfterDisposition(facts.latestAt,dispositionAt)&&(!journey||journey.enabled!==false));
    const grouped=groupCalculatorByRef(calcModes, dispositions)
      .filter((item)=>!(data.excludedRefs||[]).includes(item.ref))
      .map((item)=>{const journey=journeyByRef.get(item.ref);const disposition=dispositionFor(journey,item.ref);const person=disposition?{...item,disposition:disposition.status,discardReason:disposition.discard_reason||null,dispositionUpdatedAt:disposition.updated_at||null}:item;
        // A9 + R1: the card shows the same bid as the ficha (the ficha's bid wins over the calculator's).
        return journey?{...person,journeyId:journey.id,contactName:journey.contact?.display_name||item.contactName,phones:journey.phones,confirmed_total_ceiling_cents:journey.confirmed_total_ceiling_cents,budgetCents:effectiveCriteria(journey,item).bidCents||item.budgetCents}:person;});
    const ordersByRef=new Map(grouped.map((item)=>[item.ref,item]));
    const arrival=(order)=>firstSimulation.get(order.ref)||firstCalculatorEvent.get(order.ref)||
      Math.min(...(order.simulations||[order]).map((simulation)=>time(simulation.occurredAt)||Infinity));
    const orders = grouped
      // Only whoever really wrote: an order with no message (simulated or only clicked) never enters HOJE,
      // whatever else is true about it (the calculator has no phone).
      .filter((item) => { const journey=item.journeyId?journeyMap.get(item.journeyId):null;const facts=contacts.facts({ref:item.ref,journeyId:item.journeyId,refs:refsOf(journey)}); return facts.entered&&!optedOut(journey)&&activeFor(journey,item.ref,facts,item.dispositionUpdatedAt,item.disposition); })
      .map((item) => ({
        ...item,
        kind: 'CALCULATOR_ORDER',
        id: item.key,
        name: item.contactName || `Ref ${item.ref}`,
        checklistLabel: item.simulationCount > 1 ? `${item.simulationCount} simulações` : (item.logicalModes || []).length > 1 ? 'por valor e por ano e milhagem' : item.logicalMode === 'CARRO' ? 'carro ideal' : 'por valor',
        standardBudget: standardBudget(item.budgetCents)
      }));

    const orderRefs = new Set(orders.map((item) => item.ref).filter(Boolean));
    const journeys = data.journeys
      .filter((item) => item.closed_reason !== 'WHATSAPP_LINKED')
      .filter((item) => {const disposition=dispositionFor(item);const refs=refsOf(item);
        const facts=contacts.facts({journeyId:item.id,ref:item.reference_code,refs});
        // A ficha enters only if the client wrote or the team has a phone for it (manual record).
        if(!facts.entered&&!(item.phones||[]).length)return false;
        if(optedOut(item))return false;
        return refs.some((ref)=>wantedAfterDisposition(ref,disposition?.updated_at,disposition?.status))||activeFor(item,null,facts,disposition?.updated_at,disposition?.status);})
      .filter((item) => !refsOf(item).some((ref)=>orderRefs.has(ref)))
      .map((item) => ({
        ...item, disposition:dispositionFor(item)?.status||null, discardReason:dispositionFor(item)?.discard_reason||null, dispositionUpdatedAt:dispositionFor(item)?.updated_at||null,
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

    let items = orders.concat(journeys).map((item) => {
      const journey = journeyMap.get(item.journeyId || item.id) || journeyByRef.get(String(item.ref || item.referenceCode || '').trim().toUpperCase());
      const ref = String(item.ref || item.referenceCode || '').trim().toUpperCase();
      const simulations = item.simulations || (journey ? refsOf(journey).flatMap((own) => ordersByRef.get(own)?.simulations || []) : []);
      const ready = score({ ...item, simulations }, journey, { ...data, promises:data.promises.concat(leadPromises) }, vehicles, now);
      const dispositionAt=item.dispositionUpdatedAt||dispositionFor(journey,ref)?.updated_at,dispositionStatus=item.disposition||dispositionFor(journey,ref)?.status||null;const returned=returnedForJourney(journey,dispositionAt);
      const journeyId=journey?.id;
      const facts=contacts.facts({journeyId:journey?.id,ref,refs:journey?(data.refs||[]).filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code):[]});
      const ownMessages=journeyId?data.messages.filter((message)=>message.journey_id===journeyId).sort((a,b)=>(time(b.occurred_at_utc||b.created_at)||0)-(time(a.occurred_at_utc||a.created_at)||0)):[];
      const latestMessage=ownMessages.find((message)=>!message.is_automatic)||ownMessages[0]||null,latestMcsMessage=ownMessages.find((message)=>message.direction==='MCS')||null,lastCustomer=ownMessages.find((message)=>message.direction==='CUSTOMER')||null;
      return decorateContact({ ...item, phones:item.phones||journey?.phones||[], ...ready, latestMessage,latestMcsMessage,lastCustomerAt:lastCustomer?.occurred_at_utc||lastCustomer?.created_at||null, returnedToTalk:returned, promiseToday: ready.promiseToday || (journey?.enabled !== false && dueToday(leadPromises, ref, item.zip, now)), wantsCar: wantedAfterDisposition(ref,dispositionAt,dispositionStatus),
        todayReasons:journeyId&&dispositionStatus!=='DISCARDED'?(overdueByJourney.get(journeyId)||[]).filter((reason)=>eventAfterDisposition(reason.anchor,dispositionAt)).map(({kind,label,dueAt,detail,urgency})=>({kind,label,dueAt:dueAt||null,detail:detail||null,urgency:urgency||'yellow'})):[],
        awaitingReply:Boolean(latestMessage&&latestMessage.direction==='CUSTOMER'),
        pendingAiCount:journeyId?aiItems.filter((entry)=>entry.journey_id===journeyId).length:0,aiLinkSuggested:journeyId?aiSuggestions.some((entry)=>entry.source_journey_id===journeyId):false }, facts, insightByJourney.get(journeyId), journey);
    }).sort((left, right) => {
      const wants = Number(Boolean(right.wantsCar)) - Number(Boolean(left.wantsCar));
      if (wants) return wants;
      const promise = Number(Boolean(right.promiseToday)) - Number(Boolean(left.promiseToday));
      if (promise) return promise;
      const heat={HOT:3,WARM:2,COLD:1};
      const temperature=(heat[String(right.heat||'').toUpperCase()]||0)-(heat[String(left.heat||'').toUpperCase()]||0);
      if(temperature)return temperature;
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
    const requestedSort=String(req.query?.sort||'ready');
    if(requestedSort!=='ready')items=sortItems(items,requestedSort,'ready');

    const stageIndex=await loadSearchStageIndex(ctx).catch(()=>new Map());
    return send(res, 200, {
      environment: ctx.environment,
      windowHours: 24,
      generatedAt: new Date(now).toISOString(),
      items:items.map((item)=>decorateWithSearchStage(item,stageIndex)),
      meta
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_TODAY_ERROR' });
  }
};
