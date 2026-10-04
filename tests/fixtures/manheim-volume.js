'use strict';

// 19 exportações sintéticas do Manheim com ~70.000 linhas no total (nenhum VIN real). Mistura de
// marcas e modelos, VIN repetido entre arquivos, MMR válido, vazio, zero, negativo, "N/A", texto e
// linhas sem odômetro. Determinístico: a mesma chamada gera sempre os mesmos arquivos.
const HEADERS = ['Inventory', 'Vin', 'Year', 'Make', 'Model', 'Trim', 'Exterior Color', 'Odometer Value', 'Odometer Units', 'MMR', 'Condition Report Grade', 'Pickup Location', 'Starts At', 'Ends At', 'Buy Now Price', 'Seller Comments'];
const TEST_SALE_START=new Date(Date.now()+7*86400000).toISOString(),TEST_SALE_END=new Date(Date.now()+8*86400000).toISOString();
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
    'Starts At': TEST_SALE_START, 'Ends At': TEST_SALE_END, 'Buy Now Price': n % 11 === 0 ? String(30000 + n % 5000) : '',
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

const volumeJourneyId = (n) => `6e410000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const journeyId = volumeJourneyId;
const REFS = ['VAAA2', 'VBBB3', 'VCCC4', 'VDDD5'];

// 16 CARRO and 16 VALOR fichas (two per model) and 4 VALOR orders without ficha.
function volumeSeed(ACTOR) {
  const lines = [`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`];
  let n = 0;
  MODELS.forEach(([make, model]) => {
    [[2014, 2019, 10000, 70000], [2019, 2025, 1000, 60000]].forEach(([yearMin, yearMax, minMiles, maxMiles]) => { n += 1; lines.push(person(n, { wishlists: [{ make, model, yearMin, yearMax, minMiles, maxMiles }], logical_modes: ['CARRO'] }, null)); });
    [2000000, 4500000].forEach((bid) => { n += 1; lines.push(person(n, { wishlists: [{ make, model }], logical_modes: ['VALOR'] }, bid)); });
  });
  REFS.forEach((ref, index) => {
    const [make, model] = MODELS[index];
    lines.push(`insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados,is_test) values(now()-interval '2 days','32801','FL',30000,'cash','${JSON.stringify({ sid: 's-' + ref, ref, evento: 'simulacao', logical_mode: 'VALOR', marca: make, modelo: model, lance: 30000 })}',false),(now()-interval '1 day','32801','FL',null,null,'${JSON.stringify({ sid: 's-' + ref, ref, evento: 'whatsapp', logical_mode: 'VALOR' })}',false);`);
  });
  return lines.join('\n');
}
function person(n, criteria, bid) {
  const journey = journeyId(n), contact = journeyId(1000 + n), chat = journeyId(2000 + n), message = journeyId(3000 + n);
  return [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Cliente Volume ${n}','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify(criteria)}',${bid || 'null'},now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','vol-${n}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','Quero um carro','x',now(),'v${n}',1,'WHATSAPP_WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`
  ].join('\n');
}


module.exports = { HEADERS, MODELS, REFS, carRow, mmrFor, vin, volumeFiles, volumeSeed, volumeJourneyId };
