'use strict';

const crypto = require('node:crypto');
const calc = require('./calc-core');
const vehicleMatch = require('./vehicle-match');
const { calculatorNews, consolidateCalcRuns, effectiveCriteria, groupCalculatorByRef, journeyDemands, normalizeDeadline, normalizePayment, orderDemand, REF_RE } = require('./panel-domain');
const { batchSupported, latestActiveUpload, liveUploadIds } = require('./panel-manheim-state');
const { allRows, insert, isUuid, patchRows, rows, supabase } = require('./panel-server');
const { loadSearchStageIndex } = require('./panel-search-stage');

function timezoneForZip(zip) {
  const location = calc.zipEstado(zip);
  const state = location && location.uf;
  const code=String(zip||'').replace(/\D/g,'').slice(0,5);
  const prefix = Number(code.slice(0, 3));
  if (prefix >= 798 && prefix <= 799) return 'America/Denver';
  if (state==='TN' && (prefix===374 || prefix>=376&&prefix<=379)) return 'America/New_York';
  if (state==='KY' && prefix>=420&&prefix<=424) return 'America/Chicago';
  const laPorteZips=new Set(['46340','46345','46346','46348','46350','46352','46360','46361','46365','46371','46382','46390','46391','46532','46552','46574']);
  if (state==='IN' && laPorteZips.has(code)) return 'America/Chicago';
  const michiganCentral=new Set(['49801','49802','49812','49815','49821','49831','49834','49845','49847','49848','49852','49858','49863','49870','49873','49874','49876','49877','49881','49886','49887','49892','49893','49896','49902','49903','49911','49915','49920','49927','49935','49938','49947','49959','49964','49968','49969']);
  if (michiganCentral.has(code)) return 'America/Chicago';
  if (prefix===464 || (prefix===463 && !['46340','46341','46345','46346','46348','46350','46352','46360','46365','46371','46382','46390','46391'].includes(code))) return 'America/Chicago';
  if ([835,838].includes(prefix)) return 'America/Los_Angeles';
  if (prefix === 979) return 'America/Denver';
  if (state==='KS' && prefix===677 || state==='NE' && prefix===693 || state==='SD' && prefix===577 ||
      state==='ND' && ['58601','58602','58620','58621','58622','58623','58625','58626','58627','58630','58631','58632','58634','58636','58638','58639','58640','58641','58642','58643','58644','58645','58646','58647','58649','58650','58651','58652','58653','58654','58655','58656'].includes(code)) return 'America/Denver';
  if (state === 'FL' && prefix >= 324 && prefix <= 325) return 'America/Chicago';
  if (['CA','WA','OR','NV'].includes(state)) return 'America/Los_Angeles';
  if (['AZ','CO','NM','MT','UT','WY','ID'].includes(state)) return state === 'AZ' ? 'America/Phoenix' : 'America/Denver';
  if (['AK'].includes(state)) return 'America/Anchorage';
  if (state === 'HI') return 'Pacific/Honolulu';
  if (['AL','AR','IA','IL','KS','LA','MN','MO','MS','ND','NE','OK','SD','TN','TX','WI'].includes(state)) return 'America/Chicago';
  return 'America/New_York';
}

function localToUtc(local, zone) {
  const match = String(local || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const target = Date.UTC(+match[1], +match[2]-1, +match[3], +match[4], +match[5]);
  let stamp = target;
  for (let tries=0; tries<3; tries++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(stamp).map((part)=>[part.type,part.value]));
    const observed=Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute);
    stamp+=target-observed;
  }
  return new Date(stamp).toISOString();
}

function addClientDays(now, zone, days) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map((part)=>[part.type,part.value]));
  const shifted = new Date(Date.UTC(+parts.year,+parts.month-1,+parts.day+days,+parts.hour,+parts.minute));
  return localToUtc(shifted.toISOString().slice(0,16),zone);
}

async function orders(ctx, ref) {
  const [runs, links, dispositions] = await Promise.all([
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', ...(ref ? { 'dados->>ref': 'ilike.' + ref } : {}), order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' })
  ]);
  return groupCalculatorByRef(consolidateCalcRuns(runs, links), dispositions);
}

async function journeyFor(ctx, ref, id) {
  let found = [];
  if (id && isUuid(id)) found = await rows(ctx, 'journeys', { select: 'id,reference_code,contact_id', environment: 'eq.' + ctx.environment, id: 'eq.' + id, limit: '1' });
  if (!found.length && ref) found = await rows(ctx, 'journeys', { select: 'id,reference_code,contact_id', environment: 'eq.' + ctx.environment, reference_code: 'eq.' + ref, limit: '1' });
  if (!found.length && ref) {
    const link = await rows(ctx, 'journey_refs', { select: 'journey_id', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref, limit: '1' });
    if (link[0]) found = await rows(ctx, 'journeys', { select: 'id,reference_code,contact_id', environment: 'eq.' + ctx.environment, id: 'eq.' + link[0].journey_id, limit: '1' });
  }
  return found[0] || null;
}

async function trackFor(ctx, ref, journeyId) {
  let found = await rows(ctx, 'lead_tracking', { select: '*', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref, limit: '1' });
  if (!found[0]) {
    try {
      found = await insert(ctx, 'lead_tracking', { environment: ctx.environment, ref_code: ref, journey_id: journeyId || null, public_code: crypto.randomBytes(24).toString('base64url') });
    } catch (_) {
      found = await rows(ctx, 'lead_tracking', { select: '*', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref, limit: '1' });
    }
  } else if (journeyId && !found[0].journey_id) {
    found = await patchRows(ctx, 'lead_tracking', { environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref }, { journey_id: journeyId }, true);
  }
  return found[0] || null;
}

function capture(handler, req, query) {
  const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.data = value; return value; } };
  // IncomingMessage properties such as headers live on its prototype and are
  // not preserved by object spread. Keep the authenticated request context
  // when a panel handler delegates to another panel handler.
  return Promise.resolve(handler({ ...req, headers: req?.headers || {}, method: 'GET', query }, response)).then(() => response.code === 200 ? response.data : null);
}


const offerRank = (offer) => offer.kind === 'BATE' ? 0 : offer.kind === 'POR_VALOR' ? 1 : offer.dataGap ? 3 : 2;

// Same rule as the CSV match (vehicle-match.js): kind of one car for one wish in one mode.
function offerKind(vehicle, wish, bidCents, mode = 'CARRO') {
  const result = vehicleMatch.matchDemand(vehicle, { mode, wishes: [wish || {}], bidCents });
  return result ? result.kind : null;
}

function realisticBid(ceilingCents, options) {
  const ceiling = Math.floor(Number(ceilingCents) / 100);
  if (!(ceiling > 0)) return null;
  const estimate = (lance) => calc.calcular({ lance, inspecao: false, florida: options.florida, placa: options.plate, pgto: options.payment, estado: options.stateIndex || '', zip: options.zip || '' }).totalProjetado;
  if (estimate(calc.CONFIG.lanceMinimo) > ceiling) return null;
  let low = calc.CONFIG.lanceMinimo, high = Math.min(calc.CONFIG.lanceMaximo, ceiling);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const total = estimate(mid);
    if (total <= ceiling) low = mid; else high = mid - 1;
  }
  return low;
}

function median(values) {
  const sorted = values.filter((value) => Number(value) > 0).sort((a, b) => a - b);
  return sorted.length ? Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2) : null;
}

async function leadData(ctx, req, refInput, idInput) {
  let ref = String(refInput || '').trim().toUpperCase();
  const journey = await journeyFor(ctx, REF_RE.test(ref) ? ref : null, idInput);
  if (idInput && (!isUuid(idInput) || !journey || journey.id !== idInput || (REF_RE.test(ref) && !(await belongsToJourney(ctx, ref, journey))))) return null;
  if (!REF_RE.test(ref)) {
    ref = journey && String(journey.reference_code || '').trim().toUpperCase();
    if (!REF_RE.test(ref) && journey) {
      const linked=await rows(ctx,'journey_refs',{select:'ref_code',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,order:'created_at.asc',limit:'1'});
      ref=String(linked[0]?.ref_code||'').trim().toUpperCase();
    }
  }
  if (!REF_RE.test(ref) && !journey) return null;
  let hasRef = REF_RE.test(ref);
  let allOrders = hasRef ? await orders(ctx, ref) : [];
  let order = allOrders.find((item) => item.ref === ref) || null;
  if(!order&&journey){
    const linked=await allRows(ctx,'journey_refs',{select:'ref_code',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,order:'created_at.asc'});
    for(const candidate of linked.map((item)=>String(item.ref_code||'').trim().toUpperCase()).filter((value)=>REF_RE.test(value))){
      const candidateOrders=await orders(ctx,candidate),candidateOrder=candidateOrders.find((item)=>item.ref===candidate);
      if(candidateOrder){ref=candidate;allOrders=candidateOrders;order=candidateOrder;break;}
    }
  }
  hasRef=Boolean(order);
  if (!journey && !order) return null;
  const record = journey ? (await capture(require('./api/panel/records'), req, { id: journey.id }))?.item || null : null;
  // Tracking is useful for the customer link, but it must never make the lead
  // detail unavailable when its optional row cannot be refreshed.
  let track = null;
  if (hasRef) {
    try { track = await trackFor(ctx, ref, journey && journey.id); }
    catch (error) {
      console.error('[panel-lead-tracking]',{ref,journeyId:journey?.id||null,message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});
    }
  }
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  const scope = hasRef ? { ref_code: 'eq.' + ref } : { journey_id: 'eq.' + journey.id };
  // Notes, events and optional enrichment must not prevent the lead itself
  // from opening. In particular, an empty confirmed note is valid data.
  const optionalRead=async(label,read)=>{
    try{return await read();}
    catch(error){console.error('[panel-lead-read]',{label,ref,journeyId:journey?.id||null,message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});return [];}
  };
  // A note confirmed while the ficha had no calculator Ref is kept by the journey (ref_code null);
  // once the ficha gets a Ref those rows are still its own, so they are read together.
  const scoped=(table,extra,sortKey,descending)=>optionalRead(table,async()=>{
    const own=await allRows(ctx, table, { select: '*', environment: 'eq.' + ctx.environment, ...scope, ...extra, order: sortKey + (descending ? '.desc' : '.asc') });
    if (!hasRef || !journey) return own;
    const seen=new Set(own.map((row)=>row.id));
    const unref=(await allRows(ctx, table, { select: '*', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, ref_code: 'is.null', ...extra, order: sortKey + (descending ? '.desc' : '.asc') })).filter((row)=>!seen.has(row.id));
    if (!unref.length) return own;
    return own.concat(unref).sort((a,b)=>((Date.parse(a[sortKey])||0)-(Date.parse(b[sortKey])||0))*(descending?-1:1));
  });
  const [notes, events, promises, aiReadings, aiSuggestions, aiHelp, stageIndex] = await Promise.all([
    scoped('lead_notes',{},'created_at',true),
    scoped('lead_events',{undone_at:'is.null'},'occurred_at',true),
    scoped('lead_promises',{},'due_at',false),
    journey ? optionalRead('conversation_ai_readings',()=>rows(ctx,'conversation_ai_readings',{select:'id,summary_json,message_count,last_customer_at,created_at,chat_id',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,status:'eq.ACTIVE',order:'created_at.desc',limit:'1'})) : Promise.resolve([]),
    journey ? optionalRead('whatsapp_link_suggestions',()=>rows(ctx,'whatsapp_link_suggestions',{select:'id,target_ref,motives,status,created_at',environment:'eq.'+ctx.environment,source_journey_id:'eq.'+journey.id,status:'eq.PENDING',suggestion_kind:'eq.AI',order:'created_at.desc',limit:'1'})) : Promise.resolve([]),
    journey ? optionalRead('lead_ai_help',()=>allRows(ctx,'lead_ai_help',{select:'id,question,answer_json,created_at',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,order:'created_at.desc'})) : Promise.resolve([]),
    loadSearchStageIndex(ctx).catch(()=>new Map())
  ]);
  const aiReading=aiReadings[0]||null;
  const aiItems=aiReading?await allRows(ctx,'conversation_ai_items',{select:'id,item_json,evidence_text,manual_review,status,created_at',environment:'eq.'+ctx.environment,reading_id:'eq.'+aiReading.id,status:'eq.PENDING',order:'created_at.asc'}):[];
  const ai={reading:aiReading?{...aiReading,items:aiItems.map((item)=>({...item,...item.item_json,evidence:item.evidence_text}))}:null,suggestion:aiSuggestions[0]||null};
  // R1: the ficha's confirmed wishes and bid win; the calculator only fills what is missing.
  const criteria = effectiveCriteria(record, order);
  const wishes = criteria.wishes;
  const news = calculatorNews(record, record?.contact?.display_name, order);
  const rawZip = order && order.zip || (record?.contact?.location_text || '').match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '';
  const zip = String(rawZip).replace(/\D/g, '').slice(0, 5);
  const state = calc.zipEstado(zip);
  const timezone = timezoneForZip(zip);
  // M11 / E:M4: unknown payment is shown as unknown; estimates assume cash (the calculator default).
  const paymentKnown = normalizePayment(record && record.payment_text) || normalizePayment(order && order.paymentText);
  const payment = paymentKnown || 'cash';
  const plate = order && order.plate === 'nova' ? 'nova' : 'transf';
  const florida = state ? state.uf === 'FL' : true;
  const stateIndex = state ? String(calc.CONFIG.estados.findIndex((item) => item.nome === state.nome)) : '';
  const maxBidCents = criteria.bidCents;
  const totalCeilingCents = Number(record && record.confirmed_total_ceiling_cents) || null;
  const bid = totalCeilingCents ? realisticBid(totalCeilingCents, { florida, payment, plate, stateIndex, zip }) : maxBidCents ? Math.floor(maxBidCents / 100) : null;
  const costs = bid === null ? null : calc.calcular({ lance: bid, inspecao: false, florida, placa: plate, pgto: payment, estado: stateIndex, zip });
  // The person's demands, one per mode: VALOR (make, model, bid) and CARRO (make, model, year
  // and mileage ranges). The same car can be an offer in both modes; each mode uses its own rule.
  const modeEntries = order && Array.isArray(order.simulations) ? order.simulations : [];
  const demands = (record ? journeyDemands(record, modeEntries) : modeEntries.map(orderDemand).filter(Boolean)).filter((demand) => demand.active);
  // Cold inventory, read only for the makes this person asked for, in the live batches of the last
  // 60 days (never the whole inventory; a car without make is kept, the matcher decides).
  const makes = [...new Set(wishes.concat(demands.flatMap((demand) => demand.activeWishes || [])).map((wish) => vehicleMatch.fold(wish && wish.make)).filter(Boolean))];
  const archive = await optionalRead('manheim_vehicles', async () => {
    if (!makes.length || !(await batchSupported(ctx, { rows }))) return [];
    const uploadIds = await liveUploadIds(ctx, { since: cutoff }, { rows });
    if (!uploadIds.length) return [];
    return allRows(ctx, 'manheim_vehicles', { select: 'row_fingerprint,vehicle_json,uploaded_at,upload_id', environment: 'eq.' + ctx.environment, upload_id: 'in.(' + uploadIds.join(',') + ')', undone_at: 'is.null', make_key: 'in.(' + makes.concat(['']).map((make) => '"' + make.replace(/"/g, '') + '"').join(',') + ')', order: 'uploaded_at.desc' });
  });
  const unique = new Map();
  for (const entry of archive) if (!unique.has(entry.row_fingerprint)) unique.set(entry.row_fingerprint, { ...entry.vehicle_json, rowFingerprint: entry.row_fingerprint, uploadedAt: entry.uploaded_at });
  // A10: the cars offered come only from the active batch, the same cars OPÇÕES shows (an older
  // batch may list cars already sold). The 60 days of batches still feed the "MMR típico".
  const activeUpload = archive.length ? await latestActiveUpload(ctx, 'id').catch(() => null) : null;
  const current = new Map();
  for (const entry of archive) if (activeUpload && entry.upload_id === activeUpload.id && !current.has(entry.row_fingerprint)) current.set(entry.row_fingerprint, { ...entry.vehicle_json, rowFingerprint: entry.row_fingerprint, uploadedAt: entry.uploaded_at });
  const matchesFor = (car) => demands.map((demand) => ({ demand, result: vehicleMatch.matchDemand(car, { ...demand, wishes: demand.activeWishes }) })).filter((entry) => entry.result);
  const typical = wishes.map((wish) => {
    // A:P16: "MMR típico" uses the same rule as the offers and the CSV, never a car whose fit
    // depends on missing data. The MMR is information only; in CARRO it never selects a car.
    const label = [wish.make, wish.model].filter(Boolean).join(' ').trim();
    const compared = [...unique.values()].filter((car) => matchesFor(car).some(({ result }) => !result.dataGap && result.matchedWishlistLabel === label));
    return { ...wish, mmrCents: median(compared.map((car) => car.mmrCents)) };
  });
  // Offers use each demand's own rule (VALOR: the maximum bid, never the total ceiling, R2).
  // A QUASE caused by missing data keeps its notice so it is not read as a fit.
  const allOffers = [...(activeUpload ? current : unique).values()].flatMap((vehicle) => matchesFor(vehicle).map(({ demand, result }) => ({ ...vehicle, mode: demand.mode, kind: result.kind, matchReason: result.reason, matchNotice: result.notice, dataGap: result.dataGap })))
    .sort((a, b) => offerRank(a) - offerRank(b));
  // One car per VIN (v3.4): the same VIN in Lane/Run and in Buy Now (or in two CSV rows) is one car
  // (in each search mode: a car that fits VALOR and CARRO is an offer in both).
  const { carKey } = require('./panel-reality');
  const offerSeen = new Set();
  const offers = allOffers.filter((vehicle) => { const key = vehicle.mode + '|' + carKey(vehicle); if (offerSeen.has(key)) return false; offerSeen.add(key); return true; }).slice(0, 80);
  // "Cabe" = BATE or POR_VALOR (real opportunities); QUASE never counts as a fit.
  const fitSeen = new Set();
  const fits = offers.filter((vehicle) => vehicleMatch.countsAsServed(vehicle.kind) && !fitSeen.has(carKey(vehicle)) && fitSeen.add(carKey(vehicle)))
    .map((vehicle) => ({ year: vehicle.year, miles: vehicle.miles, make: vehicle.make, model: vehicle.model })).slice(0, 8);
  // Cartão 5: every option of the batch inside the filters (all of them counted, one per VIN), with the column chosen by the deterministic rule.
  const servedSeen = new Set();
  const servedOptions = allOffers.filter((vehicle) => vehicleMatch.countsAsServed(vehicle.kind) && !servedSeen.has(carKey(vehicle)) && servedSeen.add(carKey(vehicle)));
  const reference = [...unique.values()].filter((car) => matchesFor(car).some(({ result }) => !result.dataGap));
  const milesCap = wishes.some((wish) => Number(wish.maxMiles) > 0) || demands.some((demand) => (demand.activeWishes || []).some((wish) => Number(wish.maxMiles) > 0));
  const reality = require('./panel-reality').realityList({ options: servedOptions, reference, maxBidCents, milesCap, typicalCents: typical.map((wish) => wish.mmrCents) });
  const lastCustomer = record && [...(record.conversation || [])].reverse().find((message) => message.direction === 'CUSTOMER');
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const goodHour = hour >= 9 && hour < 20;
  const mmr = typical[0] && typical[0].mmrCents;
  const phone = record && record.phones && record.phones.find((item) => item.is_current !== false);
  const checklist = record && record.checklist || [
    'Carro e critérios confirmados', 'Teto confirmado', 'Pagamento confirmado',
    'Prazo confirmado', 'Aceita busca fora da Flórida', 'Entende inspeção limitada e sem devolução'
  ].map((point_label, index) => ({ point_number: index + 1, point_label, status: 'OPEN' }));
  const deadline = record && record.customer_deadline_text || order && order.deadlineText || '';
  const { score } = require('./panel-ready');
  const ready = score({ ...(order||{}), zip, occurredAt: order?.occurredAt, budgetCents: maxBidCents, paymentText: payment, plate, wishlists: wishes }, record, {
    checklist: checklist.map((point) => ({ ...point, journey_id: record?.id })),
    messages: (record?.conversation || []).map((message) => ({ ...message, journey_id: record?.id })),
    promises: [...(record?.promises || []), ...promises].map((promise) => ({ ...promise, journey_id: record?.id }))
  }, [...unique.values()]);
  const city = cityCache.get(zip) || null;
  const searchStage=journey?stageIndex.get(journey.id)||null:null;
  // A8: a ficha and its Refs are one person; the most recent disposition of either wins, and the
  // "Tratado/Descartado" buttons act on that same row.
  const personRefs=[...new Set([order?ref:null,record?.reference_code,...(record?.refs||[]).map((row)=>row.ref_code)].filter(Boolean).map((value)=>String(value).trim().toUpperCase()))];
  const personKeys=[...personRefs.map((key)=>({kind:'REF',key})),journey?{kind:'JOURNEY',key:journey.id}:null].filter(Boolean);
  const found=(await Promise.all(personKeys.map((entry)=>optionalRead('panel_item_dispositions',()=>rows(ctx,'panel_item_dispositions',{select:'item_kind,item_key,status,discard_reason,updated_at',environment:'eq.'+ctx.environment,item_kind:'eq.'+entry.kind,item_key:'eq.'+entry.key,cleared_at:'is.null',limit:'1'}))))).flat();
  const disposition=found.sort((left,right)=>(Date.parse(right.updated_at)||0)-(Date.parse(left.updated_at)||0))[0]||null;
  const dispositionKind=disposition?disposition.item_kind:order?'REF':'JOURNEY',dispositionKey=disposition?disposition.item_key:order?ref:journey?.id;
  // Adendo, item 2: which search types the person has and whether a batch is active (the ficha
  // splits "O QUE OFERECER" into com carros, sem carros and busca ainda não rodada).
  const batchActive = Boolean(activeUpload || (demands.length ? await latestActiveUpload(ctx, 'id').catch(() => null) : null));
  return { reality, searchModes: [...new Set(demands.map((demand) => demand.mode))], batchActive, plateInformed: Boolean(order && order.plate), paymentKnown: paymentKnown || null, zipKnown: Boolean(state), deadlineKnown: normalizeDeadline(record?.customer_deadline_text) || normalizeDeadline(order?.deadlineText) || null, ref, hasCalculatorRef:hasRef||record?.hasCalcRef===true, hasCalculatorOrder:searchStage?.hasCalculatorOrder??hasRef, directLeadSource:searchStage?.directLeadSource||null, disposition:disposition?.status||null, discardReason:disposition?.discard_reason||null, dispositionUpdatedAt:disposition?.updated_at||null, dispositionKind, dispositionKey, calculatorNews: news, bidSource: criteria.bidSource, wishesSource: criteria.wishesSource, order, record, track, notes, events, promises, checklist, wishes, zip, state, city, timezone, goodHour, payment, plate, florida, maxBidCents, totalCeilingCents, ceilingCents: totalCeilingCents, bid, costs, typical, offers, fits, score: ready.score, lastCustomerAt: lastCustomer && (lastCustomer.occurred_at_utc || lastCustomer.created_at) || null, ai, aiHelp, searchStage };
}

async function belongsToJourney(ctx, ref, journey) {
  if (String(journey.reference_code || '').trim().toUpperCase() === ref) return true;
  return Boolean((await rows(ctx, 'journey_refs', { select: 'journey_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, ref_code: 'eq.' + ref, limit: '1' }))[0]);
}
const cityCache = new Map();
async function cityForZip(zip) {
  if (!zip) return null;
  if (cityCache.has(zip)) return cityCache.get(zip);
  try {
    const response = await fetch('https://api.zippopotam.us/us/' + encodeURIComponent(zip), { signal: AbortSignal.timeout(2500) });
    const city = response.ok ? (await response.json()).places?.[0]?.['place name'] || null : null;
    cityCache.set(zip, city);
    return city;
  } catch (_) { return null; }
}

async function ensureJourney(ctx, lead) {
  if (lead.record) return lead.record;
  const existing = await journeyFor(ctx, lead.ref);
  if (existing) return { id: existing.id, contact_id: existing.contact_id, reference_code: lead.ref };
  const at = new Date().toISOString();
  const contact = (await insert(ctx, 'contacts', { environment: ctx.environment, display_name: lead.order && lead.order.contactName || 'Contato da Ref ' + lead.ref, source: 'CALCULATOR', created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id }))[0];
  const journey = (await insert(ctx, 'journeys', { environment: ctx.environment, contact_id: contact.id, reference_code: lead.ref, source: 'CALCULATOR', stage: 'NOVO', status: 'ATIVO', vehicle_text: lead.order && lead.order.vehicleText || null, criteria_json: { wishlists: lead.wishes }, budget_cents: lead.maxBidCents, payment_text: lead.paymentKnown || null, customer_deadline_text: normalizeDeadline(lead.order && lead.order.deadlineText) || lead.order && lead.order.deadlineText || null, created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id }))[0];
  for (let number = 1; number <= 6; number++) {
    const labels = ['Carro e critérios confirmados', 'Teto confirmado', 'Pagamento confirmado', 'Prazo confirmado', 'Aceita busca fora da Flórida', 'Entende inspeção limitada e sem devolução'];
    await insert(ctx, 'journey_checklist', { environment: ctx.environment, journey_id: journey.id, point_number: number, point_label: labels[number - 1], status: 'OPEN', created_at: at, updated_at: at }, false);
  }
  await insert(ctx, 'journey_refs', { environment: ctx.environment, journey_id: journey.id, ref_code: lead.ref, created_at: at, created_by: ctx.panel.id }, false);
  await patchRows(ctx, 'lead_tracking', { environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref }, { journey_id: journey.id });
  return journey;
}

module.exports = { leadData, ensureJourney, orders, timezoneForZip, localToUtc, addClientDays, journeyFor, trackFor, realisticBid, median, offerKind, cityForZip };
