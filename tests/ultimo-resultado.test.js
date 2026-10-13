'use strict';

// RESULTADO na fila de ENVIAR OPÇÕES: o último resultado de cada pessoa vem de uma leitura só; um resultado desfeito
// não conta (volta o anterior) e o que não é RESULTADO (anotação, checklist) não entra. Banco de verdade (PGlite).
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { lastResults } = require('../api/panel/lead');

const id = (n) => `6e700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...[10, 20, 30].map((n) => `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(n + 1)}','preview','Cliente ${n}','SMS_DIRECT',now(),now());
    insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(n)}','preview','${id(n + 1)}','SMS_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`),
  // Cliente 10: Atendeu, then Opções enviadas undone -> Atendeu. Cliente 20: Pediu para ligar depois. Cliente 30: only a note.
  `insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by) values
    ('preview','REFAA','${id(10)}','QUICK_ANSWERED','{}',now()-interval '3 hours','${id(1)}'),
    ('preview','REFBB','${id(20)}','QUICK_LATER','{}',now()-interval '1 hours','${id(1)}'),
    ('preview',null,'${id(30)}','NOTE_CONFIRMED','{}',now(),'${id(1)}');
   insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by,undone_at) values
    ('preview','REFAA','${id(10)}','QUICK_IN_PERSON','{}',now()-interval '1 hours','${id(1)}',now());`
].join('\n');

test('último RESULTADO por pessoa: desfeito não conta, anotação não entra', async () => {
  const backend = await createBackend({ seed });
  const before = globalThis.fetch;
  try {
    Object.assign(process.env, { SUPABASE_URL: BASE });
    globalThis.fetch = backend.fetch;
    const out = await lastResults({ environment: 'preview', config: { url: BASE, secretKey: 'secreta-simulada' } });
    assert.deepEqual(Object.keys(out.journeys).sort(), [id(10), id(20)]);
    assert.equal(out.journeys[id(10)].type, 'ANSWERED');
    assert.equal(out.journeys[id(20)].type, 'LATER');
    assert.equal(out.refs.REFAA.type, 'ANSWERED');
    assert.equal(out.refs.REFBB.type, 'LATER');
    assert.equal(out.journeys[id(30)], undefined);
  } finally {
    globalThis.fetch = before;
    await backend.db.close();
  }
});
