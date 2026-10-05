# AUD-001 · confiabilidade-sre · relatório final do aprovador

Agente: Nível 3 Aprovador do setor confiabilidade-sre, distinto do executor e do revisor
Base conferida: main 7a25ef1, banco de produção só com SELECT (schema_migrations, pg_proc, pg_roles, pg_stat_statements, contagem por status em v1_sends). Nenhum dado pessoal transcrito, lote ativo do Manheim intocado
Logs da Vercel e da borda do Supabase citados por executor e revisor não foram reabertos pelo aprovador; nenhuma decisão abaixo depende só deles

## 1. O que foi pedido

AUD-001: auditoria do painel somente com achados, sem alterar código, sem commit, sem publicação. No domínio do setor: leituras do banco repetidas, a mesma API chamada duas vezes para a mesma visão, consultas perto do limite de 8 s, e o que trave o fluxo de vender (seleção, V1, WhatsApp). Cada achado com domínio, gravidade, esforço, evidência e correção sugerida

## 2. O que foi entregue

- entregas/AUD-001-executor.md: 9 achados (E1 a E9)
- entregas/AUD-001-revisor.md: avaliação cega com 9 achados (A1 a A9), depois comparação com o rascunho
- Este relatório: 13 achados aprovados após conferência própria, 1 refutação do revisor derrubada

Conferências do aprovador
- Limite confirmado: authenticator com statement_timeout=8s
- As cinco funções de resumo (batch_summary, offer_summary, batch_cars, batch_people, score_mmr) usam panel_manheim_grouped_light (pg_proc: 5 de 5)
- pg_stat_statements: batch_summary com máximo de 18,0 s, offer_summary 12,2 s, batch_people 10,5 s, batch_cars 9,2 s, panel_undo_manheim_upload 11 chamadas com média 5,3 s e máximo 12,4 s. Já passam dos 8 s
- schema_migrations termina em 20261022010000, zero versões a partir de 20261023, mas grouped_light existe em produção
- v1_sends: 1 linha, SENT, nenhuma presa hoje

Achados aprovados (ordem por impacto)

| # | Achado | Domínio | Gravidade | Esforço | Corrigir agora |
|---|---|---|---|---|---|
| 1 | Falha de leitura base derruba ENVIAR OPÇÕES e IMPORTAÇÕES (E4=A1) | VENDAS | BLOQUEIA_VENDA | P | sim |
| 2 | V1 pode ficar presa em SENDING para sempre (E8=A6) | VENDAS | BLOQUEIA_VENDA | P | sim |
| 3 | Seis agregações pesadas do lote por abertura (E1=A3) | DADOS | INFO_ERRADA_OU_DUPLICADA (leitura duplicada) | M | sim |
| 4 | BUSCAR CARROS marca "Sem opção" quando o resumo falha (E2) | DADOS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| 5 | ENVIAR OPÇÕES mostra 0 carros no lote quando batch_cars falha (A5) | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| 6 | CLIENTES perde o aviso de carros do lote quando a contagem falha (E3) | DADOS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| 7 | Mesma visão manheim pedida duas vezes (E5=A4) | DADOS | INFO_ERRADA_OU_DUPLICADA (leitura duplicada) | P | sim |
| 8 | Cada página de opções relê a base inteira (E6) | DADOS | INFO_ERRADA_OU_DUPLICADA (leitura repetida) | M | sim |
| 9 | Sincronização de OPÇÕES espera 40 s e o servidor vive 30 s (E7) | DADOS | OUTRO | P | não, backlog |
| 10 | Rotina de identidade lenta, até 6,9 s (E9=A8) | DADOS | OUTRO | M | não, backlog |
| 11 | Chamada ao banco no servidor sem prazo (A2) | DADOS | OUTRO | P | não, backlog |
| 12 | Desfazer lote passa de 8 s (A7) | DADOS | OUTRO | G | não, backlog |
| 13 | Histórico de migrações divergente da produção (A9) | DADOS | OUTRO | P | não, backlog |

Evidências conferidas pelo aprovador
- 1: panel-buscas-view.js:150-159, Promise.all com loadBuscasBase, loadUploads, panelMeta, whatsapp_user_ids, conversation_pending_insights, journey_checklist e loadSearchStageIndex sem catch; só loadScoreIndex tem. painel.js:1942 e :1957 usam essa rota para ENVIAR OPÇÕES e IMPORTAÇÕES. Correção: catch nas leituras não essenciais com aviso de indisponível
- 2: v1-send.js:162 grava SENDING; :139 recusa todo novo envio com SEND_IN_PROGRESS; finish (:168) sem tratamento de erro; índice único v1_sends_one_in_flight_idx (migração 20261007010000 linha 32); "SENDING" não aparece em nenhuma rotina de expiração. Correção: SENDING com mais de 2 minutos tratado como UNCONFIRMED em lastSend, sem reenvio automático
- 3: boot.js:21-23 roda pesquisas, records e records?view=manheim juntos; pesquisas.js:47 (batch_summary), records.js:31 (batch_people), panel-buscas-view.js:158 (score_mmr via loadScoreIndex, panel-ready.js:25), :182-188 (summary, offer, cars). rpc() em panel-server.js:200 não passa pelo readCache (só readRows, :89). Correção: uma leitura do agrupamento por pedido HTTP e cache de rpc no ctx.readCache
- 4: pesquisas.js:47 .catch(() => []) sem log; :70-73 com resumo vazio dá served 0 e NO_OPTIONS. Correção: resumo nulo na falha, resultado "Resumo indisponível", nunca NO_OPTIONS
- 5: panel-buscas-view.js:186 batch_cars .catch(() => []), e logo abaixo `activeIds.forEach(... if (batchOn && !operational.has(uploadId)) operational.set(uploadId, 0))` grava 0 para todo lote ativo; upload.matched_vehicle_count e batches[].matchCount saem 0. Correção: catch devolve null e, nesse caso, não preencher zero; manter o número congelado com a marca de indisponível
- 6: records.js:76 e :244 trocam a falha por mapa vazio; :123 e :280 gravam 0; painel.js:5101 só mostra o aviso com contagem maior que zero. Efeito: o aviso de carros do lote some, não um "0" escrito. Correção: contagem null e cartão com "contagem indisponível"
- 7: painel.js:1942, :1957 e :1975 chamam request direto; contadores usam sharedGet na mesma rota (:2011); após desfazer (:4344-4345) e importar (:4590-4592) vêm loadCurrent e refreshCounters em seguida. Correção: abrir a visão por sharedGet ou alimentar o pool com a resposta da aba
- 8: manheim-options.js:46-51 contextFor roda loadBuscasBase completo, chamado em :143 e :203; alsoFitsFor lê todas as vitrines (:59); painel.js:2883-2896 selectedOptions em série, 50 por página. Correção: contexto só do pedido e leitura dos selecionados por id numa chamada
- 9: painel.js:334 timeoutMs 40000 e até 6 rodadas; vercel.json maxDuration 30 para manheim-options; prazo interno de 20 s (manheim-options.js:242) contado depois da base
- 10: panel-identity.js:140 chama panel_identity_evidence em blocos de 40 (:181-183, sem catch por bloco); migração 20261016040000 lê todos os calc_runs sem filtro (CTE runs); :143-146 grava updated_at de ficha sem mudança
- 11: panel-server.js:33-53, fetch sem AbortController nem prazo
- 12: pg_stat_statements, máximo de 12,4 s; correção exige dividir o desfazer em partes retomáveis, mexendo no fluxo do lote, por isso esforço G
- 13: schema_migrations parado em 20261022010000 com as funções de 20261023010000, 20261024020000 e 20261025010000 em produção

## 3. Divergências encontradas

- A5 (revisor): o revisor refutou o próprio achado dizendo que :241 e :246 caem no número congelado. O aprovador derruba a refutação: a linha anterior grava 0 em operational para todo lote ativo sem linha quando batchOn, então operational.has é verdadeiro e o número sai 0. Achado aprovado
- E3: o executor descreveu "0 carros para todo mundo"; o revisor sustentou com ressalva de que a tela esconde o aviso em vez de escrever 0. O aprovador confirma a ressalva em painel.js:5101; a informação continua errada, aprovado com o efeito corrigido
- Esforço de E4/A1 e E8/A6: executor M, revisor P. Decisão: P para a correção mínima descrita (catch nas leituras não essenciais; SENDING antigo vira UNCONFIRMED). Manter a última resposta boa no cliente fica como melhoria M no backlog
- Esforço de E9/A8: executor M, revisor P. Decisão: M, porque a correção que resolve inclui filtrar calc_runs na função do banco
- Gravidade de E1, E5 e E6: executor e revisor usaram OUTRO ou INFO_ERRADA. Decisão: leitura duplicada ou repetida do banco entra como duplicação, item 3 do comando da Leo, e vai para correção agora
- Erros de linha sem efeito no mérito: E5 (1977 é 1975), E6 (56 é 59), A4 (2010 é 2011)
- Os números dos logs (500 e 504 nas últimas 24 h) vêm de executor e revisor; o aprovador não os reabriu e apoiou as decisões no código e no pg_stat_statements

## 4. Decisão do aprovador

Aprovados para corrigir agora (bloqueia venda ou informação errada ou duplicada, esforço P ou M): 1, 2, 3, 4, 5, 6, 7, 8
Ordem sugerida: 1 e 2 (venda), 4, 5 e 6 (P, informação errada), 7 (P), depois 3 e 8 (M)
Cada correção exige spec que falha antes e passa depois, npm test e specs Playwright existentes verdes

Backlog priorizado por impacto x esforço
1. Item 11, prazo nas chamadas ao banco no servidor, P
2. Item 9, prazos da sincronização de OPÇÕES abaixo dos 30 s da função, P
3. Item 13, registrar no histórico as três migrações já aplicadas, sem reaplicar, P; necessário antes de qualquer nova migração da fase 2
4. Item 10, rotina de identidade, M
5. Manter na tela a última resposta boa de ENVIAR OPÇÕES quando a nova falha, M
6. Item 12, desfazer lote em partes retomáveis, G

Rejeitado: a refutação do revisor sobre A5. Nenhum outro achado foi rejeitado. Decisão sujeita à aprovação da Leo
