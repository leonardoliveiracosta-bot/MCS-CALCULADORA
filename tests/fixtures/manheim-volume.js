'use strict';

// 19 exportações sintéticas do Manheim com ~70.000 linhas no total (nenhum VIN real). Mistura de
// marcas e modelos, VIN repetido entre arquivos, MMR válido, vazio, zero, negativo, "N/A", texto e
// linhas sem odômetro. Determinístico: a mesma chamada gera sempre os mesmos arquivos.
const HEADERS = ['Inventory', 'Vin', 'Year', 'Make', 'Model', 'Trim', 'Exterior Color', 'Odometer Value', 'Odometer Units', 'MMR', 'Condition Report Grade', 'Pickup Location', 'Starts At', 'Ends At', 'Buy Now Price', 'Seller Comments'];
const MODELS = [
  ['Honda', 'CR-V'], ['Toyota', 'Camry'], ['BMW', 'X5'], ['Ford', 'F-150'],
  ['Chevrolet', 'Malibu'], ['Jeep', 'Wrangler'], ['Nissan', 'Altima'], ['Tesla', 'Model 3']
];
const cell = (value) => { const text = String(value === null || value === undefined ? '' : value); return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; };
const vin = (n) => 'SYNV' + String(n).padStart(13, '0');

// MMR cases by position: most valid; the rest are every invalid form the panel must refuse.
function mmrFor(n) {
  const slot = n % 100;
  if (slot === 0 || slot === 1 || slot === 2) return '';
  if (slot === 3) return '0';
  if (slot === 4) return '-1500';
  if (slot === 5 || slot === 6) return 'N/A';
  if (slot === 7) return 'desconhecido';
  return String(8000 + ((n * 7919) % 60) * 1000);
}

function carRow(n) {
  const [make, model] = MODELS[n % MODELS.length];
  return {
    Inventory: n % 3 === 0 ? 'Simulcast' : 'Timed Sale', Vin: vin(n), Year: String(2012 + ((n * 31) % 14)), Make: make, Model: model,
    Trim: ['Base', 'Sport', 'Limited', 'Touring'][n % 4], 'Exterior Color': ['Black', 'White', 'Gray', 'Blue'][n % 4],
    'Odometer Value': n % 97 === 0 ? 'TMU' : String(1000 + ((n * 104729) % 149000)), 'Odometer Units': 'mi',
    MMR: mmrFor(n), 'Condition Report Grade': (2 + (n % 30) / 10).toFixed(1), 'Pickup Location': ['FL - ORLANDO', 'GA - TUCKER', 'TX - HOUSTON'][n % 3],
    'Starts At': '2026-10-01T15:00:00Z', 'Ends At': '2026-10-02T15:00:00Z', 'Buy Now Price': n % 11 === 0 ? String(30000 + n % 5000) : '',
    'Seller Comments': n % 5 === 0 ? 'Carro ficticio ' + n + ', sem historico real' : ''
  };
}

// files: how many CSVs; perFile: rows per file; repeatEvery: every Nth row repeats a car of the
// previous file (same VIN between files).
function volumeFiles({ files = 19, perFile = 3685, repeatEvery = 10 } = {}) {
  const output = [];
  let next = 0;
  for (let file = 0; file < files; file += 1) {
    const rows = [];
    for (let index = 0; index < perFile; index += 1) {
      if (file > 0 && index % repeatEvery === 0) rows.push(carRow((file - 1) * perFile + index + 1));
      else rows.push(carRow(file * perFile + index));
      next += 1;
    }
    output.push({ name: `MCS_VOLUME_${String(file + 1).padStart(2, '0')}.csv`, text: [HEADERS.join(','), ...rows.map((row) => HEADERS.map((header) => cell(row[header])).join(','))].join('\r\n') });
  }
  return { files: output, rows: next };
}

module.exports = { HEADERS, MODELS, carRow, mmrFor, vin, volumeFiles };
