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
