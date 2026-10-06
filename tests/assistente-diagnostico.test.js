
// Diagnóstico do assistente: leitores novos e ações novas. Banco e OpenAI simulados.
process.env.VERCEL_ENV = 'preview';
process.env.OPENAI_API_KEY = 'sk-chave-secreta-teste';
process.env.SUPABASE_SECRET_KEY = 'sb-secreta-teste';
const test2 = require('node:test');
const assert2 = require('node:assert/strict');
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
const lotMatch = (row, params) => Object.entries(params || {}).every(([key, value]) => {
  if (['select', 'order', 'limit', 'environment'].includes(key) || value === undefined) return true;
  const actual = row[key];
  if (String(value).startsWith('eq.')) return String(actual) === String(value).slice(3);
  if (String(value).startsWith('in.(')) return String(value).slice(4, -1).split(',').includes(String(actual));
  return true;
});
function lotServices(extra = {}) {
  const writes = [];
  const read = async (_, table, params) => (lotTables[table] || []).filter((row) => lotMatch(row, params));
  return {
    writes,
    rows: read, allRows: read,
    insert: async (_, table, body) => { writes.push({ table, body }); return [{ id: 'ev' }]; },
    rpc: async (_, name) => (name === 'panel_manheim_demand_options' ? [] : []),
    latestUpload: async () => ({ id: uid }),
    budget: { guard: () => ({}), paidCall: async (_, { send }) => send({}), recorded: async () => {} },
    ...extra
  };
}

test2('diagnosticar_opcoes: agrupa por motivo na ordem dos portões', async () => {
  const out = await assistant.READERS.diagnosticar_opcoes(tctx, lotServices(), { journey_id: jid });
  assert2.equal(out.pessoa.ref, 'ABCDE');
  assert2.equal(out.carros_analisados, 6);
  const motivos = Object.fromEntries(out.por_motivo.map((r) => [r.motivo, r.total]));
  assert2.equal(motivos['leilão passado'], 1);
  assert2.equal(motivos['sem MMR para comparar'], 1);
  assert2.equal(motivos['título bloqueia (salvage/rebuilt)'], 1);
  assert2.equal(motivos['modelo não combina com o pedido'], 1);
  assert2.equal(motivos['ano 2018 abaixo do pedido (2020-2023)'], 1);
  // o carro bom não aparece nos motivos
  const vins = out.por_motivo.flatMap((r) => r.exemplos.map((e) => e.vin));
  assert2.ok(!vins.includes('1C4HJXFG0NW000006'));
  // sincronia: CARRO comparado, VALOR não
  const sync = Object.fromEntries(out.sincronia.map((s) => [s.modo, s.estado]));
  assert2.match(sync.CARRO, /comparado em/);
  assert2.match(sync.VALOR, /ainda não comparado/);
});

test2('diagnosticar_opcoes: termo filtra os carros', async () => {
  const out = await assistant.READERS.diagnosticar_opcoes(tctx, lotServices(), { journey_id: jid, termo: 'f-150' });
  assert2.equal(out.carros_analisados, 1);
  assert2.equal(out.por_motivo[0].motivo, 'modelo não combina com o pedido');
});

test2('diagnosticar_opcoes: termo sem carro avisa', async () => {
  const out = await assistant.READERS.diagnosticar_opcoes(tctx, lotServices(), { journey_id: jid, termo: 'fusca' });
  assert2.equal(out.carros_analisados, 0);
  assert2.match(out.aviso, /nenhum carro/);
});

test2('diagnosticar_falha: request lento vira LERDO', () => {
  const context = { actions: [{ kind: 'click', action: 'ficha-open', at: 1 }, { kind: 'request', path: '/api/panel/lead', status: 200, ms: 15000, at: 2 }] };
  return assistant.READERS.diagnosticar_falha(tctx, lotServices(), {}, context).then((out) => {
    assert2.equal(out.categoria, 'LERDO');
    assert2.equal(out.requests_lentos[0].ms, 15000);
  });
});

test2('diagnosticar_falha: erro 500 continua TECNICO, não LERDO', () => {
  const context = { actions: [{ kind: 'click', action: 'ficha-open', at: 1 }, { kind: 'request', path: '/api/panel/lead', status: 500, ms: 15000, at: 2 }] };
  return assistant.READERS.diagnosticar_falha(tctx, lotServices(), {}, context).then((out) => {
    assert2.equal(out.categoria, 'TECNICO');
  });
});

test2('diagnosticar_falha: nunca registra chamado sozinho', async () => {
  const svc = lotServices();
  await assistant.READERS.diagnosticar_falha(tctx, svc, {}, { actions: [] });
  assert2.ok(!svc.writes.some((w) => w.table === 'panel_incidents'), 'nenhum chamado registrado');
});

test2('eventos: lê e filtra por tipo', async () => {
  const all = await assistant.READERS.eventos(tctx, lotServices(), {});
  assert2.equal(all.eventos.length, 2);
  const filtered = await assistant.READERS.eventos(tctx, lotServices(), { termo: 'erro' });
  assert2.equal(filtered.eventos.length, 1);
  assert2.equal(filtered.eventos[0].tipo, 'ERRO');
});

test2('conferir_harmonia: acha seleção sem opção válida', async () => {
  const out = await assistant.READERS.conferir_harmonia(tctx, lotServices(), { journey_id: jid });
  const sel = out.divergencias.find((d) => d.tipo === 'selecao_sem_opcao');
  assert2.ok(sel, 'seleção expirada aparece');
  assert2.equal(sel.motivo, 'leilão passado');
  const vit = out.divergencias.find((d) => d.tipo === 'vitrine_expirada');
  assert2.ok(vit, 'vitrine expirada aparece');
  const sync = out.divergencias.find((d) => d.tipo === 'criterio_nao_comparado');
  assert2.ok(sync, 'VALOR não comparado aparece');
});

test2('conferir_harmonia: sem pessoa, resumo global', async () => {
  const out = await assistant.READERS.conferir_harmonia(tctx, lotServices(), {});
  assert2.equal(out.resumo, true);
  assert2.ok(out.lote);
});

test2('retomar_busca vira só proposta laranja; nada executa no servidor', async () => {
  const svc = lotServices();
  const proposal = await assistant.buildProposal(tctx, svc, { acao: 'retomar_busca', journey_id: jid, texto: '' });
  assert2.ok(proposal, 'proposta criada');
  assert2.equal(proposal.acao, 'retomar_busca');
  assert2.equal(proposal.grava, true);
  assert2.match(proposal.linha, /Comparar de novo · Maria Souza \(Ref ABCDE\)/);
  assert2.ok(Array.isArray(proposal.params.demandKeys) && proposal.params.demandKeys.length > 0);
});

test2('registrar_chamado vira só proposta laranja com o resumo', async () => {
  const proposal = await assistant.buildProposal(tctx, lotServices(), { acao: 'registrar_chamado', termo: 'botão travei', texto: 'botão travei' });
  assert2.ok(proposal, 'proposta criada');
  assert2.equal(proposal.acao, 'registrar_chamado');
  assert2.equal(proposal.grava, true);
  assert2.match(proposal.linha, /Registrar chamado/);
});
