-- Read-only boot transport. No business rules, writes, schema changes to tables or row limits.
create or replace function public.panel_boot_read_bundle(p_environment public.panel_environment, p_bundle text)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
begin
  case p_bundle
    when 'operational' then return jsonb_build_object('version', 1, 'rows', jsonb_build_array(
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","contact_id","reference_code","source","stage","status","vehicle_text","criteria_json","budget_cents","confirmed_total_ceiling_cents","payment_text","customer_deadline_at","customer_deadline_text","next_action_text","next_action_at","next_action_set_at","next_action_missing_since","last_effective_contact_at","search_started_at","qualified_at","closed_at","closed_reason","stage_frozen","created_at","updated_at" from public."journeys" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","display_name","is_lead","location_text" from public."contacts" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","contact_id","phone_e164","phone_raw","phone_owner","is_primary","is_current" from public."contact_phones" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "journey_id","ref_code","id" from public."journey_refs" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "journey_id","message_id","id" from public."message_journeys" where "environment" = p_environment and "undone_at" is null order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","chat_id","channel","direction","body_text","is_automatic","occurred_at_local","occurred_at_utc","time_uncertain","source_kind","whatsapp_delivered_at","whatsapp_read_at","created_at","undone_at" from public."messages" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","journey_id","point_number","point_label","status","completed_at" from public."journey_checklist" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","journey_id","message_id","promise_text","due_at","due_text","status","fulfilled_at","created_at" from public."promises" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","journey_id","field","status","created_at","operational_declaration_id" from public."journey_divergences" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","journey_id","vehicle_text","details_json","presented_at","last_customer_response_at","status","decline_reason","updated_at" from public."units" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","journey_id","kind","action","until_at","created_at","cancelled_at" from public."journey_alert_suppressions" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "journey_id","enabled","off_reason","switched_at","id" from public."journey_toggle_states" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "contact_id","username","environment","bsuid" from public."whatsapp_user_ids" where "environment" = p_environment order by "environment","bsuid") r)
    ));
    when 'buscas' then return jsonb_build_object('version', 1, 'rows', jsonb_build_array(
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","contact_id","reference_code","source","stage","status","criteria_json","budget_cents","confirmed_total_ceiling_cents","payment_text","customer_deadline_text","qualified_at","closed_at","vehicle_text","created_at","updated_at" from public."journeys" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","display_name","is_lead","location_text" from public."contacts" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "contact_id","phone_e164","phone_raw","phone_owner","is_primary","is_current","id" from public."contact_phones" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "journey_id","ref_code","id" from public."journey_refs" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "journey_id","enabled","off_reason","switched_at","id" from public."journey_toggle_states" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","created_at","zip","estado","lance","pagamento","dados","is_test" from public."calc_runs" order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "calc_sid","calc_ref","logical_mode","contact_id","journey_id","id" from public."calculator_request_links" where "environment" = p_environment order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "item_kind","item_key","status","discard_reason","updated_at","id" from public."panel_item_dispositions" where "environment" = p_environment and "cleared_at" is null order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "journey_id","message_id","id" from public."message_journeys" where "environment" = p_environment and "undone_at" is null order by "id") r),
      (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (select "id","direction","channel","occurred_at_utc","occurred_at_local","source_kind","created_at","undone_at" from public."messages" where "environment" = p_environment order by "id") r)
    ));
    else raise exception 'BOOT_BUNDLE_UNKNOWN';
  end case;
end;
$$;
revoke all on function public.panel_boot_read_bundle(public.panel_environment, text) from public, anon, authenticated;
grant execute on function public.panel_boot_read_bundle(public.panel_environment, text) to service_role;
