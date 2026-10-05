# AUD-001, rascunho do Executor

- Pedido: AUD-001, auditoria do painel (somente achados, sem alterar código, sem commit, sem publicar)
- Setor: eng-backend-infra
- Papel: Nível 1 Executor
- Agente: Claude (subagente executor eng-backend-infra), 2026-10-04
- Base: main atual (branch de trabalho claude/kind-brown-ak3z4i, commit 7a25ef1)
- Banco de produção: somente SELECT; tempos medidos com clock_timestamp em funções STABLE de leitura; pg_stat_statements lido; nenhum dado pessoal transcrito; lote ativo do Manheim não foi tocado

## Achados

### A1. BUSCAR CARROS mostra "sem opção" falso quando o resumo do lote falha
- Domínio: DADOS (efeito na TELA)
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: api/panel/pesquisas.js:47 chama panel_manheim_batch_summary com `.catch(() => [])`. Em pesquisas.js:76 a 78, sem linha no resumo, `served = 0` e o pedido vira `result: 'NO_OPTIONS'`, `option_count: 0` (estado SEM_OPCAO). A mesma função em panel-buscas-view.js:184 devolve null e marca "Resumo indisponível". pg_stat_statements mostra panel_manheim_batch_summary com máximo de 5,5 s via PostgREST (limite 8 s no papel authenticator), então a falha é possível em pico.
- Correção sugerida: tratar falha como desconhecido (null), não preencher o check pela importação quando o resumo falhou, e marcar o item como "resumo indisponível" em vez de SEM_OPCAO; teste unitário com rpc rejeitando.

### A2. Resumo do lote lido duas vezes na mesma chamada de abertura (counters)
- Domínio: DADOS
- Gravidade: OUTRO (desempenho, risco de 8 s)
- Esforço: P a M
- Evidência: api/panel/boot.js:20 a 24 roda juntos pesquisas e records?view=manheim. pesquisas.js:47 chama panel_manheim_batch_summary(lote ativo) e panel-buscas-view.js:184 chama a mesma função com os mesmos argumentos. O readCache de panel-server.js:89 vale só para `rows`; `rpc` (panel-server.js:200) e a chamada direta de pesquisas.js não passam por ele. No mesmo boot, panel_manheim_score_mmr roda em records.js:80 e panel-buscas-view.js:158 (e em today.js:61 no boot main) com p_since diferente por milissegundos. Medição isolada agora: batch_summary 1.384 ms, offer_summary 1.339 ms, batch_people 1.390 ms, batch_cars 1.402 ms, score_mmr 1.537 ms; juntas em paralelo os máximos registrados chegam a 5,5 a 5,8 s.
- Correção sugerida: memoizar rpc por (nome, argumentos) dentro de ctx.readCache, e arredondar p_since de score_mmr para o dia (ou hora) para a chave bater.

### A3. Mesma visão de OPÇÕES buscada duas vezes depois de importar ou desfazer lote
- Domínio: DADOS
- Gravidade: OUTRO (carga dobrada da leitura mais pesada)
- Esforço: P
- Evidência: painel/painel.js:4589 a 4592 limpa o pool, chama loadCurrent() (IMPORTAÇÕES ou OPÇÕES fazem `request('/api/panel/records?view=manheim')` direto, painel.js:1957, 1942, 1975, sem passar pelo requestPool) e logo depois refreshCounters(), que faz `sharedGet('/api/panel/records?view=manheim', 60000)` (painel.js:2010) com o cache vazio: segunda chamada idêntica. Mesmo padrão em painel.js:4344 a 4345 (desfazer importação). Na abertura, o boot counters já traz manheim (painel.js:1928) e abrir OPÇÕES em seguida busca de novo pelo request direto.
- Correção sugerida: nas visões searches, manheim e imports usar o pool (fresh ou sharedGet com ttl curto) para records?view=manheim, ou primar o pool com a resposta do loadCurrent.

### A4. BUSCAR CARROS dispara quatro funções que leem a mesma base inteira
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: M
- Evidência: painel.js:1964 a 1971 abre pesquisas, searches (loadSearchStages), manheim-searches (renderSavedSearches) e records?view=manheim. pesquisas.js:43, manheim-searches.js:22 e panel-buscas-view.js:151 chamam loadBuscasBase (journeys, contacts, contact_phones, journey_refs, journey_toggle_states, messages, message_journeys, calc_runs, calculator_request_links, panel_item_dispositions); searches.js:31 a 42 relê quase as mesmas tabelas por conta própria (messages e calc_runs inteiras) e ainda chama panel_manheim_batch_people (searches.js:46). Hoje são cerca de 3.150 mensagens e 4.129 calc_runs, então cabe no tempo, mas cresce com o volume.
- Correção sugerida: juntar as quatro leituras numa chamada só (padrão do /api/panel/boot com readCache) ou entregar os estágios dentro de pesquisas.

### A5. WhatsApp e Entrada lidos duas vezes em IMPORTAÇÕES e CONFIGURAÇÕES
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: P
- Evidência: loadWhatsApp usa `request('/api/panel/whatsapp')` direto (painel.js:1085), fora do pool; refreshCounters pede o mesmo caminho por sharedGet (painel.js:2009). Quando uma ação chama loadWhatsApp e depois refreshCounters (painel.js:1072, 1110, 1151), a mesma leitura vai duas vezes ao servidor.
- Correção sugerida: loadWhatsApp passar por fresh() como loadQueue já faz (painel.js:1269).

### A6. Reconciliação de identidade relê 120 fichas a cada 5 minutos, mesmo sem mudança
- Domínio: DADOS
- Gravidade: OUTRO (maior consumo de tempo de banco)
- Esforço: M
- Evidência: api/panel/subject-cron.js:33 roda reconcileIdentity(max 120) e vercel.json agenda o cron a cada 5 min. panel-identity.js:169 a 185 pega sempre as 120 fichas com estado mais antigo e chama panel_identity_evidence em lotes de 40. pg_stat_statements: 2.063 chamadas, média 2.559 ms, máximo 6.320 ms, total 5.279 s, de longe o maior tempo acumulado entre as funções panel_*. Para fichas sem mudança faz um PATCH por ficha, em série (panel-identity.js:146).
- Correção sugerida: só reavaliar fichas com mensagem, ref ou vínculo novo desde o último hash (marca de atualização), reduzir o lote, e trocar os PATCH unitários por um só.

### A7. Envio V1 pode ficar preso em SENDING sem saída
- Domínio: VENDAS
- Gravidade: BLOQUEIA_VENDA (plausível, depende de queda do processo)
- Esforço: P
- Evidência: api/panel/v1-send.js:162 grava status SENDING antes de chamar o 360dialog (prazo de 15 s, linha 24) e só depois finaliza. Se a função cair nesse intervalo, a linha fica SENDING; v1-send.js:139 recusa todo envio novo dessa vitrine com SEND_IN_PROGRESS e o índice único v1_sends_one_in_flight_idx (migração 20261007010000) impede outra linha. Não há regra de expiração. v1-send.js não tem maxDuration próprio em vercel.json. Hoje no banco: 1 envio, SENT, nenhum preso.
- Correção sugerida: considerar SENDING com mais de 2 minutos como UNCONFIRMED (na leitura de lastSend e numa atualização condicional), e declarar maxDuration explícito para v1-send.

### A8. Lote ativo tem 7.693 carros repetidos por pedido no armazenamento (tela protegida)
- Domínio: TELA (verificação, sem defeito visível)
- Gravidade: OUTRO
- Esforço: P (só monitorar)
- Evidência: manheim_matches do lote ativo: 55.454 linhas para 47.758 trios distintos (pedido, tipo, VIN); 7.693 grupos repetem o mesmo pedido, desejo e VIN com row_fingerprint diferente (mesmo carro em duas linhas do CSV). Conferido que todas as funções de leitura de opções e contagem (offer_page, offer_page_sorted, offer_page_trim, offer_summary, batch_summary, batch_people, batch_cars, demand_options, top_options, offer_trims, score_mmr) passam por panel_manheim_grouped_light ou grouped_options, que agrupam por VIN. batch_summary e offer_summary batem nos 385 pedidos (39.422 carros nos dois). Sem duplicação na tela por esta via.
- Correção sugerida: teste de regressão que garanta que toda função nova de leitura de opções passe pelo agrupamento por VIN.
