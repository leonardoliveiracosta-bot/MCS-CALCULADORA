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

test('Lote 3 · importação depois do webhook: a mesma mensagem (pessoa, direção, minuto e texto) não duplica', async () => {
  const real = require('../panel-server');
  const calls = [];
  const webhook = [{ direction: 'CUSTOMER', body_normalized: 'Quero  uma X5', occurred_at_utc: '2026-09-20T14:05:41Z' }];
  const server = { ...real,
    requirePanel: async () => ({ environment: 'preview', panel: { id: uuid(1) }, config: { url: 'https://example.invalid', secretKey: 'x' } }),
    allRows: async (_ctx, table) => table === 'messages' ? webhook : [],
    supabase: async (_url, _key, pathName, options) => {
      if (pathName.startsWith('/rest/v1/import_jobs')) return [{ chat_id: uuid(31) }];
      if (pathName.includes('chats?') && pathName.includes('contact_id=eq.')) return [{ id: uuid(31) }, { id: uuid(33) }];
      if (pathName.includes('chats?')) return [{ contact_id: uuid(32) }];
      calls.push(JSON.parse(options.body));
      return [{ inserted_count: 1, already_present_count: 0 }];
    }
  };
  const handler = loadWith('api/panel/entry.js', { '../../panel-server': server });
  const item = (text, minute, signature) => ({ chat_id: uuid(31), direction: 'CUSTOMER', body_text: text, body_normalized: text, occurred_at_utc: `2026-09-20T14:0${minute}:00.000Z`, signature_base: signature, file_occurrence_total: 1 });
  const res = output();
  await handler({ method: 'POST', body: { action: 'batch', importJobId: uuid(30), batchNumber: 1, messages: [item('quero uma x5', 5, 'a'), item('e o preço?', 6, 'b')] } }, res);
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  assert.deepEqual(res.payload, { inserted: 1, alreadyPresent: 1 });
  assert.deepEqual(calls[0].p_messages.map((row) => row.body_text), ['e o preço?']);
  calls.length = 0;
  const only = output();
  await handler({ method: 'POST', body: { action: 'batch', importJobId: uuid(30), batchNumber: 2, messages: [item('Quero uma X5', 5, 'a')] } }, only);
  assert.deepEqual(only.payload, { inserted: 0, alreadyPresent: 1 });
  assert.equal(calls.length, 0);
});

test('Lote 3 · importação automática: título de dois chats vai para revisão', () => {
  const parser = require('../painel/parser');
  const parsed = parser.parseWhatsApp('[25/09/2026, 14:30] Operador MCS: Olá\n[25/09/2026, 14:31] Ana: Oi', 'WhatsApp Chat with Ana.txt', {});
  const chats = [{ id: 'a', contact_id: 'pa', is_group: false }, { id: 'b', contact_id: 'pb', is_group: false }];
  const senders = ['a', 'b'].flatMap((chat) => [{ chat_id: chat, sender_text: 'Operador MCS', direction: 'MCS' }, { chat_id: chat, sender_text: 'Ana', direction: 'CUSTOMER' }]);
  assert.equal(parser.automaticImportMatch(parsed, [{ chat_id: 'a', alias_text: 'WhatsApp Chat with Ana' }], chats, senders).chat.id, 'a');
  assert.equal(parser.automaticImportMatch(parsed, [{ chat_id: 'a', alias_text: 'WhatsApp Chat with Ana' }, { chat_id: 'b', alias_text: 'WhatsApp Chat with Ana' }], chats, senders), null);
});

test('Lote 3 · início da importação: falha no meio apaga só o que esta tentativa criou', async () => {
  const real = require('../panel-server');
  const deleted = [];
  const server = { ...real,
    requirePanel: async () => ({ environment: 'preview', panel: { id: uuid(1) }, config: { url: 'https://example.invalid', secretKey: 'x' } }),
    supabase: async (_url, _key, pathName, options = {}) => {
      if (options.method === 'DELETE') { deleted.push(pathName.split('?')[0].replace('/rest/v1/', '')); return []; }
      if (pathName.startsWith('/rest/v1/contacts') && options.method === 'POST') return [{ id: uuid(41), display_name: 'Cliente Novo' }];
      if (pathName.startsWith('/rest/v1/chats') && options.method === 'POST') return [{ id: uuid(42) }];
      if (pathName.startsWith('/rest/v1/import_jobs')) throw Object.assign(new Error('boom'), { status: 500 });
      return [];
    }
  };
  const handler = loadWith('api/panel/entry.js', { '../../panel-server': server });
  const res = { ...output(), statusCode: 200, status(code) { this.code = code; this.statusCode = code; return this; } };
  await handler({ method: 'POST', body: { action: 'start', sourceKind: 'WHATSAPP_TXT', sourceFilename: 'Cliente Novo.txt', sourceSha256: 'a'.repeat(64),
    chat: { channel: 'WHATSAPP', isGroup: false, newContactName: 'Cliente Novo', aliasText: 'Cliente Novo', senderAliases: [{ senderText: 'MCS', direction: 'MCS' }, { senderText: 'Cliente Novo', direction: 'CUSTOMER' }] } } }, res);
  assert.equal(res.code, 500);
  assert.deepEqual(res.payload, { error: 'IMPORT_START_FAILED' });
  assert.deepEqual(deleted, ['chat_sender_aliases', 'chat_aliases', 'chats', 'contacts']);
});

test('Lote 3 · reimportação sem mensagem nova não abre ficha vazia', async () => {
  const real = require('../panel-server');
  const calls = [];
  let openJourneys = [{ id: uuid(53) }];
  const server = { ...real,
    requirePanel: async () => ({ environment: 'preview', panel: { id: uuid(1) }, config: { url: 'https://example.invalid', secretKey: 'x' } }),
    allRows: async () => [],
    supabase: async (_url, _key, pathName, options = {}) => {
      calls.push({ pathName, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      if (pathName.startsWith('/rest/v1/import_jobs?') && !options.method) return [{ id: uuid(50), chat_id: uuid(51), message_count: 0 }];
      if (pathName.startsWith('/rest/v1/chats?')) return [{ id: uuid(51), contact_id: uuid(52), resolution_status: 'RESOLVED', is_group: false }];
      if (pathName.startsWith('/rest/v1/journeys?') && pathName.includes('contact_id=eq.')) return openJourneys;
      if (pathName.includes('panel_finalize_import_resolution')) return uuid(53);
      return [];
    }
  };
  const handler = loadWith('api/panel/entry.js', { '../../panel-server': server });
  const res = output();
  await handler({ method: 'POST', body: { action: 'finish', importJobId: uuid(50), journey: { mode: 'new' } } }, res);
  const finalize = calls.find((call) => call.pathName.includes('panel_finalize_import_resolution'));
  assert.equal(finalize.body.p_create_new, false);
  assert.equal(finalize.body.p_journey_id, uuid(53));
  calls.length = 0; openJourneys = [];
  const none = output();
  await handler({ method: 'POST', body: { action: 'finish', importJobId: uuid(50), journey: { mode: 'new' } } }, none);
  assert.equal(none.payload.nothingNew, true);
  assert.equal(calls.some((call) => call.pathName.includes('panel_finalize_import_resolution')), false);
});

test('Lote 3 · print de SMS: nome igual sem telefone igual vai para revisão na ENTRADA', async () => {
  const real = require('../panel-server');
  const patches = [];
  const record = { id: uuid(60), status: 'READY', sha256: null, extracted_json: {}, source_journey_id: null };
  const server = { ...real,
    requirePanel: async () => ({ environment: 'preview', panel: { id: uuid(1) }, config: { url: 'https://example.invalid', secretKey: 'x' } }),
    jsonBody: async (req) => req.body,
    patchRows: async (_ctx, table, _filters, payload) => { patches.push({ table, payload }); return []; },
    rows: async (_ctx, table, params) => {
      if (table === 'sms_print_reads') return [record];
      if (table === 'contacts' && params.display_name) return [{ id: uuid(61) }];
      if (table === 'journeys' && params.contact_id) return [{ id: uuid(62), contact_id: uuid(61) }];
      return [];
    },
    supabase: async () => { throw new Error('não deveria gravar'); }
  };
  const handler = loadWith('api/panel/sms-print.js', { '../../panel-server': server, '../../panel-lead': { orders: async () => [] } });
  const res = output();
  await handler({ method: 'POST', body: { action: 'confirm', auto: true, readId: uuid(60), phone: '+13055550000', name: 'Ana Souza', message: 'oi' } }, res);
  assert.equal(res.code, 202, JSON.stringify(res.payload));
  assert.equal(res.payload.candidateJourneyId, uuid(62));
  assert.deepEqual(patches.map((row) => row.payload.error_code), ['NAME_MATCH_REVIEW']);
});
