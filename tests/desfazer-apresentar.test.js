'use strict';

// Desfazer "Registrar que apresentei" pela API do painel (presentUndo), sobre o banco simulado
// (PGlite + PostgREST): volta etapa, início da busca e acompanhamento, solta a opção do Manheim,
// tira a unidade e o evento; só quem fez, em 30 minutos, sem resposta do cliente. Nada é enviado.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { presentUndo } = require('../api/panel/actions');

const id = (n) => `7f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), OTHER = id(2), JOURNEY = id(10), UPLOAD = id(30);
let backend, ctx;
const one = async (sql, args = []) => (await backend.db.query(sql, args)).rows[0];

test.before(async () => {
  backend = await createBackend({ seed: `
    insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values
      ('${ACTOR}','preview','${id(901)}','a@example.test','admin',true,false),('${OTHER}','preview','${id(902)}','b@example.test','admin',true,false);
    insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(11)}','preview','Pessoa fictícia','WHATSAPP_DIRECT',now(),now());
    insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${id(11)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());
    insert into public.lead_tracking(environment,ref_code,journey_id,public_code,step) values('preview','ABCDE','${JOURNEY}','codigo-publico-de-teste-0002',2);
    insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) values('${UPLOAD}','preview',1,1,'${ACTOR}');` });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: ACTOR, role: 'admin' } };
});
test.after(async () => { if (backend) await backend.db.close(); });

async function present(extra = {}) {
  const unit = (await one(`insert into public.units(environment,journey_id,vehicle_text,presented_at,status,created_by${extra.columns || ''}) values('preview',$1,'2020 Toyota Camry',now(),'PRESENTED',$2${extra.values || ''}) returning id`, [JOURNEY, ACTOR])).id;
  await backend.db.query(`insert into public.lead_events(environment,ref_code,journey_id,unit_id,event_type,created_by) values('preview','ABCDE',$1,$2,'CAR_PRESENTED',$3)`, [JOURNEY, unit, ACTOR]);
  await backend.db.query(`update public.journeys set stage='EM_BUSCA',search_started_at=now() where id=$1`, [JOURNEY]);
  await backend.db.query(`update public.lead_tracking set step=2 where ref_code='ABCDE'`);
  return unit;
}
const previous = { previousStage: 'RESPONDIDO', previousSearchStartedAt: null, ref: 'ABCDE', previousTrackingStep: 1 };

test('desfazer volta etapa, início da busca e acompanhamento; tira unidade e evento; solta a opção', async () => {
  const unit = await present();
  const match = await one(`insert into public.manheim_matches(environment,upload_id,journey_id,match_kind,row_fingerprint,vehicle_json,presented_unit_id) values('preview',$1,$2,'BATE','fp-desfazer','{}',$3) returning id`, [UPLOAD, JOURNEY, unit]);
  const journey = { id: JOURNEY, contact_id: id(11) };
  // Someone else never undoes it.
  await assert.rejects(presentUndo({ ...ctx, panel: { id: OTHER } }, journey, unit, previous), { code: 'UNDO_NOT_ALLOWED' });
  const result = await presentUndo(ctx, journey, unit, previous);
  assert.deepEqual(result, { undone: true, unitId: unit, stageRestored: true });
  const after = await one('select stage,search_started_at from public.journeys where id=$1', [JOURNEY]);
  assert.equal(after.stage, 'RESPONDIDO');
  assert.equal(after.search_started_at, null);
  assert.equal((await one(`select step from public.lead_tracking where ref_code='ABCDE'`)).step, 1);
  assert.equal(Number((await one('select count(*) n from public.units where id=$1', [unit])).n), 0);
  assert.equal(Number((await one('select count(*) n from public.lead_events where unit_id=$1', [unit])).n), 0);
  assert.equal((await one('select presented_unit_id from public.manheim_matches where id=$1', [match.id])).presented_unit_id, null);
});

test('com resposta do cliente, depois de 30 minutos ou com outro evento, não desfaz nada', async () => {
  const journey = { id: JOURNEY, contact_id: id(11) };
  const answered = await present({ columns: ',last_customer_response_at', values: ',now()' });
  await assert.rejects(presentUndo(ctx, journey, answered, previous), { code: 'UNIT_HAS_RESPONSE' });
  const old = await present({ columns: ',created_at', values: ",now()-interval '2 hours'" });
  await assert.rejects(presentUndo(ctx, journey, old, previous), { code: 'UNDO_EXPIRED' });
  const used = await present();
  await backend.db.query(`insert into public.lead_events(environment,ref_code,journey_id,unit_id,event_type,created_by) values('preview','ABCDE',$1,$2,'WANT_CAR',$3)`, [JOURNEY, used, ACTOR]);
  await assert.rejects(presentUndo(ctx, journey, used, previous), { code: 'UNIT_IN_USE' });
  for (const unit of [answered, old, used]) assert.equal(Number((await one('select count(*) n from public.units where id=$1', [unit])).n), 1, 'nada apagado');
  // With other cars still presented, the stage stays (the other units justify it).
  const last = await present();
  const result = await presentUndo(ctx, journey, last, previous);
  assert.equal(result.stageRestored, false);
  assert.equal((await one('select stage from public.journeys where id=$1', [JOURNEY])).stage, 'EM_BUSCA');
});

test('cliente responde no meio do desfazer: evento e opção voltam como estavam; nada se perde', async () => {
  const journey = { id: JOURNEY, contact_id: id(11) };
  const unit = await present();
  const match = await one(`insert into public.manheim_matches(environment,upload_id,journey_id,match_kind,row_fingerprint,vehicle_json,presented_unit_id) values('preview',$1,$2,'BATE','fp-corrida','{}',$3) returning id`, [UPLOAD, JOURNEY, unit]);
  const remove = async (table, filters) => {
    // The customer's answer lands right before the unit is removed.
    if (table === 'units') await backend.db.query('update public.units set last_customer_response_at=now() where id=$1', [unit]);
    return backend.fetch(`${BASE}/rest/v1/${table}?${new URLSearchParams(filters)}`, { method: 'DELETE', headers: { prefer: 'return=representation' } }).then((response) => response.json());
  };
  await assert.rejects(presentUndo(ctx, journey, unit, previous, { remove }), { code: 'UNIT_HAS_RESPONSE' });
  assert.equal(Number((await one('select count(*) n from public.units where id=$1', [unit])).n), 1);
  assert.equal(Number((await one(`select count(*) n from public.lead_events where unit_id=$1 and event_type='CAR_PRESENTED'`, [unit])).n), 1, 'evento de volta');
  assert.equal((await one('select presented_unit_id from public.manheim_matches where id=$1', [match.id])).presented_unit_id, unit, 'opção ligada de novo');
});
