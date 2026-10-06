'use strict';

// BUSCAS simulado no formato do servidor: o resumo (records?view=manheim) não traz carros; cada
// demanda traz as próprias contagens; as opções vêm por página (manheim-options), com cursor.
// Recebe os dados de teste no formato antigo (demands + matches) e responde no formato novo.
function counted(data) {
  const matches = data.matches || [];
  const keyOf = (match) => match.demandKey || (match.journey_id ? `journey:${match.journey_id}:${match.logical_mode}` : `ref:${String(match.calc_ref).trim()}:${match.logical_mode}`);
  return { matches, keyOf };
}

function asSummary(data) {
  const { matches, keyOf } = counted(data);
  const { matches: _matches, targets: _targets, ...rest } = data;
  return {
    ...rest,
    demands: (data.demands || []).map((demand) => {
      const own = matches.filter((match) => keyOf(match) === demand.key);
      // Like the server, the offer groups and the match count come from the same batch: no car left, no offer.
      const offer = own.length ? demand.offer || { lane: own.length, offLane: 0, incomplete: 0, selected: 0, selectedIds: [] } : { ...(demand.offer || { selected: 0, selectedIds: [] }), lane: 0, offLane: 0, incomplete: 0 };
      return { reactivation: false, stale: false, ...demand, offer, matchCount: own.length, bateCount: own.filter((match) => match.match_kind === 'BATE').length, porValorCount: own.filter((match) => match.match_kind === 'POR_VALOR').length, presentedCount: own.filter((match) => match.presented_unit_id).length };
    })
  };
}

function optionsPage(data, url) {
  const { matches, keyOf } = counted(data);
  const key = url.searchParams.get('key');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 10, 50);
  const start = Number(url.searchParams.get('cursor') || 0) || 0;
  // The groups of the ficha: every simulated car is in Lane/Run; the other groups and "selected" are empty.
  const group = url.searchParams.get('group');
  const own = (group && group !== 'LANE') || url.searchParams.get('selected') ? [] : matches.filter((match) => keyOf(match) === key);
  const page = own.slice(start, start + limit).map((match) => ({ fitsBid: null, alsoFitsFor: [], criteriaChanged: false, ...match, demandKey: key }));
  return { key, uploadId: data.upload && data.upload.id || null, options: page, nextCursor: start + limit < own.length ? String(start + limit) : null };
}

// Opens the options of every demand card on the page (as the operator would).
async function openAllOptions(page) {
  for (;;) {
    const toggle = page.locator('.manheim-options-toggle:not([disabled])').first();
    if (!(await toggle.count())) return;
    await toggle.click();
    await page.waitForTimeout(50);
  }
}

module.exports = { asSummary, optionsPage, openAllOptions };
