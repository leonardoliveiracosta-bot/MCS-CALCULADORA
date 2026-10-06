'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'painel/index.html'),'utf8');
const js=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
const css=fs.readFileSync(path.join(root,'painel/tema-mcs.css'),'utf8');

test('painel publica seis abas (V1 e V2 do funil; TODOS removida, conteúdo em "Mais" de ATENDER AGORA) e mantém os ids legados',()=>{
  const tabs=[...html.matchAll(/class="tab(?: active)?"[^>]+data-view="([^"]+)"/g)].map((match)=>match[1]);
  assert.deepEqual(tabs,['today','v1','v2','requests','searches','imports']);
  // 4bf9aec (#163): as abas ATENDIMENTO e CLIENTES viraram ATENDER AGORA e TODOS.
  assert.match(html,/data-view="today"[^>]*>TODOS/);
  // TODOS deixou de ser aba: a lista, a planilha, retomar conversas e pendências gerais ficam no bloco "Mais" de ATENDER AGORA.
  assert.doesNotMatch(html,/data-view="clients"/);
  assert.match(html,/<details id="today-more"[\s\S]*id="clients-download"[\s\S]*id="clients-general-card"[\s\S]*id="clients-followup"[\s\S]*id="clients-list"[\s\S]*<\/details>/);
  assert.ok(html.indexOf('id="today-panel"')<html.indexOf('id="today-more"')&&html.indexOf('id="today-more"')<html.indexOf('id="settings-panel"'));
  assert.match(html,/data-view="requests">BUSCAR CARROS/);
  assert.match(html,/data-view="searches">ENVIAR OPÇÕES/);
  // Configurações e conexão: área secundária, fora das abas principais.
  assert.match(html,/class="quiet small settings-link" type="button" data-view="settings"/);
  // Old links to PEDIDOS and ENTRADA open ATENDIMENTO; the order detail keeps its own address.
  assert.match(js,/if \(view === 'orders' \|\| view === 'entry'\) view = 'today';/);
  assert.match(js,/pedidos:'entry'/);
  assert.match(js,/#pedido\//);
  for(const id of ['pending-panel','pending-list','manheim-results'])assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/fichas:'today',qualificacao:'today',pendencias:'today',clientes:'today',todos:'today'/);
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
  // The situation (and whether it is resolved) is computed by the server for every listed client.
  assert.match(records,/resolved:Boolean\(resolution&&resolution\.resolved_message_id===chat\.message_id\)/);
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
