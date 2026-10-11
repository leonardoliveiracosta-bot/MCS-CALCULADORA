'use strict';
const {allRows,rpc}=require('./panel-server');
const {latestActiveUpload}=require('./panel-manheim-state');
const {loadBuscasBase}=require('./panel-buscas');
const {demandContext}=require('./panel-buscas-view');
const batch=require('./panel-manheim-batch');
const {comparableEntries}=require('./panel-rematch');
const vehicleMatch=require('./vehicle-match');
const catalog=require('./vehicle-catalog');

const services={allRows,rpc,latestActiveUpload,loadBuscasBase};
// Same criteria and matcher as the manual options list; no model call or human actor.
// The service RPC only adds missing rows. Existing selections, prices and matches stay intact.
async function prepareOptions(ctx,jobId,key,deps=services){
  const upload=await deps.latestActiveUpload(ctx,'id');
  if(!upload)return {reason:'NO_OPTIONS'};
  const base=await deps.loadBuscasBase(ctx);
  const target=demandContext(base).targetByKey.get(key);
  if(!target||target.reactivation)return {reason:'REQUEST_NOT_ACTIVE'};
  const [snapshot]=batch.snapshotTargets([target]);
  const makes=snapshot.wishes.some(w=>!w.make)?[]:[...new Set(snapshot.wishes.flatMap(w=>catalog.inventoryMakes(w.make,w.model)))];
  const filter=makes.length?{make_key:'in.('+makes.concat(['']).map(m=>'"'+m.replace(/"/g,'')+'"').join(',')+')'}:{};
  const cars=await deps.allRows(ctx,'manheim_vehicles_current',{select:'id,row_fingerprint,vehicle_json,make_key,mmr_cents',environment:'eq.'+ctx.environment,upload_id:'eq.'+upload.id,undone_at:'is.null',...filter});
  const entries=comparableEntries(cars.map(c=>({fingerprint:c.row_fingerprint,makeKey:c.make_key||'',mmrCents:vehicleMatch.validMmrCents(c.mmr_cents??c.vehicle_json?.mmrCents),vehicle:c.vehicle_json||{}})));
  const matches=[...batch.matchChunk(entries,[snapshot]),...batch.nearRows(entries,snapshot)];
  return deps.rpc(ctx,'panel_whatsapp_auto_options_add_matches',{p_environment:ctx.environment,p_job:jobId,p_upload:upload.id,p_matches:matches});
}
module.exports={prepareOptions};
