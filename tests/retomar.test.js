'use strict';

// RETOMAR (/retomar): clientes que escreveram há mais de 15 dias sem resposta, com as 3 mensagens prontas. Handlers
// reais contra o banco simulado (todas as migrações): quem entra (WhatsApp e só SMS), quem fica de fora, o texto, a
// parte salva no banco, o reconhecimento do que foi enviado no WhatsApp e o RESULTADO "Opções enviadas" no fim.
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const messages = require('../retomar/mensagens');

const id = (n) => `6e200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WA = id(10), SMS = id(20), RECENT = id(30), ANSWERED = id(40), STOP = id(50);
const person = ({ journey, contact, chat, name, phone, channel = 'WHATSAPP', ref = null, lines }) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}',${ref ? `'${ref}'` : 'null'},'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now() - interval '40 days',now());`,
  `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at) values('preview','${contact}','${phone}','${phone}',true,true,now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','${channel}','${contact}','${channel === 'WHATSAPP' ? 'wa:' : 'sms:'}${phone}','RESOLVED',false,now(),now(),now(),now());`,
  ...lines.map(([direction, text, days], index) => {
    const message = chat.slice(0, -2) + String(index + 10);
    return `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','${channel}','${direction}','${text}','x',now() - interval '${days} days','s-${message}',1,'WHATSAPP_WEBHOOK',now() - interval '${days} days');`
      + `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`;
  })
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...person({ journey: WA, contact: id(11), chat: id(1200), name: 'Carlos Souza', phone: '+13055550101', ref: 'AB2CD', lines: [['CUSTOMER', 'Hi, I want a car', 20]] }),
  ...person({ journey: SMS, contact: id(21), chat: id(2200), name: 'Ana Lima', phone: '+17865550102', channel: 'SMS', lines: [['CUSTOMER', 'Oi, quero comprar um carro', 18]] }),
  ...person({ journey: RECENT, contact: id(31), chat: id(3200), name: 'Recente', phone: '+13055550103', lines: [['CUSTOMER', 'Hello', 5]] }),
  ...person({ journey: ANSWERED, contact: id(41), chat: id(4200), name: 'Respondido', phone: '+13055550104', lines: [['CUSTOMER', 'Hello', 25], ['MCS', 'Hi! Which car?', 22]] }),
  ...person({ journey: STOP, contact: id(51), chat: id(5200), name: 'Parou', phone: '+13055550105', lines: [['CUSTOMER', 'Hello', 30], ['CUSTOMER', 'STOP', 20]] }),
  // Origem: o WhatsApp veio pela calculadora (Ref comprovada); o SMS chegou direto.
  `insert into public.panel_identity_state(environment,journey_id,status,calc_origin,refs,rule_version,input_hash) values('preview','${WA}','REF_COMPROVADA',true,'{AB2CD}',1,'h'),('preview','${SMS}','SEM_ORIGEM_CALCULADORA',false,'{}',1,'h');`
].join('\n');

let backend;
const call = async ({ method = 'GET', body } = {}) => {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  await require('../api/panel/retomar')({ method, url: '/api/panel/retomar', headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res);
  return res;
};
const listed = async () => { const res = await call(); assert.equal(res.statusCode, 200, JSON.stringify(res.payload)); return res.payload; };

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('a lista: quem escreveu há mais de 15 dias e não teve resposta, por WhatsApp e só por SMS', async () => {
  const out = await listed();
  const ids = out.items.map((item) => item.journeyId);
  assert.deepEqual(new Set(ids), new Set([WA, SMS]));
  const wa = out.items.find((item) => item.journeyId === WA), sms = out.items.find((item) => item.journeyId === SMS);
  assert.equal(wa.channel, 'WHATSAPP'); assert.equal(wa.phone, '+13055550101'); assert.equal(wa.days, 20); assert.equal(wa.language, 'en');
  assert.equal(sms.channel, 'SMS'); assert.equal(sms.phone, '+17865550102'); assert.equal(sms.language, 'pt');
  // Mais recente primeiro; quem pediu para parar fica de fora com o motivo.
  assert.deepEqual(ids, [SMS, WA]);
  assert.equal(out.excluded.OPT_OUT, 1);
  assert.equal(wa.progress, null);
  assert.equal(wa.origin, 'CALCULADORA'); assert.equal(sms.origin, 'OUTRA');
});

test('as 3 mensagens: o texto do Leo, com o primeiro nome; sem opções, pede o carro e o valor (nunca a calculadora)', () => {
  const withLink = messages.sequence({ lang: 'en', name: 'carlos souza', link: 'https://www.mycarscout.net/o/abc' });
  assert.equal(withLink.length, 3);
  assert.match(withLink[0], /^Hi Carlos, how are you\? I owe you a reply, and I’m sorry it took this long\./);
  assert.match(withLink[1], /^As you may remember, we buy where dealerships buy: the dealer-only auctions, before the markup\. I pulled what’s coming up this week that fits what you asked for:\nhttps:\/\/www\.mycarscout\.net\/o\/abc$/);
  // Fecha a sequência e deixa a porta aberta: não depende de resposta, nunca um sim/não nem "ainda está procurando".
  assert.match(withLink[2], /^Take your time with them\. When one catches your eye, just tell me which and I’ll take care of the rest/);
  assert.match(withLink[2], /I’m here whenever you’re ready\.$/);
  const noLink = messages.sequence({ lang: 'en', name: '', car: 'BMW X5' });
  assert.match(noLink[0], /^Hi, how are you\? I owe you a reply about the BMW X5, and I’m sorry it took this long\./);
  assert.equal(noLink[1], 'As you may remember, we buy where dealerships buy: the dealer-only auctions, before the markup.');
  assert.match(noLink[2], /^When you’re ready, just tell me the years and the number you’d feel good about for the BMW X5/);
  for (const lang of ['en', 'pt', 'es']) for (const input of [{}, { car: 'S580' }, { link: 'https://x/o/c' }, { car: 'S580', link: 'https://x/o/c' }]) {
    const all = messages.sequence({ lang, name: 'Ana', ...input });
    assert.equal(all.length, 3);
    assert.doesNotMatch(all[2], /\?\s*$/, 'fecha sem pergunta: ' + lang);
    assert.doesNotMatch(all.join(' '), /still looking|already bought|ainda está procurando|já comprou|sigues buscando|ya compraste|calculat/i, lang + ' ' + JSON.stringify(input));
    if (input.link) assert.ok(all[1].includes(input.link)); else assert.ok(!all.join(' ').includes('/o/'));
  }
  assert.match(messages.boughtReply('en'), /^Congrats on the car! .* send me the VIN/);
  for (const lang of ['en', 'pt', 'es']) { const list = messages.replies(lang); assert.equal(list.length, 5); list.forEach((reply) => { assert.ok(reply.label && reply.text); }); }
  assert.equal(messages.replies('pt')[0].text.slice(0, 14), 'Ótima escolha.');
  assert.equal(messages.sequence({ lang: 'pt', name: 'Ana' })[0].slice(0, 15), 'Oi Ana, tudo be');
});

test('preparar, mandar parte por parte e voltar: a parte fica no banco; a 3ª grava "Opções enviadas" uma vez', async () => {
  const prepared = await call({ method: 'POST', body: { action: 'prepare', journeyId: WA, channel: 'WHATSAPP', lang: 'en', car: 'BMW X5' } });
  assert.equal(prepared.statusCode, 200, JSON.stringify(prepared.payload));
  const texts = prepared.payload.progress.texts;
  assert.equal(texts.length, 3); assert.match(texts[0], /^Hi Carlos/); assert.match(texts[2], /BMW X5/);
  assert.equal(prepared.payload.review.length, 3);
  for (const parts of [1, 2, 1, 2]) {
    const out = await call({ method: 'POST', body: { action: 'step', journeyId: WA, parts } });
    assert.equal(out.payload.progress.partsSent, parts);
  }
  // Outro aparelho: a lista devolve o mesmo ponto e o mesmo texto; preparar de novo não troca o texto já começado.
  let item = (await listed()).items.find((row) => row.journeyId === WA);
  assert.equal(item.progress.partsSent, 2); assert.deepEqual(item.progress.texts, texts);
  const again = await call({ method: 'POST', body: { action: 'prepare', journeyId: WA, channel: 'WHATSAPP', lang: 'pt' } });
  assert.deepEqual(again.payload.progress.texts, texts);
  const done = await call({ method: 'POST', body: { action: 'step', journeyId: WA, parts: 3 } });
  assert.equal(done.payload.progress.resultRecorded, true, JSON.stringify(done.payload));
  await call({ method: 'POST', body: { action: 'step', journeyId: WA, parts: 3 } });
  const events = await backend.db.query(`select event_type, count(*)::int n from public.lead_events where environment='preview' and event_type like 'QUICK_%' group by 1`);
  assert.deepEqual(events.rows, [{ event_type: 'QUICK_IN_PERSON', n: 1 }]);
  item = (await listed()).items.find((row) => row.journeyId === WA);
  assert.ok(item.progress.completedAt);
});

test('a parte enviada é reconhecida na conversa (eco do WhatsApp ou SMS registrado), e a resposta do cliente aparece', async () => {
  await call({ method: 'POST', body: { action: 'prepare', journeyId: SMS, channel: 'SMS', lang: 'pt' } });
  const started = await call({ method: 'POST', body: { action: 'step', journeyId: SMS, parts: 1 } });
  const [first, second] = started.payload.progress.texts;
  const insert = (n, direction, text, minutes) => backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(2290 + n)}','preview','${id(2200)}','SMS','${direction}',$t$${text}$t$,'x',now() + interval '${minutes} minutes','s-${n}',1,'PANEL_SMS',now());
    insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(2290 + n)}','${SMS}','IMPORT',now());`);
  await insert(1, 'MCS', first, 1); await insert(2, 'MCS', second, 2);
  let item = (await listed()).items.find((row) => row.journeyId === SMS);
  // Continua na lista (a nossa mensagem é a mais recente) e já conta 2 partes, embora só a 1 tenha sido marcada.
  assert.deepEqual(item.progress.detected, [true, true, false]);
  assert.equal(item.progress.partsSent, 2);
  assert.equal(item.progress.replied, false);
  await insert(3, 'CUSTOMER', 'Ainda estou procurando!', 3);
  item = (await listed()).items.find((row) => row.journeyId === SMS);
  assert.equal(item.progress.replied, true);
});

test('horário do cliente pelo código de área: 8:00 a 20:00 no fuso dele; código dividido exige os dois fusos', () => {
  const hour = require('../retomar/horario');
  const at = new Date('2026-10-13T00:30:00Z'); // 20:30 em Miami, 19:30 em Houston, 17:30 em Los Angeles
  assert.equal(hour.check('+13055550101', at).allowed, false);
  assert.equal(hour.check('+17135550101', at).allowed, true);
  assert.equal(hour.check('+13105550101', at).local, '17:30');
  assert.equal(hour.check('+18505550101', at).allowed, false, '850: parte em Eastern, parte em Central');
  assert.equal(hour.check('+18085550101', new Date('2026-10-13T15:00:00Z')).local, '05:00');
  assert.equal(hour.check('+447700900000', at).known, false);
});

test('o carro no texto: o modelo quando ele se sustenta sozinho, com a marca quando é curto ou só números', () => {
  const { optionsOf } = require('../panel-retomar');
  const view = (wish) => ({ upload: { id: 'u' }, demands: [{ key: 'journey:' + WA + ':CARRO', mode: 'CARRO', journeyId: WA, wishes: [wish], matchCount: 0 }] });
  assert.equal(optionsOf(view({ make: 'Cadillac', model: 'Escalade', trim: 'Sport Platinum' }), WA).car, 'Escalade');
  assert.equal(optionsOf(view({ make: 'BMW', model: 'X5' }), WA).car, 'BMW X5');
  assert.equal(optionsOf(view({ make: 'Chrysler', model: '300', trim: 's' }), WA).car, 'Chrysler 300');
  assert.equal(optionsOf(view({ make: 'Mercedes-Benz', model: 'S580' }), WA).car, 'S580');
  assert.equal(optionsOf({ upload: null, demands: [] }, WA).car, null);
});
