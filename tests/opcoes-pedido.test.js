'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criteriaHash } = require('../panel-manheim-batch');
const vehicleMatch = require('../vehicle-match');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const wish = { make: 'Porsche', model: 'Macan', yearMin: 2018, yearMax: 2022, minMiles: 5000, maxMiles: 50000 };

test('VALOR segue carro e lance; CARRO segue ano e milhagem sem exigir lance; um não herda a exigência do outro', () => {
  const carro = (bidCents) => ({ mode: 'CARRO', wishes: [wish], bidCents });
  const valor = (extra = {}, bidCents = 900000) => ({ mode: 'VALOR', wishes: [{ ...wish, ...extra }], bidCents });
  assert.equal(vehicleMatch.carroWishIssue(wish), null, 'CARRO completo não pede lance');
  assert.equal(vehicleMatch.valorWishIssue(wish, null), 'BID_MISSING', 'VALOR sem lance não busca');
  assert.equal(vehicleMatch.valorWishIssue({ make: 'Porsche', model: 'Macan' }, 900000), null, 'VALOR não exige ano nem milhagem');
  assert.equal(vehicleMatch.carroWishIssue({ ...wish, maxMiles: null }), null);
  assert.notEqual(criteriaHash(carro(null)), criteriaHash(carro(900000)), 'o lance não muda o critério de uma busca por carro');
  assert.notEqual(criteriaHash(valor()), criteriaHash(valor({ yearMin: 2010, maxMiles: 99999 })), 'ano e milhagem não mudam o critério de uma busca por valor');
  assert.notEqual(criteriaHash(carro(null)), criteriaHash(valor()), 'cada tipo tem o seu critério');
  assert.notEqual(criteriaHash(valor()), criteriaHash(valor({}, 1200000)), 'lance diferente é outro critério de VALOR');
});

test('o botão de opções conserva o pedido exato: critério e lote do clique são conferidos ao abrir', () => {
  const client = read('painel/painel.js');
  assert.match(client, /async function openOptionsCard\(demandKey, context = \{\}\)/);
  assert.match(client, /openOptionsCard\(`journey:\$\{item\.person\.journeyId\}:\$\{item\.searchMode\}`, \{ criteriaHash: item\.criteriaHash \|\| null, uploadId: requestsUploadId \}\)/);
  assert.match(client, /context\.criteriaHash !== live\.criteriaHash/);
  assert.match(client, /context\.uploadId !== manheimData\.upload\.id/);
  assert.match(client, /As opções abaixo foram recalculadas com o critério atual/);
  assert.match(client, /O lote ativo mudou desde o resultado que você abriu/);
  // the options screen exposes each demand's criteria hash so the comparison is by criterion, not by total
  assert.match(read('panel-buscas-view.js'), /reactivation, criteriaHash: target \? target\.criteriaHash : null/);
});

test('pedido lido da conversa não abre a busca oficial da ficha (seria outro critério)', () => {
  const client = read('painel/painel.js');
  assert.match(client, /item\.source === 'CONVERSA' && !item\.official/);
  assert.match(client, /Confirme o pedido na ficha para abrir as opções dele/);
});

test('candidato não validado nunca é apresentado como opção válida', () => {
  const client = read('painel/painel.js');
  assert.match(client, /first\.state === 'COM_CANDIDATOS' \? `Ver \$\{item\.optionCount === 1 \? 'o candidato'/);
  assert.match(client, /Falta: o lance oficial do cliente/);
  assert.match(client, /não é opção confirmada/);
  // ac38433 (#173, "sem jargão") encurtou a dica do grupo COM_CARROS; o aviso de que candidato não é
  // opção ficou no próprio cartão (acima). A dica do grupo que contém COM_CANDIDATOS nunca chama os
  // carros de opção.
  const group = read('painel/grupos.js').match(/\{ key: 'COM_CARROS',[^}]*\}/);
  assert.ok(group, 'grupo COM_CARROS');
  assert.match(group[0], /states: \['COM_OPCOES', 'COM_CANDIDATOS'\]/);
  assert.doesNotMatch(group[0].match(/hint: '([^']*)'/)[1], /opç/i);
  assert.match(client, /Sem isso estes carros não viram opção válida nem vão para o envio/);
  // and the shipping side only reads what was explicitly selected
  assert.match(read('api/panel/vitrines.js'), /selectedFor|SELECTED/);
});
