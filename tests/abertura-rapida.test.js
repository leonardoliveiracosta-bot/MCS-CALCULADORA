'use strict';
// Abertura rápida: /api/panel/boot entrega as listas da abertura com uma leitura só no banco, prévias e só o que mudou.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const id = (n) => `6d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const ENV = { ENTRADA_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'chave-simulada', ENTRADA_OPENAI_MODEL: 'gpt-6-luna', ENTRADA_OPENAI_SINCE: '2026-01-01T00:00:00Z' };
const PEOPLE = {
  carro: { n: 10, name: 'Cliente Carro', text: ['Hi, I am looking for a 2019 Honda Civic'] },
  aniversario: { n: 20, name: 'Amiga', text: ['Feliz aniversário! Vamos jantar sábado?'] },
  duvida: { n: 30, name: 'Contato Curto', text: ['Oi, tudo bem?'] }
};
function seed() {
  const rows = [`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`];
  Object.values(PEOPLE).forEach((person) => {
    const contact = id(person.n + 1), journey = id(person.n), chat = id(person.n + 2);
    rows.push(`insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${person.name}','WHATSAPP_DIRECT',now(),now());`);
    rows.push(`insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`);
    rows.push(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','t-${person.n}','RESOLVED',false,now(),now(),now(),now());`);
    person.text.forEach((text, index) => {
      const message = id(person.n * 100 + index);
      rows.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','${text.replace(/'/g, "''")}','x',now()-interval '2 hours','s${person.n}-${index}',1,'WHATSAPP_WEBHOOK',now()-interval '2 hours');`);
      rows.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`);
    });
  });
  return rows.join('\n');
}

let backend, reads = 0;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = async (input, options = {}) => { if (!options.method || options.method === 'GET') reads += 1; return backend.fetch(input, options); };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('boot: as 4 listas da abertura numa chamada, iguais às separadas, com menos leituras no banco', async () => {
  reads = 0;
  const separate = {};
  for (const [name, file, url] of [['today', 'today', '/api/panel/today?sort=ready'], ['entry', 'entry', '/api/panel/entry'], ['triage', 'triage', '/api/panel/triage'], ['whatsapp', 'whatsapp', '/api/panel/whatsapp']]) {
    const res = await call(file, url); assert.equal(res.statusCode, 200, name); separate[name] = res.payload;
  }
  const separateReads = reads;
  reads = 0;
  const boot = await call('boot', '/api/panel/boot', 'POST', { part: 'main', sort: 'ready', have: {} });
  assert.equal(boot.statusCode, 200);
  const parts = boot.payload.parts;
  for (const name of ['today', 'entry', 'triage', 'whatsapp']) assert.equal(parts[name].ok, true, name + ' ' + JSON.stringify(parts[name]));
  console.log('LEITURAS', { separadas: separateReads, boot: reads });
  assert.ok(reads < separateReads, `boot leu ${reads} vezes; separadas ${separateReads}`);
  const rebuilt = parts.today.order.map((key) => parts.today.items[key]);
  assert.deepEqual(rebuilt.map((item) => item.id || item.ref).sort(), separate.today.items.map((item) => item.id || item.ref).sort());
  assert.deepEqual(parts.triage.body.review.length, separate.triage.review.length);
  // Segunda abertura sem mudança: nada é mandado de novo.
  const have = { todayItems: parts.today.order };
  Object.entries(parts).forEach(([name, got]) => { have[name] = got.hash; });
  const again = await call('boot', '/api/panel/boot', 'POST', { part: 'main', sort: 'ready', have });
  const diff = (a, b, at = '') => { if (JSON.stringify(a) === JSON.stringify(b)) return []; if (!a || !b || typeof a !== 'object') return [at]; return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diff(a[k], b[k], at + '.' + k)); };
  for (const name of ['entry', 'triage', 'whatsapp']) assert.equal(again.payload.parts[name].same, true, name);
  const today = again.payload.parts.today;
  assert.ok(today.same || Object.keys(today.items || {}).length === 0, 'casos já conhecidos não voltam');
});

test('boot: a prévia corta mensagens longas e marca body_preview', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../api/panel/boot.js'), 'utf8');
  assert.match(src, /PREVIEW_CHARS = 600/);
  assert.match(src, /body_preview: true/);
});

test('boot paginado combina todas as fontes antes do corte, mantém contagens e compartilha leituras dos contadores',async()=>{
  reads=0;
  const full=await call('boot','/api/panel/boot','POST',{part:'main',sort:'ready',includeCounters:true});
  const fullReads=reads;
  assert.equal(full.statusCode,200);
  const rules=require('../panel-attend-page');
  const p=full.payload.parts;
  const today={...p.today.body,items:p.today.order.map(key=>p.today.items[key])};
  const model=rules.modelOf(today,p.entry.body,p.triage.body,p.whatsapp.body,p.pesquisas.body,'ready',Date.now());
  reads=0;
  const paged=await call('boot','/api/panel/boot','POST',{part:'main',sort:'ready',includeCounters:true,page:{ref:'all',limit:30}});
  const result=paged.payload.parts.today;
  assert.ok(result.body.page,'nenhuma fonte pode faltar silenciosamente');
  assert.deepEqual(result.body.page.counts,model.counts);
  assert.deepEqual(result.body.page.allKeys.slice().sort(),model.cases.map(entry=>entry.key).sort());
  assert.ok(result.order.length<=30);
  assert.equal(paged.payload.parts.manheim.body.summary,true);
  console.log('BOOT PAGINADO',{leiturasAntes:fullReads,leiturasDepois:reads,bytesAntes:JSON.stringify(full.payload).length,bytesDepois:JSON.stringify(paged.payload).length});
});

test('boot sem contadores mantém a fila completa, filtros, grupos e hashes; não publica contagens parciais',async()=>{
  const RealDate = Date, stamp = RealDate.now();
  global.Date = class extends RealDate { constructor(...args){super(...(args.length?args:[stamp]))} static now(){return stamp} };
  try {
    for (const options of [{sort:'ready',ref:'all'}, {sort:'recent',ref:'without'}, {sort:'ready',ref:'all',stat:'late24'}, {sort:'ready',ref:'all',query:'Carro'}]) {
      const {sort,...page}=options;
      const full=await call('boot','/api/panel/boot','POST',{part:'main',sort,page:{...page,limit:10000},includeCounters:true});
      const light=await call('boot','/api/panel/boot','POST',{part:'main',sort,page:{...page,limit:10000},includeCounters:false});
      assert.ok(full.payload.parts.today.body.page);
      assert.deepEqual(light.payload.parts.today,full.payload.parts.today);
      assert.deepEqual(light.payload.parts.completing.body.items,full.payload.parts.pesquisas.body.items);
      assert.equal(light.payload.parts.manheim,undefined);
      assert.equal(light.payload.parts.pesquisas,undefined);
    }
  } finally { global.Date=RealDate; }
});
