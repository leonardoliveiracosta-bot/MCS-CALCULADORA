'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBuscasBase } = require('../panel-buscas');

test('leituras independentes da base começam antes de terminar a página de mensagens, sem repetir consultas', {timeout:3000}, async () => {
  let releaseMessages, notifyStarted;
  const messages = new Promise(resolve => { releaseMessages = resolve; });
  const independentStarted = new Promise(resolve => { notifyStarted = resolve; });
  const waiting = new Set(['conversation_triage','vehicle_requests','vehicle_request_versions','journey_declarations','panel_journey_explicit_refs']);
  const calls = [];
  const started = name => { waiting.delete(name); if (!waiting.size) notifyStarted(); };
  const read = async (_ctx, table, query) => {
    calls.push({table,query}); started(table);
    if (table === 'messages') await messages;
    return [];
  };
  const rpc = async (_ctx, name) => {
    started(name);
    return name === 'panel_model_dictionary' ? {aliases:[],known:[],revision:'test'} : [];
  };
  const load = loadBuscasBase({environment:'preview'},{allRows:read,rpc});
  try {
    await independentStarted;
    assert.ok(calls.some(call => call.table === 'messages'));
    releaseMessages();
    const result = await load;
    assert.deepEqual(result.journeys,[]);
    for (const table of ['conversation_triage','vehicle_requests','vehicle_request_versions','journey_declarations']) {
      assert.equal(calls.filter(call => call.table === table).length,1,table);
    }
  } finally {releaseMessages();}
});
