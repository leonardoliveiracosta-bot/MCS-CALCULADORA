'use strict';
// "Confirmar vínculo" por nome: telefone igual e nome diferente nunca ficam juntos sem a decisão da operadora.
//  - JUNTO: uma simulação já ligada a uma ficha de outro chat (ex.: simulação por SMS, conversa no WhatsApp) cujo nome
//    a ficha não confirma (outro nome, ou a ficha não tem nome nenhum). Vale para o passado e para o futuro; nada é
//    desfeito sozinho: fica junto até a decisão.
//  - FILA: a regra do telefone não juntou por causa do nome (panel-phone-link) e a mensagem espera a decisão.
// Os dois lados vão lado a lado: o nome e o canal da simulação, e os nomes, o canal e a última mensagem da ficha.
const { rows, rpc } = require('./panel-server');
const phoneLink = require('./panel-phone-link');

const personNames = (list) => [...new Set((list || []).map((name) => String(name || '').trim()).filter(phoneLink.isPersonName))];

function fromCandidate(row) {
  return {
    key: `namelink:${row.message_id}:${row.journey_id}`, state: 'JUNTO', messageId: row.message_id, journeyId: row.journey_id, ref: row.reference_code || null, phone: row.phone || null,
    simulation: { name: row.message_name || null, channel: row.message_channel || null, at: row.message_at || null },
    ficha: { names: personNames([row.contact_name, ...(row.other_names || [])]), channel: row.other_channel || null, lastAt: row.other_last_at || null }
  };
}

async function loadReviews(ctx) {
  const env = 'eq.' + ctx.environment;
  const [candidates, queued] = await Promise.all([
    rpc(ctx, 'panel_name_link_candidates', { p_environment: ctx.environment }),
    rows(ctx, 'panel_calc_message_route', { select: 'message_id,evidence,updated_at', environment: env, destination: 'eq.FILA', reason: 'eq.FILA_CONTRADICAO', order: 'updated_at.desc', limit: '200' })
  ]);
  const joined = (Array.isArray(candidates) ? candidates : [])
    .filter((row) => !phoneLink.namesAgree(row.message_name, [row.contact_name, ...(row.other_names || [])]))
    .map(fromCandidate);
  // Any contradiction (name, unknown name, car), by the phone or by the Ref: one candidate ficha waits for the decision.
  const byName = queued.filter((row) => (row.evidence?.conflicts || []).some((code) => ['nome', 'nome-desconhecido', 'carro'].includes(code)) && (row.evidence?.candidates || []).length === 1);
  if (!byName.length) return joined;
  const journeyIds = [...new Set(byName.map((row) => row.evidence.candidates[0]))];
  const messageIds = byName.map((row) => row.message_id);
  const [messages, names, journeys] = await Promise.all([
    rows(ctx, 'messages', { select: 'id,channel,occurred_at_utc,created_at', environment: env, id: 'in.(' + messageIds.join(',') + ')' }),
    rpc(ctx, 'panel_journey_names', { p_environment: ctx.environment, p_journey_ids: journeyIds }),
    rows(ctx, 'journeys', { select: 'id,reference_code,contact_id', environment: env, id: 'in.(' + journeyIds.join(',') + ')' })
  ]);
  const contactIds = [...new Set(journeys.map((row) => row.contact_id).filter(Boolean))];
  const phones = contactIds.length ? await rows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,is_primary', environment: env, contact_id: 'in.(' + contactIds.join(',') + ')', is_current: 'eq.true', retired_at: 'is.null' }) : [];
  const messageOf = new Map(messages.map((row) => [row.id, row]));
  const namesOf = new Map((Array.isArray(names) ? names : []).map((row) => [row.journey_id, row]));
  const journeyOf = new Map(journeys.map((row) => [row.id, row]));
  const waiting = byName.map((row) => {
    const journeyId = row.evidence.candidates[0], message = messageOf.get(row.message_id) || {}, known = namesOf.get(journeyId) || {}, journey = journeyOf.get(journeyId) || {};
    const phone = phones.filter((entry) => entry.contact_id === journey.contact_id).sort((a, b) => Number(b.is_primary) - Number(a.is_primary))[0];
    return {
      key: `namelink:${row.message_id}:${journeyId}`, state: 'FILA', via: row.evidence.via === 'REF' ? 'REF' : 'TELEFONE', conflicts: row.evidence.conflicts || [], messageRef: row.evidence.ref || null,
      messageId: row.message_id, journeyId, ref: journey.reference_code || null, phone: phone ? phone.phone_e164 : null,
      simulation: { name: row.evidence.name || null, channel: message.channel || null, at: message.occurred_at_utc || message.created_at || null },
      ficha: { names: personNames([known.contact_name, ...(known.calc_names || [])]), channel: known.last_channel || null, lastAt: known.last_at || null }
    };
  });
  return joined.concat(waiting.filter((entry) => !joined.some((other) => other.key === entry.key)));
}

module.exports = { loadReviews, fromCandidate, personNames };
