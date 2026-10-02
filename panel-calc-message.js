'use strict';
// Mensagem da calculadora: o que a regra lê dela, sem adivinhar nada.
// A calculadora (msc-calculadora.html, linkWhatsApp / linkWhatsAppFind) termina a mensagem com "Ref: XXXXX"; quando o navegador
// bloqueia o armazenamento escreve "Ref: -----" (Ref ilegível na origem: nunca vira Ref). Versões antigas do modelo não tinham a linha.
const REF_RE = /^[A-HJ-NP-Z2-9]{5}$/;
// Every version and language of the model (the VALOR and FIND copies, and the older "estimate" wording).
const MARKERS = /(vehicle search request|calculate my cost|find one for me|maximum bid|year range|mileage range|·\s*FIND\s*·|lance máximo|faixa de anos|rango de años|oferta máxima|solicitud de búsqueda|solicitação de busca|rango de millas|faixa de milhas|ran a simulation on the my car scout|ran an estimate on the my car scout|simulación en la calculadora|simulação na calculadora|discuss this simulation|discuss this vehicle search|estimate and not a commercial offer)/i;
const BRAND = /my car scout/i;
const REF_LINE = /(?:^|[^A-Za-z0-9])Ref:\s*([A-Za-z0-9-]{5})(?![A-Za-z0-9-])/gi;
const TALK_LINE = /(discuss this simulation|discuss this vehicle search|conversar sobre esta (simulação|busca)|hablar sobre esta búsqueda|conversar sobre esta simulación)\s*$/i;
const MODERN = /(i just ran a simulation on the my car scout|i just sent a vehicle search request|acabo de hacer una simulación|acabo de enviar una solicitud|acabei de fazer uma simulação|acabei de enviar uma solicitação)/i;

const isCalculator = (text) => BRAND.test(String(text || '')) && MARKERS.test(String(text || ''));
const line = (text, labels) => { const found = String(text || '').split(/\r?\n/).map((row) => row.trim()).find((row) => labels.some((label) => row.toLowerCase().startsWith(label))); return found ? found.slice(found.indexOf(':') + 1).trim() : ''; };

// refState: REF (valid code), REF_ILEGIVEL ("Ref: -----" or a code with letters the calculator never uses), SEM_LINHA_REF.
// diagnosis (only when there is no valid Ref): SEM_LINHA_REF_MODELO_ANTIGO, SEM_LINHA_REF_CORTADA (modern model ending at the talk line),
// SEM_LINHA_REF, REF_TRACOS, REF_FORMATO_INVALIDO.
function parse(text) {
  const body = String(text || '');
  const calculator = isCalculator(body);
  const raws = [...body.matchAll(REF_LINE)].map((match) => match[1]);
  const valid = [...new Set(raws.map((raw) => raw.toUpperCase()).filter((raw) => REF_RE.test(raw)))];
  let refState = 'SEM_LINHA_REF', ref = null, diagnosis = null;
  if (valid.length === 1) { refState = 'REF'; ref = valid[0]; }
  else if (valid.length > 1) { refState = 'REF'; ref = valid[valid.length - 1]; diagnosis = 'VARIAS_REFS'; }
  else if (raws.length) { refState = 'REF_ILEGIVEL'; diagnosis = raws.some((raw) => /^-{5}$/.test(raw)) ? 'REF_TRACOS' : 'REF_FORMATO_INVALIDO'; }
  else diagnosis = !MODERN.test(body) ? 'SEM_LINHA_REF_MODELO_ANTIGO' : TALK_LINE.test(body.trim()) ? 'SEM_LINHA_REF_CORTADA' : 'SEM_LINHA_REF';
  return { calculator, refState, ref, refs: valid, diagnosis, name: line(body, ['name:', 'nome:', 'nombre:']), vehicle: line(body, ['vehicle:', 'veículo:', 'vehículo:']) };
}

module.exports = { REF_RE, MARKERS, isCalculator, parse };
