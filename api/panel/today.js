'use strict';

const { consolidateCalcRuns, groupCalculatorByRef, standardBudget, time } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');
const { score } = require('../../panel-ready');
const { timezoneForZip } = require('../../panel-lead');
const { sortItems } = require('../../panel-sort');
const { contactIndex, decorateContact } = require('../../panel-contact');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');

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
    const [data, calcRuns, links, dispositions, meta, responses, archive, leadPromises, recentMatches, aiItems, aiSuggestions, pendingInsights] = await Promise.all([
      operational(ctx),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' }),
      panelMeta(ctx),
      allRows(ctx, 'lead_events', { select: 'ref_code,unit_id,occurred_at', environment: 'eq.' + ctx.environment, event_type: 'eq.WANT_CAR', undone_at: 'is.null', occurred_at: 'gte.' + new Date(cutoff).toISOString() }),
      allRows(ctx, 'manheim_vehicles', { select: 'row_fingerprint,vehicle_json', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + new Date(now - 60 * 86400000).toISOString() }),
      allRows(ctx, 'lead_promises', { select: 'ref_code,journey_id,due_at,status', environment: 'eq.' + ctx.environment, status: 'eq.OPEN' }),
      allRows(ctx, 'manheim_matches', { select: 'row_fingerprint,vehicle_json', environment: 'eq.' + ctx.environment, created_at: 'gte.' + new Date(now - 60 * 86400000).toISOString() }),
      allRows(ctx, 'conversation_ai_items', { select: 'journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING' }),
      allRows(ctx, 'whatsapp_link_suggestions', { select: 'source_journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING', suggestion_kind: 'eq.AI' })
      ,allRows(ctx, 'conversation_pending_insights', { select: 'journey_id,heat,summary_text,next_step_text', environment: 'eq.' + ctx.environment })
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
    const wantedAfterDisposition = (ref, dispositionAt) => { const stamp=wantedAtByRef.get(String(ref || '').trim().toUpperCase());return Boolean(stamp)&&eventAfterDisposition(stamp,dispositionAt); };
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
    const uniqueVehicles=new Map();
    archive.forEach((entry)=>uniqueVehicles.set(entry.row_fingerprint,entry.vehicle_json));
    recentMatches.forEach((entry)=>{if(entry.vehicle_json?.parsed&&!uniqueVehicles.has(entry.row_fingerprint))uniqueVehicles.set(entry.row_fingerprint,entry.vehicle_json.parsed);});
    const vehicles=[...uniqueVehicles.values()];

    const journeyMap = new Map(data.journeys.map((item) => [item.id, item]));
    const journeyByRef = new Map(data.journeys.filter((item) => item.reference_code).map((item) => [String(item.reference_code).trim().toUpperCase(), item]));
    for(const link of data.refs||[]){const journey=journeyMap.get(link.journey_id);if(journey)journeyByRef.set(String(link.ref_code).trim().toUpperCase(),journey);}
    const latestByJourney = new Map();
    for (const message of data.messages) {
      if (message.is_automatic) continue;
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
    const returnedForJourney=(journey,dispositionAt)=>{const latest=journey&&latestByJourney.get(journey.id);const stamp=time(latest?.occurred_at_utc||latest?.occurred_at_local||latest?.created_at)||0;return Boolean(journey&&(journey.enabled===false||journey.status==='ENCERRADO')&&latest?.direction==='CUSTOMER'&&stamp>=cutoff&&eventAfterDisposition(stamp,dispositionAt));};
    const returnedForRef=(ref,dispositionAt)=>returnedForJourney(journeyByRef.get(String(ref||'').trim().toUpperCase()),dispositionAt);
    const grouped=groupCalculatorByRef(calcModes, dispositions)
      .filter((item)=>!(data.excludedRefs||[]).includes(item.ref))
      .filter((item)=>!item.disposition||wantedAfterDisposition(item.ref,item.dispositionUpdatedAt)||returnedForRef(item.ref,item.dispositionUpdatedAt))
      .map((item)=>{const journey=journeyByRef.get(item.ref);return journey?{...item,journeyId:journey.id,contactName:journey.contact?.display_name||item.contactName,phones:journey.phones,confirmed_total_ceiling_cents:journey.confirmed_total_ceiling_cents}:item;});
    const ordersByRef=new Map(grouped.map((item)=>[item.ref,item]));
    const arrival=(order)=>firstSimulation.get(order.ref)||firstCalculatorEvent.get(order.ref)||
      Math.min(...(order.simulations||[order]).map((simulation)=>time(simulation.occurredAt)||Infinity));
    const orders = grouped
      .filter((item) => { const facts=contacts.facts({ref:item.ref,journeyId:item.journeyId}); return wantedAfterDisposition(item.ref,item.dispositionUpdatedAt) || (facts.entered && (facts.latestAt>=cutoff || returnedForRef(item.ref,item.dispositionUpdatedAt))); })
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
      .filter((item) => item.closed_reason !== 'WHATSAPP_LINKED')
      .filter((item) => {const disposition=dispositionByJourney.get(item.id);const ref=String(item.reference_code||'').trim().toUpperCase();if(wantedAfterDisposition(ref,disposition?.updated_at))return true;
        if(returnedForJourney(item,disposition?.updated_at))return true;
        const facts=contacts.facts({journeyId:item.id,ref,refs:(data.refs||[]).filter((row)=>row.journey_id===item.id).map((row)=>row.ref_code)});
        return facts.entered && facts.latestAt>=cutoff;})
      .filter((item) => {const disposition=dispositionByJourney.get(item.id);const ownRefs=[item.reference_code,...(data.refs||[]).filter((row)=>row.journey_id===item.id).map((row)=>row.ref_code)].filter(Boolean);return !disposition||ownRefs.some((ref)=>wantedAfterDisposition(ref,disposition.updated_at))||returnedForJourney(item,disposition.updated_at);})
      .filter((item) => {const ownRefs=[item.reference_code,...(data.refs||[]).filter(r=>r.journey_id===item.id).map(r=>r.ref_code)].filter(Boolean).map(r=>String(r).trim().toUpperCase());return !ownRefs.some(ref=>orderRefs.has(ref));})
      .map((item) => ({
        ...item, disposition:dispositionByJourney.get(item.id)?.status||null, discardReason:dispositionByJourney.get(item.id)?.discard_reason||null, dispositionUpdatedAt:dispositionByJourney.get(item.id)?.updated_at||null,
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
      const ready = score(item, journey, { ...data, promises:data.promises.concat(leadPromises) }, vehicles, now);
      const dispositionAt=item.dispositionUpdatedAt||dispositionByJourney.get(journey?.id)?.updated_at;const returned=returnedForJourney(journey,dispositionAt);
      const journeyId=journey?.id;
      const facts=contacts.facts({journeyId:journey?.id,ref,refs:journey?(data.refs||[]).filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code):[]});
      const ownMessages=journeyId?data.messages.filter((message)=>message.journey_id===journeyId).sort((a,b)=>(time(b.occurred_at_utc||b.created_at)||0)-(time(a.occurred_at_utc||a.created_at)||0)):[];
      const latestMessage=ownMessages.find((message)=>!message.is_automatic)||ownMessages[0]||null,latestMcsMessage=ownMessages.find((message)=>message.direction==='MCS')||null,lastCustomer=ownMessages.find((message)=>message.direction==='CUSTOMER')||null;
      return decorateContact({ ...item, phones:item.phones||journey?.phones||[], ...ready, latestMessage,latestMcsMessage,lastCustomerAt:lastCustomer?.occurred_at_utc||lastCustomer?.created_at||null, returnedToTalk:returned, promiseToday: ready.promiseToday || (journey?.enabled !== false && dueToday(leadPromises, ref, item.zip, now)), wantsCar: wantedAfterDisposition(ref,dispositionAt),
        pendingAiCount:journeyId?aiItems.filter((entry)=>entry.journey_id===journeyId).length:0,aiLinkSuggested:journeyId?aiSuggestions.some((entry)=>entry.source_journey_id===journeyId):false }, facts, insightByJourney.get(journeyId));
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
