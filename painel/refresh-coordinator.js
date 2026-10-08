(function attachRefreshCoordinator(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.MCSRefresh = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
  'use strict';

  // Várias abas do painel abertas ao mesmo tempo não multiplicam as consultas:
  //  * só UMA aba visível (a líder) faz a atualização automática; abas ocultas nunca consultam;
  //  * a liderança é um aluguel curto no localStorage, avisado às outras abas por BroadcastChannel;
  //    quando a líder fica oculta ou fecha, outra aba visível assume;
  //  * uma atualização nunca começa enquanto a anterior está rodando, e depois de erro o intervalo
  //    dobra (até o teto) em vez de insistir;
  //  * requisições iguais em andamento são compartilhadas, e uma resposta recente é reaproveitada.
  // Ações do operador (clicar, salvar, trocar de aba) continuam funcionando em qualquer aba.
  const LEASE_MS = 15000;
  const RENEW_MS = 5000;
  const LEASE_KEY = 'mcs_panel_refresh_leader';

  const randomId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

  function safeStorage(storage) {
    return {
      get(key) { try { return storage ? storage.getItem(key) : null; } catch (_) { return null; } },
      set(key, value) { try { if (storage) storage.setItem(key, value); return true; } catch (_) { return false; } },
      remove(key) { try { if (storage) storage.removeItem(key); } catch (_) { /* sem armazenamento: cada aba decide sozinha */ } }
    };
  }

  function createCoordinator(options = {}) {
    const id = options.id || randomId();
    const storage = safeStorage(options.storage);
    const doc = options.document || null;
    const now = options.now || (() => Date.now());
    const timers = options.timers || { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (handle) => clearInterval(handle) };
    const channel = options.channel || null;
    const key = options.key || LEASE_KEY;
    const listeners = new Set();
    let renewTimer = null;
    let stopped = false;
    let lastLeader = false;
    // Without usable storage (private mode, blocked site data) every tab decides alone, as before.
    let storageUsable = storage.set('__mcs_probe__', '1');
    if (storageUsable) storage.remove('__mcs_probe__');

    const visible = () => !doc || doc.visibilityState !== 'hidden';
    const readLease = () => {
      const raw = storage.get(key);
      if (!raw) return null;
      try { const lease = JSON.parse(raw); return lease && typeof lease.id === 'string' && Number.isFinite(lease.until) ? lease : null; } catch (_) { return null; }
    };
    const notify = () => {
      const leader = isLeader();
      if (leader !== lastLeader) { lastLeader = leader; listeners.forEach((listener) => { try { listener(leader); } catch (_) { /* nada */ } }); }
    };
    function tryAcquire() {
      if (stopped || !visible()) { notify(); return false; }
      const lease = readLease();
      if (!lease || lease.until < now() || lease.id === id) {
        if (!storage.set(key, JSON.stringify({ id, until: now() + LEASE_MS }))) storageUsable = false;
      }
      notify();
      return isLeader();
    }
    function release() {
      const lease = readLease();
      if (lease && lease.id === id) {
        storage.remove(key);
        if (channel) { try { channel.postMessage({ type: 'released', id }); } catch (_) { /* nada */ } }
      }
      notify();
    }
    function isLeader() {
      if (stopped || !visible()) return false;
      if (!storageUsable) return true;
      const lease = readLease();
      return Boolean(lease && lease.id === id && lease.until >= now());
    }
    const onVisibility = () => { if (visible()) tryAcquire(); else release(); };
    const onMessage = (event) => { const data = event && event.data; if (data && data.type === 'released' && data.id !== id) tryAcquire(); };
    const onUnload = () => release();

    function start() {
      stopped = false;
      if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
      if (channel) { if (channel.addEventListener) channel.addEventListener('message', onMessage); else channel.onmessage = onMessage; }
      if (options.window && options.window.addEventListener) options.window.addEventListener('pagehide', onUnload);
      tryAcquire();
      renewTimer = timers.setInterval(() => tryAcquire(), RENEW_MS);
      return api;
    }
    function stop() {
      release();
      stopped = true;
      if (renewTimer) timers.clearInterval(renewTimer);
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
      if (channel && channel.removeEventListener) channel.removeEventListener('message', onMessage);
    }
    const api = { id, start, stop, isLeader, tryAcquire, release, onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    return api;
  }

  // Atualização automática: só na aba líder, uma por vez, com espera maior depois de erro.
  function createScheduler(options) {
    const intervalMs = options.intervalMs;
    const maxBackoffMs = options.maxBackoffMs || intervalMs * 8;
    const timers = options.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle) };
    const coordinator = options.coordinator;
    let timer = null, running = null, failures = 0, stopped = true, lastSuccessAt = null, lastFailureAt = null;
    const delay = () => failures ? Math.min(intervalMs * Math.pow(2, failures), maxBackoffMs) : intervalMs;
    const schedule = () => { if (stopped) return; if (timer) timers.clearTimeout(timer); timer = timers.setTimeout(tick, delay()); };
    async function execute() {
      if (running) return running;
      running = (async () => {
        try { await options.run(); failures = 0; lastSuccessAt = Date.now(); if (options.onSuccess) options.onSuccess(lastSuccessAt); }
        catch (failure) { failures += 1; lastFailureAt = Date.now(); if (options.onFailure) options.onFailure(failure, delay()); }
        finally { running = null; }
      })();
      return running;
    }
    async function tick() {
      timer = null;
      if (stopped) return;
      // Hidden or not the leader: nothing is asked; the check repeats at the normal interval.
      if ((coordinator && !coordinator.isLeader()) || (options.isBusy && options.isBusy())) { schedule(); return; }
      await execute();
      schedule();
    }
    return {
      start() { stopped = false; schedule(); return this; },
      stop() { stopped = true; if (timer) timers.clearTimeout(timer); timer = null; },
      // The operator asked ("Tentar novamente"): runs now in this tab, still one at a time.
      async runNow() { await execute(); schedule(); },
      state: () => ({ failures, running: Boolean(running), nextDelayMs: delay(), lastSuccessAt, lastFailureAt })
    };
  }

  // Requisições iguais em andamento viram uma só; uma resposta recente pode ser reaproveitada.
  function createRequestPool(options = {}) {
    const now = options.now || (() => Date.now());
    const inflight = new Map();
    const cache = new Map();
    let epoch = 0;
    return {
      get(key, run, config = {}) {
        const ttl = Number(config.ttlMs) || 0;
        const cached = cache.get(key);
        if (ttl && cached && now() - cached.at <= ttl) return Promise.resolve(cached.value);
        if (inflight.has(key)) return inflight.get(key);
        const startedEpoch = epoch;
        const promise = Promise.resolve().then(run).then((value) => { if (epoch === startedEpoch) cache.set(key, { value, at: now() }); return value; }).finally(() => { if (inflight.get(key) === promise) inflight.delete(key); });
        inflight.set(key, promise);
        return promise;
      },
      // An answer already in hand (the panel's single opening call) serves the next identical GET of the ttl.
      prime(key, value) { cache.set(key, { value, at: now() }); },
      invalidate(prefix) { ++epoch; if (!prefix) { cache.clear(); inflight.clear(); return; } [...cache.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => cache.delete(key)); [...inflight.keys()].filter((key) => key.startsWith(prefix)).forEach((key) => inflight.delete(key)); },
      inflightCount: () => inflight.size
    };
  }

  // Contador: antes da primeira resposta mostra "—"; zero só com resposta válida que diga zero; uma
  // falha mantém o último valor confirmado (marcado como desatualizado) e nunca vira zero.
  function counterText(entry) {
    return entry && Number.isFinite(entry.value) ? String(entry.value) : '—';
  }
  function nextCounter(previous, outcome) {
    if (outcome && outcome.ok === true && Number.isFinite(Number(outcome.value)) && Number(outcome.value) >= 0) return { value: Number(outcome.value), stale: false, at: outcome.at || Date.now() };
    return previous ? { ...previous, stale: true } : { value: null, stale: true, at: null };
  }

  return { LEASE_MS, RENEW_MS, LEASE_KEY, createCoordinator, createScheduler, createRequestPool, counterText, nextCounter };
}));
