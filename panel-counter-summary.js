'use strict';

// These projections use the same final request list and demand counts as the tabs.
// A summary must never be primed under the URL of a complete list.
function requestsSummary(items) {
  return {
    summary: true,
    requestCount: (items || []).filter((item) => item.state !== 'PRECISA_DETALHE' && item.state !== 'PRECISA_REVISAO' && ['VALOR', 'CARRO'].includes(item.searchMode)).length,
    items: (items || []).filter((item) => item.state === 'PRECISA_DETALHE').map((item) => ({
      key: item.key, state: item.state, person: item.person, lacksText: item.lacksText,
      missing: item.missing, criteriaText: item.criteriaText, source: item.source
    }))
  };
}
function optionsSummary(demands) {
  return { summary: true, peopleWithOptions: new Set((demands || []).filter((demand) => demand.matchCount > 0)
    .map((demand) => demand.journeyId ? 'ficha:' + demand.journeyId : 'ref:' + String(demand.ref || '').toUpperCase())).size };
}
module.exports = { requestsSummary, optionsSummary };
