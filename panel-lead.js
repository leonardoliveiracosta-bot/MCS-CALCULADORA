'use strict';

const crypto = require('node:crypto');
const calc = require('./calc-core');
const catalog = require('./vehicle-catalog');
const { consolidateCalcRuns, groupCalculatorByRef, mergeWishlists, REF_RE } = require('./panel-domain');
const { allRows, insert, isUuid, patchRows, rows, supabase } = require('./panel-server');

function timezoneForZip(zip) {
  const location = calc.zipEstado(zip);
  const state = location && location.uf;
  const prefix = Number(String(zip || '').slice(0, 3));
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

async function orders(ctx) {
  const [runs, links, dispositions] = await Promise.all([
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment })
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
  return Promise.resolve(handler({ ...req, method: 'GET', query }, response)).then(() => response.code === 200 ? response.data : null);
}

function relevant(vehicle, wish) {
  return (!wish.make || !vehicle.make || String(vehicle.make).toLowerCase() === String(wish.make).toLowerCase())
    && catalog.modelsMatch(vehicle.model, wish.model, vehicle.make, wish.make);
}

function offerKind(vehicle, wish) {
  if (!relevant(vehicle, wish)) return null;
  const yearDelta = vehicle.year < wish.yearMin ? wish.yearMin - vehicle.year : vehicle.year > wish.yearMax ? vehicle.year - wish.yearMax : 0;
  const milesDelta = wish.maxMiles && vehicle.miles > wish.maxMiles ? vehicle.miles - wish.maxMiles : 0;
  if (yearDelta === 0 && milesDelta === 0) return 'BATE';
  if (yearDelta <= 1 && milesDelta <= 15000) return 'QUASE';
  return null;
}

function realisticBid(ceilingCents, options) {
  const ceiling = Math.floor(Number(ceilingCents) / 100);
  if (!(ceiling > 0)) return null;
  let low = 0, high = Math.min(300000, ceiling);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const total = calc.calcular({ lance: mid, inspecao: false, florida: options.florida, placa: options.plate, pgto: options.payment, estado: options.stateIndex || '', zip: options.zip || '' }).totalProjetado;
    if (total <= ceiling) low = mid; else high = mid - 1;
  }
  return low;
}

function median(values) {
  const sorted = values.filter((value) => Number(value) > 0).sort((a, b) => a - b);
  return sorted.length ? Math.round((sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2) : null;
}

async function leadData(ctx, req, refInput, idInput) {
  const allOrders = await orders(ctx);
  let ref = String(refInput || '').trim().toUpperCase();
  const journey = await journeyFor(ctx, REF_RE.test(ref) ? ref : null, idInput);
  if (!REF_RE.test(ref)) ref = journey && String(journey.reference_code || '').trim().toUpperCase();
  if (!REF_RE.test(ref)) return null;
  const order = allOrders.find((item) => item.ref === ref) || null;
  if (!journey && !order) return null;
  const record = journey ? (await capture(require('./api/panel/records'), req, { id: journey.id }))?.item || null : null;
  const track = await trackFor(ctx, ref, journey && journey.id);
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  const [notes, events, promises, archive, recentMatches] = await Promise.all([
    allRows(ctx, 'lead_notes', { select: '*', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref, order: 'created_at.desc' }),
    allRows(ctx, 'lead_events', { select: '*', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref, undone_at: 'is.null', order: 'occurred_at.desc' }),
    allRows(ctx, 'lead_promises', { select: '*', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref, order: 'due_at.asc' }),
    allRows(ctx, 'manheim_vehicles', { select: 'row_fingerprint,vehicle_json,uploaded_at', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + cutoff, order: 'uploaded_at.desc' }),
    allRows(ctx, 'manheim_matches', { select: 'id,vehicle_json,row_fingerprint,created_at', environment: 'eq.' + ctx.environment, calc_ref: 'eq.' + ref, created_at: 'gte.' + cutoff })
  ]);
  const wishes = mergeWishlists(record && record.wishlists || [], order && order.wishlists || []);
  const rawZip = order && order.zip || (record?.contact?.location_text || '').match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '';
  const zip = String(rawZip).replace(/\D/g, '').slice(0, 5);
  const state = calc.zipEstado(zip);
  const timezone = timezoneForZip(zip);
  const payment = String(record && record.payment_text || order && order.paymentText || 'cash').toLowerCase() === 'fin' ? 'fin' : 'cash';
  const plate = order && order.plate === 'nova' ? 'nova' : 'transf';
  const florida = state ? state.uf === 'FL' : true;
  const stateIndex = state ? String(calc.CONFIG.estados.findIndex((item) => item.nome === state.nome)) : '';
  const ceilingCents = Number(record && record.budget_cents || order && order.budgetCents) || null;
  const bid = realisticBid(ceilingCents, { florida, payment, plate, stateIndex, zip });
  const costs = bid === null ? null : calc.calcular({ lance: bid, inspecao: false, florida, placa: plate, pgto: payment, estado: stateIndex, zip });
  const vehicles = archive.map((entry) => ({ ...entry.vehicle_json, rowFingerprint: entry.row_fingerprint, uploadedAt: entry.uploaded_at }));
  const unique = new Map();
  for (const vehicle of vehicles) if (!unique.has(vehicle.rowFingerprint)) unique.set(vehicle.rowFingerprint, vehicle);
  for (const match of recentMatches) {
    const parsed = match.vehicle_json && match.vehicle_json.parsed;
    if (parsed && !unique.has(match.row_fingerprint)) unique.set(match.row_fingerprint, { ...parsed, rowFingerprint: match.row_fingerprint, matchId: match.id, uploadedAt: match.created_at });
  }
  const typical = wishes.map((wish) => {
    const compared = [...unique.values()].filter((car) => relevant(car, wish) && (!wish.yearMin || (car.year >= wish.yearMin - 1 && car.year <= (wish.yearMax || wish.yearMin) + 1)) && (!wish.maxMiles || Math.abs(car.miles - wish.maxMiles) <= 20000));
    return { ...wish, mmrCents: median(compared.map((car) => car.mmrCents)) };
  });
  const offers = [...unique.values()].flatMap((vehicle) => {
    const kind = wishes.map((wish) => offerKind(vehicle, wish)).find((value) => value === 'BATE') || wishes.map((wish) => offerKind(vehicle, wish)).find(Boolean);
    return kind && bid !== null && Number(vehicle.mmrCents) > 0 && vehicle.mmrCents <= bid * 100 ? [{ ...vehicle, kind }] : [];
  }).slice(0, 80);
  const fits = [...unique.values()].filter((vehicle) => bid !== null && vehicle.mmrCents > 0 && vehicle.mmrCents <= bid * 100 && wishes.some((wish) => relevant(vehicle, wish)))
    .map((vehicle) => ({ year: vehicle.year, miles: vehicle.miles, make: vehicle.make, model: vehicle.model })).slice(0, 8);
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
  const activeMs = lastCustomer ? Date.now() - Date.parse(lastCustomer.occurred_at_utc || lastCustomer.created_at) : Infinity;
  const score = record && !record.enabled ? null : Math.min(100, (phone ? 15 : 0) + Math.min(30, checklist.filter((item) => item.status === 'COMPLETE').length * 5)
    + (['now','30d'].includes(deadline) ? 20 : ['3m','30–90 dias'].includes(deadline) ? 10 : 0)
    + (mmr && bid ? mmr <= bid * 100 ? 15 : mmr <= bid * 120 ? 5 : 0 : 0)
    + (activeMs < 86400000 ? 10 : activeMs < 72 * 3600000 ? 5 : 0) + (goodHour ? 10 : 0));
  return { ref, order, record, track, notes, events, promises, checklist, wishes, zip, state, timezone, goodHour, payment, plate, florida, ceilingCents, bid, costs, typical, offers, fits, score, lastCustomerAt: lastCustomer && (lastCustomer.occurred_at_utc || lastCustomer.created_at) || null };
}

async function ensureJourney(ctx, lead) {
  if (lead.record) return lead.record;
  const existing = await journeyFor(ctx, lead.ref);
  if (existing) return { id: existing.id, contact_id: existing.contact_id, reference_code: lead.ref };
  const at = new Date().toISOString();
  const contact = (await insert(ctx, 'contacts', { environment: ctx.environment, display_name: lead.order && lead.order.contactName || 'Contato da Ref ' + lead.ref, source: 'CALCULATOR', created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id }))[0];
  const journey = (await insert(ctx, 'journeys', { environment: ctx.environment, contact_id: contact.id, reference_code: lead.ref, source: 'CALCULATOR', stage: 'NOVO', status: 'ATIVO', vehicle_text: lead.order && lead.order.vehicleText || null, criteria_json: { wishlists: lead.wishes }, budget_cents: lead.ceilingCents, payment_text: lead.payment, customer_deadline_text: lead.order && lead.order.deadlineText || null, created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id }))[0];
  for (let number = 1; number <= 6; number++) {
    const labels = ['Carro e critérios confirmados', 'Teto confirmado', 'Pagamento confirmado', 'Prazo confirmado', 'Aceita busca fora da Flórida', 'Entende inspeção limitada e sem devolução'];
    await insert(ctx, 'journey_checklist', { environment: ctx.environment, journey_id: journey.id, point_number: number, point_label: labels[number - 1], status: 'OPEN', created_at: at, updated_at: at }, false);
  }
  await insert(ctx, 'journey_refs', { environment: ctx.environment, journey_id: journey.id, ref_code: lead.ref, created_at: at, created_by: ctx.panel.id }, false);
  await patchRows(ctx, 'lead_tracking', { environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref }, { journey_id: journey.id });
  return journey;
}

module.exports = { leadData, ensureJourney, orders, timezoneForZip, localToUtc, addClientDays, journeyFor, trackFor, realisticBid, median, offerKind };
