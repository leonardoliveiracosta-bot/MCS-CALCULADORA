'use strict';

// Lote 3 da auditoria (AUDITORIA-PAINEL-MCS.md): importações, arquivos, Manheim/BUSCAS e UX.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../vehicle-catalog');
const domain = require('../panel-domain');
const vehicleMatch = require('../vehicle-match');
const upload = require('../painel/manheim-upload');
const stage = require('../panel-search-stage');

const root = path.join(__dirname, '..');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function loadWith(relative, mocks) {
  const file = path.join(root, relative); const mod = { exports: {} };
  const localRequire = (name) => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(localRequire, mod, mod.exports);
  return mod.exports;
}
const output = () => ({ code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return payload; } });

test('Lote 3 · modelo: o nome mais longo do catálogo vence; versões numéricas viram o modelo; sem marca, só sem ambiguidade', () => {
  const same = (a, am, b, bm) => catalog.modelsMatch(a, b, am, bm);
  assert.equal(same('Grand Cherokee', 'Jeep', 'Cherokee', 'Jeep'), false);
  assert.equal(same('Range Rover Sport', 'Land Rover', 'Range Rover', 'Land Rover'), false);
  assert.equal(same('Transit Connect', 'Ford', 'Transit', 'Ford'), false);
  assert.equal(same('Cherokee Latitude', 'Jeep', 'Cherokee', 'Jeep'), true);
  assert.equal(same('330i', 'BMW', '3 Series', 'BMW'), true);
  assert.equal(same('RX350', 'Lexus', 'RX', 'Lexus'), true);
  assert.equal(same('C300', 'Mercedes-Benz', 'C-Class', 'Mercedes-Benz'), true);
  assert.equal(same('Mach-E', '', 'E-Class', 'Mercedes-Benz'), false);
  assert.equal(same('Model S', '', 'S-Class', 'Mercedes-Benz'), false);
  assert.equal(same('3', '', 'Model 3', 'Tesla'), false);
  assert.equal(same('Ram 1500', '', '1500', 'Ram'), true);
});

test('Lote 3 · critérios: override sem carro não volta à Ref; milhas_de não vira limite; "não sei" não vira versão; ficha encerrada nunca reativa', () => {
  const ref = { wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2020, yearMax: 2022, maxMiles: 40000 }], budgetCents: 3000000 };
  assert.deepEqual(domain.effectiveCriteria({ criteria_json: { wishlists: [], wishlistOverride: true } }, ref).wishes, []);
  assert.equal(domain.effectiveCriteria({ criteria_json: {} }, ref).wishes.length, 1);
  const [only] = domain.wishlistsFromCalculatorEvents([{ marca: 'BMW', modelo: 'X5', milhas_de: 80000, evento: 'busca' }]);
  assert.equal(only?.maxMiles ?? null, null);
  assert.equal(domain.reactivationEligible({ status: 'ENCERRADO', offReason: 'GAVE_UP', enabled: false }), false);
  assert.equal(domain.reactivationEligible({ status: 'PARADO' }), true);
});

test('Lote 3 · busca salva: a mesma identidade de "Quais buscas salvar" (critério, valor, qualificar)', () => {
  const wish = { make: 'BMW', model: 'X5', yearMin: 2020, yearMax: 2022, maxMiles: 40000 };
  assert.deepEqual(stage.searchIdentity(wish, null), { basis: 'CRITERIA', key: 'bmw|x5' });
  assert.deepEqual(stage.searchIdentity({ make: 'BMW', model: 'X5' }, 3000000), { basis: 'VALUE', key: 'bmw|x5|valor' });
  assert.deepEqual(stage.searchIdentity({ make: 'BMW', model: 'X5' }, null), { basis: 'QUALIFY', key: 'bmw|x5|qualificar' });
});

test('Lote 3 · CSV: odômetro desconhecido não aparece como "Odometer OK"; POR VALOR avisa a milhagem que falta', () => {
  const marked = upload.markSearchFiltered([{ miles: 30000 }, { miles: null }, { miles: '' }]);
  assert.deepEqual(marked.map((row) => row.odometerOk), [true, false, false]);
  const result = vehicleMatch.matchWish({ year: 2021, make: 'BMW', model: 'X5', miles: null, mmrCents: 3000000 }, { make: 'BMW', model: 'X5' }, 3000000);
  assert.equal(result.kind, 'POR_VALOR');
  assert.match(result.notice, /milhagem não informada/);
});

test('Lote 3 · "Carro ou faixa" vira o desejo confirmado da ficha, mantendo os outros carros', async () => {
  const sent = [];
  const real = require('../panel-server');
  const journey = { id: uuid(10), contact_id: uuid(11), status: 'ATIVO', stage: 'RESPONDIDO', criteria_json: { wishlists: [{ make: 'Audi', model: 'Q5' }, { make: 'BMW', model: 'X5' }] } };
  const server = { ...real,
    requirePanel: async () => ({ environment: 'preview', panel: { id: uuid(1) }, config: { url: 'https://example.invalid', secretKey: 'x' } }),
    jsonBody: async (req) => req.body,
    rows: async (_ctx, table) => table === 'journeys' ? [journey] : table === 'message_journeys' ? [{ message_id: uuid(12) }] : table === 'messages' ? [{ id: uuid(12), chat_id: uuid(13), direction: 'CUSTOMER', body_text: 'quero X5 2021' }] : [],
    allRows: async () => [],
    supabase: async (_url, _key, pathName, options) => { sent.push({ pathName, body: JSON.parse(options.body || '{}') }); return { pointNumber: 1 }; }
  };
  const handler = loadWith('api/panel/actions.js', { '../../panel-server': server, '../../panel-read-model': { journeyExists: async () => journey, messageForJourney: async () => ({ id: uuid(12), chat_id: uuid(13), direction: 'CUSTOMER', body_text: 'quero X5 2021' }) } });
  const res = output();
  await handler({ method: 'POST', body: { action: 'mark_message', journeyId: journey.id, messageId: uuid(12), kind: 'VEHICLE', wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2021, yearMax: 2023, maxMiles: 40000 }] } }, res);
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  const call = sent.find((entry) => entry.pathName.includes('panel_mark_message_fact_v2'));
  assert.deepEqual(call.body.p_value_json.confirmedWishlists.map((wish) => `${wish.model}:${wish.yearMin || ''}`), ['X5:2021', 'Q5:']);
});

test('Lote 3 · banco: a V2 grava o desejo confirmado quando recebe confirmedWishlists', async () => {
  const { migratedDatabase } = require('./sql/run');
  const { db } = await migratedDatabase();
  try {
    const ids = { actor: uuid(21), contact: uuid(22), journey: uuid(23), chat: uuid(24), message: uuid(25) };
    await db.query(`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values($1,'preview',$2,'l3@example.test','admin',true,false)`, [ids.actor, uuid(26)]);
    await db.query(`insert into public.contacts(id,environment,display_name,created_at,updated_at) values($1,'preview','Cliente',now(),now())`, [ids.contact]);
    await db.query(`insert into public.journeys(id,environment,contact_id,source,status,stage,criteria_json,created_at,updated_at) values($1,'preview',$2,'MANUAL','ATIVO','NOVO','{"wishlists":[{"make":"Audi","model":"Q5"}]}',now(),now())`, [ids.journey, ids.contact]);
    for (let point = 1; point <= 6; point += 1) await db.query(`insert into public.journey_checklist(environment,journey_id,point_number,point_label,created_at,updated_at) values('preview',$1,$2,'p',now(),now())`, [ids.journey, point]);
    await db.query(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at) values($1,'preview','WHATSAPP',$2,'l3','RESOLVED',now(),now())`, [ids.chat, ids.contact]);
    await db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values($1,'preview',$2,'WHATSAPP','CUSTOMER','quero X5','quero x5',now(),'sig-l3',0,'WHATSAPP_WEBHOOK',now())`, [ids.message, ids.chat]);
    await db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'TEST',now())`, [ids.message, ids.journey]);
    const wishes = [{ make: 'BMW', model: 'X5', yearMin: 2021, yearMax: 2023, maxMiles: 40000 }, { make: 'Audi', model: 'Q5' }];
    await db.query(`select public.panel_mark_message_fact_v2(p_environment => 'preview', p_journey_id => $1, p_message_id => $2, p_kind => 'VEHICLE', p_actor_id => $3, p_value => 'BMW X5 2021-2023', p_value_json => $4::jsonb)`,
      [ids.journey, ids.message, ids.actor, JSON.stringify({ wishlist: { wishlists: [wishes[0]] }, confirmedWishlists: wishes })]);
    const criteria = (await db.query(`select criteria_json from public.journeys where id=$1`, [ids.journey])).rows[0].criteria_json;
    assert.equal(criteria.wishlistOverride, true);
    assert.deepEqual(criteria.wishlists.map((wish) => wish.model), ['X5', 'Q5']);
  } finally { await db.close(); }
});
