-- Conferência (MANHEIM_MATCH_AUDIT) v3.5: só os carros selecionados para o cliente, em blocos.
-- Aditiva: uma coluna nova. Nenhuma linha existente é alterada ou apagada.
--
--  * car_results: veredito da IA por carro (hash do carro -> {status, divergences}), gravado bloco a
--    bloco. Um bloco que estoura o tempo repete só ele; uma seleção alterada confere só os carros
--    novos ou alterados (mesmo hash do carro e mesma versão da regra são reaproveitados).
--  * As linhas antigas (conferencia-v3.4, pedido inteiro) ficam para auditoria. A regra nova tem
--    outro hash, então os pedidos hoje PENDENTE por AUDIT_DEADLINE são conferidos de novo, já só
--    sobre os carros selecionados.
alter table public.manheim_match_audits
  add column if not exists car_results jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'manheim_match_audits_car_results_object') then
    alter table public.manheim_match_audits
      add constraint manheim_match_audits_car_results_object check (jsonb_typeof(car_results) = 'object');
  end if;
end $$;
