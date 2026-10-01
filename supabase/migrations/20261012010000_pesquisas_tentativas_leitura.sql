-- PESQUISAS: uma leitura que falhou (tempo esgotado, erro do provedor) é tentada de novo.
-- A tabela guarda um registro por conteúdo de conversa; a nova tentativa atualiza o mesmo
-- registro e conta as tentativas aqui. Só acrescenta a coluna; nada é apagado.
alter table public.vehicle_request_runs
  add column if not exists attempts integer not null default 1 check (attempts >= 1);
