'use strict';

// Conversas fictícias para as sugestões de resposta e a fila de conversas antigas: inglês recente
// (janela aberta), espanhol antigo, português com pergunta já respondida, opt-out, número inválido,
// "não é lead" e uma conversa recente demais para a fila. Nenhum dado real.
const id = (n) => `6d200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const q = (value) => "'" + String(value).replaceAll("'", "''") + "'";

let message = 1000;
function person(n, { name, phone, key, isLead = true, status = 'ATIVO', closedReason = null, messages, ref = null, criteria = {} }) {
  const contact = id(n), journey = id(n + 1), chat = id(n + 2);
  const sql = [
    `insert into public.contacts(id,environment,display_name,source,is_lead,created_at,updated_at) values('${contact}','preview',${q(name)},'WHATSAPP_DIRECT',${isLead},now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,reference_code,closed_at,closed_reason,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','${status}',${q(JSON.stringify(criteria))}::jsonb,${ref ? q(ref) : 'null'},${status === 'ENCERRADO' ? 'now()' : 'null'},${closedReason ? q(closedReason) : 'null'},now() - interval '90 days',now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}',${q(key || 'wa:' + phone)},'RESOLVED',false,now(),now(),now(),now());`
  ];
  if (phone) sql.push(`insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,created_at) values('preview','${contact}',${q(phone)},${q(phone)},true,true,now());`);
  messages.forEach(([direction, text, msAgo, automatic]) => {
    const mid = id(message++);
    sql.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,is_automatic,created_at) values('${mid}','preview','${chat}','WHATSAPP','${direction}',${q(text)},'x',${q(at(msAgo))},${q('s' + mid)},1,'WHATSAPP_WEBHOOK',${automatic === true},${q(at(msAgo))});`);
    sql.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${mid}','${journey}','IMPORT',now());`);
  });
  return { sql: sql.join('\n'), contact, journey, chat };
}

const people = {
  english: person(10, { name: 'Ethan Example', phone: '+13055550111', criteria: { wishlists: [{ make: 'Honda', model: 'CR-V' }], logical_modes: ['VALOR'] }, messages: [
    ['CUSTOMER', "Hi, I'm looking for a Honda CR-V 2019, budget around 22k", 3 * HOUR],
    ['MCS', 'Thanks for reaching out to My Car Scout! We received your message and will reply shortly.', 3 * HOUR - 60000, true],
    ['CUSTOMER', 'Mileage under 60k please', 2 * HOUR]
  ] }),
  spanish: person(20, { name: 'Sofía Ejemplo', phone: '+13055550122', messages: [
    ['CUSTOMER', 'Hola, busco un Corolla 2018, presupuesto 15 mil', 70 * DAY],
    ['MCS', 'Hola Sofía, con 15 mil hay Corollas 2018 en subasta. ¿Lo quieres para este mes?', 69 * DAY]
  ] }),
  answered: person(30, { name: 'Paulo Exemplo', phone: '+13055550133', messages: [
    ['CUSTOMER', 'Quero um Civic', 41 * DAY],
    ['MCS', 'Qual ano você procura?', 41 * DAY - HOUR],
    ['CUSTOMER', '2019 ou mais novo', 41 * DAY - 2 * HOUR],
    ['MCS', 'Perfeito, vou olhar o mercado com isso', 40 * DAY]
  ] }),
  optOut: person(40, { name: 'Olivia Optout', phone: '+13055550144', messages: [
    ['CUSTOMER', 'I was looking for a Tacoma', 35 * DAY],
    ['MCS', 'Got it, what budget are you working with?', 34 * DAY],
    ['CUSTOMER', "Please don't text me again", 30 * DAY]
  ] }),
  invalid: person(50, { name: 'Ivan Invalido', phone: null, key: 'wa:12345', messages: [
    ['CUSTOMER', 'Tem algum Onix?', 50 * DAY],
    ['MCS', 'Aqui nos EUA trabalhamos com leilão americano. Qual carro você quer?', 49 * DAY]
  ] }),
  notLead: person(60, { name: 'Nina Naolead', phone: '+13055550166', isLead: false, messages: [
    ['CUSTOMER', 'Oi, sou do banco', 60 * DAY],
    ['MCS', 'Oi, tudo bem', 59 * DAY]
  ] }),
  recent: person(70, { name: 'Rita Recente', phone: '+13055550177', messages: [
    ['CUSTOMER', 'Quero um Compass', 5 * DAY],
    ['MCS', 'Qual o orçamento?', 5 * DAY - HOUR]
  ] })
};

const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...Object.values(people).map((item) => item.sql)
].join('\n');

module.exports = { ACTOR, people, seed };
