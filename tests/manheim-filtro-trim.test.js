'use strict';

// Filtro por TRIM nos grupos do BUSCAS (panel_manheim_offer_page_trim / panel_manheim_offer_trims): só
// visualização. Com 1 ou 2 trims marcados, o grupo inteiro (mais de 50 carros, várias páginas) traz a contagem e
// a ordem certas, nas ordens por CR, ano e MMR; trims normalizados (maiúsculas, espaços, pontuação) sem juntar
// trims diferentes; seleção, match e conferência intactos.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const id = (n) => `6cf00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), JOURNEY = id(10), CONTACT = id(11);
const KEY = `journey:${JOURNEY}:CARRO`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Trim','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,reference_code,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',null,'TRMQ2',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','trim-1','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'s1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
// 160 carros em Lane/Run: trims variados, com grafias diferentes do mesmo trim e carros sem trim.
const TRIMS = ['Laredo X', 'LAREDO-X', 'laredo  x.', '4xe', 'Summit Reserve', '', 'Summit', 'EX-L'];
const car = (n) => {
  const vin = 'TRMV' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2019 + (n % 4), make: 'Honda', model: 'CR-V', trim: TRIMS[n % TRIMS.length], miles: 20000 + n, mmrCents: 1500000 + (n % 7) * 250000, location: 'FL - Orlando', startsAt: '2026-10-01T15:00:00Z', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: (1.9 + (n % 8) * 0.4).toFixed(1), cleanTitle: true, odometerOk: true } };
};
const cars = Array.from({ length: 160 }, (_, n) => car(n));
const expectedCount = (keys) => cars.filter((item) => keys.includes(require('../api/panel/manheim-options').trimKey(item.vehicle.trim))).length;

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['MANHEIM_MATCH_AUDIT_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ name: 'TRIM.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: 'e'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin', 'Lane', 'Run']], headerMap: {} });
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  const done = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'finalize', uploadId: started.payload.uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
});
test.after(async () => { if (backend) await backend.db.close(); });

async function allPages(sort, limit, trims = null) {
  const out = [];
  let cursor = null, calls = 0, first = null;
  do {
    const res = await call('manheim-options', `/api/panel/manheim-options?key=${KEY}&group=LANE&limit=${limit}&sort=${sort}${trims ? '&trims=' + encodeURIComponent(JSON.stringify(trims)) : ''}${cursor ? '&cursor=' + cursor : ''}`);
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    if (!first) first = res.payload;
    out.push(...res.payload.options);
    cursor = res.payload.nextCursor; calls += 1;
  } while (cursor && calls < 60);
  return { options: out, first };
}

test('trims do grupo com contagem: grafias do mesmo trim juntas, trims diferentes separados, "Sem trim"', async () => {
  const { first } = await allPages('cr', 10);
  const byKey = Object.fromEntries(first.trims.map((item) => [item.key, item]));
  assert.deepEqual(Object.keys(byKey).sort(), ['', '4xe', 'ex l', 'laredo x', 'summit', 'summit reserve']);
  assert.equal(byKey['laredo x'].count, expectedCount(['laredo x']));
  assert.equal(byKey[''].label, 'Sem trim');
  assert.equal(byKey.summit.count, expectedCount(['summit']), '"Summit" e "Summit Reserve" não se juntam');
  assert.equal(first.trims.reduce((sum, item) => sum + item.count, 0), 160, 'cada carro em exatamente um trim');
  assert.equal(first.total, 160, 'sem filtro: o grupo inteiro');
});

// The CR order applied to the filtered cars only: the 5 best at or above the recommended minimum,
// then the 5 best below it, then the rest of each side (the order the panel shows, now within the filter).
function crOrder(list) {
  const above = list.filter((option) => option.offer.cr !== null && !option.offer.belowMinimum), below = list.filter((option) => option.offer.cr !== null && option.offer.belowMinimum);
  return [...above.slice(0, 5), ...below.slice(0, 5), ...above.slice(5), ...below.slice(5), ...list.filter((option) => option.offer.cr === null)];
}

test('filtro por 1 e por 2 trims: contagem e ordem certas no grupo inteiro, em todas as ordens e tamanhos de página', async () => {
  const { trimKey, sortedGroup } = require('../api/panel/manheim-options');
  const byCr = (await allPages('cr', 50)).options;
  const tierOf = new Map(byCr.map((option) => [option.id, option.offer.tier]));
  const crRank = new Map(byCr.map((option, index) => [option.id, index]));
  // Within the whole group the CR order is tier first: relative CR order on each side is the same.
  const sideOrder = [...byCr].sort((a, b) => (a.offer.belowMinimum - b.offer.belowMinimum) || ((tierOf.get(a.id) % 2) - (tierOf.get(b.id) % 2)) || crRank.get(a.id) - crRank.get(b.id));
  for (const keys of [['laredo x'], ['laredo x', '']]) {
    const subset = crOrder(sideOrder.filter((option) => keys.includes(trimKey(option.vehicle_json.parsed.trim))));
    assert.equal(subset.length, expectedCount(keys));
    assert.ok(subset.length > 50, 'mais de uma página de 50');
    const asRows = subset.map((option) => ({ id: option.id, vehicle_json: option.vehicle_json, mmr_cents: option.offer.mmrCents }));
    for (const sort of ['cr', 'year_desc', 'mmr_asc']) {
      const expected = sort === 'cr' ? subset.map((option) => option.id) : sortedGroup(asRows, sort).map((row) => row.id);
      for (const limit of [10, 50]) {
        const { options, first } = await allPages(sort, limit, keys);
        assert.equal(first.total, expectedCount(keys), `total ${keys} ${sort}`);
        assert.deepEqual(first.filter, keys);
        assert.deepEqual(options.map((option) => option.id), expected, `${keys} · ${sort} · páginas de ${limit}`);
        assert.ok(options.every((option) => keys.includes(trimKey(option.vehicle_json.parsed.trim))));
      }
    }
  }
  // The checked trim is sent as the operator sees it: any spelling gives the same filter.
  const typed = await allPages('cr', 50, ['LAREDO-X']);
  assert.equal(typed.first.total, expectedCount(['laredo x']));
});

test('só visualização: seleção continua (e é contada no trim fora do filtro); nada muda no lote', async () => {
  const before = (await backend.db.query('select count(*)::int n, md5(string_agg(id::text || coalesce(match_kind, \'\') || coalesce(demand_key, \'\'), \',\' order by id)) h from public.manheim_matches')).rows[0];
  const summit = (await allPages('cr', 50, ['summit'])).options[0];
  const selected = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'select', matchId: summit.id });
  assert.equal(selected.statusCode, 200, JSON.stringify(selected.payload));
  const filtered = await allPages('cr', 10, ['4xe']);
  assert.ok(filtered.options.every((option) => option.vehicle_json.parsed.trim === '4xe'));
  const counts = Object.fromEntries(filtered.first.trims.map((item) => [item.key, item.selected]));
  assert.equal(counts.summit, 1, 'o selecionado fora do filtro aparece na contagem do trim dele');
  const status = (await backend.db.query('select status from public.manheim_option_selections where match_id=$1', [summit.id])).rows[0];
  assert.equal(status.status, 'SELECTED', 'o filtro não muda a seleção');
  const after = (await backend.db.query('select count(*)::int n, md5(string_agg(id::text || coalesce(match_kind, \'\') || coalesce(demand_key, \'\'), \',\' order by id)) h from public.manheim_matches')).rows[0];
  assert.deepEqual(after, before, 'match e lote intactos');
});

test('filtro inválido é recusado', async () => {
  for (const bad of ['nao-json', JSON.stringify('laredo'), JSON.stringify(Array.from({ length: 41 }, (_, n) => 't' + n)), JSON.stringify([1])]) {
    const res = await call('manheim-options', `/api/panel/manheim-options?key=${KEY}&group=LANE&trims=${encodeURIComponent(bad)}`);
    assert.deepEqual([res.statusCode, res.payload.error], [400, 'MANHEIM_TRIMS_INVALID'], bad);
  }
});
