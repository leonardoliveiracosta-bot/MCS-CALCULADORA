'use strict';
// Carimbo de proveniência de cada carro mostrado em ENVIAR OPÇÕES:
//   { ficha, ref, tipo, criterios (hash), versao, lote, valido, motivo }
// Válido = o carro ainda serve ao critério atual do pedido, está no lote ativo e tem MMR válido. Qualquer troca de lote ou de
// critério invalida na hora (a conta é refeita a cada leitura, nunca guardada como verdade). Recalcular cria uma nova versão
// (manheim_demand_syncs guarda um hash por comparação) e o painel avisa; nada muda em silêncio.
const { allRows, rows } = require('./panel-server');
const { loadBuscasBase, liveMatchesFor } = require('./panel-buscas');
const { demandContext } = require('./panel-buscas-view');

const REASONS = {
  SEM_PEDIDO: 'O pedido deste carro não está mais ativo na ficha',
  LOTE_MUDOU: 'O lote ativo mudou: este carro é de um lote antigo',
  CRITERIO_MUDOU: 'O critério do pedido mudou: este carro não serve mais ao pedido atual',
  SEM_MMR: 'Carro sem MMR válido',
  TIPO_DIFERENTE: 'O carro foi comparado para outro tipo de busca (VALOR ou CARRO)'
};

const hasMmr = (match) => Number(match && match.vehicle_json && match.vehicle_json.parsed && match.vehicle_json.parsed.mmrCents) > 0;

// match: manheim_matches row; demand: the active demand of the same key (or null); hashes: criteria hashes compared, oldest first.
function stampOf({ match, demand, key, activeUploadId = null, hashes = [] }) {
  const mode = match && match.logical_mode || (demand && demand.mode) || null;
  const live = demand && match ? liveMatchesFor(match, [demand])[0] || null : null;
  let reason = null;
  if (!demand) reason = 'SEM_PEDIDO';
  else if (activeUploadId && match.upload_id && match.upload_id !== activeUploadId) reason = 'LOTE_MUDOU';
  else if (mode && demand.mode !== mode) reason = 'TIPO_DIFERENTE';
  else if (!hasMmr(match)) reason = 'SEM_MMR';
  else if (!live) reason = 'CRITERIO_MUDOU';
  const hash = demand && demand.criteriaHash || null;
  const index = hash ? hashes.indexOf(hash) : -1;
  return {
    journeyId: match && match.journey_id || (demand && demand.journeyId) || null, ref: match && match.calc_ref ? String(match.calc_ref).trim() : (demand && demand.ref) || null,
    type: mode, demandKey: key || (demand && demand.key) || null, criteriaHash: hash, version: index >= 0 ? index + 1 : null,
    uploadId: match && match.upload_id || null, valid: !reason, reason, reasonText: reason ? REASONS[reason] : null
  };
}

async function contextFor(ctx, loader = loadBuscasBase, build = demandContext) {
  const base = await loader(ctx, { allRows });
  const context = build(base);
  return { base, context };
}
async function hashesFor(ctx, uploadId, key, reader = rows) {
  if (!uploadId || !key) return [];
  const found = await reader(ctx, 'manheim_demand_syncs', { select: 'criteria_hash,synced_at', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId, demand_key: 'eq.' + key, order: 'synced_at.asc', limit: '50' }).catch(() => []);
  return (found || []).map((row) => row.criteria_hash);
}

// Gate for selecting a car and for generating a V1: every match must still be valid for its own demand.
// Returns null (all valid) or { code: 'MANHEIM_STAMP_INVALID', matchId, reason, text }.
async function gate(ctx, matchIds, deps = {}) {
  if (!matchIds || !matchIds.length) return null;
  const read = deps.rows || rows;
  const { latestActiveUpload } = require('./panel-manheim-state');
  const active = await (deps.latestActiveUpload || latestActiveUpload)(ctx, 'id');
  const { context } = await contextFor(ctx, deps.loadBase, deps.demandContext);
  for (const id of matchIds) {
    const [match] = await read(ctx, 'manheim_matches', { select: 'id,upload_id,journey_id,calc_ref,logical_mode,vehicle_json,demand_key,undone_at', environment: 'eq.' + ctx.environment, id: 'eq.' + id, limit: '1' });
    if (!match || match.undone_at) return { code: 'MANHEIM_STAMP_INVALID', matchId: id, reason: 'LOTE_MUDOU', text: REASONS.LOTE_MUDOU };
    const key = match.demand_key || (match.journey_id ? `journey:${match.journey_id}:${match.logical_mode}` : null);
    const demand = key ? context.listed.find((item) => item.key === key && item.active) || null : null;
    const stamp = stampOf({ match, demand, key, activeUploadId: active && active.id || null });
    if (!stamp.valid) return { code: stamp.reason === 'SEM_MMR' ? 'MANHEIM_MATCH_WITHOUT_MMR' : 'MANHEIM_STAMP_INVALID', matchId: id, reason: stamp.reason, text: stamp.reasonText };
  }
  return null;
}

module.exports = { REASONS, stampOf, gate, contextFor, hashesFor };
