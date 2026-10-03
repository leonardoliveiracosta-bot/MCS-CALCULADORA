'use strict';

// Telefone igual, nome diferente: a simulação ligada a uma ficha de outro chat aparece para "Confirmar vínculo" com os
// dois lados; nada é desfeito sem a decisão; "é a mesma pessoa" encerra a revisão; "não é" tira só esta simulação
// (e a Ref que veio com ela) e cria a ficha própria. Banco PGlite local com todas as migrações; nada sai da máquina.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migratedDatabase } = require('./sql/run');
const phoneLink = require('../panel-phone-link');
const { fromCandidate } = require('../panel-name-link');

const id = (n) => `7d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const CALC = (name, ref) => `Hello! I just ran a simulation on the My Car Scout calculator\n\nName: ${name}\nVehicle: Chevrolet Corvette\nMaximum bid: $72,000\n\nRef: ${ref}`;
let db;

async function person({ n, contactName, refCode, whatsName = null, smsName, smsRef }) {
  const contact = id(n + 1), journey = id(n), wa = id(n + 2), sms = id(n + 3);
  await db.exec(`
    insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${contactName}','WHATSAPP_DIRECT',now(),now());
    insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,created_at) values('preview','${contact}','+1872364${String(n).padStart(4, '0')}','x',true,true,now());
    insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,reference_code,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','NOVO','ATIVO','{}','${refCode}',now()-interval '8 days',now());
    insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values
      ('${wa}','preview','WHATSAPP','${contact}','wa-${n}','RESOLVED',false,now(),now(),now(),now()),('${sms}','preview','SMS','${contact}','sms-${n}','RESOLVED',false,now(),now(),now(),now());
    insert into public.journey_refs(environment,journey_id,ref_code,created_at) values('preview','${journey}','${smsRef}',now());
  `);
  const add = async (m, chat, channel, text, minutes) => {
    await db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
      values($1,'preview',$2,$3,'CUSTOMER',$4,'x',now()-($5||' minutes')::interval,$6,1,'IMPORT',now())`, [id(m), chat, channel, text, String(minutes), 's' + m]);
    await db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'SMS_PRINT',now())`, [id(m), journey]);
  };
  await add(n + 10, wa, 'WHATSAPP', whatsName ? CALC(whatsName, refCode) : 'Ok cool', 8 * 24 * 60);
  await add(n + 11, sms, 'SMS', CALC(smsName, smsRef), 18);
  return { journey, contact, simulation: id(n + 11) };
}

const reviews = async () => (await db.query(`select * from public.panel_name_link_candidates('preview')`)).rows
  .filter((row) => !phoneLink.namesAgree(row.message_name, [row.contact_name, ...(row.other_names || [])])).map(fromCandidate);

test.before(async () => {
  ({ db } = await migratedDatabase());
  await db.exec(`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','${id(900)}','a@example.test','admin',true,false);`);
});
test.after(async () => { if (db) await db.close(); });

test('simulação por SMS numa ficha do WhatsApp sem nome, ou com outro nome, vira "Confirmar vínculo" com os dois lados', async () => {
  const dante = await person({ n: 100, contactName: '+18723640049', refCode: 'CWZWK', smsName: 'Dante', smsRef: 'NTHQS' });
  await person({ n: 200, contactName: 'Flava', refCode: 'FD7VJ', smsName: 'Andrew', smsRef: 'QRSTU' });
  await person({ n: 300, contactName: 'Tyreek Eazy Thompson', refCode: 'CF3CM', whatsName: 'Tyreek Thompson', smsName: 'Tyreek Thompson', smsRef: 'VWXYZ' });
  const list = await reviews();
  const names = list.map((entry) => entry.simulation.name).sort();
  assert.deepEqual(names, ['Andrew', 'Dante'], 'Tyreek tem o mesmo nome dos dois lados: não entra');
  const one = list.find((entry) => entry.simulation.name === 'Dante');
  assert.equal(one.state, 'JUNTO');
  assert.equal(one.journeyId, dante.journey);
  assert.equal(one.simulation.channel, 'SMS');
  assert.equal(one.ficha.channel, 'WHATSAPP');
  assert.deepEqual(one.ficha.names, [], 'um telefone salvo como nome não é nome');
  assert.equal(one.ref, 'CWZWK');
  // Nada foi desfeito: a simulação continua na ficha.
  const linked = (await db.query(`select count(*)::int n from public.message_journeys where message_id=$1 and journey_id=$2 and undone_at is null`, [dante.simulation, dante.journey])).rows[0].n;
  assert.equal(linked, 1);
});

test('"é a mesma pessoa" encerra a revisão sem mexer no vínculo', async () => {
  const andrew = (await reviews()).find((entry) => entry.simulation.name === 'Andrew');
  const result = (await db.query(`select public.panel_name_link_decide('preview',$1,$2,'CONFIRMED',$3,3) r`, [andrew.messageId, andrew.journeyId, ACTOR])).rows[0].r;
  assert.equal(result.decision, 'CONFIRMED');
  assert.ok(!(await reviews()).some((entry) => entry.simulation.name === 'Andrew'));
  const linked = (await db.query(`select count(*)::int n from public.message_journeys where message_id=$1 and journey_id=$2 and undone_at is null`, [andrew.messageId, andrew.journeyId])).rows[0].n;
  assert.equal(linked, 1);
});

test('"não é a mesma pessoa" tira só esta simulação e a Ref dela, e cria a ficha própria', async () => {
  const dante = (await reviews()).find((entry) => entry.simulation.name === 'Dante');
  const result = (await db.query(`select public.panel_name_link_decide('preview',$1,$2,'SEPARATED',$3,3) r`, [dante.messageId, dante.journeyId, ACTOR])).rows[0].r;
  assert.equal(result.decision, 'SEPARATED');
  assert.ok(result.newJourneyId && result.newJourneyId !== dante.journeyId);
  const links = (await db.query(`select journey_id from public.message_journeys where message_id=$1 and undone_at is null`, [dante.messageId])).rows.map((row) => row.journey_id);
  assert.deepEqual(links, [result.newJourneyId]);
  const created = (await db.query(`select reference_code from public.journeys where id=$1`, [result.newJourneyId])).rows[0];
  assert.equal(created.reference_code, 'NTHQS', 'a Ref da simulação vai com ela');
  const oldRefs = (await db.query(`select ref_code from public.journey_refs where journey_id=$1`, [dante.journeyId])).rows.map((row) => row.ref_code);
  assert.ok(!oldRefs.includes('NTHQS'));
  const oldCode = (await db.query(`select reference_code from public.journeys where id=$1`, [dante.journeyId])).rows[0].reference_code;
  assert.equal(oldCode, 'CWZWK', 'o código da ficha original não muda');
  // The WhatsApp conversation stays in the original ficha.
  const rest = (await db.query(`select count(*)::int n from public.message_journeys where journey_id=$1 and undone_at is null`, [dante.journeyId])).rows[0].n;
  assert.equal(rest, 1);
  assert.ok(!(await reviews()).some((entry) => entry.simulation.name === 'Dante'));
});

test('nomes conhecidos da ficha: contato e mensagens da calculadora, e os chats dela', async () => {
  const rows = (await db.query(`select * from public.panel_journey_names('preview',$1::uuid[])`, [[id(300)]])).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].calc_names, ['Tyreek Thompson']);
  assert.equal(rows[0].chat_ids.length, 2);
  assert.ok(rows[0].last_channel);
});

test('na fila (vínculo automático desfeito): "é a mesma pessoa" junta de novo, sem duplicar a linha', async () => {
  const p = await person({ n: 400, contactName: 'Flavia', refCode: 'HJKLM', smsName: 'Bruno', smsRef: 'NPQRS' });
  await db.query(`update public.message_journeys set undone_at=now() where message_id=$1`, [p.simulation]);
  await db.query(`select public.panel_name_link_decide('preview',$1,$2,'CONFIRMED',$3,3)`, [p.simulation, p.journey, ACTOR]);
  const rows = (await db.query(`select undone_at, association_source from public.message_journeys where message_id=$1 and journey_id=$2`, [p.simulation, p.journey])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].undone_at, null);
  assert.equal(rows[0].association_source, 'CALC_ROUTE_MANUAL');
});
