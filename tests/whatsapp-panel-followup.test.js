'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {normalizePhone,formatPhone}=require('../panel-phone');
const {sortItems}=require('../panel-sort');
const root=path.join(__dirname,'..');

test('US phones normalize to E.164 and display consistently',()=>{
  assert.equal(normalizePhone('(407) 555-4821'),'+14075554821');
  assert.equal(normalizePhone('+55 11 95555-1212'),'+5511955551212');
  assert.equal(formatPhone('+14075554821'),'(407) 555-4821');
});

test('server list ordering keeps missing values last in both directions',()=>{
  const items=[{id:'none'},{id:'small',budgetCents:100},{id:'large',confirmed_total_ceiling_cents:300}];
  assert.deepEqual(sortItems(items,'value_desc').map(x=>x.id),['large','small','none']);
  assert.deepEqual(sortItems(items,'value_asc').map(x=>x.id),['small','large','none']);
});

test('migration normalizes all phone inserts and creates durable ambiguity review',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260926151000_whatsapp_phone_nonlead.sql'),'utf8');
  assert.match(sql,/create trigger contact_phone_normalize/i);
  assert.match(sql,/update public\.contact_phones set phone_e164/i);
  assert.match(sql,/whatsapp_phone_reviews/);
  assert.match(sql,/reference_code/);
  assert.match(sql,/force row level security/);
});

test('panel exposes Ref and phone together and never adds attachments to the public tracking page',()=>{
  const panel=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
  const lead=fs.readFileSync(path.join(root,'painel/lead.js'),'utf8');
  const tracking=fs.readFileSync(path.join(root,'api/tracking.js'),'utf8');
  assert.match(panel,/Ref \$\{ref\} · 📞/);
  assert.match(lead,/record\.attachments/);
  assert.doesNotMatch(tracking,/attachments/);
});
