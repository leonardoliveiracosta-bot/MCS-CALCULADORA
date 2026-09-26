update storage.buckets
set allowed_mime_types = case
  when allowed_mime_types is null then array['image/jpeg','image/png','image/webp','application/pdf']::text[]
  else array(select distinct mime from unnest(allowed_mime_types || array['application/pdf']::text[]) mime)
end
where id='mcs-panel-attachments'
  and (allowed_mime_types is null or not allowed_mime_types @> array['application/pdf']::text[]);

create or replace function public.panel_attachment_finalize(
  p_environment public.panel_environment,
  p_actor uuid,
  p_attachment uuid,
  p_kind public.panel_attachment_kind,
  p_bucket text,
  p_storage_path text,
  p_filename text,
  p_mime text,
  p_byte_size bigint,
  p_sha256 text,
  p_contact uuid default null,
  p_chat uuid default null,
  p_journey uuid default null,
  p_message uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare existing public.attachments%rowtype; inserted public.attachments%rowtype;
begin
  if p_attachment is null or p_actor is null or p_bucket<>'mcs-panel-attachments'
    or p_storage_path not like 'panel/'||p_environment::text||'/%'
    or length(coalesce(p_filename,'')) not between 1 and 120
    or p_mime not in ('image/jpeg','image/png','image/webp','application/pdf')
    or p_byte_size not between 1 and 10485760
    or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'ATTACHMENT_INVALID'; end if;

  select a.* into existing from public.attachments a
    where a.id=p_attachment and a.environment=p_environment for update;
  if found then
    if existing.storage_path<>p_storage_path or existing.sha256<>p_sha256 then raise exception 'ATTACHMENT_ID_REUSED'; end if;
    return jsonb_build_object('attachmentId',existing.id,'duplicate',true);
  end if;

  if not exists(select 1 from public.panel_users u where u.id=p_actor and u.environment=p_environment and u.active) then raise exception 'ACTOR_INVALID'; end if;
  if p_contact is not null and not exists(select 1 from public.contacts c where c.id=p_contact and c.environment=p_environment) then raise exception 'CONTACT_INVALID'; end if;
  if p_chat is not null and not exists(select 1 from public.chats c where c.id=p_chat and c.environment=p_environment) then raise exception 'CHAT_INVALID'; end if;
  if p_journey is not null and not exists(select 1 from public.journeys j where j.id=p_journey and j.environment=p_environment) then raise exception 'JOURNEY_INVALID'; end if;
  if p_message is not null and not exists(select 1 from public.messages m where m.id=p_message and m.environment=p_environment) then raise exception 'MESSAGE_INVALID'; end if;
  if p_contact is null and p_journey is null then raise exception 'ATTACHMENT_LEAD_REQUIRED'; end if;
  if p_contact is not null and p_journey is not null and not exists(
    select 1 from public.journeys j where j.id=p_journey and j.contact_id=p_contact and j.environment=p_environment
  ) then raise exception 'ATTACHMENT_RELATION_INVALID'; end if;

  insert into public.attachments(
    id,environment,contact_id,chat_id,journey_id,message_id,kind,bucket_name,storage_path,
    original_filename,mime_type,byte_size,sha256,verified_at,created_at,created_by
  ) values(
    p_attachment,p_environment,p_contact,p_chat,p_journey,p_message,p_kind,p_bucket,p_storage_path,
    p_filename,p_mime,p_byte_size,p_sha256,clock_timestamp(),clock_timestamp(),p_actor
  ) returning * into inserted;

  insert into public.activity_log(environment,journey_id,contact_id,chat_id,activity_type,summary,metadata,occurred_at,actor_user_id)
  values(p_environment,p_journey,p_contact,p_chat,'ATTACHMENT_ADDED','Anexo adicionado: '||p_filename,
    jsonb_build_object('attachmentId',inserted.id),clock_timestamp(),p_actor);

  return jsonb_build_object('attachmentId',inserted.id,'duplicate',false);
end $$;

revoke all on function public.panel_attachment_finalize(public.panel_environment,uuid,uuid,public.panel_attachment_kind,text,text,text,text,bigint,text,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.panel_attachment_finalize(public.panel_environment,uuid,uuid,public.panel_attachment_kind,text,text,text,text,bigint,text,uuid,uuid,uuid,uuid) to service_role;
