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
  // R2: value = maximum bid. A total ceiling alone is not a bid, so it sorts with the unknowns.
  const items=[{id:'none'},{id:'small',budgetCents:100},{id:'large',budget_cents:300},{id:'ceilingOnly',confirmed_total_ceiling_cents:900}];
  const desc=sortItems(items,'value_desc').map(x=>x.id),asc=sortItems(items,'value_asc').map(x=>x.id);
  assert.deepEqual(desc.slice(0,2),['large','small']);assert.deepEqual(new Set(desc.slice(2)),new Set(['none','ceilingOnly']));
  assert.deepEqual(asc.slice(0,2),['small','large']);assert.deepEqual(new Set(asc.slice(2)),new Set(['none','ceilingOnly']));
});

test('server list ordering supports stable name and Ref modes',()=>{
  const items=[{id:'2',contact:{display_name:'Álvaro'},reference_code:'B2222'},{id:'1',contact:{display_name:'Bruno'},reference_code:'A1111'},{id:'3'}];
  assert.deepEqual(sortItems(items,'name').map(x=>x.id),['2','1','3']);
  assert.deepEqual(sortItems(items,'ref').map(x=>x.id),['1','2','3']);
});

test('migration normalizes all phone inserts and creates durable ambiguity review',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260926151000_whatsapp_phone_nonlead.sql'),'utf8');
  assert.match(sql,/create trigger contact_phone_normalize/i);
  assert.match(sql,/update public\.contact_phones set phone_e164/i);
  assert.match(sql,/whatsapp_phone_reviews/);
  assert.match(sql,/reference_code/);
  assert.match(sql,/force row level security/);
});

test('follow-up migration scopes primary-phone updates and count to real columns',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260926170000_whatsapp_phone_integrity.sql'),'utf8');
  assert.match(sql,/count\(distinct cp\.contact_id\)/);
  assert.match(sql,/where cp\.environment=p_environment and cp\.contact_id=contact_id/);
  assert.doesNotMatch(sql,/count\(distinct contact_id\)/);
  assert.doesNotMatch(sql,/where environment=p_environment and contact_id=contact_id/);
  assert.match(sql,/contact_phones_one_active_primary_idx/);
});

test('panel exposes Ref and phone together and never adds attachments to the public tracking page',()=>{
  const panel=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
  const lead=fs.readFileSync(path.join(root,'painel/lead.js'),'utf8');
  const tracking=fs.readFileSync(path.join(root,'api/tracking.js'),'utf8');
  assert.match(panel,/Ref \$\{ref\} · 📞/);
  assert.match(lead,/record\.attachments/);
  assert.doesNotMatch(tracking,/attachments/);
});
