# AUD-001, eng-backend-infra, Nível 2 Revisor independente

Pedido: AUD-001 (auditoria do painel, somente achados, sem alterar código)
Agente: revisor independente do setor eng-backend-infra
Ordem das etapas: avaliação cega registrada abaixo ANTES de abrir o rascunho do executor (AUD-001-executor.md não foi aberto)
Banco de produção: só SELECT e EXPLAIN ANALYZE em funções STABLE (somente leitura, provolatile = s conferido em pg_proc). Nenhum dado pessoal transcrito. Lote ativo do Manheim não foi tocado.

## Avaliação cega

Medições de referência (produção, 04/10/2026, lote ativo com 243 mil linhas em manheim_matches):
- Limite: authenticator com statement_timeout=8s (pg_roles)
- panel_manheim_score_mmr 1.630 ms; panel_manheim_batch_summary 1.600 ms; panel_manheim_batch_cars 1.492 ms; panel_manheim_batch_people 1.410 ms; panel_manheim_offer_summary 1.328 ms; panel_manheim_offer_page (pedido com 3.097 carros) 1.049 ms; panel_manheim_offer_page_sorted 846 ms; panel_manheim_offer_trims 829 ms (EXPLAIN ANALYZE, cada uma sozinha, banco sem carga)
- pg_stat_statements (desde 19/09/2026): score_mmr 3.198 chamadas, máximo 5.724 ms; batch_people 1.606 chamadas, máximo 5.673 ms; offer_summary 433 chamadas, média 1.251 ms, máximo 5.535 ms; batch_summary 980 chamadas, máximo 5.508 ms. Sob carga essas leituras chegam a 70% do limite de 8 s

### A1. Abertura (boot, parte counters) roda as mesmas funções pesadas duas vezes
- Domínio DADOS, gravidade INFO_ERRADA_OU_DUPLICADA (leitura duplicada), esforço P
- Evidência: api/panel/boot.js:20-24 roda pesquisas, records (clientes) e records (view manheim) juntos. O cache da abertura (panel-server.js:89-92) só cobre rows(); rpc() (panel-server.js:200-204) não tem cache. Resultado numa só chamada: panel_manheim_batch_summary 2 vezes (api/panel/pesquisas.js:47 e panel-buscas-view.js:184), panel_manheim_score_mmr 2 vezes (api/panel/records.js:80 e panel-buscas-view.js:158), além de mais uma vez na parte main (api/panel/today.js:61). Cada uma custa 1,3 a 1,6 s e varre manheim_matches; rodando em paralelo disputam o banco (máximos de 5,5 a 5,7 s acima)
- Correção: estender ctx.readCache para rpc() de leitura (chave = nome + argumentos), e fazer loadScoreIndex usar um p_since arredondado (por exemplo ao minuto), para que as chamadas da mesma abertura caiam na mesma chave

### A2. Abrir OPÇÕES, IMPORTAÇÕES ou MANHEIM recalcula records?view=manheim que a abertura acabou de trazer
- Domínio DADOS, gravidade INFO_ERRADA_OU_DUPLICADA (mesma API duas vezes para a mesma visão), esforço P
- Evidência: painel/painel.js:1928 coloca o resultado de /api/panel/records?view=manheim no cache (primeBoot). Mas painel/painel.js:1942 (searches), 1957 (imports) e 1975 (manheim) usam request() direto, não sharedGet(), então ignoram o cache e o servidor refaz manheimView: loadBuscasBase (cerca de 15 tabelas paginadas) + score_mmr + batch_summary + offer_summary + batch_cars, cerca de 6 s de banco. Mesmo padrão em painel/painel.js:1964 para /api/panel/pesquisas (requests)
- Correção: usar sharedGet com ttl curto (por exemplo 30 a 60 s) na primeira abertura da visão e request() só no recarregar manual ou depois de uma ação

### A3. Cada página de opções relê a base inteira de BUSCAS
- Domínio DADOS, gravidade OUTRO (leitura repetida e lentidão no fluxo de vender), esforço M
- Evidência: api/panel/manheim-options.js:162 (groupPage) e :198 chamam contextFor (linha 37), que chama loadBuscasBase (panel-buscas.js:16-36): journeys, contacts, contact_phones, journey_refs, journey_toggle_states, calc_runs (4.129 linhas, sem filtro de ambiente), calculator_request_links, panel_item_dispositions, message_journeys (3.157), messages (3.156), triagem, refs explícitas e 3 tabelas de pedidos, tudo paginado de 1.000 em 1.000. Isso acontece a cada "Ver mais" de 10 carros. Em groupPage a leitura vem DEPOIS da RPC da página (linhas 147-162, em série), somando cerca de 1 s da RPC + a base. alsoFitsFor (linha 49) ainda lê todas as vitrines a cada página
- Correção: rodar contextFor em paralelo com a RPC da página (como já faz options() na linha 191) e montar só o contexto da demanda pedida (journey da chave) em vez da base inteira; ler vitrines só para as fichas da página

### A4. Baixar PDF com carro selecionado em grupo fechado pode passar por dezenas de páginas em série
- Domínio VENDAS, gravidade OUTRO (atrasa entrega ao cliente; pode estourar e falhar), esforço M
- Evidência: painel/painel.js:2883-2895 (selectedOptions) percorre LANE, OFFLANE e INCOMPLETE de 50 em 50, em série, até achar os ids selecionados. A ordem do banco é por faixa e CR (supabase/migrations/20261006030000_panel_manheim_complemento_troca.sql:106), não por seleção, então um carro selecionado pode estar no fim. Pedido real do lote ativo tem 3.097 carros: até cerca de 62 páginas, cada uma com RPC de cerca de 1 s + loadBuscasBase (A3). Chamado em painel/painel.js:3623
- Correção: endpoint ou RPC que devolva os carros selecionados da demanda por id (a seleção já está em tabela própria, ver selected_ids na mesma migração, linha 54), uma chamada só

### A5. Selecionar carro para o cliente relê a base inteira e lê os carros um por um
- Domínio VENDAS, gravidade OUTRO (latência em cada clique de seleção), esforço M
- Evidência: api/panel/manheim-options.js:142-145 chama optionStamp.gate antes de selecionar; panel-option-stamp.js:53-66 chama contextFor (loadBuscasBase inteira, mesma de A3) e depois lê manheim_matches um id por vez dentro de um for (linha 59-60, N+1). Cada clique em Selecionar paga a base inteira antes da RPC panel_manheim_offer_select_v2
- Correção: ler os matches de uma vez (id=in.(...)) e montar só o contexto da demanda da chave

### A6. Funções do resumo do lote em 1,3 a 1,6 s cada, com picos acima de 5,5 s
- Domínio DADOS, gravidade OUTRO (risco de passar de 8 s com lote de 66 mil carros), esforço G
- Evidência: medições acima. As cinco funções varrem o mesmo lote; com A1 e A2 elas rodam várias vezes em paralelo. Com o lote crescendo, os picos já registrados (5,5 a 5,7 s) ficam perto do corte de 8 s, e a visão some com "Resumo indisponível" (panel-buscas-view.js:183-184)
- Correção: guardar o resumo por lote (tabela ou visão materializada atualizada no fim da importação e da seleção) em vez de recalcular a cada leitura; enquanto isso, A1 e A2 já cortam a maior parte das execuções

### Não encontrado no meu domínio
- Nenhuma consulta atual medida acima de 8 s nas leituras do painel
- Leituras paginadas grandes de manheim_matches por created_at que aparecem em pg_stat_statements (até 7,6 s) não têm mais chamador no código atual (busca por gte em manheim_matches sem resultado); são de versão anterior
- latestV1For (painel/painel.js:3357-3375) já agrupa as fichas numa só chamada; sem duplicação

## Comparação com o rascunho

Feita depois da avaliação cega, abrindo AUD-001-executor.md e conferindo cada achado no código atual e no banco (somente SELECT).

### Correção da minha própria medição
- Escrevi acima "lote ativo com 243 mil linhas em manheim_matches". Errado: esse número é a tabela inteira (hoje 273.102 linhas, todos os lotes). O lote ativo de produção tem 55.454 linhas ativas (56.014 no total), como o executor disse. Os tempos medidos continuam válidos; o que muda é só a legenda.

### Achados do executor
- E-A1 "sem opção" falso quando o resumo falha: SUSTENTADO. api/panel/pesquisas.js:47 usa `.catch(() => [])`; nas linhas 76 a 78, sem linha no resumo, served = 0 e o pedido vira NO_OPTIONS. Só ocorre quando não há check gravado e o hash da importação bate, mas nesse caso a informação fica errada. Eu não tinha visto. Gravidade INFO_ERRADA_OU_DUPLICADA, esforço P, concordo.
- E-A2 resumo do lote lido duas vezes no boot counters: SUSTENTADO e CONCORDANTE com meu A1 (mesmas linhas: boot.js:20-24, pesquisas.js:47, panel-buscas-view.js:184, records.js:80, panel-buscas-view.js:158, panel-server.js:89 e 200). Divergência só de rótulo: eu marquei INFO_ERRADA_OU_DUPLICADA (leitura duplicada, que o pedido manda corrigir agora), ele marcou OUTRO. Recomendo meu rótulo, porque o item 3 do comando fecha "leituras duplicadas do banco".
- E-A3 OPÇÕES buscada duas vezes depois de importar ou desfazer: SUSTENTADO e CONCORDANTE com meu A2, e mais completo. painel.js:4589 invalida o pool, 4591 loadCurrent faz request direto (1942, 1957, 1975) e 4592 refreshCounters faz sharedGet com cache vazio (2010): duas chamadas idênticas. Mesmo em 4344 a 4345. Mesma divergência de rótulo (OUTRO x INFO_ERRADA_OU_DUPLICADA).
- E-A4 BUSCAR CARROS dispara leituras que repetem a base: SUSTENTADO com ressalva. pesquisas.js:43, manheim-searches.js:22 e panel-buscas-view.js:151 chamam loadBuscasBase; searches.js:31-42 relê as mesmas tabelas e chama batch_people (46). Ressalva: na visão requests, records?view=manheim vai por sharedGet com 60 s (painel.js:1971) e costuma sair do cache do boot, então são três leituras da base no servidor, não quatro. Complementa meu A3 (mesma base relida em cada página de opções).
- E-A5 WhatsApp lido duas vezes: PARCIALMENTE SUSTENTADO (divergente no alcance). Vale para painel.js:1072 (refresh da triagem: loadWhatsApp com request direto e depois refreshCounters com sharedGet de 10 s). Nas linhas 1110 e 1151 o refresh chama só loadWhatsApp/loadQueue, sem refreshCounters (MCSAction em painel/action.js não chama contadores), então ali não há leitura dupla. Esforço P, gravidade OUTRO, concordo.
- E-A6 reconciliação de identidade relê 120 fichas a cada 5 min: SUSTENTADO. subject-cron.js:33 com max 120, vercel.json:24 agenda 3-59/5; panel-identity.js:169-185 ordena por updated_at e chama panel_identity_evidence em lotes de 40; ficha sem mudança faz PATCH unitário em série (146). Não confirmei os números de pg_stat_statements dele, mas o mecanismo está no código. Fora do meu recorte cego; concordo como backlog (esforço M).
- E-A7 V1 preso em SENDING: SUSTENTADO como risco. v1-send.js:162 grava SENDING antes do envio (prazo de 15 s, linha 24); 139 recusa novo envio enquanto houver SENDING; índice único v1_sends_one_in_flight_idx (migração 20261007010000:32); nenhum outro código no repositório muda SENDING antigo; v1-send.js não aparece em functions do vercel.json. Divergência de gravidade: BLOQUEIA_VENDA só se a função cair entre gravar e finalizar; hoje nenhum preso. Aceito BLOQUEIA_VENDA condicional, esforço P, é bom candidato a correção imediata.
- E-A8 7.693 carros repetidos por pedido no armazenamento, sem duplicação na tela: SUSTENTADO. SELECT agora: lote ativo com 55.454 linhas ativas e 47.759 trios (demanda, desejo, VIN) distintos (ele contou 47.758; diferença de 1, sem efeito). Não refiz a conferência de todas as funções de leitura, mas as que li (batch_summary, offer_summary) agrupam por VIN. Concordo: só monitorar.

### Meus achados, conferidos de novo
- R-A1 (boot duplica funções pesadas): SUSTENTADO, coincide com E-A2.
- R-A2 (OPÇÕES, IMPORTAÇÕES, MANHEIM ignoram o cache do boot): SUSTENTADO, coincide com E-A3.
- R-A3 (cada página de opções relê a base inteira): SUSTENTADO. manheim-options.js groupPage chama contextFor depois da RPC da página; o executor não tem este item.
- R-A4 (Baixar PDF percorre páginas em série): SUSTENTADO. painel.js:2883-2895 pagina LANE, OFFLANE e INCOMPLETE de 50 em 50 em série; chamado em 3623. O executor não tem este item.
- R-A5 (selecionar carro relê a base e lê matches um a um): SUSTENTADO. panel-option-stamp.js:58 chama contextFor e 59-60 lê manheim_matches um id por vez dentro do for. O executor não tem este item.
- R-A6 (funções do resumo entre 1,3 e 1,6 s com picos de 5,5 a 5,7 s): SUSTENTADO pelas medições dos dois lados (executor mediu 1,34 a 1,54 s). Retiro a menção "lote de 66 mil carros": o lote ativo tem 55 mil linhas; o risco segue pelo crescimento e pela concorrência.

### Resumo para o Aprovador
- Concordâncias: E-A2 = R-A1; E-A3 = R-A2; E-A6 (mecanismo), E-A7, E-A8, E-A1.
- Divergências: rótulo de gravidade de E-A2/E-A3 (proponho INFO_ERRADA_OU_DUPLICADA por ser leitura duplicada); alcance de E-A5 (só a linha 1072); E-A4 conta três leituras da base, não quatro.
- Refutados: nenhum achado inteiro. Refutada só a minha legenda de 243 mil linhas no lote ativo (é a tabela toda).
- Itens só de um lado, todos sustentados: E-A1, E-A5, E-A6, E-A7, E-A8 (executor); R-A3, R-A4, R-A5 (revisor).
