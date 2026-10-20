
// "Por que este carro não aparece?" do assistente: o primeiro portão que barra cada carro do lote, na ordem do
// painel, e o diagnóstico do "Não funcionou". Banco simulado (PostgREST em memória).
process.env.VERCEL_ENV = 'preview';
process.env.SUPABASE_URL = 'https://mock.supabase';
process.env.SUPABASE_SECRET_KEY = 'sb-secreta-teste';
const test2 = require('node:test');
const assert2 = require('node:assert/strict');
const { createFake } = require('./support/fake-postgrest');
const diagnose = require('../panel-assistant-diagnose');
const assistant = require('../api/panel/assistant');

const jid = '11111111-1111-4111-8111-111111111111';
const uid = '44444444-4444-4444-8444-444444444444';
const tctx = { environment: 'preview', panel: { id: '55555555-5555-4555-8555-555555555555' } };
const P = (o) => ({ parsed: o });
const lotTables = {
  journeys: [{ id: jid, contact_id: '22222222-2222-4222-8222-222222222222', reference_code: 'ABCDE', status: 'ATIVO', stage: 'RESPONDIDO', budget_cents: 3000000, criteria_json: { wishlists: [{ make: 'Jeep', model: 'Wrangler', yearMin: 2020, yearMax: 2023, minMiles: 0, maxMiles: 60000 }] }, updated_at: '2026-10-05T10:00:00Z' }],
  contacts: [{ id: '22222222-2222-4222-8222-222222222222', display_name: 'Maria Souza', is_lead: true }],
  contact_phones: [],
  manheim_matches: [
    { id: 'a0000000-0000-4000-8000-000000000001', upload_id: uid, demand_key: `journey:${jid}:CARRO`, mmr_cents: 2500000, vehicle_json: P({ year: 2021, make: 'Jeep', model: 'Wrangler', trim: 'Sport', vin: '1C4HJXFN0MW000001', lane: 'B', run: '7', saleDate: '2026-09-01' }) },
    { id: 'a0000000-0000-4000-8000-000000000002', upload_id: uid, demand_key: `journey:${jid}:CARRO`, mmr_cents: null, vehicle_json: P({ year: 2022, make: 'Jeep', model: 'Wrangler', trim: 'Sport', vin: '1C4HJXFN0NW000002', lane: 'B', run: '7', saleDate: '2026-12-01' }) },
    { id: 'a0000000-0000-4000-8000-000000000003', upload_id: uid, demand_key: `journey:${jid}:CARRO`, mmr_cents: 2500000, vehicle_json: P({ year: 2022, make: 'Jeep', model: 'Wrangler', trim: 'Sport', vin: '1C4HJXFN0NW000003', lane: 'B', run: '7', saleDate: '2026-12-01', title: 'Salvage Title' }) },
    { id: 'a0000000-0000-4000-8000-000000000004', upload_id: uid, demand_key: `journey:${jid}:CARRO`, mmr_cents: 2500000, vehicle_json: P({ year: 2022, make: 'Ford', model: 'F-150', trim: 'XLT', vin: '1FTEW1E50NFA00004', lane: 'B', run: '7', saleDate: '2026-12-01' }) },
    { id: 'a0000000-0000-4000-8000-000000000005', upload_id: uid, demand_key: `journey:${jid}:CARRO`, mmr_cents: 2500000, vehicle_json: P({ year: 2018, make: 'Jeep', model: 'Wrangler', trim: 'Sport', vin: '1C4HJXFN0JW000005', lane: 'B', run: '7', saleDate: '2026-12-01' }) },
    { id: 'a0000000-0000-4000-8000-000000000006', upload_id: uid, demand_key: `journey:${jid}:CARRO`, mmr_cents: 2500000, vehicle_json: P({ year: 2022, make: 'Jeep', model: 'Wrangler', trim: 'Rubicon', vin: '1C4HJXFG0NW000006', lane: 'B', run: '7', saleDate: '2026-12-01', miles: 30000 }) }
  ],
  manheim_demand_syncs: [{ upload_id: uid, demand_key: `journey:${jid}:CARRO`, synced_at: '2026-10-05T12:00:00Z' }],
  manheim_option_selections: [{ upload_id: uid, match_id: 'a0000000-0000-4000-8000-000000000001', demand_key: `journey:${jid}:CARRO`, status: 'SELECTED' }],
  vitrines: [{ id: 'b0000000-0000-4000-8000-000000000001', journey_id: jid, token: 'tok1', version: 'V1', created_at: '2026-10-04T10:00:00Z', expires_at: '2026-10-03T10:00:00Z' }],
  vitrine_cars: [],
  vitrine_events: [],
  message_journeys: [],
  messages: [],
  panel_assistant_events: [
    { event_type: 'ERRO', action: null, created_at: '2026-10-05T15:00:00Z', payload: { code: 'OPENAI_TIMEOUT' } },
    { event_type: 'PROPOSTA', action: 'abrir_ficha', created_at: '2026-10-05T14:00:00Z', payload: {} }
  ]
};

const tables = () => {
  const copy = JSON.parse(JSON.stringify(lotTables));
  copy.journeys.forEach((row) => { row.environment = 'preview'; });
  copy.manheim_matches.forEach((row) => { row.environment = 'preview'; row.undone_at = null; });
  copy.manheim_uploads = [{ id: uid, environment: 'preview', activated_at: '2026-10-01T00:00:00Z', undone_at: null, uploaded_at: '2026-10-01T00:00:00Z' }];
  return copy;
};
const ctx = { ...tctx, config: { url: 'https://mock.supabase', secretKey: 'k' } };

test2('por que não aparece: agrupa por motivo na ordem dos portões', async () => {
  globalThis.fetch = createFake(tables()).fetchImpl;
  const out = await diagnose.diagnoseOptions(ctx, jid);
  assert2.equal(out.carros_analisados, 6);
  const motivos = Object.fromEntries(out.por_motivo.map((r) => [r.motivo, r.total]));
  assert2.equal(motivos['leilão passado'], 1);
  assert2.equal(motivos['sem MMR para comparar'], 1);
  assert2.equal(motivos['título bloqueia (salvage/rebuilt)'], 1);
  assert2.equal(motivos['modelo não combina com o pedido'], 1);
  assert2.equal(motivos['ano 2018 abaixo do pedido (2020-2023)'], 1);
  const vins = out.por_motivo.flatMap((r) => r.exemplos.map((e) => e.vin));
  assert2.ok(!vins.includes('1C4HJXFG0NW000006'), 'o carro bom não aparece nos motivos');
});

test2('por que não aparece: termo filtra os carros e avisa quando nada bate', async () => {
  globalThis.fetch = createFake(tables()).fetchImpl;
  const one = await diagnose.diagnoseOptions(ctx, jid, 'f-150');
  assert2.equal(one.carros_analisados, 1);
  assert2.equal(one.por_motivo[0].motivo, 'modelo não combina com o pedido');
  const none = await diagnose.diagnoseOptions(ctx, jid, 'fusca');
  assert2.equal(none.carros_analisados, 0);
  assert2.match(none.aviso, /nenhum carro/);
});

test2('"Não funcionou": pedido lento vira LENTIDAO; erro 500 é TECNICO mesmo lento', () => {
  const slow = assistant.rulesDiagnosis({ actions: [{ kind: 'click', action: 'ficha-open', at: 1 }, { kind: 'request', path: '/api/panel/lead', status: 200, ms: 15000, at: 2 }] });
  assert2.equal(slow.categoria, 'LENTIDAO');
  const broken = assistant.rulesDiagnosis({ actions: [{ kind: 'click', action: 'ficha-open', at: 1 }, { kind: 'request', path: '/api/panel/lead', status: 500, ms: 15000, at: 2 }] });
  assert2.equal(broken.categoria, 'TECNICO');
  const own = assistant.rulesDiagnosis({ actions: [{ kind: 'click', action: 'v1-generate', at: 1 }, { kind: 'request', path: '/api/panel/assistant', status: 500, at: 2 }] });
  assert2.notEqual(own.categoria, 'TECNICO', 'o pedido ao próprio assistente não é evidência da falha');
});
