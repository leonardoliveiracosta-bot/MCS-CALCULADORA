'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildReturns, buildTodayItems, consolidateCalcRuns, journeyEnabled, matchManheimVehicle,
  mergeWishlist, reactivationEligible, wishlistForJourney
} = require('../panel-domain');
const manheim = require('../painel/manheim');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260925180602_panel_manheim_match.sql');
const client = read('painel/painel.js');
const server = read('api/panel/actions.js');

test('journeys default to enabled and disabled journeys leave HOJE', () => {
  const active = { id: 'a', status: 'ATIVO', stage: 'RESPONDIDO', stage_frozen: false };
  const disabled = { ...active, id: 'b', enabled: false };
  assert.equal(journeyEnabled(active), true);
  assert.equal(journeyEnabled(disabled), false);
  const data = { journeys: [active, disabled], messages: [], checklist: [], promises: [], divergences: [
    { journey_id: 'a', status: 'OPEN', field: 'TETO', created_at: '2026-09-25T10:00:00Z' },
    { journey_id: 'b', status: 'OPEN', field: 'TETO', created_at: '2026-09-25T10:00:00Z' }
  ], units: [], suppressions: [] };
  assert.deepEqual(buildTodayItems(data, new Date('2026-09-25T12:00:00Z')).map((item) => item.id), ['a']);
});

test('toggle migration keeps an exact snapshot, optional reason, logs, and environment isolation', () => {
  assert.match(migration, /resume_snapshot jsonb not null/);
  for (const field of ['stage', 'status', 'stage_frozen', 'qualified_at', 'closed_at', 'closed_reason', 'next_action_at', 'next_action_text', 'next_action_missing_since']) {
    assert.match(migration, new RegExp(`'${field}'`));
    assert.match(migration, new RegExp(`${field} = .*resume_snapshot`, 's'));
  }
  assert.match(migration, /p_reason is not null and p_reason not in/);
  assert.match(migration, /where id = p_journey_id and environment = p_environment/i);
  assert.match(migration, /JOURNEY_DISABLED/);
  assert.match(migration, /insert into public\.activity_log/);
  assert.match(migration, /insert into public\.audit_log/);
});

test('only the requested disabled reasons and Parado are eligible for Reativar', () => {
  assert.equal(reactivationEligible({ enabled: false, offReason: 'GAVE_UP' }), true);
  assert.equal(reactivationEligible({ enabled: false, offReason: 'NO_RESPONSE' }), true);
  assert.equal(reactivationEligible({ enabled: false, offReason: 'MCS_PURCHASE' }), false);
  assert.equal(reactivationEligible({ enabled: false, offReason: null }), false);
  assert.equal(reactivationEligible({ enabled: true, status: 'PARADO' }), true);
});

test('calculator wishlist fills only empty fields', () => {
  const rows = [{ id: '1', created_at: '2026-09-25T10:00:00Z', dados: {
    sid: 'synthetic', ref: 'TST23', evento: 'busca', marca: 'Honda', modelo: 'Civic',
    ano_de: 2020, ano_ate: 2024, milhas_ate: 50000, lance: 20000
  } }];
  const incoming = consolidateCalcRuns(rows)[0].wishlist;
  assert.deepEqual(incoming, { make: 'Honda', model: 'Civic', yearMin: 2020, yearMax: 2024, maxMiles: 50000 });
  assert.deepEqual(mergeWishlist({ make: 'Toyota', yearMin: 2021 }, incoming), {
    make: 'Toyota', model: 'Civic', yearMin: 2021, yearMax: 2024, maxMiles: 50000
  });
  assert.deepEqual(wishlistForJourney({ criteria_json: { wishlist: incoming } }), incoming);
});

test('CSV mapping recognizes the supported Manheim header shape and reports missing essentials', () => {
  const parsed = manheim.parseCsv('Year,Make,Model,Trim,Odometer,Auction,Sale Date,MMR\r\n2022,Honda,Civic,EX,25000,Orlando,09/30/2026,"$18,500"');
  const mapping = manheim.mapHeaders(parsed.headers);
  assert.deepEqual(mapping.missing, []);
  const row = manheim.normalizeRows(parsed, mapping)[0];
  assert.deepEqual({ year: row.year, make: row.make, model: row.model, miles: row.miles, mmrCents: row.mmrCents }, {
    year: 2022, make: 'Honda', model: 'Civic', miles: 25000, mmrCents: 1850000
  });
  assert.deepEqual(manheim.mapHeaders(['Year', 'Make', 'Model']).missing, ['miles']);
});

test('BATE, QUASE and MMR are independent and deterministic', () => {
  const wish = { make: 'Honda', model: 'Civic', yearMin: 2020, yearMax: 2024, maxMiles: 50000 };
  assert.deepEqual(matchManheimVehicle({ year: 2022, make: 'HONDA', model: 'Cívic', miles: 45000, mmrCents: 2100000 }, wish, 2000000), {
    kind: 'BATE', reason: null, mmrStatus: 'MMR acima do teto'
  });
  assert.deepEqual(matchManheimVehicle({ year: 2025, make: 'Honda', model: 'Civic', miles: 45000, mmrCents: 1900000 }, wish, 2000000), {
    kind: 'QUASE', reason: 'ano 1 acima', mmrStatus: 'MMR dentro do teto'
  });
  assert.equal(matchManheimVehicle({ year: 2025, make: 'Honda', model: 'Civic', miles: 56000 }, wish, 2000000), null);
  assert.equal(matchManheimVehicle({ year: 2022, make: 'Honda', model: 'Accord', miles: 45000 }, wish, 2000000), null);
});

test('shortlist preserves CSV columns and escaping', () => {
  const csv = manheim.toCsv(['Year', 'Model', 'Auction'], [{ Year: '2022', Model: 'Civic, EX', Auction: 'Orlando' }]);
  assert.match(csv, /^\uFEFFYear,Model,Auction\r\n2022,"Civic, EX",Orlando$/);
});

test('returns are unified and HOJE colors overdue and next-two-hour deadlines', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const journey = { id: 'j', status: 'ATIVO', stage: 'RESPONDIDO', next_action_text: 'Retornar', next_action_at: '2026-09-25T13:30:00Z' };
  const promises = [{ id: 'p', journey_id: 'j', status: 'OPEN', promise_text: 'Enviar opções', due_at: '2026-09-25T11:00:00Z' }];
  assert.deepEqual(buildReturns(journey, promises).map((item) => item.origin), ['Mensagem', 'Manual']);
  const item = buildTodayItems({ journeys: [journey], messages: [], checklist: [], promises, divergences: [], units: [], suppressions: [] }, now)[0];
  assert.deepEqual(item.reasons.map((reason) => [reason.kind, reason.urgency]), [['NEXT_ACTION', 'yellow'], ['PROMISE', 'red']]);
});

test('UI and server wire structured wishlist, grouping, presenting, Reativar, and no start-search button', () => {
  assert.match(client, /wishlist: \{ make: make\.value, model: model\.value, yearMin:/);
  assert.match(client, /Compatíveis/);
  assert.match(client, /Reativar/);
  assert.match(client, /Apresentei ao cliente/);
  assert.match(client, /Exportar para shortlist/);
  assert.doesNotMatch(client, /INICIAR BUSCA/);
  assert.match(server, /manheimMatchId/);
  assert.match(server, /JOURNEY_ALREADY_DISABLED/);
  assert.match(server, /environment: 'eq\.' \+ ctx\.environment/);
});

test('new Manheim tables force RLS and allow no direct writes from browser roles', () => {
  for (const table of ['journey_toggle_states', 'manheim_uploads', 'manheim_matches']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`, 'i'));
  }
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant select on table[\s\S]*to authenticated/i);
  for (const line of migration.split(/\r?\n/)) assert.doesNotMatch(line, /grant (?:insert|update|delete|all).*to (?:anon|authenticated)/i);
});
