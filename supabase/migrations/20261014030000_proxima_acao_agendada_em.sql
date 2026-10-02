-- "Não atendidos": uma mensagem nova do cliente, recebida depois que a próxima ação foi agendada e
-- ainda sem resposta, aparece como não atendida mesmo antes da data marcada. Para isso o painel
-- precisa saber quando a próxima ação foi agendada. Aditiva: uma coluna e um gatilho que a preenche
-- em qualquer caminho que grava next_action_at (botão, ligação, ação rápida, desfazer). Nenhum dado
-- existente é alterado.
alter table public.journeys add column if not exists next_action_set_at timestamptz;

create or replace function public.journeys_next_action_set_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.next_action_at is null then
    new.next_action_set_at := null;
  elsif tg_op = 'INSERT' or old.next_action_at is distinct from new.next_action_at
     or old.next_action_text is distinct from new.next_action_text then
    new.next_action_set_at := now();
  end if;
  return new;
end $$;

create or replace trigger journeys_next_action_set_at before insert or update of next_action_at, next_action_text on public.journeys
  for each row execute function public.journeys_next_action_set_at();
