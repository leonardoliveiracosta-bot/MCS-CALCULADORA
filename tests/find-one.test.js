'use strict';

// Find One For Me: form order, no value field, "busca" messages, CARRO database defense and the
// VALOR/CARRO matching rules (VALOR = Calculate My Cost, CARRO = Find One For Me).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const domain = require('../panel-domain');
const vehicleMatch = require('../vehicle-match');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('msc-calculadora.html');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const findForm = html.slice(html.indexOf('<form id="find-form"'), html.indexOf('</form>', html.indexOf('<form id="find-form"')));

test('formato: veículo, identificação, perguntas e contato nessa ordem', () => {
  const order = ['find-marca', 'find-modelo', 'find-trim', 'find-year-from', 'find-year-to', 'find-miles-from', 'find-miles-to',
    'find-zip', 'find-nome', 'name="find-prazo"', 'name="find-exp"', 'find-wa', 'find-sms'];
  const positions = order.map((key) => findForm.indexOf(key.startsWith('name=') ? key : `id="${key}"`));
  positions.forEach((position, index) => assert.ok(position > 0, order[index]));
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b));
  // Two cards like Calculate My Cost: the vehicle card with its title, then the card that ends in the contact buttons.
  const cards = findForm.split('<section class="card">').slice(1);
  assert.equal(cards.length, 2);
  assert.match(cards[0], /data-i18n="find_vehicle_title"/);
  assert.doesNotMatch(cards[0], /find-zip|find-prazo|contact-cta/);
  assert.match(cards[1], /id="find-zip"[\s\S]*id="find-nome"[\s\S]*find-prazo[\s\S]*find-exp[\s\S]*class="contact-cta"/);
});

test('formato: nenhum campo de valor no Find One For Me', () => {
  assert.doesNotMatch(findForm, /lance|budget|price|preco|preço|orcamento|orçamento|max[-_ ]?bid|\(US\$\)/i);
  const inputs = [...findForm.matchAll(/<(input|select)[^>]*id="([^"]+)"/g)].map((match) => match[2]);
  assert.deepEqual(inputs.sort(), ['find-marca', 'find-marca-other', 'find-miles-from', 'find-miles-to', 'find-modelo', 'find-modelo-custom', 'find-modelo-other',
    'find-nome', 'find-trim', 'find-trim-unsure', 'find-year-from', 'find-year-to', 'find-zip'].sort());
});

test('formato: Calculate My Cost não mudou', () => {
  const pathA = html.slice(html.indexOf('<section id="path-a"'), html.indexOf('<section id="path-b"'));
  // Markup of path-a on main ce1f9c1.
  assert.equal(sha(pathA), 'd165678e324e580d7fe33d383699b8396ada09b0903e5c753b93923aaa05137a');
});

test('mensagens: "busca" nos três idiomas e nunca "simulação"', () => {
  const copy = html.slice(html.indexOf('function findCopy(){'), html.indexOf('function linhaTriagemFind'));
  for (const text of [
    'Hello! I just sent a vehicle search request through My Car Scout', "I'd like to discuss this vehicle search",
    'Olá! Acabei de enviar uma solicitação de busca pela My Car Scout', 'Quero conversar sobre esta busca',
    'Hola, acabo de enviar una solicitud de búsqueda a My Car Scout', 'Quiero hablar sobre esta búsqueda'
  ]) assert.ok(copy.includes(`"${text}"`), text);
  assert.doesNotMatch(copy, /simula/i);
  // Ref, vehicle, years, mileage, ZIP, deadline and experience stay in the message.
  const builder = html.slice(html.indexOf('function linkWhatsAppFind'), html.indexOf('function linkSmsFind'));
  for (const piece of ['c.years', 'c.vehicle', 'c.miles', 'zipLinha', 'c.planning', 'c.experience', '"Ref: "+d.ref']) assert.ok(builder.includes(piece), piece);
});

test('validação no navegador: ano e milhagem em ordem, Year to filtrado e botões bloqueados', () => {
  const validate = html.slice(html.indexOf('function validarFind'), html.indexOf('function findCopy'));
  assert.match(validate, /d\.anoAte < d\.anoDe/);
  assert.match(validate, /d\.milhasAte < d\.milhasDe/);
  assert.match(validate, /!\(d\.milhasDe > 0\)/);
  const years = html.slice(html.indexOf('function atualizarFindAnoAte'), html.indexOf('function atualizarFindModelo'));
  assert.match(years, /y>=\(de\|\|1995\)/);
  assert.match(years, /parseInt\(atual,10\)>=de/);
  assert.match(html, /\$\("find-year-from"\)\.addEventListener\("change",atualizarFindAnoAte\)/);
  const block = html.slice(html.indexOf('function findBloquear'), html.indexOf('function atualizarFindLink'));
  assert.match(block, /aria-disabled/);
  assert.match(block, /a\.href="#"/);
  assert.match(html, /if\(!validarFind\(true\)\)\{ev\.preventDefault\(\);/);
});

// ------------------------------------------------------------------ banco
const migrationName = '20261003010000_calc_runs_busca_carro_limites.sql';
test('banco: migração nova amplia calc_runs_insert_limits sem editar a antiga', () => {
  const migration = read('supabase/migrations/' + migrationName);
  assert.match(migration, /alter policy calc_runs_insert_limits on public\.calc_runs/);
  assert.doesNotMatch(migration, /drop policy|delete from|update public\.calc_runs/i);
  for (const piece of ["dados ->> 'logical_mode' = 'CARRO'", "'^[1-9][0-9]{3}$'", "'^[1-9][0-9]{0,6}$'",
    "(dados ->> 'ano_de')::int <= (dados ->> 'ano_ate')::int", "(dados ->> 'milhas_de')::int <= (dados ->> 'milhas_ate')::int"]) assert.ok(migration.includes(piece), piece);
  // Every condition of the original policy is kept.
  const original = read('supabase/migrations/20260929030000_calc_runs_insert_limits.sql');
  assert.equal(sha(original), 'ccfb5a5a65e5e87d731f117dc7bbe7c9e84a40a86d277af2ba6f3aa00364376e');
  const conditions = original.slice(original.indexOf('with check (') + 12, original.lastIndexOf(');')).split('\n').map((line) => line.trim().replace(/^and /, '')).filter(Boolean);
  for (const condition of conditions) assert.ok(migration.includes(condition), condition);
  // The site sends exactly what the policy asks for.
  assert.match(html, /sid:FIND_SID,evento:"busca",logical_mode:"CARRO"/);
  assert.match(html, /ano_de:d\.anoDe,ano_ate:d\.anoAte/);
  assert.match(html, /milhas_de:d\.milhasDe,milhas_ate:d\.milhasAte/);
});

// ------------------------------------------------------------------ matching
const car = (overrides) => ({ year: 2023, make: 'BMW', model: 'X5', miles: 8000, mmrCents: 4500000, ...overrides });
const carroRow = (ref, extra = {}) => ({ id: 'c' + ref, created_at: new Date().toISOString(), dados: { sid: 's-' + ref + '-find-1', ref, evento: 'busca', logical_mode: 'CARRO', canal: 'whatsapp', marca: 'BMW', modelo: 'X5', trim: 'M Sport', ano_de: 2020, ano_ate: 2025, milhas_de: 1000, milhas_ate: 10000, ...extra } });
const valorRow = (ref, extra = {}) => ({ id: 'v' + ref, created_at: new Date().toISOString(), dados: { sid: 's-' + ref, ref, evento: 'simulacao', logical_mode: 'VALOR', marca: 'BMW', modelo: 'X5', lance: 20000, total: 26000, ...extra } });

test('CARRO: exemplo BMW X5 2020 a 2025 com 1.000 a 10.000 milhas', () => {
  const demand = domain.orderDemand(domain.consolidateCalcRuns([carroRow('HJKM2')])[0]);
  const match = (vehicle) => vehicleMatch.matchDemand(vehicle, { ...demand, wishes: demand.activeWishes, bidCents: 2000000 });
  assert.equal(match(car()).kind, 'BATE');
  assert.equal(match(car({ year: 2019 })), null);
  assert.equal(match(car({ miles: 20000 })), null);
  // MMR outside any VALOR band, or missing, does not matter.
  assert.equal(match(car({ mmrCents: 99900000 })).kind, 'BATE');
  assert.equal(match(car({ mmrCents: null })).kind, 'BATE');
  // Inclusive limits and no tolerance.
  assert.equal(match(car({ year: 2020, miles: 1000 })).kind, 'BATE');
  assert.equal(match(car({ year: 2025, miles: 10000 })).kind, 'BATE');
  assert.equal(match(car({ miles: 999 })), null);
  assert.equal(match(car({ miles: 10001 })), null);
  assert.equal(match(car({ year: 2026 })), null);
  // No verifiable odometer: not compatible, and never QUASE.
  for (const miles of [null, undefined, '', 'TMU', 'EXEMPT']) assert.equal(match(car({ miles })), null, String(miles));
  // Trim is kept and shown, but not an automatic filter.
  assert.equal(demand.activeWishes[0].trim, 'M Sport');
  assert.equal(match(car({ trim: 'xDrive40i' })).kind, 'BATE');
});

test('CARRO: QUASE não atende a busca (não entra em shortlist, V1 ou V2)', () => {
  assert.equal(vehicleMatch.countsAsServed('QUASE'), false);
  const wish = { make: 'BMW', model: 'X5', yearMin: 2020, yearMax: 2025, minMiles: 1000, maxMiles: 10000 };
  for (const vehicle of [car({ mmrCents: null }), car({ miles: null }), car({ year: 2019 }), car({ miles: 10500 })]) {
    const result = vehicleMatch.matchCarroWish(vehicle, wish);
    assert.ok(result === null || result.kind === 'BATE');
  }
});

test('VALOR: marca, modelo e o lance da própria demanda; nunca ano, milhagem ou teto total', () => {
  const [item] = domain.consolidateCalcRuns([valorRow('HJKM3')]);
  assert.equal(item.budgetCents, 2000000, 'o lance, não o total');
  const demand = domain.orderDemand(item);
  assert.equal(demand.bidCents, 2000000);
  const match = (vehicle) => vehicleMatch.matchDemand(vehicle, { ...demand, wishes: demand.activeWishes });
  // US$ 20.000: 70% to 115% = US$ 14.000 to US$ 23.000.
  assert.equal(match(car({ mmrCents: 1400000, year: 1998, miles: 400000 })).kind, 'POR_VALOR');
  assert.equal(match(car({ mmrCents: 2300000, miles: null })).kind, 'POR_VALOR');
  assert.equal(match(car({ mmrCents: 2600000 })), null, 'o total de US$ 26.000 não vira lance');
  assert.equal(match(car({ mmrCents: null })).kind, 'QUASE');
  assert.equal(match(car({ model: 'X3', mmrCents: 2000000 })), null);
  assert.deepEqual([vehicleMatch.valueBand(6000000).low, vehicleMatch.valueBand(6000000).high, vehicleMatch.valueBand(6000100).low, vehicleMatch.valueBand(6000100).high], [70, 115, 75, 110]);
});

test('histórico: busca é CARRO, Calculate My Cost é VALOR, ambíguo vai para revisão', () => {
  const mode = (dados) => domain.logicalMode({ dados });
  assert.equal(mode({ evento: 'busca' }), 'CARRO');
  assert.equal(mode({ evento: 'whatsapp', sid: '123-find-abc' }), 'CARRO');
  for (const evento of ['simulacao', 'saida', 'share', 'whatsapp', 'sms']) assert.equal(mode({ evento }), 'VALOR', evento);
  for (const evento of ['teste_http_201', '', undefined]) assert.equal(mode({ evento }), 'REVIEW', String(evento));
  assert.equal(mode({ evento: 'busca', logical_mode: 'MIXED' }), 'CARRO', 'MIXED não existe como modo');
  // One Ref, two modes: two independent demands, nothing carried between them.
  const built = domain.buildSearchDemands({ journeys: [], refs: [], modeItems: domain.consolidateCalcRuns([valorRow('HJKM4'), carroRow('HJKM4')]) });
  const demands = built.orders.filter((demand) => demand.ref === 'HJKM4');
  assert.deepEqual(demands.map((demand) => demand.mode).sort(), ['CARRO', 'VALOR']);
  const valor = demands.find((demand) => demand.mode === 'VALOR'), carro = demands.find((demand) => demand.mode === 'CARRO');
  assert.equal(carro.bidCents, null);
  assert.deepEqual([valor.wishes[0].yearMin, valor.wishes[0].maxMiles], [null, null]);
  // An invalid historical CARRO is not searched and goes to review with its original values.
  const inverted = domain.orderDemand(domain.consolidateCalcRuns([carroRow('HJKM5', { ano_de: 2025, ano_ate: 2020 })])[0]);
  assert.deepEqual([inverted.active, inverted.issues[0].code, inverted.wishes[0].yearMin], [false, 'YEAR_INVERTED', 2025]);
  const empty = domain.orderDemand(domain.consolidateCalcRuns([carroRow('HJKM6', { milhas_de: '' })])[0]);
  assert.deepEqual([empty.active, empty.issues[0].code], [false, 'MILES_MISSING']);
});
