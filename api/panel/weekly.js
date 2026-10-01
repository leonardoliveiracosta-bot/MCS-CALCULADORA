'use strict';
const {allRows,requirePanel,send}=require('../../panel-server');
const {buildWeeklySummary}=require('../../panel-weekly');
const {toggleEnabled}=require('../../panel-domain');
const {outOfFunnelIndex}=require('../../panel-triage');

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const ctx=await requirePanel(req,res);if(!ctx)return;
  try{
    const [journeys,contacts,messageLinks,messages,units,dispositions,toggles,refs]=await Promise.all([
      allRows(ctx,'journeys',{select:'id,contact_id,reference_code,source,status,created_at',environment:'eq.'+ctx.environment}),
      allRows(ctx,'contacts',{select:'id,is_lead',environment:'eq.'+ctx.environment}),
      allRows(ctx,'message_journeys',{select:'journey_id,message_id,undone_at',environment:'eq.'+ctx.environment}),
      allRows(ctx,'messages',{select:'id,direction,is_automatic,source_kind,occurred_at_utc,occurred_at_local,created_at,undone_at',environment:'eq.'+ctx.environment}),
      allRows(ctx,'units',{select:'journey_id,presented_at',environment:'eq.'+ctx.environment}),
      allRows(ctx,'panel_item_dispositions',{select:'status,discard_reason,updated_at,cleared_at',environment:'eq.'+ctx.environment}),
      allRows(ctx,'journey_toggle_states',{select:'journey_id,enabled',environment:'eq.'+ctx.environment}),
      allRows(ctx,'journey_refs',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment})
    ]);
    // Triagem: a ficha out of the commercial funnel leaves the summary too (same rule as CLIENTES/HOJE).
    const triageOut=await outOfFunnelIndex(ctx,journeys,refs);
    const contactById=new Map(contacts.map((item)=>[item.id,item])),toggleByJourney=new Map(toggles.map((item)=>[item.journey_id,item]));
    const visible=journeys.filter((item)=>contactById.get(item.contact_id)?.is_lead!==false&&!triageOut.has(item.id)).map((item)=>({...item,enabled:toggleEnabled(item.status,toggleByJourney.get(item.id))}));
    return send(res,200,buildWeeklySummary({journeys:visible,messageLinks,messages,units,dispositions}));
  }catch(_){return send(res,500,{error:'PANEL_WEEKLY_ERROR'});}
};
