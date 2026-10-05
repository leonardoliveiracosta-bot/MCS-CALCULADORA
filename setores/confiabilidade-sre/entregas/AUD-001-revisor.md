# AUD-001 · confiabilidade-sre · Nível 2 Revisor independente

Pedido: AUD-001, auditoria do painel, somente achados (sem mudar código, sem commit, sem publicar)
Agente: Nível 2 Revisor independente do setor confiabilidade-sre
Ordem das etapas: avaliação cega registrada abaixo ANTES de abrir AUD-001-executor.md; a comparação com o rascunho fica para a seção seguinte, acrescentada depois

## Avaliação cega

Fontes usadas: código do main atual (painel/painel.js, panel-server.js, panel-buscas-view.js, api/panel/*.js, vercel.json), Supabase de produção só com SELECT (pg_roles, pg_stat_statements, pg_proc, schema_migrations, contagem por status em v1_sends) e cronometragem de funções só de leitura, logs da borda do Supabase e logs da Vercel das últimas 24 h e 7 dias. Nenhum dado pessoal ou conversa transcrito. Lote ativo do Manheim não foi alterado.

Limite confirmado: `authenticator` tem `statement_timeout=8s` e `service_role` não tem valor próprio, então toda chamada do painel ao PostgREST corta aos 8 s.

### A1 · Uma leitura lenta derruba a aba ENVIAR OPÇÕES inteira (e IMPORTAÇÕES junto)
- Domínio: DADOS · Gravidade: BLOQUEIA_VENDA · Esforço: P
- Evidência: panel-buscas-view.js:150-159, o primeiro `Promise.all` (loadBuscasBase, loadUploads, panelMeta, whatsapp_user_ids, conversation_pending_insights, journey_checklist, loadSearchStageIndex) não tem `.catch` em nenhum item; qualquer falha vira 500 em `/api/panel/records?view=manheim`. Vercel, 04/10: 8 respostas 500 em `/api/panel/records` (20:59 a 22:22) com `SUPABASE_REQUEST_FAILED` vindo de `manheimView ... Promise.all (index 0)`; Supabase no mesmo período: 500 em panel_manheim_score_mmr (34), batch_people (17), batch_summary (15), offer_summary (12), batch_cars (11). As leituras do segundo bloco (linhas 182-188) já ganharam `.catch`; as do primeiro bloco não. A visão IMPORTAÇÕES (painel.js:1957) usa a mesma rota, então cai junto.
- Correção sugerida: tratar as leituras não essenciais do primeiro bloco (meta, userIds, insights, checklist, stageIndex) como parciais com `.catch` e aviso "indisponível" na tela, mantendo só base e uploads como obrigatórios.

### A2 · Chamada ao banco no servidor sem prazo: função presa até 60 ou 300 s
- Domínio: DADOS · Gravidade: OUTRO (trava aba) · Esforço: P
- Evidência: panel-server.js:33-53, `supabase()` chama `fetch` sem `AbortController` nem prazo. Vercel, 7 dias: 270 "Task timed out after 60/300 seconds", incluindo rotas do painel /api/panel/today (3), /searches (3), /weekly (3), /notifications (4), /records (2), /triage (11), /manheim-options (1, 04/10 20:19 após 30 s). vercel.json só define maxDuration para algumas rotas; /today, /records, /boot, /v1-send, /searches ficam no padrão. O navegador desiste aos 30 s (painel.js:266) mas a função continua ocupando conexão.
- Correção sugerida: prazo por chamada em `supabase()` (por exemplo 9 s, acima dos 8 s do banco) com erro codificado `SUPABASE_TIMEOUT`, e maxDuration explícito para /api/panel/boot, /records, /today.

### A3 · O resumo de ENVIAR OPÇÕES varre o lote inteiro 5 vezes por carregamento
- Domínio: DADOS · Gravidade: OUTRO (perto do limite) · Esforço: M
- Evidência: em produção, panel_manheim_batch_summary, offer_summary, batch_cars, batch_people e score_mmr chamam cada uma `panel_manheim_grouped_light` (pg_proc: uses_light = true nas cinco). Medido agora em sequência no lote ativo: summary 1713 ms, offer 1393 ms, cars 1370 ms, people 1357 ms, score 1333 ms (cerca de 7,2 s de banco por carregamento). As três primeiras rodam em paralelo em panel-buscas-view.js:182-188 e score/people em outras leituras da mesma visão. pg_stat_statements: panel_manheim_score_mmr máx 6730 ms, batch_summary máx 6166 ms, batch_cars máx 5839 ms, batch_people máx 5673 ms, offer_summary máx 5535 ms; nos picos com outras abas abertas passam dos 8 s (os 500 do item A1).
- Correção sugerida: uma função única que lê `grouped_light` uma vez e devolve os cinco resumos, ou uma tabela de resumo por lote gravada ao ativar o lote.

### A4 · ENVIAR OPÇÕES e IMPORTAÇÕES pedem a mesma visão pesada duas vezes
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: painel.js:1942, 1957 e 1975 leem `/api/panel/records?view=manheim` com `request` direto, fora do `requestPool`; os contadores leem a mesma rota com `sharedGet` (painel.js:2010). Depois de importar lote (painel.js:4588-4592) e de desfazer lote (4344-4345) o código faz `loadCurrent()` e em seguida `refreshCounters()`, e como o pool foi invalidado a visão é calculada duas vezes no servidor (cada uma com as varreduras do A3). Ao abrir o painel direto em #opcoes, o boot dos contadores (api/panel/boot.js:22, parte `manheim`) e a carga da aba correm ao mesmo tempo.
- Correção sugerida: carregar a visão pelo `sharedGet` (ou `requestPool.prime` com a resposta da aba) para que contadores e aba usem a mesma resposta.

### A5 · Falha na contagem de carros do lote mostra "0 carros" como se fosse verdade
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: panel-buscas-view.js:186 `panel_manheim_batch_cars(...).catch(() => [])` e linhas 222-223 gravam 0 para todo lote ativo sem linha; `upload.matched_vehicle_count` e `batches[].matchCount` saem 0. A função teve 11 respostas 500 em 24 h (logs do Supabase).
- Correção sugerida: `.catch(() => null)` e, quando nulo, manter o número congelado do lote com a marca "contagem indisponível", nunca zero.

### A6 · Envio da V1 pode ficar preso em SENDING para sempre
- Domínio: VENDAS · Gravidade: BLOQUEIA_VENDA (latente) · Esforço: P
- Evidência: api/panel/v1-send.js:159-163 grava a linha com status SENDING; 170-188 só sai desse estado por `finish(...)`, que não tem tratamento de erro. Se o `finish` falhar depois de a mensagem sair (banco lento, A2) ou a função morrer, a linha fica SENDING, o índice único `v1_sends_one_in_flight_idx` (migração 20261007010000, linha 32) e a checagem da linha 139 respondem SEND_IN_PROGRESS em toda tentativa seguinte, inclusive Reenviar. Não existe nenhuma rotina que expire SENDING (busca por "SENDING" no código e nas migrações). Hoje não há linha presa (SELECT por status: 1 SENT), então o risco é latente.
- Correção sugerida: considerar SENDING com mais de 2 minutos como UNCONFIRMED em `lastSend` (sem reenviar sozinho) e proteger o `finish` com nova tentativa curta.

### A7 · Desfazer lote do Manheim perto do limite de 8 s
- Domínio: DADOS · Gravidade: OUTRO · Esforço: M
- Evidência: pg_stat_statements: `panel_undo_manheim_upload` pelo PostgREST, 8 chamadas, média 3112 ms, máximo 7249 ms; em chamada direta, máximo 12374 ms. Chamada em api/panel/actions.js (ação manheim_undo, painel.js:4340).
- Correção sugerida: dividir o desfazer em partes retomáveis, como já é feito na importação.

### A8 · Rotina de identidade com leitura perto do limite e falhando
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: panel_identity_evidence (panel-identity.js:140, 40 fichas por chamada a cada 5 min no subject-cron) é a leitura de maior tempo total no banco: 2095 chamadas, média 2563 ms, máximo 6892 ms. Supabase e Vercel registraram 2 falhas em 04/10 23:28 e 23:48 (`[identity] SUPABASE_REQUEST_FAILED`). Não derruba aba, mas disputa o banco com o painel.
- Correção sugerida: baixar o lote para 20 fichas ou indexar o que a função filtra; acompanhar o máximo.

### A9 · Histórico de migrações divergente do banco de produção
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: `supabase_migrations.schema_migrations` termina em 20261022010000, mas as funções de 20261023010000, 20261024020000 e 20261025010000 já estão em produção (pg_proc mostra panel_manheim_grouped_light, panel_manheim_offer_trims, panel_manheim_offer_page_trim e os cinco resumos usando grouped_light). Um `db push` futuro reaplicaria essas migrações e não há registro de quando cada uma entrou.
- Correção sugerida: registrar as três versões no histórico (sem reaplicar), e aplicar as próximas pelo caminho que registra.

### Itens verificados sem achado
- Cliente: toda requisição tem prazo e cancelamento (painel.js:264-312); trocar de aba cancela a carga anterior (1866-1873).
- Atualização automática só na aba líder, uma por vez, com espera dobrando após erro (refresh-coordinator.js).
- Contadores em falha mostram "—" e não zeram (painel.js:2016-2031).

## Comparação com o rascunho do executor

Pendente: acrescentada só depois desta avaliação cega, sem alterar o texto acima.

## Comparação com o rascunho

Feita depois da avaliação cega, lendo AUD-001-executor.md e tentando refutar cada achado no código do main (7a25ef1) e com SELECT no banco de produção (schema_migrations, pg_proc, pg_stat_statements).

### Achados do executor
- E1 · seis agregações pesadas por abertura: SUSTENTADO. boot.js:20-24 roda pesquisas, records e records?view=manheim juntos; pesquisas.js:47 (batch_summary), records.js:31 (batch_people), panel-buscas-view.js:158 (loadScoreIndex, score_mmr), :182-188 (summary, offer, cars). `rpc()` (panel-server.js:200) não passa pelo readCache (só `readRows`, panel-server.js:89). pg_proc confirma as cinco funções usando grouped_light. Concorda com A3, que não tinha visto a soma com boot/pesquisas/records.
- E2 · BUSCAR CARROS vira "Sem opção" quando o resumo falha: SUSTENTADO, achado que a avaliação cega não teve. pesquisas.js:47 `.catch(() => [])` sem log; :70-73 com resumo vazio dá served 0 e `NO_OPTIONS`. Gravidade INFO_ERRADA correta, e esforço P.
- E3 · CLIENTES com 0 carros quando a contagem falha: SUSTENTADO COM RESSALVA. records.js:76 e :244 trocam a falha por mapa vazio e :123/:280 gravam 0. Na tela (painel.js:5101) o aviso só aparece com contagem maior que zero, então o efeito é o aviso "carro(s) do export batem" sumir, não um "0" escrito. Continua informação errada, P.
- E4 · leitura base derruba ENVIAR OPÇÕES: SUSTENTADO, igual a A1. panel-buscas-view.js:149-158 sem catch (só loadScoreIndex tem). Divergência só no esforço: executor M, revisor P (catch nas leituras não essenciais é pequeno; manter a última resposta boa no cliente seria o M).
- E5 · mesma visão pedida duas vezes: SUSTENTADO, igual a A4. Erro de linha no executor: a leitura da aba manheim é painel.js:1975, a :1977 é `updateMeta`. A4 acrescenta o caso pós-importação e pós-desfazer (painel.js:4344-4345 e 4590-4592: invalida o pool, `loadCurrent` e depois `refreshCounters` pedem a mesma visão).
- E6 · cada página de opções recarrega a base inteira: SUSTENTADO. manheim-options.js:46-51 `contextFor` roda loadBuscasBase completo; chamado em :143 e :203. A leitura de todas as vitrines está na linha 59 (não 56). selectedOptions em série confirmado em painel.js:2883-2896. A avaliação cega não tinha.
- E7 · sincronização espera mais do que o servidor vive: SUSTENTADO. painel.js:334 timeoutMs 40000, vercel.json maxDuration 30 para manheim-options, prazo interno de 20 s (manheim-options.js:242) contado só depois da base. Complementa A2.
- E8 · V1 preso em SENDING: SUSTENTADO, igual a A6. v1-send.js:139, :162, `finish` sem tratamento; nenhuma rotina expira SENDING. Divergência de esforço (M x P): a correção mínima em `lastSend` é P.
- E9 · rotina de identidade lenta: SUSTENTADO, igual a A8 e com mais detalhe. Migração 20261016040000 linha ~121 lê todos os calc_runs sem filtro; panel-identity.js:143-146 grava `updated_at` de ficha sem mudança; :181-183 sem catch por bloco, um bloco com erro encerra o ciclo. pg_stat_statements agora: 2133 chamadas, média 2566 ms, máximo 6892 ms. Divergência de esforço (M x P): a correção completa do executor é M.

### Achados do revisor
- A1: sustentado (igual E4).
- A2 · fetch ao banco sem prazo: SUSTENTADO no código (panel-server.js:33-53 sem AbortController). O executor não teve; E7 é um caso particular.
- A3: sustentado (igual E1, que é mais completo).
- A4: sustentado (igual E5). Corrigir linha: os contadores pedem a visão em painel.js:2011 (a :2010 é pesquisas).
- A5 · falha em batch_cars mostra 0 carros: REFUTADO pela própria revisão. Com `carsRead = []`, panel-buscas-view.js:239 não preenche `operational`, e :241 e :246 caem no número congelado `matched_vehicle_count`, não em zero. Não há zero falso; no máximo o número fica o da importação, sem a marca "congelado".
- A6: sustentado (igual E8).
- A7 · desfazer lote perto de 8 s: SUSTENTADO. pg_stat_statements agora: pelo PostgREST 8 chamadas, média 3112 ms, máximo 7249 ms; chamada direta máximo 12374 ms. O executor não teve.
- A8: sustentado (igual E9).
- A9 · histórico de migrações divergente: SUSTENTADO. schema_migrations termina em 20261022010000, zero versões a partir de 20261023, e panel_manheim_grouped_light existe com as cinco funções usando ela. O executor não teve.

### Resumo
- Concordâncias: E1=A3, E4=A1, E5=A4, E8=A6, E9=A8.
- Só do executor, sustentados: E2, E3 (com ressalva de efeito), E6, E7.
- Só do revisor, sustentados: A2, A7, A9.
- Refutado: A5 (revisor).
- Divergências de esforço: E4, E8, E9 (executor M, revisor P); proposta: P para a correção mínima, M para a completa.
- Erros de linha sem efeito no mérito: E5 (1977 deveria ser 1975), E6 (56 deveria ser 59), A4 (2010 deveria ser 2011).
