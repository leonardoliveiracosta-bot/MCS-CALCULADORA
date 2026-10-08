-- Read-only: both implementations use one MVCC snapshot and the same SQL now().
-- Only counts leave the database. Nested criteria/selection arrays are compared exactly.
with batches as materialized (
 select distinct environment,upload_id from public.manheim_matches where undone_at is null
), current_batch as materialized (
 select id from public.manheim_uploads where environment='production' and undone_at is null and activated_at is not null
 order by activated_at desc,id desc limit 1
), old_group as materialized (
 select b.environment,g.* from batches b cross join lateral public.panel_manheim_grouped_light(b.environment,b.upload_id) g
), new_group as materialized (
 select b.environment,g.* from batches b cross join lateral panel_internal.manheim_grouped_prepared(b.environment,b.upload_id) g
), group_diff as (
 (select * from old_group except all select * from new_group)
 union all
 (select * from new_group except all select * from old_group)
), old_overview as materialized (
 select public.panel_manheim_batch_overview('production',id) r from current_batch
), new_overview as materialized (
 select panel_internal.manheim_batch_overview_prepared('production',id) r from current_batch
), old_overview_rows as (
 select k.key,v.value from old_overview o cross join lateral jsonb_each(o.r) k cross join lateral jsonb_array_elements(k.value) v
), new_overview_rows as (
 select k.key,v.value from new_overview o cross join lateral jsonb_each(o.r) k cross join lateral jsonb_array_elements(k.value) v
), overview_diff as (
 (select * from old_overview_rows except all select * from new_overview_rows)
 union all
 (select * from new_overview_rows except all select * from old_overview_rows)
), old_score as materialized (
 select * from public.panel_manheim_score_mmr('production',now()-interval '60 days')
), new_score as materialized (
 select * from panel_internal.manheim_score_mmr_prepared('production',now()-interval '60 days')
), score_diff as (
 (select * from old_score except all select * from new_score)
 union all
 (select * from new_score except all select * from old_score)
)
select (select count(*) from batches) batches,
 (select count(*) from public.manheim_matches where undone_at is null) source_matches,
 (select count(*) from panel_internal.manheim_prepared_inputs) prepared_matches,
 (select count(*) from old_group) old_groups,(select count(*) from new_group) prepared_groups,
 (select count(*) from group_diff) group_differences,
 (select count(*) from old_overview_rows) overview_rows,(select count(*) from overview_diff) overview_differences,
 (select count(*) from old_score) people,(select count(*) from score_diff) score_differences;
