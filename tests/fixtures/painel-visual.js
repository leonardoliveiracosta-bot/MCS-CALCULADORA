'use strict';
const { asSummary, optionsPage } = require('./buscas-simulado');

// Painel com dados fictícios para os testes visuais: os handlers reais de api/panel rodam contra o
// banco PGlite simulado (tests/fixtures/banco-simulado.js). Nomes, telefones (555-01xx) e Refs são
// inventados. Nada sai da máquina: rede externa é abortada e rotas que enviam, cobram ou chamam IA
// respondem vazio.
const { BASE, createBackend } = require('./banco-simulado');

const ACTOR = '69000000-0000-4000-8000-000000000001';
const id = (n) => `69000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PEOPLE = [
  { n: 10, name: 'Mariana Costa', ref: 'MCQ2A', phone: '+13055550101', stage: 'RESPONDIDO', vehicle: 'BMW X5', budget: 4500000, overdue: true },
  { n: 20, name: 'Rafael Lima', ref: 'RLT3B', phone: '+13055550102', stage: 'QUALIFICADO', vehicle: 'Toyota RAV4', budget: null },
  { n: 30, name: 'Juliana Alves', ref: 'JAV4C', phone: '+13055550103', stage: 'NOVO', vehicle: 'Honda CR-V', budget: 2200000 },
  { n: 40, name: 'Pedro Santos', ref: null, phone: '+13055550104', stage: 'NOVO', vehicle: null, budget: null }
];

function seed() {
  const rows = [];
  rows.push(`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`);
  PEOPLE.forEach((person, index) => {
    const contact = id(person.n + 1), journey = id(person.n), chat = id(person.n + 2);
    const criteria = person.n === 20
      ? '{"logical_modes":["CARRO"],"wishlists":[{"make":"Toyota","model":"RAV4","yearMin":2020,"yearMax":2023,"minMiles":10000,"maxMiles":60000,"mode":"CARRO"}]}'
      : person.vehicle ? `{"logical_modes":["VALOR"],"wishlists":[{"make":"${person.vehicle.split(' ')[0]}","model":"${person.vehicle.split(' ').slice(1).join(' ')}","mode":"VALOR"}]}` : '{}';
    rows.push(`insert into public.contacts(id,environment,display_name,source,location_text,created_at,updated_at) values('${contact}','preview','${person.name}','WHATSAPP_DIRECT','Miami, FL',now()-interval '${index + 2} days',now());`);
    rows.push(`insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,created_at) values('preview','${contact}','${person.phone}','${person.phone}',true,true,now());`);
    rows.push(`insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,vehicle_text,budget_cents,reference_code,next_action_text,next_action_at,qualified_at,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','${person.stage}','ATIVO','${criteria}',${person.vehicle ? `'${person.vehicle}'` : 'null'},${person.budget || 'null'},${person.ref ? `'${person.ref}'` : 'null'},${person.overdue ? "'Ligar para confirmar o lance'" : 'null'},${person.overdue ? "now()-interval '3 hours'" : 'null'},${person.stage === 'QUALIFICADO' ? 'now()' : 'null'},now()-interval '${index + 2} days',now());`);
    rows.push(`insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) select 'preview','${journey}',n,'Ponto '||n,(case when n<=${3 - Math.min(index, 3)} then 'COMPLETE' else 'OPEN' end)::public.panel_checklist_status,now(),now() from generate_series(1,6) n;`);
    rows.push(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','visual-${person.n}','RESOLVED',false,now()-interval '2 days',now(),now(),now());`);
    const messages = [
      ['CUSTOMER', `Oi, vim pela calculadora${person.ref ? `. Ref ${person.ref}` : ''}`, 26 + index],
      ['MCS', 'Olá! Recebi sua simulação. Qual é o prazo para comprar?', 25 + index],
      ['CUSTOMER', person.vehicle ? `Quero um ${person.vehicle} ainda este mês` : 'Ainda estou pesquisando', 2 + index]
    ];
    messages.forEach(([direction, text, hours], order) => {
      const message = id(person.n * 10 + order + 500);
      rows.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','${direction}','${text}','${text.toLowerCase()}',now()-interval '${hours} hours','v${person.n}-${order}',1,'IMPORT',now());`);
      rows.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`);
    });
    if (person.ref) {
      rows.push(`insert into public.journey_refs(environment,journey_id,ref_code,created_at) values('preview','${journey}','${person.ref}',now());`);
      const carro = person.n === 20;
      const dados = carro
        ? `{"ref":"${person.ref}","sid":"v-${person.n}-find-1","evento":"busca","logical_mode":"CARRO","canal":"whatsapp","marca":"Toyota","modelo":"RAV4","ano_de":2020,"ano_ate":2023,"milhas_de":10000,"milhas_ate":60000,"nome":"${person.name}"}`
        : `{"ref":"${person.ref}","sid":"v-${person.n}","evento":"sms","logical_mode":"VALOR","marca":"${person.vehicle.split(' ')[0]}","modelo":"${person.vehicle.split(' ').slice(1).join(' ')}","lance":${person.budget / 100},"nome":"${person.name}"}`;
      rows.push(`insert into public.calc_runs(created_at,zip,estado,lance,pagamento,idioma,origem,dados) values(now()-interval '${30 + index} hours','33101','Florida',${carro ? 'null' : person.budget / 100},'cash','pt','visual','${dados}');`);
    }
  });
  // Pediram contato pela calculadora e ainda não têm ficha; e um que só simulou.
  rows.push(`insert into public.calc_runs(created_at,zip,estado,lance,pagamento,idioma,origem,dados) values
    (now()-interval '5 hours','32801','Florida',18000,'cash','en','visual','{"ref":"PDK5D","sid":"v-p1","evento":"sms","logical_mode":"VALOR","marca":"Ford","modelo":"Bronco","lance":18000}'),
    (now()-interval '7 hours','33602','Florida',null,null,'es','visual','{"ref":"PDK6E","sid":"v-p2-find-1","evento":"busca","logical_mode":"CARRO","canal":"whatsapp","marca":"Jeep","modelo":"Wrangler","ano_de":2019,"ano_ate":2022,"milhas_de":20000,"milhas_ate":70000}'),
    (now()-interval '9 hours','30301','Georgia',12000,'cash','pt','visual','{"ref":"SMQ7F","sid":"v-s1","evento":"simulacao","logical_mode":"VALOR","marca":"Mazda","modelo":"CX-5","lance":12000}');`);
  return rows.join('\n');
}

// BUSCAS: the Manheim data comes from the same fictitious payload as tests/buscas-split.spec.js.
const JOURNEY = id(10), OTHER = id(20);
const x5 = (vin, extra) => ({ year: 2022, make: 'BMW', model: 'X5', trim: 'xDrive40i', miles: 38000, mmrCents: 4300000, vin, locationDisplay: 'Orlando, FL', ...extra });
const rav4 = (vin, extra) => ({ year: 2021, make: 'Toyota', model: 'RAV4', trim: 'XLE', miles: 42000, mmrCents: 2600000, vin, locationDisplay: 'Tampa, FL', ...extra });
const match = (n, mode, kind, vehicle, target) => ({ id: id(900 + n), ...target, logical_mode: mode, demandKey: `journey:${target.journey_id}:${mode}`, match_kind: kind, match_reason: null, row_fingerprint: 'vin:' + vehicle.vin, vehicle_json: { parsed: vehicle } });
function manheim() {
  const matches = [
    match(1, 'VALOR', 'POR_VALOR', x5('VIS1'), { journey_id: JOURNEY }),
    match(2, 'VALOR', 'POR_VALOR', x5('VIS2', { year: 2021, miles: 51000, mmrCents: 3900000, locationDisplay: 'Fort Lauderdale, FL' }), { journey_id: JOURNEY }),
    match(3, 'CARRO', 'BATE', rav4('VIS3'), { journey_id: OTHER }),
    match(4, 'CARRO', 'BATE', rav4('VIS4', { year: 2022, miles: 28000 }), { journey_id: OTHER })
  ];
  const demands = [
    { key: `journey:${JOURNEY}:VALOR`, mode: 'VALOR', targetType: 'JOURNEY', journeyId: JOURNEY, ref: 'MCQ2A', name: 'Mariana Costa', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 4500000, issues: [], stage: 'SAVED', stageLabel: '💾 Busca salva' },
    { key: `journey:${OTHER}:CARRO`, mode: 'CARRO', targetType: 'JOURNEY', journeyId: OTHER, ref: 'RLT3B', name: 'Rafael Lima', wishes: [{ make: 'Toyota', model: 'RAV4', trim: 'XLE', yearMin: 2020, yearMax: 2023, minMiles: 10000, maxMiles: 60000 }], bidCents: null, issues: [], stage: 'MISSING', stageLabel: '🔍 Falta buscar' }
  ];
  const count = (mode) => ({ demands: demands.filter((demand) => demand.mode === mode).length, served: 1, matches: matches.filter((item) => item.logical_mode === mode).length });
  return {
    items: [
      { id: JOURNEY, reference_code: 'MCQ2A', status: 'ATIVO', stage: 'RESPONDIDO', enabled: true, contact: { display_name: 'Mariana Costa' }, phones: [], created_at: '2026-09-27T00:00:00Z' },
      { id: OTHER, reference_code: 'RLT3B', status: 'ATIVO', stage: 'QUALIFICADO', enabled: true, contact: { display_name: 'Rafael Lima' }, phones: [], created_at: '2026-09-27T00:00:00Z' }
    ],
    orders: [], demands, matches, targets: [],
    upload: { id: id(801), vehicle_count: 412, matched_vehicle_count: 4, uploaded_at: '2026-09-29T10:00:00Z', current_lead_count: 2 },
    uploads: [
      { id: id(801), uploadedAt: '2026-09-29T10:00:00Z', fileCount: 3, vehicleCount: 412, matchCount: 4, leadCount: 2, status: 'ACTIVE', current: true, undoSummary: null, ai: null },
      { id: id(802), uploadedAt: '2026-09-28T10:00:00Z', fileCount: 1, vehicleCount: 120, matchCount: 1, leadCount: 1, status: 'UNDONE', current: false, undoSummary: { vehiclesWithdrawn: 120, matchesWithdrawn: 1, unitsPreserved: 0, vitrinesPreserved: 0 }, ai: null }
    ],
    undoAvailable: true,
    review: [{ key: `journey:${id(30)}:REVIEW`, mode: 'REVIEW', targetType: 'JOURNEY', journeyId: id(30), name: 'Juliana Alves', ref: 'JAV4C', issues: [{ code: 'MODE_UNKNOWN', text: 'tipo de busca indefinido' }], canDefineMode: true }],
    counts: { VALOR: count('VALOR'), CARRO: count('CARRO'), total: { people: 2, served: 2, matches: matches.length, review: 1 } }, meta: {}
  };
}
const searches = {
  countsByMode: { VALOR: { MISSING: 0, SAVED: 1, SENT: 0 }, CARRO: { MISSING: 1, SAVED: 0, SENT: 0 } },
  items: [
    { key: JOURNEY + ':VALOR', journeyId: JOURNEY, mode: 'VALOR', ref: 'MCQ2A', name: 'Mariana Costa', exactSearch: 'BMW X5 · lance até US$ 45.000', stage: 'SAVED', stageSource: 'MARK', stageLabel: '💾 Busca salva', days: 0, matchCount: 2 },
    { key: OTHER + ':CARRO', journeyId: OTHER, mode: 'CARRO', ref: 'RLT3B', name: 'Rafael Lima', exactSearch: 'Toyota RAV4 XLE · 2020 a 2023 · 10.000 a 60.000 milhas', stage: 'MISSING', stageSource: null, stageLabel: '🔍 Falta buscar', days: 1, matchCount: 2 }
  ]
};
const saved = {
  groups: [
    { key: 'bmw|x5|valor', mode: 'VALOR', basis: 'VALUE', make: 'BMW', model: 'X5', mmrMinCents: 3150000, mmrMaxCents: 5175000, leads: 1, clients: [], searches: 1, percent: 100, individualPercent: 100, created: false },
    { key: 'toyota|rav4', mode: 'CARRO', basis: 'CRITERIA', make: 'Toyota', model: 'RAV4', yearFrom: 2020, yearTo: 2023, milesFrom: 10000, milesTo: 60000, leads: 1, clients: [], searches: 1, percent: 100, individualPercent: 100, created: false }
  ], review: []
};

// Routes that send messages, call AI, push or touch media never run here.
const BLOCKED = new Set(['reply', 'push-test', 'push-config', 'push-subscriptions', 'ai-cron', 'media-cron', 'ai-conversations', 'lead-help', 'sms-print', 'media', 'attachments', 'vitrine-photos', 'capture', 'notifications']);

async function createPanel() {
  const backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
  globalThis.fetch = backend.fetch;
  const handlers = {};
  const handler = (name) => {
    if (BLOCKED.has(name)) return null;
    if (!(name in handlers)) { try { handlers[name] = require('../../api/panel/' + name); } catch (_) { handlers[name] = null; } }
    return handlers[name];
  };
  async function run(fn, request) {
    const url = new URL(request.url());
    const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
    const req = { method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined };
    await fn(req, res);
    return res;
  }
  const failures = [];
  async function open(page, base, { width = 1280, height = 900, login = false } = {}) {
    await page.setViewportSize({ width, height });
    if (!login) await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
    await page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.href.startsWith(base)) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
      const name = url.pathname.replace('/api/panel/', '');
      if (name === 'config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
      if (name === 'session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
      // BUSCAS in the server format: a summary without cars, options page by page.
      if (name === 'records' && url.searchParams.get('view') === 'manheim') return json(asSummary(manheim()));
      if (name === 'manheim-options') return json(optionsPage(manheim(), url));
      if (name === 'searches') return json(searches);
      if (name === 'manheim-searches') return json(saved);
      if (request.method() !== 'GET') return json({ ok: true });
      const fn = handler(name);
      if (!fn) return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
      try {
        const res = await run(fn, request);
        if (res.statusCode >= 400) failures.push(`${url.pathname}${url.search} ${res.statusCode} ${JSON.stringify(res.payload).slice(0, 160)}`);
        return json(res.payload, res.statusCode);
      } catch (error) {
        failures.push(`${url.pathname}${url.search} ${error.message}`);
        return json({ error: 'FALHA_SIMULADA' }, 500);
      }
    });
    await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  }
  return { backend, open, failures, close: () => backend.db.close() };
}

module.exports = { createPanel, PEOPLE };
