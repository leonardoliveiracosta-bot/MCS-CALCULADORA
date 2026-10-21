'use strict';

const { journeyFor, orders } = require('../../panel-lead');
const { REF_RE } = require('../../panel-domain');
const { isUuid, jsonBody, requirePanel, rows, send, supabase } = require('../../panel-server');

async function targetFor(ctx, input) {
  const id = String(input.journeyId || '');
  const ref = String(input.ref || '').trim().toUpperCase();
  if (id && !isUuid(id)) return null;
  const journey = await journeyFor(ctx, id ? null : REF_RE.test(ref) ? ref : null, id);
  if (id && !journey) return null;
  if (journey) return { journeyId:journey.id, ref:REF_RE.test(journey.reference_code || '') ? journey.reference_code : null };
  if (!REF_RE.test(ref) || !(await orders(ctx, ref)).some(order => order.ref === ref)) return null;
  return { journeyId:null, ref };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  if (!['GET','POST'].includes(req.method)) return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  try {
    const input = req.method === 'POST' ? await jsonBody(req,4096) : req.query || {};
    if (req.method === 'POST' && !isUuid(input.openingId)) return send(res,400,{error:'OPENING_ID_REQUIRED'});
    const target = await targetFor(ctx,input);
    if (!target) return send(res,404,{error:'LEAD_NOT_FOUND'});
    if (req.method === 'POST') {
      // The browser supplies only the opening token and the target. Identity and time are server-owned.
      const saved = await supabase(ctx.config.url,ctx.config.secretKey,
        '/rest/v1/panel_lead_accesses?on_conflict=environment,created_by,opening_id',{
          method:'POST',headers:{'content-type':'application/json',prefer:'resolution=ignore-duplicates,return=representation'},
          body:JSON.stringify({environment:ctx.environment,opening_id:input.openingId,journey_id:target.journeyId,ref_code:target.ref,
            created_by:ctx.panel.id,login_email:ctx.panel.email,display_name:String(ctx.panel.display_name || ctx.panel.email).trim()})
        });
      if (!saved.length) {
        const [previous] = await rows(ctx,'panel_lead_accesses',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment,
          created_by:'eq.'+ctx.panel.id,opening_id:'eq.'+input.openingId,limit:'1'});
        const sameTarget=previous&&(previous.journey_id&&target.journeyId
          ? previous.journey_id===target.journeyId : previous.ref_code&&previous.ref_code===target.ref);
        if (!sameTarget) return send(res,409,{error:'OPENING_TARGET_CHANGED'});
      }
      return send(res,200,{ok:true});
    }
    const offset = Number(input.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return send(res,400,{error:'PAGE_INVALID'});
    const until = input.until ? String(input.until) : new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T/.test(until) || !Number.isFinite(Date.parse(until))) return send(res,400,{error:'PAGE_INVALID'});
    let scope = {ref_code:'eq.'+target.ref};
    if (target.journeyId) {
      const linked = await rows(ctx,'journey_refs',{select:'ref_code',environment:'eq.'+ctx.environment,journey_id:'eq.'+target.journeyId});
      const refs = [...new Set([target.ref,...linked.map(row=>row.ref_code)].filter(ref=>REF_RE.test(ref || '')))];
      scope = {or:'(journey_id.eq.'+target.journeyId+refs.map(ref=>',ref_code.eq.'+ref).join('')+')'};
    }
    const found = await rows(ctx,'panel_lead_accesses',{select:'id,login_email,display_name,accessed_at',environment:'eq.'+ctx.environment,
      ...scope,accessed_at:'lte.'+until,order:'accessed_at.desc,id.desc',limit:'31',offset:String(offset)});
    return send(res,200,{items:found.slice(0,30),nextOffset:found.length>30 ? offset+30 : null,until,timezone:'America/New_York'});
  } catch (error) {
    return send(res,error?.message==='PAYLOAD_TOO_LARGE'?413:500,{error:'LEAD_ACCESS_FAILED'});
  }
};
