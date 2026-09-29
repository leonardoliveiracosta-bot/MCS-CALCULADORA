'use strict';

// Paginação estável de allRows: várias páginas, datas iguais e atualização no meio da
// leitura. Nenhuma linha pulada ou repetida, e o mesmo resultado com qualquer tamanho de página.
// Tudo local (PGlite); nenhuma chamada externa.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { allRows, rows } = require('../panel-server');

const id = (n) => `6e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOTAL = 23;
// Ids are inserted out of order and many rows share the same timestamps and names.
const ORDER = Array.from({ length: TOTAL }, (_, index) => (index * 7) % TOTAL + 1);
const seed = ORDER.map((n) => `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(n)}','preview','${['Ana', 'Bia', 'ana', 'Caio'][n % 4]}','WHATSAPP_DIRECT','2026-09-01T10:00:00Z','2026-09-${n % 3 ? '20T12:00:00.123456Z' : '21T08:00:00Z'}');`).join('\n');

let backend, ctx;
test.before(async () => {
  backend = await createBackend({ seed });
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview' };
});
test.after(async () => { if (backend) await backend.db.close(); });

const params = (order) => ({ select: 'display_name,updated_at', environment: 'eq.preview', ...(order ? { order } : {}) });
async function expected(orderSql) {
  return (await backend.db.query(`select display_name, updated_at from public.contacts where environment='preview' order by ${orderSql}`)).rows
    .map((row) => row.display_name + '|' + new Date(row.updated_at).toISOString());
}
const shape = (list) => list.map((row) => row.display_name + '|' + new Date(row.updated_at).toISOString());

test('mesma resposta com qualquer tamanho de página, na ordem pedida com desempate por id', async () => {
  for (const [order, sql] of [['updated_at.desc', 'updated_at desc, id asc'], ['updated_at.asc', 'updated_at asc, id asc'], ['created_at.asc', 'created_at asc, id asc']]) {
    const want = await expected(sql);
    for (const size of [1, 2, 5, 22, 23, 1000]) {
      const got = await allRows(ctx, 'contacts', params(order), size);
      assert.equal(got.length, TOTAL);
      assert.deepEqual(shape(got), want, `${order} com páginas de ${size}`);
    }
  }
  // The key added for paging never leaks into the rows.
  assert.ok((await allRows(ctx, 'contacts', params('updated_at.desc'), 4)).every((row) => !('id' in row)));
  // Without an order the rows come by id, always the same.
  const byId = await allRows(ctx, 'contacts', { select: 'id', environment: 'eq.preview' }, 3);
  assert.deepEqual(byId.map((row) => row.id), [...byId.map((row) => row.id)].sort());
});

test('atualização durante a leitura não pula nem repete fichas', async () => {
  const realFetch = globalThis.fetch;
  const runWithChanges = async (reader) => {
    let pages = 0;
    globalThis.fetch = async (url, options) => {
      const reply = await realFetch(url, options);
      if (String(url).includes('/rest/v1/contacts') && ++pages === 1) {
        // Between page 1 and 2 another request moves a row that was already read to the end of
        // the order, and moves a row not read yet to the start.
        const first = (await reply.json());
        await backend.db.query(`update public.contacts set updated_at='2026-12-31T00:00:00Z' where id=$1`, [first[0].id || id(1)]);
        await backend.db.query(`update public.contacts set updated_at='2026-01-01T00:00:00Z' where id=$1`, [id(TOTAL)]);
        return { ok: true, status: 200, json: async () => first, text: async () => JSON.stringify(first) };
      }
      return reply;
    };
    try { return await reader(); } finally { globalThis.fetch = realFetch; }
  };
  // The old paging (offset over the functional order) is shown failing on the same scenario.
  const legacy = async () => {
    const result = [];
    for (let offset = 0; ; offset += 5) {
      const page = await rows(ctx, 'contacts', { select: 'id', environment: 'eq.preview', order: 'updated_at.asc', limit: '5', offset: String(offset) });
      result.push(...page);
      if (page.length < 5) return result;
    }
  };
  const old = await runWithChanges(legacy);
  assert.notEqual(new Set(old.map((row) => row.id)).size, TOTAL, 'a leitura antiga pula ou repete');
  await backend.db.query(`update public.contacts set updated_at='2026-09-20T12:00:00Z'`);
  const stable = await runWithChanges(() => allRows(ctx, 'contacts', { select: 'id,updated_at', environment: 'eq.preview', order: 'updated_at.asc' }, 5));
  assert.equal(stable.length, TOTAL);
  assert.equal(new Set(stable.map((row) => row.id)).size, TOTAL, 'nenhuma ficha pulada ou repetida');
});
