'use strict';

// A client's request not to be contacted. Shared by the reply suggestions and the automatic reading,
// so both stop on the same words.
// Pedido para não receber contato, em português, inglês ou espanhol.
const OPT_OUT = /\b(unsubscribe|remove me|take me off (your|the) list|do not (text|message|contact|call) me|don'?t (text|message|contact|call) me( again| anymore)?|stop (texting|messaging|contacting|calling) me|no more (messages|texts)|leave me alone|pare de (me )?(mandar|enviar|chamar|escrever)|n[aã]o (me )?(mande|envie|chame|escreva) mais|n[aã]o quero (mais )?(receber|contato|mensage)|me (tire|remova) da lista|para de (me )?(mandar|enviar)|no me (escribas|escriba|env[ií]es|envie|contactes|contacte|llames) m[aá]s|deja de (escribirme|enviarme|mandarme)|ya no (me )?(escribas|env[ií]es|contactes)|no quiero (m[aá]s )?(mensajes|recibir))\b/i;
// A message that is only the word (STOP, PARE, BAJA…) is an opt-out; inside a sentence it is not
// ("I'll stop by tomorrow").
const OPT_OUT_WORD = /^\s*(stop|unsubscribe|pare|parar|sair|cancelar|baja|alto)\s*[.!]*\s*$/i;
const messageAt = (message) => message && (message.occurred_at_utc || message.created_at) || null;
const stamp = (message) => Date.parse(messageAt(message) || '') || 0;
function optOutOf(messages) {
  const said = (text) => OPT_OUT.test(text) || OPT_OUT_WORD.test(text);
  const found = (messages || []).filter((message) => message.direction === 'CUSTOMER' && !message.undone_at && said(String(message.body_text || ''))).sort((a, b) => stamp(b) - stamp(a))[0];
  return found ? { at: messageAt(found), text: String(found.body_text || '').slice(0, 200) } : null;
}

module.exports = { OPT_OUT, OPT_OUT_WORD, optOutOf };

// Whether the panel may still offer cars to this ficha (V1 created or sent): not when the client asked
// not to be contacted, the case is closed or switched off, the person was discarded or marked "não é
// lead". Returns null (allowed) or { code, text }. Reads only this ficha.
async function journeyBlock(ctx, journeyId, read) {
  const env = 'eq.' + ctx.environment;
  const [journey] = await read(ctx, 'journeys', { select: 'id,contact_id,status,closed_reason', environment: env, id: 'eq.' + journeyId, limit: '1' });
  if (!journey) return { code: 'JOURNEY_NOT_FOUND', text: 'Ficha não encontrada' };
  const [contacts, toggles, dispositions, links] = await Promise.all([
    read(ctx, 'contacts', { select: 'id,is_lead', environment: env, id: 'eq.' + journey.contact_id, limit: '1' }),
    read(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: env, journey_id: 'eq.' + journeyId, limit: '1' }).catch(() => []),
    read(ctx, 'panel_item_dispositions', { select: 'status,cleared_at', environment: env, item_kind: 'eq.JOURNEY', item_key: 'eq.' + journeyId, cleared_at: 'is.null', limit: '1' }).catch(() => []),
    read(ctx, 'message_journeys', { select: 'message_id', environment: env, journey_id: 'eq.' + journeyId, undone_at: 'is.null' })
  ]);
  if (contacts[0] && contacts[0].is_lead === false) return { code: 'NOT_LEAD', text: 'Marcado como "não é lead"' };
  if (journey.status === 'ENCERRADO') return { code: 'CLOSED', text: 'Caso encerrado' };
  if (toggles[0] && toggles[0].enabled === false) return { code: 'OFF', text: 'Caso desligado' };
  if (dispositions[0] && dispositions[0].status === 'DISCARDED') return { code: 'DISCARDED', text: 'Pessoa descartada' };
  // Same rule as HOJE: blocked while the client's latest message is the request not to be contacted
  // (a later message from the client brings the case back).
  const ids = links.map((row) => row.message_id).filter(Boolean);
  const messages = [];
  for (let index = 0; index < ids.length; index += 100) {
    messages.push(...await read(ctx, 'messages', { select: 'id,direction,body_text,occurred_at_utc,created_at,undone_at', environment: env, direction: 'eq.CUSTOMER', id: 'in.(' + ids.slice(index, index + 100).join(',') + ')' }));
  }
  const live = messages.filter((message) => !message.undone_at).sort((a, b) => stamp(a) - stamp(b));
  const last = live.at(-1);
  const found = last ? optOutOf([last]) : null;
  if (found) return { code: 'OPT_OUT', text: 'O cliente pediu para não receber contato: "' + found.text + '"' };
  return null;
}

module.exports.journeyBlock = journeyBlock;
