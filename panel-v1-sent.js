'use strict';

// "Esta V1 (ou V2) chegou ao cliente?" pela própria conversa: uma mensagem da MCS com o link /v/<token>
// da vitrine desta ficha. Cobre o envio manual (link copiado e mandado pelo WhatsApp), que nunca passa
// pelo envio direto nem por "Apresentei ao cliente". Só leitura: nada é gravado.
// Uma regra só para o painel inteiro; quem precisar saber se a V1 foi enviada usa esta função.

const TOKEN_RE = /\/v\/([A-Za-z0-9_-]{6,})/g;

// Tokens /v/... presentes num texto.
function tokensIn(text) {
  const out = new Set();
  for (const found of String(text || '').matchAll(TOKEN_RE)) out.add(found[1]);
  return out;
}

const stamp = (message) => Date.parse(message.occurred_at_utc || message.occurred_at_local || message.created_at || '') || null;

// messages: a conversa da ficha. vitrines: [{ id, token, version }] da ficha. cars: vitrine_cars
// [{ vitrine_id, source_match_id, vehicle_snapshot }]. Devolve as vitrines enviadas por link, cada uma com
// a primeira mensagem que levou o link e os seus carros, da mais recente para a mais antiga.
function sentByLink({ messages = [], vitrines = [], cars = [] } = {}) {
  const byToken = new Map(vitrines.filter((item) => item && item.token).map((item) => [String(item.token), item]));
  if (!byToken.size) return [];
  const firstAt = new Map();
  for (const message of messages) {
    if (!message || message.direction !== 'MCS' || message.undone_at) continue;
    for (const token of tokensIn(message.body_text)) {
      const vitrine = byToken.get(token);
      if (!vitrine) continue;
      const at = stamp(message);
      const prior = firstAt.get(vitrine.id);
      if (!prior || (at !== null && (prior.at === null || at < prior.at))) firstAt.set(vitrine.id, { at, messageId: message.id || null });
    }
  }
  return [...firstAt.entries()].map(([vitrineId, first]) => {
    const vitrine = vitrines.find((item) => item.id === vitrineId);
    const own = cars.filter((car) => car.vitrine_id === vitrineId).map((car) => {
      const v = car.vehicle_snapshot || {};
      return { matchId: car.source_match_id || null, vin: v.vin || null, vehicleText: [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || null };
    });
    return { vitrineId, version: vitrine.version || null, sentAt: first.at === null ? null : new Date(first.at).toISOString(), messageId: first.messageId, cars: own };
  }).sort((a, b) => (Date.parse(b.sentAt || '') || 0) - (Date.parse(a.sentAt || '') || 0));
}

module.exports = { tokensIn, sentByLink };
