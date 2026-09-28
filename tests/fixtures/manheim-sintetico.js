'use strict';

// Synthetic Manheim exports. Every VIN, seller and address here is fake.
// Same columns as the real "Export" CSV from Manheim (Porsche 911 and Malibu searches).
const HEADERS = ['Inventory','Vin','Year','Make','Model','Trim','Interior Color','Exterior Color','Odometer Value','Odometer Units','Drivetrain','Transmission Type','Engine Type','MMR','Condition Report Grade','Seller Name','Auction House','Pickup Location','Starts At','Ends At','Lane','Run','Bid Count','Bid Amount','Buy Now Price','Event Sale Name','Seller Comments','Status','Notes'];

const cell = (value) => {
  const text = String(value === null || value === undefined ? '' : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// 17 characters, only letters valid in a VIN, prefixed so it can never be a real one.
const fakeVin = (prefix, index) => `${prefix}${String(index).padStart(17 - prefix.length, '0')}`;

function csv(rows) {
  return [HEADERS.join(','), ...rows.map((row) => HEADERS.map((header) => cell(row[header])).join(','))].join('\r');
}

function vehicleRow(index, overrides) {
  return {
    Inventory: ['Timed Sale', 'Simulcast', 'Porsche Direct'][index % 3],
    'Interior Color': ['Black', 'Beige', 'Gray'][index % 3],
    'Exterior Color': ['Gray', 'Blue', 'White', 'Black'][index % 4],
    'Odometer Units': index % 2 ? 'mi' : 'miles',
    Drivetrain: 'RWD', 'Transmission Type': 'Automatic', 'Engine Type': '6 Cylinder',
    MMR: index % 7 === 0 ? '' : String(40000 + (index % 50) * 900),
    'Condition Report Grade': index % 5 === 0 ? '' : (2 + (index % 30) / 10).toFixed(1),
    'Seller Name': `Vendedor Ficticio ${String(index % 40).padStart(3, '0')}`,
    'Auction House': 'Leilao Sintetico', 'Pickup Location': ['FL - ORLANDO', 'GA - TUCKER', 'TX - HOUSTON'][index % 3],
    'Starts At': '2026-09-27T20:00:00Z', 'Ends At': '2026-09-28T20:00:00Z',
    'Bid Count': String(index % 4), 'Bid Amount': '', 'Buy Now Price': index % 6 === 0 ? String(60000 + index * 10) : '',
    'Seller Comments': index % 4 === 0 ? `Carro ficticio ${index}.<br><br>ABS, Alloy wheels, Navigation System<br><br>Comentario com "aspas", virgulas e HTML <b>longo</b> ${'x'.repeat(400)}` : '',
    Status: 'Live', Notes: '',
    ...overrides
  };
}

// 322 rows, 312 distinct cars: 10 VINs appear twice (Simulcast + Timed Sale), as in the real export.
function porsche911Csv(cars = 312, duplicates = 10) {
  const rows = [];
  for (let index = 0; index < cars; index += 1) {
    rows.push(vehicleRow(index, {
      Vin: fakeVin('SYNP911', index), Year: String(2012 + (index % 13)), Make: 'Porsche', Model: '911',
      Trim: ['Carrera', 'Carrera S', 'Carrera 4S', 'Turbo', 'GT3'][index % 5],
      'Odometer Value': String(3000 + ((index * 7919) % 95000))
    }));
  }
  for (let index = 0; index < duplicates; index += 1) rows.push({ ...rows[index], Inventory: rows[index].Inventory === 'Simulcast' ? 'Timed Sale' : 'Simulcast' });
  return csv(rows);
}

// Small export: 269 Chevrolet Malibu rows.
function malibuCsv(count = 269) {
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push(vehicleRow(index, {
      Inventory: 'Simulcast', Vin: fakeVin('SYNMLB', index), Year: String(2016 + (index % 9)), Make: 'Chevrolet', Model: 'Malibu',
      Trim: ['LS', 'LT', 'RS', 'Premier'][index % 4], 'Odometer Value': String(8000 + ((index * 3571) % 110000)),
      MMR: String(9000 + (index % 40) * 300)
    }));
  }
  return csv(rows);
}

const uuid = (group, index) => `${group}-0000-4000-8000-${String(index).padStart(12, '0')}`;
const REF_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const fakeRef = (index) => `Z${REF_LETTERS[index % 24]}${REF_LETTERS[(index + 5) % 24]}${2 + (index % 8)}${REF_LETTERS[(index * 7) % 24]}`;

// 30 panel journeys + 4 calculator orders = 34 customers who want a Porsche 911.
function porscheCustomers(journeyCount = 30, orderCount = 4) {
  const journeys = Array.from({ length: journeyCount }, (_, index) => {
    const yearMin = 2012 + (index % 6);
    return {
      id: uuid('51000000', index + 1), contactId: uuid('52000000', index + 1), status: 'ATIVO', stage: 'NOVO',
      budget_cents: 6000000 + index * 100000,
      criteria_json: { wishlists: [{ make: 'Porsche', model: '911', yearMin, yearMax: yearMin + 7, maxMiles: 60000 + (index % 5) * 8000 }] }
    };
  });
  const calcRuns = Array.from({ length: orderCount }, (_, index) => ({
    id: String(9000 + index), created_at: `2026-09-2${index}T12:00:00Z`, zip: '32801', estado: 'FL', lance: 70000, pagamento: 'avista', is_test: false,
    dados: { sid: `sintetico-${index}`, ref: fakeRef(index), evento: 'busca', marca: 'Porsche', modelo: '911', ano_de: 2014 + index, ano_ate: 2022 + index, milhas_ate: 70000, lance: 70000 + index * 5000 }
  }));
  return { journeys, calcRuns };
}

module.exports = { HEADERS, fakeRef, malibuCsv, porsche911Csv, porscheCustomers, uuid };
