'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'painel/index.html'),'utf8');
const js=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
const css=fs.readFileSync(path.join(root,'painel/tema-mcs.css'),'utf8');

test('painel publica seis abas (PEDIDOS fundido em ENTRADA e CLIENTES) e mantém os ids legados',()=>{
  const tabs=[...html.matchAll(/class="tab(?: active)?"[^>]+data-view="([^"]+)"/g)].map((match)=>match[1]);
  assert.deepEqual(tabs,['today','entry','clients','requests','searches','imports']);
  // Lote 4: old links to PEDIDOS open ENTRADA; the order detail keeps its own address.
  assert.match(js,/if \(view === 'orders'\) view = 'entry';/);
  assert.match(js,/pedidos:'entry'/);
  assert.match(js,/#pedido\//);
  for(const id of ['pending-panel','qualification-panel','records-panel','manheim-panel','pending-list','qualification-list','records-list','manheim-results'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/fichas:'clients'.*qualificacao:'clients'.*pendencias:'clients'/);
  assert.match(js,/manheim:'imports'.*buscas:'searches'/);
});

test('Ref, próximo passo e motivo da perda usam ação imediata e persistência local',()=>{
  assert.match(js,/mcs_today_ref_filter/);
  assert.match(js,/function nextActionNode[\s\S]*MCSAction\.bind/);
  assert.match(js,/const DISCARD_REASONS=.*PRICE:'Preço'.*DISAPPEARED:'Sumiu'/);
  assert.match(js,/set_disposition[\s\S]*reason/);
});

test('login usa somente a imagem local e sai do modo fotográfico ao abrir o app',()=>{
  assert.ok(fs.existsSync(path.join(root,'painel/login-fundo.jpg')));
  assert.match(html,/<body class="login-screen">/);
  assert.match(js,/document\.body\.classList\.toggle\('login-screen', id === 'login-view'\)/);
  assert.match(css,/login-screen #login-view \.eyebrow \{ color: #C9A34E; \}/);
  assert.match(css,/login-screen #login-view h1,[\s\S]*color: #F2EFE9/);
});

test('CLIENTES preserva resolvidos, não leads e exporta a própria lista filtrada',()=>{
  const records=fs.readFileSync(path.join(root,'api/panel/records.js'),'utf8');
  const pending=fs.readFileSync(path.join(root,'api/panel/pendencias.js'),'utf8');
  assert.match(js,/includeResolved=true/);
  assert.match(js,/Restaurar pendência/);
  assert.match(js,/Restaurar lead/);
  assert.match(js,/function downloadClientsCsv/);
  assert.doesNotMatch(js,/clients-download'[\s\S]{0,180}downloadPendingCsv/);
  assert.match(records,/isLead:complete\.contact\?\.is_lead!==false/);
  assert.match(pending,/includeResolved\|\|!item\.resolved/);
});

test('cartões da HOJE e CLIENTES não esticam nem distribuem espaço interno',()=>{
  assert.match(css,/\.today-card,[\s\S]*\.client-card \{[\s\S]*align-self: start;[\s\S]*align-content: start;[\s\S]*gap: 10px/);
});

test('migrações aditivas guardam leitura e motivo sem remover dados',()=>{
  const receipts=fs.readFileSync(path.join(root,'supabase/migrations/20260927120000_whatsapp_message_receipts.sql'),'utf8');
  const reasons=fs.readFileSync(path.join(root,'supabase/migrations/20260927121000_panel_discard_reason.sql'),'utf8');
  assert.match(receipts,/add column if not exists whatsapp_read_at/);
  assert.match(receipts,/panel_whatsapp_apply_status/);
  assert.match(reasons,/add column if not exists discard_reason/);
  assert.doesNotMatch(receipts+reasons,/\b(delete|truncate)\b/i);
});
