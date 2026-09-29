-- Find One For Me: calc_runs_insert_limits refuses invalid CARRO searches from anon and keeps
-- every Calculate My Cost insert working. Runs inside a transaction that is rolled back.
begin;
alter table public.calc_runs enable row level security;
create policy site_insere_teste on public.calc_runs as permissive for insert to anon with check (true);
grant insert on public.calc_runs to anon;
grant usage, select on all sequences in schema public to anon;

create function pg_temp.aceita(p_dados jsonb) returns boolean language plpgsql as $$
begin
  set local role anon;
  insert into public.calc_runs(zip, idioma, origem, dados) values ('33101', 'en', 'teste', p_dados);
  reset role;
  return true;
exception when insufficient_privilege or check_violation then
  reset role;
  return false;
end $$;

do $$
declare
  base jsonb := '{"ref":"QZ7K2","sid":"1-find-abc","evento":"busca","logical_mode":"CARRO","ano_de":2020,"ano_ate":2025,"milhas_de":1000,"milhas_ate":10000}';
  caso record;
begin
  for caso in select * from (values
    ('busca CARRO válida', base, true),
    ('limites iguais', base || '{"ano_de":2023,"ano_ate":2023,"milhas_de":5000,"milhas_ate":5000}', true),
    ('anos como texto numérico', base || '{"ano_de":"2020","ano_ate":"2025"}', true),
    ('ano final menor', base || '{"ano_de":2025,"ano_ate":2020}', false),
    ('milhagem final menor', base || '{"milhas_de":10000,"milhas_ate":1000}', false),
    ('milhagem zero', base || '{"milhas_de":0}', false),
    ('milhagem negativa', base || '{"milhas_de":-5}', false),
    ('ano vazio', base || '{"ano_de":""}', false),
    ('milhagem vazia', base || '{"milhas_ate":""}', false),
    ('ano ausente', base - 'ano_ate', false),
    ('milhagem ausente', base - 'milhas_de', false),
    ('ano texto', base || '{"ano_de":"abc"}', false),
    ('ano 0000', base || '{"ano_de":"0000"}', false),
    ('milhagem decimal', base || '{"milhas_ate":"10000.5"}', false),
    ('busca sem logical_mode', base - 'logical_mode', false),
    ('busca VALOR', base || '{"logical_mode":"VALOR"}', false),
    ('CARRO fora de busca', base || '{"evento":"simulacao"}', false),
    ('MIXED', base || '{"logical_mode":"MIXED"}', false),
    ('modo em minúsculas', base || '{"logical_mode":"carro"}', false),
    ('milhagem com 8 dígitos', base || '{"milhas_ate":10000000}', false),
    ('milhagem máxima do navegador', base || '{"milhas_ate":9999999}', true),
    ('simulacao VALOR', '{"ref":"QZ7K2","sid":"s1","evento":"simulacao","logical_mode":"VALOR"}'::jsonb, true),
    ('whatsapp sem logical_mode', '{"ref":"QZ7K2","sid":"s1","evento":"whatsapp"}'::jsonb, true),
    ('sms VALOR', '{"ref":"QZ7K2","sid":"s1","evento":"sms","logical_mode":"VALOR"}'::jsonb, true),
    ('regra antiga: Ref inválida continua recusada', base || '{"ref":"-----"}', false),
    ('regra antiga: evento desconhecido continua recusado', '{"ref":"QZ7K2","sid":"s1","evento":"outro"}'::jsonb, false)
  ) as t(nome, dados, esperado) loop
    if pg_temp.aceita(caso.dados) is distinct from caso.esperado then
      raise exception 'calc_runs CARRO: % esperado %', caso.nome, caso.esperado;
    end if;
  end loop;
  raise notice 'OK: calc_runs CARRO recusa faixas inválidas e mantém Calculate My Cost';
end $$;
rollback;
