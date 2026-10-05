# AUD-001 · setor dados · relatório final do aprovador

- Papel: Nível 3 Aprovador (agente distinto do executor e do revisor)
- Base: main 7a25ef1
- Fontes lidas: entregas/AUD-001-executor.md, entregas/AUD-001-revisor.md e o código citado por eles
- Banco de produção: somente SELECT; nenhum dado pessoal transcrito; lote ativo intocado

## 1. O que foi pedido

Auditoria do painel no domínio de dados, somente achados com evidência, sem alterar código, sem commit e sem publicar. Caçar mesma API chamada duas vezes para a mesma visão, mesma leitura do banco repetida, consultas perto do limite de 8 s, seleção guardada em dois lugares e divergindo, contagens e carros duplicados, e o que quebre o fluxo de vender

## 2. O que foi entregue

Executor: 8 achados (E1 a E8). Revisor: avaliação cega com 7 achados (D1 a D7), depois comparação com o rascunho, sem refutar nenhum por inteiro e rebaixando E5

Conferência do aprovador no código e no banco

- E1=D1 ficha conta venda encerrada: confirmado. panel-lead.js:240 monta allOffers a partir de manheim_vehicles sem filtro de endsAt nem de MMR; panel_manheim_grouped_light (20261024020000_manheim_resumo_rapido.sql, CTE flagged) só conta venda ativa com MMR. SELECT no lote ativo hoje: 66.359 linhas, 13.218 com venda já encerrada
- E2+D7 seleção em dois lugares: confirmado no código. painel/painel.js:3174 chama state.setSelected(option.id, ...) e ignora o matchId devolvido; o banco grava no membro do grupo que já tinha linha (20261022010000_manheim_v34_group_vin.sql:265); selectedIds nasce de first_selected (20261024020000:39); selectedOptions (painel/painel.js:2886) compara só option.id; o "N de 10 selecionados" (painel.js:3511-3512) usa só o conjunto local e ignora o total do servidor; a V1 (painel.js:3634) manda esse conjunto e api/panel/vitrines.js:111 recusa VIN repetido. Latente hoje segundo os dois, mas o caminho de falha existe no código
- E3=D2 "carros analisados" conta linhas: confirmado. painel/manheim.js:235 inclui lane e run no fingerprint quando há VIN; dedupeAcrossFiles (painel/manheim-upload.js:165) usa esse fingerprint. SELECT: vehicle_count 66.359 contra 56.694 VINs distintos; matched_vehicle_count congelado 34.906
- E4 MMR típico e mediana contam o mesmo VIN várias vezes: confirmado. panel-lead.js:225-226 junta por row_fingerprint; typical (229-234) e reference (252) usam esse mapa
- E5 badges com regras diferentes: confirmado só como rótulo. O badge searches (ENVIAR OPÇÕES) usa optionsPeopleOf, que inclui QUASE; o badge manheim usa current_lead_count (BATE e POR_VALOR, panel-buscas-view.js:205-207). São abas diferentes e o contador da linha 2027 usa a mesma regra do badge; não há número errado, há rótulo que não diz o que mede
- E6 resumo ignora grupo gravado no complemento: confirmado, latente. grouped_light calcula priority só pela regra inline; offer_page usa coalesce(stored_group, regra) (20261025010000:30 e 85); a versão anterior (20261018010000:34) preferia si.offer_group
- E7 base pesada relida a cada página: confirmado. api/panel/manheim-options.js:46 contextFor roda loadBuscasBase (panel-buscas.js:20-31, dez leituras de tabelas inteiras) em cada página; alsoFitsFor (59) lê vitrines inteira
- E8=D3 agrupamento calculado três ou quatro vezes por carga: confirmado. panel-buscas-view.js:182-186 roda batch_summary, offer_summary e batch_cars em paralelo, todas sobre grouped_light. Tempos medidos por executor e revisor (1,4 a 1,7 s cada) ficam longe dos 8 s
- D4 abrir a aba ignora o pool dos contadores: confirmado. As visões usam request() direto (painel.js:1942, 1957, 1964, 1975) e os contadores usam sharedGet com 60 s (painel.js:2010-2011)
- D5 contexto do cliente refaz batch_people: confirmado. panel-client-context.js:330 chama panel_manheim_batch_people sem memo; api/panel/records.js:31 faz a mesma leitura inteira para uma ficha
- D6 ficha baixa o estoque inteiro da marca: confirmado no código. panel-lead.js:216-220 lê vehicle_json completo de todos os lotes vivos de 60 dias para as marcas pedidas

## 3. Divergências encontradas

- E1: executor esforço P, revisor M (falta também o complemento de venda e a ordem do representante). Decisão: M, porque a ficha precisa da mesma regra de venda ativa, do complemento e do mesmo representante do banco
- E2: executor BLOQUEIA_VENDA, revisor no cego INFO_ERRADA (D7), depois aceitou BLOQUEIA_VENDA. Decisão: BLOQUEIA_VENDA, latente; o código leva a V1 recusada e PDF sem o carro quando o representante muda
- E5: executor INFO_ERRADA_OU_DUPLICADA, revisor rebaixou para rótulo. Decisão: OUTRO, P; os números estão certos para o que cada badge mede
- E3 e D2: o revisor acrescentou o número congelado dos lotes desfeitos e o rótulo "matches" (painel.js:4335). Decisão: junto num achado só
- E8 e D3: executor contou três leituras, revisor quatro com o score e a repetição em BUSCAR CARROS. Decisão: junto num achado só, com a contagem do revisor
- Medição de encerrados: executor 13.189, aprovador 13.218 hoje; diferença esperada porque mais vendas terminaram desde a medição

## 4. Decisão do aprovador

Aprovados (11), todos com evidência conferida pelo aprovador

| Achado | Domínio | Gravidade | Esforço | Corrigir agora |
|---|---|---|---|---|
| E2+D7 seleção em dois lugares com ids diferentes | VENDAS | BLOQUEIA_VENDA (latente) | M | sim |
| E1=D1 ficha conta e oferece venda encerrada | DADOS | INFO_ERRADA_OU_DUPLICADA | M | sim |
| E3=D2 "carros analisados" conta linhas, não VIN | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| E4 MMR típico e mediana contam o mesmo VIN várias vezes | DADOS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| E6 resumo ignora grupo gravado no complemento | DADOS | INFO_ERRADA_OU_DUPLICADA (latente) | P | sim |
| E8=D3 agrupamento do lote calculado três ou quatro vezes por carga | DADOS | OUTRO | M | não, backlog |
| D4 abrir a aba repete a chamada que os contadores acabaram de fazer | DADOS | OUTRO | P | não, backlog |
| D5 contexto do cliente refaz batch_people a cada pedaço | DADOS | OUTRO | P | não, backlog |
| E7 base pesada relida a cada página de opções | DADOS | OUTRO | M | não, backlog |
| D6 ficha baixa o estoque inteiro da marca | DADOS | OUTRO | M | não, backlog |
| E5 badges de abas diferentes sem rótulo do que medem | TELA | OUTRO | P | não, backlog |

Rejeitados: nenhum por falta de evidência. E5 aprovado só como rótulo, não como informação errada

Observação para a fase de correção: E8, D4, D5 e E7 entram no item 3 do comando (leituras duplicadas do banco e consultas lentas); pela regra deste pedido (gravidade OUTRO) ficam no backlog, mas a Leo pode puxá-los para a correção imediata, já que o comando lista esse tema entre os itens fechados

Esta decisão não substitui a aprovação da Leo
