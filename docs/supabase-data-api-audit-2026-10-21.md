# Auditoria da mudança de permissões da Data API — 21/10/2026

A mudança de 30/10 não retira permissões de tabelas existentes. Há uma incompatibilidade comprovada em recriações: sem concessões automáticas, o servidor perde acessos que o código atual faz pela Data API. A correção está em uma migração nova e aditiva; nada foi aplicado ao banco de produção.

## Escopo e evidências

- Repositório: `leonardoliveiracosta-bot/MCS-CALCULADORA`, `main` em `1e4d19c4b8782d9e43ec38bea3efe59523b28ff5`, com 164 arquivos SQL antes da correção.
- Todas as 164 migrações foram executadas localmente em PGlite 0.5.8, pelo mecanismo já usado em `tests/sql/run.js`, sem default grants de tabelas/sequências para as roles da API. O teste fornece a tabela histórica `calc_runs` e stubs de Auth/Storage; isso não equivale a um `supabase db reset` completo.
- Foram inspecionados o catálogo final de privilégios, políticas RLS, grants/revokes dinâmicos, o código REST do servidor, inserções do navegador e dependências de RPCs SECURITY INVOKER. Buscas estáticas são evidência auxiliar, não um analisador completo de fluxo de dados.
- Produção consultada apenas por SELECT de metadados: projeto `lMy Car Scout`, `wwmakfaqahlbjzqvzgbr`; 124 tabelas em `public`, todas com RLS habilitada; uma view pública; 165 registros de migração. Quantidade e versões do histórico remoto não são idênticas à sequência do repositório. Datas no nome de arquivo não provam quando uma migração foi executada.
- Não foi criada branch de banco, usado reset remoto, aplicado DDL/DML em produção, alterado default privilege ou concedido acesso ao navegador.

## Acesso exigido pelo produto

O navegador envia registros para `public.calc_runs` como `anon`, em `msc-calculadora.html` (`registrar`/`registrarBusca`). O painel chama rotas `/api/panel/*`; `panel-server.js` usa `SUPABASE_SECRET_KEY` e PostgREST como `service_role`. Portanto, usar o servidor não elimina a dependência de grants da Data API. BYPASSRLS não substitui SELECT/INSERT/UPDATE/DELETE.

A migração inicial concede SELECT para `authenticated` em 24 tabelas e mantém políticas por usuário/ambiente. Existem mais cinco tabelas com SELECT explícito para `authenticated` em migrações posteriores. Esses 29 acessos foram preservados. Não foi acrescentado acesso anônimo a essas tabelas nem escrita para `authenticated`.

As demais tabelas públicas criadas pela sequência já declaram acesso para `service_role`, com operações específicas ou ALL, incluindo Vendedor IA, assistente, links de opções, WhatsApp, Manheim e demais estruturas internas. O inventário registra os privilégios efetivos de cada objeto, inclusive grants emitidos por loops.

### Lacuna comprovada e correção

Na sequência original, **25 objetos** ficaram sem SELECT de `service_role`: as 24 tabelas da fundação e a tabela histórica `calc_runs`, fornecida pelo bootstrap do teste. Corrigimos **24 objetos que o produto efetivamente acessa pelo servidor**:

| Grupo | Operações agora explícitas para `service_role` | Evidência do uso |
|---|---|---|
| `contacts`, `chats`, `chat_aliases`, `units` | SELECT, INSERT, UPDATE, DELETE | Entrada/importação, resposta e apresentação; rollback da entrada e desfazer apresentação |
| `contact_phones` | SELECT, INSERT, DELETE | Entrada/SMS e rollback de uma entrada incompleta |
| `journeys`, `messages`, `message_journeys`, `journey_checklist`, `journey_divergences`, `promises`, `import_jobs`, `calculator_request_links` | SELECT, INSERT, UPDATE | `entry.js`, `actions.js`, `reply.js`, `lead.js` e rotas de SMS |
| `panel_users`, `journey_alert_suppressions` | SELECT, UPDATE | Autenticação/conclusão da troca de senha e atualização de alertas |
| `journey_refs`, `journey_declarations`, `interactions`, `activity_log`, `audit_log`, `panel_notifications` | SELECT, INSERT | Histórico, evidências operacionais, auditoria e INSERT RETURNING de notificações |
| `attachments`, `checklist_evidence` | SELECT | Leitura da ficha; mutações já feitas por RPCs SECURITY DEFINER |
| `calc_runs` | SELECT | Leituras do painel e RPCs SECURITY INVOKER, incluindo contador e boot |

Não concedemos TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, acesso a todas as tabelas do schema ou permissões sobre todas as sequências. O INSERT em `panel_notifications` foi exercitado com a identidade gerada pelo banco, sem grant adicional de sequência.

**Exceção deliberada:** `import_batches` continua sem grants de tabela para `service_role` no replay limpo. As operações normais são realizadas por `panel_reconcile_import_batch` e outras funções SECURITY DEFINER, cujo EXECUTE já está concedido. Não há necessidade comprovada de abrir CRUD direto dessa tabela para o produto normal. A manutenção pontual `purge-tests.js` usa `_purge_teste`, que também não faz parte do bootstrap versionado; portar essa manutenção não justifica ampliar permissões de todas as tabelas.

A correção foi criada pela CLI como `supabase/migrations/20261021142552_data_api_explicit_server_grants.sql`. As migrações antigas ficaram intactas, conforme `docs/MIGRACOES.md`. Em banco existente, esses GRANTs já são verdadeiros: cada concessão proposta foi comparada ao catálogo atual de produção. Não há necessidade demonstrada de aplicar essa migração agora ao banco de produção. Ela pode acompanhar o fluxo normal de migrações após revisão; repositório e histórico remoto devem ser reconciliados individualmente antes de qualquer execução remota.

## Limites anteriores à mudança do Supabase

Uma recriação integral ainda depende de um **bootstrap externo de `calc_runs`**. Nenhuma das 164 migrações cria essa tabela ou sua política permissiva `site_insere`, nem concede INSERT ao `anon`. Produção tem esse grant e a política. As migrações adicionam a política restritiva `calc_runs_insert_limits`; uma política restritiva sozinha não autoriza inserções.

Executar a sequência original sem o stub de `calc_runs` falha em `20260925223000_panel_auditoria_fix.sql`, com `relation "public.calc_runs" does not exist`. Isso é uma lacuna pré-existente de reprodução do schema, não uma falha causada pelo aviso nem uma quebra comprovada do site atual. A nova migração não inventa um bootstrap ou políticas anônimas: preservar/restaurar esse baseline é pré-requisito de uma recriação integral. O stub dos testes usa bigserial, enquanto produção usa UUID; não deve ser copiado como baseline de produção.

Há três tabelas públicas do banco consultado sem CREATE correspondente na sequência: `_purge_teste`, `ai_feature_daily_limits`, `manheim_complement_matches`. Não foram recriadas nem receberam grants. Somente a primeira tem consumo localizado no código atual, em manutenção pontual. Esses desvios reforçam que passar no harness local não certifica um reset completo do ambiente real.

## Verificação e resultado

| Verificação | Resultado |
|---|---|
| Regressão contra a sequência original | Falha esperada: `server SELECT missing on panel_users` |
| Replay com correção e nenhuma concessão automática de tabela/sequência | 165 migrações e 32 cenários SQL passaram |
| Operações reais como `service_role` com BYPASSRLS | SELECT, contador, boot de mensagens/calc_runs, INSERT, upsert, UPDATE, DELETE e identidade de notificação passaram |
| Comparação original × corrigido | As 35 políticas RLS do replay, flags RLS e todos os privilégios de tabela de `anon`/`authenticated` permaneceram idênticos |
| Reaplicação da migração aditiva | Passou; GRANTs idempotentes |
| Comparação com permissões atuais | Todas as concessões propostas já existem em produção |
| `npm test`, executado antes de qualquer edição | 1.295 passaram, 4 falharam, 2 pulados, total 1.301; falhas pré-existentes abaixo |
| `npm run test:sql:concorrencia` | Ambos os testes pulados pelo runner: `PG_TEST_HOST` não configurado; não foram certificados |
| `git diff --check` | Passou |

Falhas JavaScript anteriores à correção:

1. `tests/aud001-textos-whatsapp.test.js:19`: texto "Abrir no WhatsApp do celular" contraria a expectativa do teste.
2. `tests/buscas-split.test.js:42`: regex do texto/fonte de `logical_mode: "VALOR"` não corresponde ao HTML atual.
3. `tests/panel-navigation-sms.test.js:70`: `sellerBox is not defined` no ambiente do teste.
4. `tests/panel-navigation-sms.test.js:84`: extração de trecho da função não encontra os delimitadores esperados.

Nenhum arquivo do produto JavaScript/HTML foi alterado. Não tratamos essas quatro falhas como regressões desta mudança e não fizemos correções fora do escopo.

A consulta read-only de Advisors mostrou 91 avisos informativos de RLS sem política e quatro warnings de search_path mutável (`panel_manheim_offer_mmr`, `panel_calc_template_text`, `panel_message_at`, `zz_probe`). Tabelas acessadas exclusivamente por servidor podem intencionalmente negar todo acesso sob RLS às roles comuns. Esses avisos não demonstram incompatibilidade com o novo default e não foram alterados. Referências: [RLS sem política](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) e [search_path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable).

**Conclusão operacional:** há risco futuro comprovado para recriação/preview sem grants automáticos; foi preparada correção mínima e testada. Não foi encontrada falta atual dessas permissões em produção, nem demonstrada necessidade de modificá-las. O reset integral continua condicionado ao baseline externo e à reconciliação do histórico, não só a esta correção.

## Referências

- [Inventário completo dos 122 objetos públicos no replay](supabase-data-api-inventory-2026-10-21.md), mais a tabela em `panel_internal` descrita ao final.
- [Aviso enviado em 20/10](https://mail.google.com/mail/u/?authuser=leonardoliveiracosta%40gmail.com#all/1a15b47519840b05), lido integralmente.
- [Anúncio oficial e prazo de 30/10](https://github.com/orgs/supabase/discussions/45329).
- [Índice de mudanças do Supabase](https://supabase.com/changelog.md), consultado nesta auditoria.
- [Modelo atual de grants e RLS](https://supabase.com/docs/guides/api/securing-your-api).
