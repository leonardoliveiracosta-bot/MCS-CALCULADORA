-- "Por que este carro": uma frase curta para o cliente, escrita pelo operador em cada carro selecionado.
-- Aparece na página da V1 (e da V2) junto do carro. É diferente da "observação interna" (note), que
-- nunca vai ao cliente. Aditiva: uma coluna nova e uma função nova; nada existente muda.
alter table public.manheim_option_selections add column if not exists client_reason text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'manheim_option_selections_client_reason_len') then
    alter table public.manheim_option_selections add constraint manheim_option_selections_client_reason_len check (client_reason is null or char_length(client_reason) between 1 and 300);
  end if;
end $$;

-- Grava (ou apaga, com texto vazio) o motivo do carro selecionado. O carro é o VIN do pedido: vale a
-- seleção de qualquer venda do mesmo VIN (Lane/Run ou Buy Now), como na regra v3.4.
create or replace function public.panel_manheim_offer_reason(p_environment public.panel_environment, p_actor_id uuid, p_match_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := nullif(btrim(regexp_replace(coalesce(p_reason, ''), '[[:cntrl:]]+', ' ', 'g')), '');
  v_match public.manheim_matches%rowtype;
  v_vin text;
  v_row public.manheim_option_selections%rowtype;
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  if v_reason is not null and char_length(v_reason) > 300 then raise exception 'MANHEIM_REASON_TOO_LONG'; end if;
  select * into v_match from public.manheim_matches m where m.environment = p_environment and m.id = p_match_id;
  if not found then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
  v_vin := nullif(upper(btrim(coalesce(v_match.vehicle_json #>> '{parsed,vin}', ''))), '');
  select s.* into v_row from public.manheim_option_selections s
   where s.environment = p_environment and s.status = 'SELECTED'
     and s.match_id in (select mm.id from public.manheim_matches mm
                         where mm.environment = p_environment and mm.upload_id = v_match.upload_id
                           and mm.demand_key is not distinct from v_match.demand_key
                           and (mm.id = p_match_id or (v_vin is not null and upper(btrim(coalesce(mm.vehicle_json #>> '{parsed,vin}', ''))) = v_vin)))
   order by s.updated_at, s.id limit 1 for update;
  if not found then raise exception 'MANHEIM_OPTION_NOT_SELECTED'; end if;
  update public.manheim_option_selections set client_reason = v_reason, updated_by = p_actor_id, updated_at = now() where id = v_row.id;
  insert into public.audit_log (environment, actor_user_id, entity_type, entity_id, action, before_json, after_json)
  values (p_environment, p_actor_id, 'manheim_option_selection', v_row.id, 'CLIENT_REASON', jsonb_build_object('client_reason', v_row.client_reason), jsonb_build_object('client_reason', v_reason));
  return jsonb_build_object('saved', true, 'matchId', v_row.match_id, 'clientReason', v_reason);
end $$;
revoke all on function public.panel_manheim_offer_reason(public.panel_environment, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.panel_manheim_offer_reason(public.panel_environment, uuid, uuid, text) to service_role;
