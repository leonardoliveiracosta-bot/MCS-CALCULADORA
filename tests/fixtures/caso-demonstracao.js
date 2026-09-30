'use strict';

// Caso fictício completo para testes e demonstração do contexto do cliente: pedido da calculadora
// (Ref DMCRA, por valor), conversa de WhatsApp com a Ref, leitura da conversa (pedido extraído com
// as mensagens de origem), ficha em busca e, à parte, os casos que não podem ser ligados com
// segurança (contato com duas fichas, Ref em duas fichas, Ref sem ficha). Nenhum dado real.
const id = (n) => `6c100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const IDS = {
  ACTOR,
  CONTACT: id(10), JOURNEY: id(11), CHAT: id(12), RUN: id(13), REQUEST: id(14), VERSION: id(15),
  MSG1: id(21), MSG2: id(22), MSG3: id(23), MSG4: id(24),
  TWIN_CONTACT: id(30), TWIN_A: id(31), TWIN_B: id(32),
  SHARED_A: id(40), SHARED_B: id(41), SHARED_CONTACT_A: id(42), SHARED_CONTACT_B: id(43)
};
const REF = 'DMCRA', SHARED_REF = 'SHRAB', LOOSE_REF = 'NLNKA';
const HOUR = 3600 * 1000;
const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();
const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const json = (value) => q(JSON.stringify(value)) + '::jsonb';

function calcRun(n, data, hoursAgo) {
  return `insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados,is_test) values(${q(at(hoursAgo))},${q(data.zip || '')},${q(data.estado || '')},${data.lance || 'null'},${data.pagamento ? q(data.pagamento) : 'null'},${json({ quando: at(hoursAgo), ...data })},false);`;
}
const message = (msgId, direction, text, hoursAgo) => `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${msgId}','preview','${IDS.CHAT}','WHATSAPP','${direction}',${q(text)},'x',${q(at(hoursAgo))},${q('s' + msgId)},1,'WHATSAPP_WEBHOOK',${q(at(hoursAgo))});
insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${msgId}','${IDS.JOURNEY}','IMPORT',now());`;
const contact = (contactId, name) => `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contactId}','preview',${q(name)},'WHATSAPP_DIRECT',now(),now());`;
const journey = (journeyId, contactId, extra = {}) => `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,reference_code,vehicle_text,created_at,updated_at) values('${journeyId}','preview','${contactId}','${extra.source || 'WHATSAPP_DIRECT'}','${extra.stage || 'NOVO'}','ATIVO',${json(extra.criteria || {})},${extra.budget || 'null'},${extra.ref ? q(extra.ref) : 'null'},${extra.vehicle ? q(extra.vehicle) : 'null'},${q(at(extra.createdHoursAgo || 30))},now());`;

const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','demo@example.test','admin',true,false);`,
  // 1) The calculator: the client asked by value (bid), with payment, deadline, state and plate.
  calcRun(1, { evento: 'simulacao', sid: 's-demo-1', ref: REF, logical_mode: 'VALOR', marca: 'Toyota', modelo: 'Corolla', lance: 18000, pagamento: 'Financiado', prazo: '30 dias', estado: 'FL', zip: '33101', nome: 'Marina Demonstração', placa: 'transferir' }, 30),
  calcRun(2, { evento: 'whatsapp', sid: 's-demo-1', ref: REF, logical_mode: 'VALOR', marca: 'Toyota', modelo: 'Corolla', lance: 18000, pagamento: 'Financiado', prazo: '30 dias', estado: 'FL', zip: '33101', nome: 'Marina Demonstração', placa: 'transferir' }, 29.9),
  // 2) The ficha of that client, opened from the WhatsApp message that carried the Ref.
  contact(IDS.CONTACT, 'Marina Demonstração'),
  `insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,created_at) values('preview','${IDS.CONTACT}','+13055550142','+1 305 555 0142',true,true,now());`,
  journey(IDS.JOURNEY, IDS.CONTACT, { stage: 'EM_BUSCA', ref: REF, budget: 1800000, criteria: { wishlists: [{ make: 'Toyota', model: 'Corolla' }], logical_modes: ['VALOR'] } }),
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${IDS.CHAT}','preview','WHATSAPP','${IDS.CONTACT}','demo-chat','RESOLVED',false,now(),now(),now(),now());`,
  // 3) The conversation: the client wrote last, so the answer is owed by MCS.
  message(IDS.MSG1, 'CUSTOMER', 'Oi! Fiz a simulação, Ref: DMCRA. Quero um Corolla, consigo uns 22 mil no total. Moro em Miami.', 29.8),
  message(IDS.MSG2, 'MCS', 'Oi, Marina! Recebemos sua Ref DMCRA. Vamos procurar Corolla dentro do seu lance.', 29),
  message(IDS.MSG3, 'CUSTOMER', 'Perfeito. Prefiro 2019 ou mais novo, se der.', 3),
  // 4) The reading of the conversation (PESQUISAS): criteria with the messages that support them.
  `insert into public.vehicle_request_runs(id,environment,chat_id,contact_id,provider,rule_version,input_hash,messages_read,status,request_count) values('${IDS.RUN}','preview','${IDS.CHAT}','${IDS.CONTACT}','SIMULATED','v1','${'a'.repeat(64)}',3,'DONE',1);`,
  `insert into public.vehicle_requests(id,environment,chat_id,contact_id,request_key,created_at,updated_at) values('${IDS.REQUEST}','preview','${IDS.CHAT}','${IDS.CONTACT}','corolla',now(),now());`,
  `insert into public.vehicle_request_versions(id,environment,request_id,run_id,criteria_json,missing_fields,evidence_json,confidence,needs_review,criteria_hash) values('${IDS.VERSION}','preview','${IDS.REQUEST}','${IDS.RUN}',${json({ make: 'Toyota', model: 'Corolla', yearMin: 2019, budgetUsd: 22000, location: 'Miami' })},'{miles}',${json({ make: [IDS.MSG1], model: [IDS.MSG1], year: [IDS.MSG3], budget: [IDS.MSG1], location: [IDS.MSG1] })},'media',false,'${'b'.repeat(24)}');`,
  // 5) Cases that cannot be linked safely.
  contact(IDS.TWIN_CONTACT, 'Contato com duas fichas'),
  journey(IDS.TWIN_A, IDS.TWIN_CONTACT, { vehicle: 'Honda Civic' }),
  journey(IDS.TWIN_B, IDS.TWIN_CONTACT, { vehicle: 'Honda Fit' }),
  contact(IDS.SHARED_CONTACT_A, 'Ref compartilhada A'),
  contact(IDS.SHARED_CONTACT_B, 'Ref compartilhada B'),
  journey(IDS.SHARED_A, IDS.SHARED_CONTACT_A, { ref: SHARED_REF }),
  journey(IDS.SHARED_B, IDS.SHARED_CONTACT_B, {}),
  `insert into public.journey_refs(environment,journey_id,ref_code,created_at) values('preview','${IDS.SHARED_B}','${SHARED_REF}',now());`,
  calcRun(3, { evento: 'simulacao', sid: 's-shared', ref: SHARED_REF, logical_mode: 'VALOR', marca: 'Kia', modelo: 'Soul', lance: 9000, nome: 'Sem dono' }, 50),
  calcRun(4, { evento: 'busca', sid: 's-loose-find', ref: LOOSE_REF, logical_mode: 'CARRO', marca: 'Mazda', modelo: 'CX-5', ano_de: 2018, ano_ate: 2021, milhas_ate: 80000, estado: 'GA', zip: '30301', nome: 'Rafael Simulação' }, 5)
].join('\n');

module.exports = { IDS, REF, SHARED_REF, LOOSE_REF, seed };
