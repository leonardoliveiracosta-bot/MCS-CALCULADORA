'use strict';

// Ordenar as opções de um grupo por ano ou por MMR no banco (panel_manheim_offer_page_sorted), página por página:
// a sequência de todas as páginas é a mesma da regra em memória (sortedGroup sobre a ordem por CR), nas 4 ordens,
// com empates mantendo a ordem por CR, e sem limite de tamanho (antes o servidor lia no máximo 2.000 carros).
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const id = (n) => `6cd00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), JOURNEY = id(10), CONTACT = id(11);
const KEY = `journey:${JOURNEY}:CARRO`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Ordem','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,reference_code,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',3000000,'WRDE2',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','ord-1','RESOLVED',false,now(),now(),now(),now());`,
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
// 73 carros em Lane/Run (mais de uma página de 50): anos, MMR e CR variados, com empates de ano e de MMR.
const car = (n) => {
  const vin = 'ORDV' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2019 + (n % 4), make: 'Honda', model: 'CR-V', trim: 'EX', miles: 20000 + n, mmrCents: 1500000 + (n % 7) * 250000, location: 'FL - Orlando', startsAt: '2026-10-01T15:00:00Z', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: (1.5 + (n % 9) * 0.4).toFixed(1), cleanTitle: true, odometerOk: true } };
};
const cars = Array.from({ length: 73 }, (_, n) => car(n));

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['MANHEIM_MATCH_AUDIT_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ name: 'ORD.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: 'f'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin', 'Lane', 'Run']], headerMap: {} });
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  const done = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'finalize', uploadId: started.payload.uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
});
test.after(async () => { if (backend) await backend.db.close(); });

async function allPages(sort, limit) {
  const out = [];
  let cursor = null, calls = 0;
  do {
    const res = await call('manheim-options', `/api/panel/manheim-options?key=${KEY}&group=LANE&limit=${limit}&sort=${sort}${cursor ? '&cursor=' + cursor : ''}`);
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
    out.push(...res.payload.options);
    cursor = res.payload.nextCursor; calls += 1;
  } while (cursor && calls < 50);
  return out;
}

test('ano e MMR, nos dois sentidos: o banco dá a mesma ordem da regra, página por página', async () => {
  const { sortedGroup } = require('../api/panel/manheim-options');
  const byCr = await allPages('cr', 50);
  assert.equal(byCr.length, 73);
  const asRows = byCr.map((option) => ({ id: option.id, vehicle_json: option.vehicle_json, mmr_cents: option.offer.mmrCents }));
  for (const sort of ['year_desc', 'year_asc', 'mmr_desc', 'mmr_asc']) {
    const expected = sortedGroup(asRows, sort).map((row) => row.id);
    for (const limit of [10, 50]) {
      const got = (await allPages(sort, limit)).map((option) => option.id);
      assert.deepEqual(got, expected, `${sort} · páginas de ${limit}`);
    }
  }
  const years = (await allPages('year_desc', 50)).map((option) => option.vehicle_json.parsed.year);
  assert.deepEqual(years, [...years].sort((a, b) => b - a));
});

test('a rota não lê mais o grupo inteiro: uma chamada ao banco por página, sem teto de 2.000', () => {
  const source = require('node:fs').readFileSync(require.resolve('../api/panel/manheim-options'), 'utf8');
  assert.doesNotMatch(source, /wholeGroup|offset < 2000/);
  assert.match(source, /panel_manheim_offer_page_sorted/);
});

test('preço para o cliente digitado em dólar: só dólares inteiros (centavos recusados)', async () => {
  const [option] = await allPages('cr', 10);
  const mmr = option.offer.mmrCents;
  const price = (finalCents) => call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'price', matchId: option.id, finalCents });
  const withCents = await price(mmr + 10050);
  assert.equal(withCents.statusCode, 400);
  assert.equal(withCents.payload.error, 'MANHEIM_SELECTION_FINAL_CENTS');
  const whole = await price(mmr + 10000);
  assert.equal(whole.statusCode, 200, JSON.stringify(whole.payload));
  assert.equal(whole.payload.finalCents, mmr + 10000);
});
