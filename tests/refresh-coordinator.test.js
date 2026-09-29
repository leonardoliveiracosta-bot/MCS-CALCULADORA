'use strict';

// Várias abas do painel: só a aba visível líder faz a atualização automática; abas ocultas não
// consultam; a liderança passa para outra aba visível quando a líder fica oculta; nunca duas
// atualizações ao mesmo tempo; espera maior depois de erro; pedidos iguais em andamento viram um só;
// contador nunca mostra zero sem resposta. Relógio, armazenamento e canal simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const refresh = require('../painel/refresh-coordinator');

function world() {
  let now = 0;
  const timers = [];
  let seq = 0;
  const store = new Map();
  const listeners = new Set();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const api = {
    now: () => now,
    storage: { getItem: (key) => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) },
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
      clearTimeout: (id) => { const index = timers.findIndex((timer) => timer.id === id); if (index >= 0) timers.splice(index, 1); },
      setInterval: (fn, ms) => { const id = ++seq; const tick = () => { fn(); timers.push({ id, at: now + ms, fn: tick }); }; timers.push({ id, at: now + ms, fn: tick }); return id; },
      clearInterval: (id) => { for (let index = timers.length - 1; index >= 0; index -= 1) if (timers[index].id === id) timers.splice(index, 1); }
    },
    channel(owner) {
      const handlers = new Set();
      const channel = { postMessage: (data) => listeners.forEach((entry) => { if (entry.owner !== owner) entry.handlers.forEach((handler) => handler({ data })); }), addEventListener: (_type, handler) => handlers.add(handler), removeEventListener: (_type, handler) => handlers.delete(handler) };
      listeners.add({ owner, handlers });
      return channel;
    },
    document(state) {
      const handlers = new Set();
      return { visibilityState: state, addEventListener: (_type, handler) => handlers.add(handler), removeEventListener: (_type, handler) => handlers.delete(handler), set(stateNext) { this.visibilityState = stateNext; handlers.forEach((handler) => handler()); } };
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((left, right) => left.at - right.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        now = next.at;
        next.fn();
        await flush(); await flush();
      }
      now = end;
      await flush();
    }
  };
  return api;
}

function tab(env, name, visibility, run) {
  const doc = env.document(visibility);
  // Timers of this tab only: a crashed tab stops every timer without releasing anything.
  const life = { dead: false };
  const guard = (fn) => () => { if (!life.dead) fn(); };
  const timers = { setTimeout: (fn, ms) => env.timers.setTimeout(guard(fn), ms), clearTimeout: env.timers.clearTimeout, setInterval: (fn, ms) => env.timers.setInterval(guard(fn), ms), clearInterval: env.timers.clearInterval };
  const coordinator = refresh.createCoordinator({ id: name, storage: env.storage, document: doc, channel: env.channel(name), now: env.now, timers }).start();
  const runs = { count: 0 };
  const scheduler = refresh.createScheduler({ coordinator, intervalMs: 1000, maxBackoffMs: 8000, timers, run: run || (async () => { runs.count += 1; }) }).start();
  return { doc, coordinator, scheduler, runs, crash() { life.dead = true; } };
}

test('três abas, duas ocultas: só a visível faz polling e o total não triplica', async () => {
  const env = world();
  const a = tab(env, 'A', 'visible'), b = tab(env, 'B', 'hidden'), c = tab(env, 'C', 'hidden');
  await env.advance(10000);
  assert.equal(b.runs.count, 0, 'aba oculta B não consulta');
  assert.equal(c.runs.count, 0, 'aba oculta C não consulta');
  assert.ok(a.runs.count >= 9 && a.runs.count <= 10, `aba visível: ${a.runs.count}`);
  assert.equal(a.runs.count + b.runs.count + c.runs.count, a.runs.count, 'uma aba só, não três');
});

test('a líder fica oculta: outra aba visível assume com segurança; duas visíveis não dobram', async () => {
  const env = world();
  const a = tab(env, 'A', 'visible'), b = tab(env, 'B', 'hidden'), c = tab(env, 'C', 'hidden');
  await env.advance(3000);
  const before = a.runs.count;
  c.doc.set('visible');
  a.doc.set('hidden');
  await env.advance(5000);
  assert.equal(a.runs.count, before, 'a antiga líder parou');
  assert.ok(c.runs.count >= 4, `C assumiu: ${c.runs.count}`);
  assert.equal(b.runs.count, 0);
  // Now two visible tabs (A comes back): still only one polls.
  a.doc.set('visible');
  const snapshot = { a: a.runs.count, c: c.runs.count };
  await env.advance(10000);
  const deltaA = a.runs.count - snapshot.a, deltaC = c.runs.count - snapshot.c;
  assert.ok(deltaA === 0 || deltaC === 0, `só uma consulta: A+${deltaA} C+${deltaC}`);
  assert.ok(deltaA + deltaC >= 9);
});

test('a líder fecha (para sem avisar): o aluguel vence e outra aba visível assume', async () => {
  const env = world();
  const a = tab(env, 'A', 'visible');
  const b = tab(env, 'B', 'visible');
  await env.advance(2000);
  const leader = a.coordinator.isLeader() ? a : b, other = leader === a ? b : a;
  // A crashed tab: its timers stop and it never releases the lease.
  leader.crash();
  const frozen = other.runs.count;
  await env.advance(refresh.LEASE_MS + 5000);
  assert.ok(other.runs.count > frozen, 'a outra aba passou a atualizar');
});

test('nunca duas atualizações ao mesmo tempo; depois de erro a espera dobra até o teto', async () => {
  const env = world();
  let active = 0, peak = 0, calls = 0, release;
  const slow = async () => { calls += 1; active += 1; peak = Math.max(peak, active); await new Promise((resolve) => { release = resolve; }); active -= 1; };
  const a = tab(env, 'A', 'visible', slow);
  await env.advance(5000);
  assert.equal(calls, 1, 'a próxima só começa quando a anterior termina');
  assert.equal(peak, 1);
  release(); await env.advance(0);
  // Failures: 1s -> 2s -> 4s -> 8s (ceiling).
  const envFail = world();
  const moments = [];
  const failing = tab(envFail, 'F', 'visible', async () => { moments.push(envFail.now()); throw new Error('503'); });
  await envFail.advance(40000);
  const gaps = moments.slice(1).map((moment, index) => moment - moments[index]);
  assert.deepEqual(gaps.slice(0, 4), [2000, 4000, 8000, 8000]);
  assert.equal(failing.scheduler.state().failures, moments.length);
  assert.ok(a);
});

test('"Tentar novamente" roda na hora, mesmo numa aba que não é líder, uma vez só', async () => {
  const env = world();
  const hidden = tab(env, 'H', 'hidden');
  await Promise.all([hidden.scheduler.runNow(), hidden.scheduler.runNow()]);
  assert.equal(hidden.runs.count, 1);
});

test('pedidos iguais em andamento viram um só e uma resposta recente é reaproveitada', async () => {
  let now = 0, calls = 0, resolve;
  const pool = refresh.createRequestPool({ now: () => now });
  const fetcher = () => { calls += 1; return new Promise((done) => { resolve = done; }); };
  const first = pool.get('/api/panel/today', fetcher, { ttlMs: 10000 });
  const second = pool.get('/api/panel/today', fetcher, { ttlMs: 10000 });
  await Promise.resolve();
  resolve({ items: [1] });
  assert.deepEqual(await first, { items: [1] });
  assert.equal(await second, await first);
  assert.equal(calls, 1);
  now = 5000;
  await pool.get('/api/panel/today', fetcher, { ttlMs: 10000 });
  assert.equal(calls, 1, 'resposta de 5 s atrás reaproveitada');
  now = 20000;
  const third = pool.get('/api/panel/today', fetcher, { ttlMs: 10000 });
  await Promise.resolve();
  resolve({ items: [] });
  await third;
  assert.equal(calls, 2);
  // A failure is not cached.
  const failing = pool.get('/api/panel/entry', async () => { throw new Error('x'); }, { ttlMs: 10000 });
  await assert.rejects(failing);
  let later = 0;
  await pool.get('/api/panel/entry', async () => { later += 1; return {}; }, { ttlMs: 10000 });
  assert.equal(later, 1);
});

test('contador: "—" antes da resposta, zero só com resposta que diz zero, falha mantém o último', () => {
  assert.equal(refresh.counterText(undefined), '—');
  const failedFirst = refresh.nextCounter(undefined, { ok: false });
  assert.equal(refresh.counterText(failedFirst), '—', 'falha antes da primeira resposta nunca vira zero');
  const confirmed = refresh.nextCounter(failedFirst, { ok: true, value: 12, at: 1 });
  assert.deepEqual([refresh.counterText(confirmed), confirmed.stale], ['12', false]);
  const failed = refresh.nextCounter(confirmed, { ok: false });
  assert.deepEqual([refresh.counterText(failed), failed.stale], ['12', true], 'mantém o último valor confirmado, marcado');
  const zero = refresh.nextCounter(failed, { ok: true, value: 0, at: 2 });
  assert.deepEqual([refresh.counterText(zero), zero.stale], ['0', false], 'zero só quando a resposta diz zero');
});

test('sem armazenamento (navegação privada bloqueada): a aba decide sozinha, como antes', async () => {
  const env = world();
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  const doc = env.document('visible');
  const coordinator = refresh.createCoordinator({ id: 'X', storage: broken, document: doc, now: env.now, timers: env.timers }).start();
  assert.equal(coordinator.isLeader(), true);
  doc.set('hidden');
  assert.equal(coordinator.isLeader(), false, 'oculta nunca consulta');
});
