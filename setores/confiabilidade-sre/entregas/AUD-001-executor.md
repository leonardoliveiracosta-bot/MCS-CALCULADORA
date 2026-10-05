# AUD-001 · confiabilidade-sre · rascunho do executor

- Pedido: AUD-001, auditoria do painel My Car Scout, somente achados, sem alterar código, sem commit, sem publicação
- Papel: Nível 1 Executor
- Agente: executor confiabilidade-sre (subagente da orquestração AUD-001)
- Base: main atual (7a25ef1), banco de produção só com SELECT, logs do Supabase e da Vercel só leitura
- Data: 05/10/2026

## Medições de apoio

- Lote ativo: 55.454 carros em manheim_matches (SELECT count)
- Cada resumo do lote, rodando sozinho: batch_summary 1,45 s, offer_summary 1,38 s, score_mmr 1,72 s (clock_timestamp em SELECT)
- Últimas 24 h no Postgres: 104 "canceling statement due to statement timeout"
- Últimas 24 h no edge do Supabase, RPCs com 500: score_mmr 34, batch_people 17, batch_summary 15, offer_summary 12, batch_cars 11, batch_demand_options 10, identity_evidence 2
- Depois da publicação de dea9691 (22:43), ainda houve 500: rajada em 23:48:00 a 23:48:01 com batch_summary, score_mmr (duas vezes), batch_cars, offer_summary e batch_people juntos; identity_evidence em 23:28 e 23:48
- Vercel, últimas 24 h, 5xx: /api/panel/records 8 (todas em manheimView), /api/panel/manheim-batch 3, /api/panel/manheim-options 1 (504, "Task timed out after 30 seconds" às 20:19)

## Achados

### 1. A abertura dos contadores roda seis vezes a mesma agregação pesada do lote, em paralelo
- Domínio: DADOS
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: M
- Evidência: api/panel/boot.js:20-24 roda juntos pesquisas, records e records?view=manheim. Dentro deles: pesquisas.js:47 (batch_summary), records.js:31 e :76 (batch_people) e :80 (score_mmr), panel-buscas-view.js:158 (score_mmr), :184 (batch_summary), :185 (offer_summary), :186 (batch_cars). As seis funções chamam panel_manheim_grouped_light sobre o lote inteiro (pg_get_functiondef confirma), cada uma ~1,4 a 1,7 s sozinha. O readCache do boot só vale para leituras GET (panel-server.js:89); rpc() não passa por ele. Rajada de 500 em 23:48:00-01 com exatamente essas seis chamadas
- Efeito: os contadores e o resumo de ENVIAR OPÇÕES aparecem como indisponíveis ou zerados de tempos em tempos, e o banco fica saturado para quem está vendendo
- Correção sugerida: uma única leitura do agrupamento por pedido HTTP (uma RPC que devolve resumo, oferta, carros e pessoas juntos, ou guardar o agrupamento por lote numa tabela atualizada só quando o lote ou a seleção mudam), e cache de rpc no ctx.readCache do boot

### 2. BUSCAR CARROS mostra "Sem opção" quando o resumo do lote falha
- Domínio: DADOS
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: api/panel/pesquisas.js:47 faz panel_manheim_batch_summary(...).catch(() => []), sem log. Em :70-73, sem conferência gravada e com o critério igual ao do lote, o resultado vem do resumo: served = 0 e result 'NO_OPTIONS'. Com o resumo vazio por timeout, todo pedido nessa situação vira SEM_OPCAO com 0 opções, e o pedido some da fila de quem tem carro
- Correção sugerida: na falha devolver null, registrar o erro e deixar o resultado como desconhecido ("Resumo indisponível"), nunca NO_OPTIONS

### 3. CLIENTES mostra 0 carros do lote para todo mundo quando a contagem falha
- Domínio: DADOS
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: api/panel/records.js:76 manheimCounts(ctx).catch(() => ({ byJourney: new Map() })) e :123 manheimMatchCount: manheim.byJourney.get(item.id) || 0. A função usa batch_people, que teve 17 respostas 500 em 24 h. O mesmo vale para a ficha (:244 e :280)
- Correção sugerida: marcar a contagem como indisponível (null) e o cartão dizer "contagem indisponível" em vez de 0

### 4. Uma leitura base com falha derruba a aba ENVIAR OPÇÕES inteira
- Domínio: VENDAS
- Gravidade: BLOQUEIA_VENDA
- Esforço: M
- Evidência: logs da Vercel com 8 respostas 500 em /api/panel/records (20:59, 21:54, 22:19 a 22:22), pilha em manheimView Promise.all, mensagem SUPABASE_REQUEST_FAILED. O resumo ganhou catch depois disso, mas panel-buscas-view.js:150-159 ainda espera loadBuscasBase, loadUploads, panelMeta e três allRows sem catch; loadBuscasBase (panel-buscas.js:20-35) lê dez tabelas inteiras. Qualquer falha passageira vira renderFailure da aba (painel.js:643-645), e quem estava selecionando carros perde a tela
- Correção sugerida: catch por parte com aviso local, e manter na tela a última resposta boa enquanto a nova falha

### 5. Abrir ENVIAR OPÇÕES chama a mesma visão pesada duas vezes
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: P
- Evidência: painel.js:1942 (searches), :1957 (imports) e :1977 (manheim) chamam request('/api/panel/records?view=manheim') direto, fora do requestPool, enquanto os contadores pedem o mesmo caminho por sharedGet (painel.js:2011) e BUSCAR CARROS também (painel.js:1971). Em BUSCAR CARROS, pesquisas vem por request (:1964) e de novo por sharedGet nos contadores (:2010). Cada visão manheim custa as quatro leituras do achado 1 mais a base inteira
- Correção sugerida: abrir a visão por sharedGet com o mesmo prazo e alimentar o pool com a resposta da aba, para os contadores reaproveitarem

### 6. Cada página de opções recarrega a base inteira do painel
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: M
- Evidência: api/panel/manheim-options.js:143 (groupPage) e :202-203 (options) chamam contextFor, que roda loadBuscasBase completo (todas as mensagens, todos os calc_runs, telefones, refs, vínculos, triagem), e alsoFitsFor lê todas as vitrines (:56). painel.js:2883-2896 (selectedOptions) busca os carros selecionados página por página, em série, 50 por vez, por grupo; um pedido amplo exige várias voltas, cada uma com a base inteira
- Correção sugerida: contexto só do pedido pedido (ficha e refs dele), e a lista dos selecionados lida direto por id numa chamada só

### 7. Sincronização de OPÇÕES espera mais do que o servidor vive
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: P
- Evidência: painel.js:334 usa timeoutMs 40000 e até 6 rodadas; vercel.json:9 dá 30 s a manheim-options. Log da Vercel: POST /api/panel/manheim-options 504 às 20:19, "Task timed out after 30 seconds". Ela roda em toda abertura de ENVIAR OPÇÕES (painel.js:1946) e após cada gravação de critério (painel.js:316), e no fim recarrega a visão inteira (painel.js:339)
- Correção sugerida: prazo do servidor (20 s em manheim-options.js:242) bem abaixo dos 30 s contando a base, tempo do cliente abaixo do limite da função, e não disparar a cada abertura se a última rodada terminou há pouco

### 8. Envio da V1 pode ficar preso em "enviando" para sempre
- Domínio: VENDAS
- Gravidade: BLOQUEIA_VENDA
- Esforço: M
- Evidência: api/panel/v1-send.js:162 grava status SENDING antes de falar com o 360dialog; só :169-186 mudam o status. Se a função morrer no meio (fim do prazo, queda), a linha fica SENDING; :139 recusa todo novo envio com SEND_IN_PROGRESS e o índice único v1_sends_one_in_flight_idx (migração 20261007010000, linha 32) impede outro registro. Nenhum código expira um SENDING antigo (busca por 'SENDING' no repositório). Hoje não há linha presa (SELECT em v1_sends: 1 linha, SENT)
- Correção sugerida: SENDING com mais de alguns minutos vira UNCONFIRMED na próxima tentativa (ou por rotina), com o aviso de conferir no WhatsApp antes de reenviar

### 9. Rotina de identidade lenta e perto do limite de 8 s
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: M
- Evidência: pg_stat_statements: panel_identity_evidence com 2.086 chamadas, média 2,56 s, máxima 6,9 s; 500 por timeout às 23:28 e 23:48. Chamada pela subject-cron a cada 5 min em blocos de 40 fichas (panel-identity.js:181-183). A função (migração 20261016040000, linhas 120-121) lê todos os calc_runs em cada chamada, sem filtro, e reavalia fichas sem mudança para só gravar updated_at (panel-identity.js:143-146). Um bloco com timeout interrompe a etapa inteira do ciclo
- Correção sugerida: ler as Refs de calc_runs só para as Refs candidatas, blocos menores, pular fichas sem mensagem nova desde a última avaliação, e um bloco com erro não parar os seguintes

## Fora do meu domínio, não investigado a fundo
- Guard do makeCardClickable e duplicação de VIN na tela ficaram para os setores de frontend e QA
