'use strict';

// Lote 2 da auditoria (AUDITORIA-PAINEL-MCS.md): ciclo de vida do lead, etapas, encerramento e reabertura.
const test = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../panel-domain');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('Lote 2 · etapas só avançam: carro apresentado → EM_BUSCA; quero/revisando → DECIDINDO; nunca volta', () => {
  const { nextStageForUnits, forwardStage } = domain;
  assert.equal(nextStageForUnits('NOVO', [{ status: 'PRESENTED' }]), 'EM_BUSCA');
  assert.equal(nextStageForUnits('RESPONDIDO', [{ status: 'ACCEPTED' }]), 'DECIDINDO');
  assert.equal(nextStageForUnits('DECIDINDO', [{ status: 'ACCEPTED' }]), 'DECIDINDO');
  assert.equal(nextStageForUnits('DECIDINDO', [{ status: 'DECLINED' }]), 'DECIDINDO');
  assert.equal(nextStageForUnits('QUALIFICADO', [{ status: 'UNDER_REVIEW' }]), 'QUALIFICADO');
  assert.equal(nextStageForUnits('RESPONDIDO', [{ status: 'WITHDRAWN' }]), 'RESPONDIDO');
  assert.equal(nextStageForUnits('NOVO', []), 'NOVO');
  assert.equal(forwardStage('EM_BUSCA', 'RESPONDIDO'), 'EM_BUSCA');
  assert.equal(forwardStage('NOVO', 'EM_BUSCA'), 'EM_BUSCA');
});

async function database() {
  const { migratedDatabase } = require('./sql/run');
  const { db } = await migratedDatabase();
  const ids = { actor: uuid(1), contact: uuid(2), chat: uuid(3) };
  await db.query(`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values($1,'preview',$2,'lote2@example.test','admin',true,false)`, [ids.actor, uuid(4)]);
  await db.query(`insert into public.contacts(id,environment,display_name,created_at,updated_at) values($1,'preview','Cliente Lote 2',now(),now())`, [ids.contact]);
  await db.query(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at) values($1,'preview','WHATSAPP',$2,'lote2','RESOLVED',now(),now())`, [ids.chat, ids.contact]);
  let n = 100;
  const journey = async (fields = {}) => {
    n += 1;
    const id = uuid(n);
    const row = { status: 'ATIVO', stage: 'NOVO', qualified_at: null, closed_at: null, closed_reason: null, stage_frozen: false, reference_code: null, next_action_at: null, next_action_text: null, ...fields };
    await db.query(`insert into public.journeys(id,environment,contact_id,source,status,stage,qualified_at,closed_at,closed_reason,stage_frozen,reference_code,next_action_at,next_action_text,created_at,updated_at)
      values($1,'preview',$2,'MANUAL',$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())`,
    [id, ids.contact, row.status, row.stage, row.qualified_at, row.closed_at, row.closed_reason, row.stage_frozen, row.reference_code, row.next_action_at, row.next_action_text]);
    for (let point = 1; point <= 6; point += 1) await db.query(`insert into public.journey_checklist(environment,journey_id,point_number,point_label,created_at,updated_at) values('preview',$1,$2,'p',now(),now())`, [id, point]);
    return id;
  };
  const state = async (id) => (await db.query(`select status,stage,stage_frozen,closed_reason,qualified_at is not null as qualified,payment_text,customer_deadline_text,next_action_text,last_effective_contact_at from public.journeys where id=$1`, [id])).rows[0];
  const toggle = (id, enabled, reason = null) => db.query(`select public.panel_set_journey_enabled('preview',$1,$2,$3,$4) as r`, [id, enabled, reason, ids.actor]).then((result) => result.rows[0].r);
  return { db, ids, journey, state, toggle };
}

test('Lote 2 · reabrir: fechada sem snapshot (Cliente deu OK antigo) volta ATIVO e mantém QUALIFICADO', async () => {
  const { db, journey, state, toggle } = await database();
  try {
    const okClosed = await journey({ status: 'ENCERRADO', stage: 'QUALIFICADO', qualified_at: '2026-09-20T12:00:00Z', closed_at: '2026-09-20T12:00:00Z', closed_reason: 'CLIENTE_DEU_OK', stage_frozen: true });
    const result = await toggle(okClosed, true);
    assert.equal(result.reopened, true);
    assert.deepEqual(await state(okClosed), { status: 'ATIVO', stage: 'QUALIFICADO', stage_frozen: false, closed_reason: null, qualified: true, payment_text: null, customer_deadline_text: null, next_action_text: null, last_effective_contact_at: null });
    // A normal off → on restores the snapshot, as before.
    const active = await journey({ stage: 'RESPONDIDO' });
    await toggle(active, false, 'GAVE_UP');
    assert.equal((await state(active)).status, 'ENCERRADO');
    const back = await toggle(active, true);
    assert.equal(back.reopened, false);
    assert.equal((await state(active)).status, 'ATIVO');
    assert.equal((await state(active)).stage, 'RESPONDIDO');
    // S9: switch on, then closed by another path (switch still "on") → switching on reopens instead of doing nothing.
    const s9 = await journey({ stage: 'RESPONDIDO' });
    await toggle(s9, false, 'NO_RESPONSE');
    await toggle(s9, true);
    await db.query(`update public.journeys set status='ENCERRADO',stage_frozen=true,closed_at=now(),closed_reason='CLOSED_BY_OPERATOR' where id=$1`, [s9]);
    assert.equal((await toggle(s9, true)).reopened, true);
    assert.equal((await state(s9)).status, 'ATIVO');
    // A ficha merged into another conversation stays closed.
    const merged = await journey({ status: 'ENCERRADO', closed_at: '2026-09-20T12:00:00Z', closed_reason: 'WHATSAPP_LINKED', stage_frozen: true });
    await assert.rejects(() => toggle(merged, true), /JOURNEY_MERGED/);
    // An active ficha without a switch row: nothing to do.
    assert.equal((await toggle(await journey(), true)).changed, false);
  } finally { await db.close(); }
});

test('Lote 2 · ficha encerrada não muda por resultado rápido, nota ou marcação; nota aceita 3mo; retorno manual futuro fica', async () => {
  const { db, ids, journey, state } = await database();
  try {
    const closed = await journey({ status: 'ENCERRADO', closed_at: '2026-09-20T12:00:00Z', closed_reason: 'DESLIGADO_DESISTIU', stage_frozen: true, reference_code: 'ABC23' });
    const quick = (id, ref, type, due = null) => db.query(`select public.panel_quick_result('preview',$1,$2,$3,$4,$5,$6) as r`, [ids.actor, ref, id, type, due, crypto.randomUUID()]);
    await assert.rejects(() => quick(closed, 'ABC23', 'DEPOSIT', '2026-10-01T12:00:00Z'), /JOURNEY_FROZEN/);
    assert.equal((await state(closed)).stage, 'NOVO');
    const note = (id, ref, items) => db.query(`select public.panel_confirm_lead_note('preview',$1,$2,$3,'nota',$4::jsonb,$5,'{}'::jsonb) as r`, [ids.actor, ref, id, JSON.stringify(items), crypto.randomUUID()]);
    await assert.rejects(() => note(closed, 'ABC23', [{ type: 'stage', value: 'QUALIFICADO' }]), /JOURNEY_FROZEN/);
    const open = await journey({ reference_code: 'ABC24', next_action_at: new Date(Date.now() + 5 * 86400000).toISOString(), next_action_text: 'Ligar sexta' });
    await note(open, 'ABC24', [{ type: 'deadline', value: '3mo' }]);
    assert.equal((await state(open)).customer_deadline_text, '3m');
    // B6: "atendeu" suggests a return in 2 days, but the manual return still in the future wins.
    await quick(open, 'ABC24', 'ANSWERED', new Date(Date.now() + 2 * 86400000).toISOString());
    assert.equal((await state(open)).next_action_text, 'Ligar sexta');
    assert.equal((await state(open)).stage, 'RESPONDIDO');
    // M6: a ficha closed later refuses a payment marked on a message (every kind, not only the ceiling).
    const message = uuid(900);
    await db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values($1,'preview',$2,'WHATSAPP','CUSTOMER','vou financiar','vou financiar',now(),'sig-l2',0,'WHATSAPP_WEBHOOK',now())`, [message, ids.chat]);
    await db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'TEST',now())`, [message, closed]);
    await assert.rejects(() => db.query(`select public.panel_mark_message_fact_v2(p_environment => 'preview', p_journey_id => $1, p_message_id => $2, p_kind => 'PAYMENT', p_actor_id => $3, p_value => 'financiado') as r`, [closed, message, ids.actor]), /JOURNEY_CLOSED/);
    assert.equal((await state(closed)).payment_text, null);
    // The V1 (writes the ceiling into budget_cents) can no longer be called by the server role.
    const privilege = (await db.query(`select has_function_privilege('service_role','public.panel_mark_message_fact(public.panel_environment,uuid,uuid,text,uuid,text,jsonb,timestamptz,boolean)','execute') as ok`)).rows[0].ok;
    assert.equal(privilege, false);
  } finally { await db.close(); }
});

test('Lote 2 · contato efetivo nunca rebaixa a etapa; "quero o carro" leva a DECIDINDO', async () => {
  const { db, ids, journey, state } = await database();
  try {
    const answered = await journey({ stage: 'RESPONDIDO' });
    await db.query(`select public.panel_refresh_effective_mcs('preview',$1)`, [answered]);
    assert.equal((await state(answered)).stage, 'RESPONDIDO');
    // An answered call counts as effective contact.
    await db.query(`insert into public.interactions(environment,journey_id,type,occurred_at,created_at,created_by) values('preview',$1,'CALL_ANSWERED','2026-09-27T15:00:00Z',now(),$2)`, [answered, ids.actor]);
    await db.query(`select public.panel_refresh_effective_mcs('preview',$1)`, [answered]);
    assert.equal(new Date((await state(answered)).last_effective_contact_at).toISOString(), '2026-09-27T15:00:00.000Z');
    const want = async (stage, qualified) => {
      const id = await journey({ stage, qualified_at: qualified ? '2026-09-20T12:00:00Z' : null, reference_code: stage === 'QUALIFICADO' ? 'QWE23' : 'QWE24' });
      const code = 'x'.repeat(21) + (stage === 'QUALIFICADO' ? 'q' : 'e');
      await db.query(`insert into public.lead_tracking(environment,ref_code,journey_id,public_code) values('preview',$1,$2,$3)`, [stage === 'QUALIFICADO' ? 'QWE23' : 'QWE24', id, code]);
      const unit = (await db.query(`insert into public.units(environment,journey_id,vehicle_text,presented_at,status) values('preview',$1,'2022 BMW X5',now(),'PRESENTED') returning id`, [id])).rows[0].id;
      await db.query(`select public.panel_customer_unit_response('preview',$1,$2,'WANT')`, [code, unit]);
      return (await state(id)).stage;
    };
    assert.equal(await want('EM_BUSCA', false), 'DECIDINDO');
    assert.equal(await want('QUALIFICADO', true), 'QUALIFICADO');
  } finally { await db.close(); }
});
