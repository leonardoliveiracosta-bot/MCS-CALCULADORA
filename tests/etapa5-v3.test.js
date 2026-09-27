'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('confirm function repair is additive and does not edit the original SMS migration', () => {
  assert.match(read('supabase/migrations/20260927080000_fix_sms_print_confirm_ref_alias.sql'), /journey_row/);
  assert.match(read('supabase/migrations/20260927080100_fix_automatic_message_trigger_digest.sql'), /extensions\.digest/);
});

test('storage destination and attachment id are persisted only after a successful move', () => {
  const api = read('api/panel/sms-print.js');
  assert.match(api, /await supabase[\s\S]*\/storage\/v1\/object\/move[\s\S]*await patchRows/);
  assert.match(api, /SMS_PRINT_STORAGE_MOVE_FAILED/);
  assert.match(api, /record\.storage_path&&isUuid\(record\.attachment_id\)/);
});

test('automatic resolution follows ref, source, calculator ref, phone, exact name, then a new lead', () => {
  const api = read('api/panel/sms-print.js');
  const body = api.slice(api.indexOf('async function automaticTarget'), api.indexOf('async function read'));
  for (const token of ['refTarget', 'record.source_journey_id', 'orders(ctx', 'contact_phones', "display_name:'eq.'+name", "matchedBy:'novo'"]) assert.match(body, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('multiple image selection, direct iPhone labels, duplicate guard, and no per-card status request are present', () => {
  const panel = read('painel/painel.js'), html = read('painel/index.html'), stage = read('panel-search-stage.js');
  assert.match(html, /id="auto-print-file"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.match(panel, /input\.multiple=true/);
  assert.match(panel, /for\(const file of files\)/);
  assert.doesNotMatch(panel, /\/api\/panel\/sms-print\?journeyId=/);
  assert.match(stage, /smsPrintConfirmed/);
  assert.match(read('api/panel/sms-print.js'), /sha256:'eq\.'\+record\.sha256/);
});

test('each selected print keeps its own result and a duplicate only opens the original lead', () => {
  const panel = read('painel/painel.js'), api = read('api/panel/sms-print.js');
  assert.match(panel, /function autoPrintResult\(filename,text,saved\)/);
  assert.match(panel, /\$\{filename\|\|'Print'\} — \$\{text\}/);
  assert.match(panel, /if\(!saved\.duplicate\)\{const undo=/);
  assert.match(api, /async function duplicateResult/);
  assert.match(api, /name:contact\?\.display_name\|\|null/);
});

test('multiple upload status advances, finishes, and clears only the selected files', () => {
  const panel = read('painel/painel.js');
  assert.match(panel, /\$\{index\+1\} de \$\{files\.length\}…/);
  assert.match(panel, /\$\{files\.length\} de \$\{files\.length\} prontos/);
  assert.match(panel, /\$\('auto-print-file'\)\.value=''/);
  assert.match(panel, /let failures=0/);
});
