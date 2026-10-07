'use strict';

// Assistente do painel: uma conversa onde a Leo escreve do jeito dela e o assistente responde,
// encontra, explica e propõe. Ele lê o painel livremente (funções de leitura que rodam aqui, com os
// dados completos que a pergunta precisa; a IA pede cada leitura no mesmo formato JSON que o resto do
// painel já usa com a OpenAI). Qualquer ação volta só como PROPOSTA: nada é executado neste servidor; a ação roda no navegador, pelo mesmo caminho do botão normal, depois do toque da
// Leo em "Autorizar". "Não funcionou" só diagnostica e propõe. O chamado nasce apenas após autorização.
//   POST { action: 'chat', message, history, context }    -> { reply, proposal, unavailable? }
//   POST { action: 'report', context, note }               -> { incident, diagnosis, reply, proposal }
//   POST { action: 'event', type, acao, payload, reason }  -> { ok }
//   POST { action: 'incident_status', id, status, prUrl }  -> { ok }
//   GET  ?incidents=1                                      -> { incidents }
const { allRows, isUuid, jsonBody, requirePanel, rows, rpc, insert, patchRows, safeText, send } = require('../../panel-server');
const openAiBudget = require('../../panel-openai-budget');
const vehicleMatch = () => require('../../vehicle-match');
const manheimOffer = () => require('../../manheim-offer');
const v1sent = () => require('../../panel-v1-sent');

const MODEL = 'gpt-6-luna';
const PRICE = { input: 0.10, output: 0.50 };
const TIMEOUT_MS = 20000;
co���q�^