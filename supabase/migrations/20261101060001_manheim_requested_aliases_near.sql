-- Existing aliases remain unchanged. A requested version only matches its trim.
-- Production already has this optional column; include it for fresh installs.
alter table public.model_aliases add column if not exists variant_key text;

insert into public.model_aliases(make,client_model,manheim_models,kind,target_make,variant_key)
values
 ('Land Rover','Defender',array['Defender','Defender 90','Defender 110','Defender 130'],'EQUIVALENT','Land Rover',null),
 ('Ford','Raptor',array['F-150'],'EQUIVALENT','Ford','Raptor'),
 ('Mercedes-Benz','GLE 450',array['GLE'],'EQUIVALENT','Mercedes-Benz','450'),
 ('BMW','M550i',array['5 Series'],'EQUIVALENT','BMW','M550i'),
 ('BMW','M340i',array['3 Series'],'EQUIVALENT','BMW','M340i'),
 ('Lexus','ES 300h',array['ES'],'EQUIVALENT','Lexus','300h')
on conflict(make,client_model,kind,target_make) do update
set manheim_models=excluded.manheim_models,variant_key=excluded.variant_key;

-- Same service-only dictionary contract plus the optional trim guard.
create or replace function public.panel_model_dictionary() returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
   'aliases',a.data,
   'known',coalesce((select jsonb_agg(k order by make,model) from public.manheim_known_models k),'[]'::jsonb),
   'revision',md5(a.data::text)
 )
 from (
   select coalesce(jsonb_agg(jsonb_build_object(
     'make',make,'client_model',client_model,'manheim_models',manheim_models,'kind',kind,
     'target_make',target_make,'variant_key',variant_key
   ) order by make,client_model,kind,target_make),'[]'::jsonb) data
   from public.model_aliases
 ) a;
$$;
