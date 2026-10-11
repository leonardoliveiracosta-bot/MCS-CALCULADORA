-- RESULTADO: o botão "Conversa presencial" passa a se chamar "Opções enviadas". Só o texto que o botão grava muda;
-- o tipo (IN_PERSON) e o que ele faz (contato feito, sai de Novo, não mexe no retorno) ficam como estão.
-- Nenhum registro antigo usa esse botão (0 em produção), então nada do histórico muda.
do $$
declare
  v_def text;
  v_old constant text := 'Conversa presencial';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'panel_quick_result';
  if v_def is null then raise exception 'RESULTADO_OPCOES: panel_quick_result não existe'; end if;
  if position('Opções enviadas' in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'RESULTADO_OPCOES: panel_quick_result não tem exatamente um "%"', v_old;
  end if;
  execute replace(v_def, v_old, 'Opções enviadas');
end;
$$;
