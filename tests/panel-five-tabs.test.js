'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'painel/index.html'),'utf8');
const js=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');

test('painel publica exatamente cinco abas e mantém os ids legados',()=>{
  const tabs=[...html.matchAll(/class="tab(?: active)?"[^>]+data-view="([^"]+)"/g)].map((match)=>match[1]);
  assert.deepEqual(tabs,['today','entry','clients','orders','searches']);
  for(const id of ['pending-panel','qualification-panel','records-panel','manheim-panel','pending-list','qualification-list','records-list','manheim-results'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/fichas:'clients'.*qualificacao:'clients'.*pendencias:'clients'/);
  assert.match(js,/manheim:'searches'.*buscas:'searches'/);
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
});

test('migrações aditivas guardam leitura e motivo sem remover dados',()=>{
  const receipts=fs.readFileSync(path.join(root,'supabase/migrations/20260927120000_whatsapp_message_receipts.sql'),'utf8');
  const reasons=fs.readFileSync(path.join(root,'supabase/migrations/20260927121000_panel_discard_reason.sql'),'utf8');
  assert.match(receipts,/add column if not exists whatsapp_read_at/);
  assert.match(receipts,/panel_whatsapp_apply_status/);
  assert.match(reasons,/add column if not exists discard_reason/);
  assert.doesNotMatch(receipts+reasons,/\b(delete|truncate)\b/i);
});
