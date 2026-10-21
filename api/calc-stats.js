'use strict';
// Contadores públicos dos últimos 30 dias. A home pede os eventos; a capa antiga mantém suas sessões.
// A conta é feita no banco (calc_public_stats); a resposta fica em cache por 10 minutos na Vercel.
const { configuration, supabase } = require('../panel-server');

const DAYS = 30;
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') { res.setHeader('Cache-Control', 'no-store'); return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' }); }
  const config = configuration();
  if (!config) { res.setHeader('Cache-Control', 'no-store'); return res.status(503).json({ error: 'SERVICE_UNAVAILABLE' }); }
  try {
    const scenariosOnly = req.query?.metric === 'scenarios';
    const stats = await supabase(config.url, config.secretKey, '/rest/v1/rpc/' + (scenariosOnly ? 'calc_public_scenarios' : 'calc_public_stats'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_days: DAYS })
    });
    if (scenariosOnly) {
      if (!Number.isSafeInteger(stats?.scenarios) || stats.scenarios < 0) throw new Error('SCENARIOS_INVALID');
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
      return res.status(200).json({ days: DAYS, scenarios: stats.scenarios });
    }
    const total = Math.max(0, Math.floor(Number(stats && stats.total) || 0));
    const ready = Math.max(0, Math.min(total, Math.floor(Number(stats && stats.ready) || 0)));
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ days: DAYS, total, ready });
  } catch (error) {
    console.error('[calc-stats]', String(error && error.message || error));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'STATS_UNAVAILABLE' });
  }
};
