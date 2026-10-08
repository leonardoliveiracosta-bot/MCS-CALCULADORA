'use strict';

// Fixed read-only bundles, used only inside an authenticated boot. The JavaScript business
// rules still receive the same projections, row order and fresh data as allRows.
const { allRows, memoRead, rpc, orderComparator } = require('./panel-server');
const BUNDLES = {
  operational: (ctx) => { const env = "eq." + ctx.environment; return [
    ['journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_set_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
      environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
    }],
    ['contacts', { select: 'id,display_name,is_lead,location_text', environment: 'eq.' + ctx.environment }],
    ['contact_phones', { select: 'id,contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: 'eq.' + ctx.environment }],
    ['journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }],
    ['message_journeys', {
      select: 'journey_id,message_id',
      environment: 'eq.' + ctx.environment, undone_at:'is.null'
    }],
    ['messages', { select: 'id,chat_id,channel,direction,body_text,is_automatic,occurred_at_local,occurred_at_utc,time_uncertain,source_kind,whatsapp_delivered_at,whatsapp_read_at,created_at,undone_at', environment: 'eq.' + ctx.environment }],
    ['journey_checklist', { select: 'id,journey_id,point_number,point_label,status,completed_at', environment: 'eq.' + ctx.environment }],
    ['promises', { select: 'id,journey_id,message_id,promise_text,due_at,due_text,status,fulfilled_at,created_at', environment: 'eq.' + ctx.environment }],
    ['journey_divergences', { select: 'id,journey_id,field,status,created_at,operational_declaration_id', environment: 'eq.' + ctx.environment }],
    ['units', { select: 'id,journey_id,vehicle_text,details_json,presented_at,last_customer_response_at,status,decline_reason,updated_at', environment: 'eq.' + ctx.environment }],
    ['journey_alert_suppressions', { select: 'id,journey_id,kind,action,until_at,created_at,cancelled_at', environment: 'eq.' + ctx.environment }],
    ['journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }],
    ['whatsapp_user_ids', { select: 'contact_id,username', environment: 'eq.' + ctx.environment }],
  ]; },
  buscas: (ctx) => { const env = "eq." + ctx.environment; return [
    ['journeys', { select: 'id,contact_id,reference_code,source,stage,status,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,qualified_at,closed_at,vehicle_text,created_at,updated_at', environment: env, order: 'updated_at.desc' }],
    ['contacts', { select: 'id,display_name,is_lead,location_text', environment: env }],
    ['contact_phones', { select: 'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: env }],
    ['journey_refs', { select: 'journey_id,ref_code', environment: env }],
    ['journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: env }],
    ['calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }],
    ['calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: env }],
    ['panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: env, cleared_at: 'is.null' }],
    ['message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null' }],
    ['messages', { select: 'id,direction,channel,occurred_at_utc,occurred_at_local,source_kind,created_at,undone_at', environment: env }],
  ]; },
};
const KEYS = { whatsapp_user_ids: ['environment', 'bsuid'] };

async function readBundle(ctx, name, read = allRows) {
  const specs = BUNDLES[name](ctx);
  const fallback = () => Promise.all(specs.map(([table, params]) => read(ctx, table, params)));
  if (!ctx.readCache || read !== allRows) return fallback();
  return memoRead(ctx, 'boot-bundle:' + name, async () => {
    try {
      const result = await rpc(ctx, 'panel_boot_read_bundle', { p_environment: ctx.environment, p_bundle: name });
      if (result?.version !== 1 || !Array.isArray(result.rows) || result.rows.length !== specs.length || result.rows.some(rows => !Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row)))) throw new Error('BOOT_BUNDLE_INVALID');
      return result.rows.map((rows, index) => {
        const [table, params] = specs[index];
        const fields = params.select.split(',');
        if (rows.some(row => fields.some(field => !Object.hasOwn(row, field)))) throw new Error('BOOT_BUNDLE_COLUMNS_MISSING');
        rows.sort(orderComparator(params.order || '', KEYS[table] || ['id']));
        return rows.map(row => Object.fromEntries(fields.map(field => [field, row[field]])));
      });
    } catch (error) {
      // No partial or empty substitute: an unavailable bundle uses the complete old reads.
      console.warn('[boot-bundle-fallback]', name, error?.code || error?.message);
      return fallback();
    }
  });
}
// The identical calculator reads in HOJE and search stages share the BUSCAS transport too.
// A different projection, filter or sort always keeps its original reader.
function readBootSource(ctx, table, params, read = allRows) {
  if (ctx.readCache && read === allRows) {
    const index = BUNDLES.buscas(ctx).findIndex(([name, spec]) => name === table
      && Object.keys(spec).length === Object.keys(params).length
      && Object.entries(spec).every(([key, value]) => params[key] === value));
    if (index >= 0) return readBundle(ctx, 'buscas', read).then(rows => rows[index]);
  }
  return read(ctx, table, params);
}
module.exports = { BUNDLES, readBundle, readBootSource };
