'use strict';

// "Já apresentados" da ficha: uma V1 mandada à mão (link /v/ copiado e enviado pelo WhatsApp) conta
// como apresentada, pela própria conversa. Antes a ficha dizia "nenhum carro" porque só o envio
// direto e "Apresentei ao cliente" registravam a apresentação. Só leitura: nada é gravado.
// Banco PGlite local.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { sentByLink, tokensIn } = require('../panel-v1-sent');

const id = (n) => `6b200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), CONTACT = id(2), JOURNEY = id(3), CHAT = id(4), ASK = id(5), LINK = id(6), SENT = id(7), UNSENT = id(8), V2 = id(9);
const TOKEN = 'LkVQguDfhxOJktlZyeN--u-QfobsMOq4Qf-oNPnCVEI', OTHER = 'NuncaEnviadoAoCliente_abcdefghijklmnopqrstu', V2TOKEN = 'SegundaVitrineV2Token_abcdefghijklmnopqrstu';
const snapshot = (vin, model, year) => JSON.stringify({ vin, year, make: 'Volvo', model, trim: 'B6 Plus' }).replace(/'/g, "''");
const message = (mid, direction, body, hoursAgo) => `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${mid}','preview','${CHAT}','WHATSAPP','${direction}','${body}','${body.toLowerCase()}',now()-interval '${hoursAgo} hours','${mid}',0,'IMPORT',now());
insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${mid}','${JOURNEY}','IMPORT',now());`;

function seed() {
  return [
    `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Volvo','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${CHAT}','preview','WHATSAPP','${CONTACT}','volvo','RESOLVED',false,now(),now(),now(),now());`,
    message(ASK, 'CUSTOMER', 'Any other SUV with low mileage?', 30),
    message(LINK, 'MCS', `You can view them here: https://www.mycarscout.net/v/${TOKEN}`, 29),
    `insert into public.vitrines(id,environment,token,journey_id,contact_id,reference_code,version,expires_at) values('${SENT}','preview','${TOKEN}','${JOURNEY}','${CONTACT}','','V1',now()+interval '3 days'),('${UNSENT}','preview','${OTHER}','${JOURNEY}','${CONTACT}','','V1',now()+interval '3 days'),('${V2}','preview','${V2TOKEN}','${JOURNEY}','${CONTACT}','','V2',now()+interval '3 days');`,
    `insert into public.vitrine_cars(environment,vitrine_id,short_code,vehicle_snapshot) values('preview','${SENT}','AAA111','${snapshot('VIN1', 'XC90', 2026)}'),('preview','${SENT}','AAA112','${snapshot('VIN2', 'XC90', 2025)}'),('preview','${UNSENT}','AAA113','${snapshot('VIN3', 'XC60', 2024)}'),('preview','${V2}','AAA114','${snapshot('VIN4', 'XC40', 2023)}');`
  ].join('\n');
}

let backend;
async function call(name, url) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method: 'GET', url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams) }, res);
  return res;
}
test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('regra: só a mensagem da MCS com o link desta ficha conta, com a primeira data', () => {
  assert.deepEqual([...tokensIn(`ver https://x.net/v/${TOKEN}. e /v/${OTHER}`)], [TOKEN, OTHER]);
  const vitrines = [{ id: 'a', token: TOKEN, version: 'V1' }, { id: 'b', token: OTHER, version: 'V1' }];
  const cars = [{ vitrine_id: 'a', source_match_id: 'm1', vehicle_snapshot: { year: 2026, make: 'Volvo', model: 'XC90' } }];
  const messages = [
    { id: '1', direction: 'CUSTOMER', body_text: `/v/${OTHER}`, occurred_at_utc: '2026-10-04T10:00:00Z' },
    { id: '2', direction: 'MCS', body_text: `de novo /v/${TOKEN}`, occurred_at_utc: '2026-10-04T12:00:00Z' },
    { id: '3', direction: 'MCS', body_text: `link /v/${TOKEN}`, occurred_at_utc: '2026-10-04T11:00:00Z' }
  ];
  const sent = sentByLink({ messages, vitrines, cars });
  assert.equal(sent.length, 1, 'o link mandado pelo cliente não conta');
  assert.equal(sent[0].sentAt, '2026-10-04T11:00:00.000Z');
  assert.deepEqual(sent[0].cars, [{ matchId: 'm1', vin: null, vehicleText: '2026 Volvo XC90' }]);
  assert.deepEqual(sentByLink({ messages, vitrines: [], cars }), []);
});

test('ficha: a V1 mandada à mão aparece como enviada, com os carros; a não enviada e a V2 sem link não', async () => {
  const res = await call('records', '/api/panel/records?id=' + JOURNEY);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload).slice(0, 300));
  const record = res.payload.item || res.payload;
  const sent = record.sentByLink || [];
  assert.equal(sent.length, 1, JSON.stringify(sent));
  assert.equal(sent[0].vitrineId, SENT);
  assert.equal(sent[0].version, 'V1');
  assert.deepEqual(sent[0].cars.map((car) => car.vehicleText).sort(), ['2025 Volvo XC90 B6 Plus', '2026 Volvo XC90 B6 Plus']);
  assert.ok(sent[0].sentAt, 'com a data do envio');
  // Read only: no unit was written.
  assert.deepEqual(record.units, []);
});

test('tela: "Já apresentados" junta os carros do link aos já registrados, sem repetir', () => {
  const lead = fs.readFileSync(path.join(__dirname, '..', 'painel', 'lead.js'), 'utf8');
  assert.match(lead, /record\.sentByLink/);
  assert.match(lead, /link enviado/);
  assert.match(lead, /unitMatches\.has\(car\.matchId\)/);
});
