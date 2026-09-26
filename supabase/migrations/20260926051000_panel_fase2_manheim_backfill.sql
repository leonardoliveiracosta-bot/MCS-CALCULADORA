-- Preserve every historical vehicle retained with a matching CSV row.
insert into public.manheim_vehicles(environment, upload_id, row_fingerprint, vehicle_json, uploaded_at)
select distinct on (m.environment, m.upload_id, m.row_fingerprint)
  m.environment, m.upload_id, m.row_fingerprint, m.vehicle_json->'parsed', u.uploaded_at
from public.manheim_matches m
join public.manheim_uploads u on u.id = m.upload_id and u.environment = m.environment
where u.uploaded_at >= now() - interval '60 days'
  and m.vehicle_json ? 'parsed'
order by m.environment, m.upload_id, m.row_fingerprint, m.created_at desc
on conflict (environment, upload_id, row_fingerprint) do nothing;
