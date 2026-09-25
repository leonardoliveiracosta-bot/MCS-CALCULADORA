-- Cover foreign keys introduced by panel_manheim_match. Additive and idempotent.

create index if not exists journey_toggle_states_journey_id_idx
  on public.journey_toggle_states(journey_id);
create index if not exists journey_toggle_states_switched_by_idx
  on public.journey_toggle_states(switched_by);
create index if not exists manheim_uploads_created_by_idx
  on public.manheim_uploads(created_by);
create index if not exists manheim_matches_upload_id_idx
  on public.manheim_matches(upload_id);
create index if not exists manheim_matches_journey_id_idx
  on public.manheim_matches(journey_id);
create index if not exists manheim_matches_presented_unit_id_idx
  on public.manheim_matches(presented_unit_id)
  where presented_unit_id is not null;
