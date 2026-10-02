'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
const stage=require('../panel-search-stage');

test('search identity is stable for peers and only complete wishes enter BUSCAS',()=>{
  const wish={make:'Porsche',model:'Cayenne',yearMin:2018};
  assert.equal(stage.searchKey(wish),stage.searchKey({make:'porsche',model:'Cayenne'}));
  assert.equal(stage.searchableWish([{make:'Porsche',model:''}]),null);
  // The work stage never says "Falta buscar" (that is the result in the batch, shown apart).
  assert.equal(stage.stageLabel('MISSING'),'🔍 Busca não salva no Manheim');
  assert.equal(stage.stageLabel('SAVED'),'💾 Busca salva no Manheim');
  assert.equal(stage.stageLabel('SENT'),'📤 Opções enviadas');
});

test('BUSCAS uses contact facts, excludes inactive or incomplete leads, and propagates saved marks by search key',()=>{
  const api=read('api/panel/searches.js');
  assert.match(api,/if \(!facts\.entered\) return/);
  // Lote 3: active, not paused, not discarded; the saved mark follows the same search identity
  // (criteria / value) as "Quais buscas salvar".
  assert.match(api,/!activeStatus\(journey, disabled\) \|\| journey\.status === 'PARADO'/);
  // buscas-split: the saved mark follows the identity of ONE mode (VALOR or CARRO).
  assert.match(api,/entry\.modes\?\.\[mode\]\?\.searchKey === key/);
  assert.match(api,/kind==='SAVED'/);
  assert.match(api,/logical_mode: 'eq\.' \+ mode/);
});

test('stage source recognizes automatic saved and sent states plus manual marks and undo',()=>{
  const source=read('panel-search-stage.js'),migration=read('supabase/migrations/20260927070000_panel_etapa5_search_help_attachment.sql');
  assert.match(source,/manheim_saved_searches/);
  assert.match(source,/event_type: 'eq\.CAR_PRESENTED'/);
  // A11 (Lote 2): any unit not withdrawn keeps the badge at "sent".
  assert.match(source,/status: 'neq\.WITHDRAWN'/);
  assert.match(source,/panel_search_marks/);
  assert.match(migration,/kind text not null check \(kind in \('SAVED','SENT'\)\)/);
  assert.match(migration,/undone_at timestamptz/);
});

test('every card route decorates the same deterministic search-stage index',()=>{
  for(const file of ['api/panel/today.js','api/panel/orders.js','api/panel/qualification.js','api/panel/records.js','api/panel/search.js','api/panel/pendencias.js']){
    assert.match(read(file),/decorateWithSearchStage/,'missing stage decoration in '+file);
  }
  assert.match(read('painel/painel.js'),/searchStageLabel/);
  assert.match(read('painel/lead.js'),/data\.searchStage/);
});

test('lead help reserves an Anthropic call, limits context, persists history, and has safe failures',()=>{
  const api=read('api/panel/lead-help.js'),client=read('painel/lead.js');
  assert.match(api,/await reserveCall\(ctx\)/);
  assert.match(api,/aiContextWindow/);
  assert.match(api,/slice\(0, 8\)/);
  assert.match(api,/lead_ai_help/);
  assert.match(api,/AI_DAILY_LIMIT/);
  assert.match(client,/Não consegui responder agora, tente mais tarde/);
  assert.match(client,/Histórico de ajuda deste lead/);
});

test('note distribution uses reserveCall and never silently changes the configured model',()=>{
  const source=read('api/panel/notes/distribute.js');
  assert.match(source,/await reserveCall\(ctx\)/);
  assert.doesNotMatch(source,/claude-sonnet-5/);
  assert.match(source,/DISTRIBUTION_UNAVAILABLE/);
});

test('automatic attachment resolves and saves without a manual target choice',()=>{
  const client=read('painel/painel.js'),api=read('api/panel/sms-print.js');
  assert.match(client,/handleAutoPrintRead/);
  assert.match(client,/auto:true/);
  assert.match(api,/automaticTarget/);
  assert.match(api,/matchedBy:'ref'/);
  assert.match(api,/matchedBy:'telefone'/);
  assert.match(api,/matchedBy:'nome'/);
  assert.match(api,/body\.action==='photo'/);
  assert.match(api,/panel_sms_print_attach_photo/);
});

test('automatic attachment can remove and replace a selected file without choosing a lead',()=>{
  const html=read('painel/index.html'),client=read('painel/painel.js');
  assert.match(html,/id="auto-print-remove"/);
  assert.match(client,/function clearAutoPrint/);
  assert.match(client,/input\.value=''/);
  assert.match(client,/auto-print-send'\)\.disabled=!files\.length/);
  assert.doesNotMatch(html,/attachment-contact-select|attachment-order-select/);
});

test('undo is additive: it retires only created phone data and filters effective rows without storage deletion',()=>{
  const migration=read('supabase/migrations/20260927070000_panel_etapa5_search_help_attachment.sql'),api=read('api/panel/sms-print.js');
  assert.match(migration,/create or replace function public\.panel_sms_print_undo/);
  assert.match(migration,/created_phone_id/);
  assert.match(migration,/prior_primary_phone_id/);
  assert.match(migration,/set undone_at=at_time/);
  assert.match(migration,/status='UNDONE'/);
  assert.doesNotMatch(api.match(/if\(body\.action==='discard'\)[\s\S]*?return send\(res,200,\{discarded:true\}\);/)[0],/method:'DELETE'/);
  for(const file of ['panel-read-model.js','panel-capture.js','api/panel/records.js','api/panel/search.js','panel-buscas.js']) assert.match(read(file),/undone_at/);
});

test('manual fallback keeps the quarantined print and retry does not re-upload it',()=>{
  const client=read('painel/painel.js'),api=read('api/panel/sms-print.js');
  assert.match(client,/Não consegui ler agora, tente mais tarde/);
  assert.match(client,/action:'retry',readId:result\.read\.id/);
  assert.doesNotMatch(client,/\.then\(\(\)=>sendAutoPrint\(\)\)/);
  assert.match(api,/status:'DISCARDED'/);
});
