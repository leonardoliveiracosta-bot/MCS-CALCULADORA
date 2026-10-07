'use strict';
// Antigo "Confirmar vínculo" por nome (desligado): o nome diferente entre a calculadora e a ficha virou só informação.
const phoneLink = require('./panel-phone-link');

const personNames = (list) => [...new Set((list || []).map((name) => String(name || '').trim()).filter(phoneLink.isPersonName))];

function fromCandidate(row) {
  return {
    key: `namelink:${row.message_id}:${row.journey_id}`, state: 'JUNTO', messageId: row.message_id, journeyId: row.journey_id, ref: row.reference_code || null, phone: row.phone || null,
    simulation: { name: row.message_name || null, channel: row.message_channel || null, at: row.message_at || null },
    ficha: { names: personNames([row.contact_name, ...(row.other_names || [])]), channel: row.other_channel || null, lastAt: row.other_last_at || null }
  };
}

// Nome diferente não pede mais decisão: a Ref do fim da mensagem (ou o telefone com uma ficha só) já liga, e o nome da
// calculadora aparece na ficha só como informação. Nenhuma revisão "Confirmar vínculo" por nome é gerada.
async function loadReviews() { return []; }

module.exports = { loadReviews, fromCandidate, personNames };
