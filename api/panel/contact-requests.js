'use strict';
const { requirePanel, rows, jsonBody, isUuid, supabase, send } = require('../../panel-server');
const financeModel=require('../../finance-model');
const SELECT = 'id,request_key,name,phone_e164,channel,language,source,status,created_at,handled_at';
module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  try {
    if (req.method === 'GET') {
      const offset = Number(req.query?.offset || 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) return send(res, 400, { error: 'CONTACT_PAGE_INVALID' });
      const [open, recent] = await Promise.all([
        rows(ctx, 'site_contact_requests', { select: SELECT, environment: 'eq.' + ctx.environment, status: 'eq.OPEN', order: 'created_at.desc,id.desc', offset: String(offset), limit: '51' }),
        offset ? Promise.resolve([]) : rows(ctx, 'site_contact_requests', { select: SELECT, environment: 'eq.' + ctx.environment, status: 'neq.OPEN', handled_at: 'gte.' + new Date(Date.now() - 7 * 86400000).toISOString(), order: 'handled_at.desc,id.desc', limit: '20' })
      ]);
      const items=open.slice(0,50),requests=items.concat(recent);
      const ids=[...new Set(requests.filter(item=>item.source==='finance'&&isUuid(item.request_key)).map(item=>item.request_key))];
      const runs=ids.length?await rows(ctx,'calc_runs',{select:'id,dados',id:'in.('+ids.join(',')+')',is_test:'eq.'+(ctx.environment!=='production'),limit:String(ids.length)}):[];
      const byId=new Map(runs.map(run=>[run.id,run.dados]));
      const decorate=item=>{
        const {request_key,...result}=item;
        if(item.source!=='finance')return result;
        const data=byId.get(request_key);
        result.finance=data?.tipo==='finance'&&/^[A-HJ-NP-Z2-9]{5}$/.test(data.ref)&&financeModel.valid(data.finance)?{ref:data.ref,details:financeModel.details(data.finance,'pt')}:null;
        return result;
      };
      return send(res, 200, { items: items.map(decorate), recent:recent.map(decorate), nextOffset: open.length > 50 ? offset + 50 : null });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 4096);
    if (!isUuid(body.id) || !['OPEN', 'CONTACTED', 'ARCHIVED'].includes(body.status) || !['OPEN', 'CONTACTED', 'ARCHIVED'].includes(body.expectedStatus)) return send(res, 400, { error: 'CONTACT_ACTION_INVALID' });
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/site_contact_request_status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment, p_id: body.id, p_status: body.status, p_expected_status: body.expectedStatus, p_actor: ctx.panel.id }) });
    return send(res, 200, { ok: true });
  } catch (error) {
    if (error.code === 'CONTACT_NOT_FOUND') return send(res, 404, { error: 'CONTACT_NOT_FOUND' });
    if (error.code === 'CONTACT_STATUS_CHANGED') return send(res, 409, { error: 'CONTACT_STATUS_CHANGED' });
    return send(res, 503, { error: 'CONTACT_REQUESTS_UNAVAILABLE' });
  }
};
