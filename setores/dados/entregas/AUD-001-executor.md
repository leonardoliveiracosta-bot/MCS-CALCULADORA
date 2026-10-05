# AUD-001 · setor dados · rascunho do executor

- Pedido: AUD-001, auditoria do painel My Car Scout, somente achados, sem alterar código, sem commit, sem publicar
- Papel: Nível 1 Executor
- Agente: Claude (subagente do fluxo de auditoria, setor dados)
- Data: 2026-10-05
- Base: main atual (commit 7a25ef1, que traz 77c9352 e 29e1bd9)
- Foco do setor: contagens, duplicação por VIN, totais que divergem entre telas, seleção guardada em dois lugares
- Banco de produção: somente SELECT e EXPLAIN ANALYZE em funções só de leitura; nenhum dado pessoal transcrito; lote ativo intocado

## Medições no lote ativo (produção, 2026-10-05)

- manheim_vehicles do lote ativo: 66.359 linhas, 56.694 VINs diferentes (9.665 linhas repetem VIN, 14,6 %)
- manheim_uploads.vehicle_count do lote ativo: 66.359
- manheim_matches do lote ativo: 55.454 linhas, 47.758 pares pedido e VIN
- Linhas do lote com venda já encerrada (endsAt no passado): 13.189 (cerca de 20 %)
- Pedidos do lote: 389; em 366 a contagem de carros por VIN (BATE e POR_VALOR) sem filtro de venda ativa difere da contagem que BUSCAS usa; maior diferença 300 carros num pedido
- Tempo das funções: panel_manheim_batch_summary 1,7 s; offer_summary + batch_cars + batch_people juntas 4,2 s (cerca de 1,4 s cada); offer_page + offer_trims do maior pedido (3.097 matches) 1,5 s. Nada perto dos 8 s hoje
- Seleções ativas no lote: 7 carros selecionados, 0 com o id selecionado diferente do representante do VIN (o achado 2 está latente hoje)
- Itens de complemento de venda no lote ativo: 0 (o achado 6 está latente hoje)

## Achados

### 1. Ficha conta e oferece carros com venda encerrada (cartão 5 e O QUE OFERECER)
- Domínio: DADOS (afeta VENDAS)
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: panel-lead.js:240-253 monta allOffers, offers, fits e servedOptions a partir de manheim_vehicles do lote ativo só com vehicleMatch.matchDemand; nenhum filtro de venda ativa (endsAt) nem de MMR válido (grep por endsAt e saleActive em panel-lead.js, panel-reality.js e vehicle-match.js não acha nada). BUSCAS conta só venda ativa com MMR (panel_manheim_grouped_light, 20261024020000_manheim_resumo_rapido.sql:23-26). Medição: 13.189 linhas do lote com venda encerrada; em 366 de 389 pedidos o total por VIN sem esse filtro difere do total de BUSCAS, até 300 carros a mais. Na prática a ficha diz "N opções no lote" e lista carros que BUSCAS não deixa selecionar
- Correção sugerida: em panel-lead.js filtrar os carros por manheim-offer.purchaseOptions(parsed).length > 0 (mesma regra saleActive) e por MMR válido antes de allOffers, e escolher o representante do VIN pela mesma ordem do banco (ativo, Lane/Run, Buy Now, incompleto). Teste: lote fictício com o mesmo VIN encerrado em Lane/Run e ativo em Buy Now deve contar 1 carro e mostrar a venda ativa

### 2. Seleção para o cliente guardada em dois lugares com ids diferentes (navegador x banco)
- Domínio: DADOS (afeta VENDAS)
- Gravidade: BLOQUEIA_VENDA (latente: 0 casos hoje, aparece quando o representante do VIN muda)
- Esforço: M
- Evidência: o banco grava a seleção no id do membro do grupo do VIN que já tinha linha (panel_manheim_offer_select_v2, 20261022010000_manheim_v34_group_vin.sql, trecho "select coalesce((select ss.match_id ... v_members ? ss.match_id::text ...), v_match.id) into p_match_id") e devolve esse id em matchId. O navegador guarda outro id: painel/painel.js:3174 chama state.setSelected(option.id, ...) com o id do representante da página e ignora result.matchId; painel/painel.js:3508 inicia selectedIds com selected_ids do resumo, que é o primeiro membro selecionado do grupo (grouped_light, first_selected), não o representante. O representante muda quando a venda Lane/Run termina ou quando um arquivo é acrescentado ao lote (grouped_options ordena por ativo, Lane/Run, Buy Now, id). Consequências: (a) contador "N de 10 selecionados" conta o mesmo carro duas vezes depois de selecionar de novo; (b) "Remover da seleção" tira só o id do representante e o id antigo fica no conjunto; (c) Gerar link V1 envia os dois ids do mesmo VIN e api/panel/vitrines.js:111 devolve VITRINE_VIN_DUPLICATE, mostrado como "Não consegui gerar o link", ou envia o id antigo já removido e volta MANHEIM_OPTION_NOT_SELECTED; (d) Baixar PDF procura o id antigo em selectedOptions (painel/painel.js:2890 compara só option.id, não memberMatchIds) e não acha o carro
- Correção sugerida: guardar no navegador uma chave por carro (o representante) e traduzir ids com memberMatchIds: em setSelected remover qualquer id do mesmo grupo antes de adicionar; selectedOptions aceitar match quando o id procurado estiver em option.vehicle_json.parsed.memberMatchIds; offer_summary devolver o id do representante (r.id) em vez do membro selecionado. Teste Playwright: carro com dois membros, seleção gravada no membro antigo, abrir cartão, contador mostra 1, remover deixa 0, V1 com um carro

### 3. "Carros analisados" do lote conta linhas, não carros (mesmo VIN contado várias vezes)
- Domínio: DADOS
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: painel/manheim.js:234-236 fingerprint inclui lane e run quando há VIN ("vin:X:lane:Y:run:Z"), então dedupeAcrossFiles (painel/manheim-upload.js:161-175, comentário diz "o mesmo VIN é um carro") não junta o mesmo VIN em lanes diferentes ou em Buy Now. O total vai para manheim_uploads.vehicle_count e aparece em painel/painel.js:3763 ("N carro(s) analisado(s)"), 4295 ("N veículos"), 4335 (pergunta de desfazer) e 4585-4586 ("lote ativo com N carros"). Medição: 66.359 exibido contra 56.694 VINs diferentes (9.665 a mais). Ao lado, "carros com combinação" já vem por VIN (panel_manheim_batch_cars), então as duas contagens da mesma linha usam regras diferentes
- Correção sugerida: contar carros por VIN no servidor (count distinct VIN de manheim_vehicles do lote, ou uma coluna nova calculada na ativação) e mostrar "N carros (M linhas do arquivo)"; não mudar o fingerprint, que serve para o match por venda

### 4. MMR típico e mediana do cartão Realidade contam o mesmo VIN mais de uma vez
- Domínio: DADOS
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: panel-lead.js:225-226 monta unique por row_fingerprint (que separa o mesmo VIN por lane e por lote dos 60 dias); panel-lead.js:229-234 (typical, "MMR típico") e panel-lead.js:252 (reference, mediana de reserva das linhas do cartão 5 em panel-reality.js:24-27) usam unique sem juntar por VIN. Um carro repetido em Lane/Run e Buy Now, ou em dois lotes, pesa duas vezes na mediana. Medição: 14,6 % das linhas do lote ativo repetem VIN. A lista do score (panel_manheim_score_mmr) já usa distinct por car_key, então o MMR da lista e o da ficha podem divergir
- Correção sugerida: juntar unique por carKey (panel-reality.js) antes de typical e reference, mantendo o lote mais recente de cada VIN

### 5. Os dois contadores de BUSCAS usam regras diferentes para "pessoas com carros"
- Domínio: DADOS
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: painel/painel.js:3760 setCount('manheim', current_lead_count), que é allServed no servidor (panel-buscas-view.js:205-207: só BATE e POR_VALOR); painel/painel.js:3730 e 3762 setCount('searches', optionsPeopleOf(data)), que conta demandas com matchCount > 0 (inclui QUASE). O comentário da linha 3762 diz "mesma regra dos contadores", mas não é. Em pedido em reativação o servidor usa bate_count, o badge usa matchCount já ajustado, ok; a diferença é QUASE
- Correção sugerida: escolher uma regra (pessoas atendidas = BATE ou POR_VALOR) e usar o mesmo campo nos dois badges, ou rotular cada um com o que mede

### 6. Resumo e página contam o grupo do carro por regras diferentes (Lane/Run, Buy Now, incompleto)
- Domínio: DADOS
- Gravidade: INFO_ERRADA_OU_DUPLICADA (latente: 0 itens de complemento no lote ativo hoje)
- Esforço: P
- Evidência: o resumo (panel_manheim_grouped_light, 20261024020000_manheim_resumo_rapido.sql:27-30) calcula o grupo só pela regra atual sobre os dados juntos; a página e o filtro de trim usam coalesce(si.offer_group, panel_manheim_offer_group(parsed)) (20261022010000 e 20261025010000, CTE options), ou seja, o grupo gravado no complemento ganha. A versão anterior do resumo (20261018010000_offer_group_inline.sql:34) também dava preferência ao grupo gravado; a reescrita rápida perdeu isso. Quando houver complemento com grupo gravado diferente da regra, o "Lane/Run (N)" do cabeçalho não bate com o total da página e com "Ver opções (N)"
- Correção sugerida: em grouped_light usar coalesce(si.offer_group, regra inline) como offer_group, igual à página; teste SQL com um item de complemento cujo grupo gravado difere da regra

### 7. A mesma base pesada é lida de novo a cada página de opções
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: M
- Evidência: api/panel/manheim-options.js:137 (groupPage) chama contextFor, que roda loadBuscasBase (panel-buscas.js:20-31: dez leituras de tabelas inteiras, entre elas messages, calc_runs, journeys, message_journeys, cerca de 11 mil linhas hoje) a cada "Ver opções", "Ver mais", troca de ordem e troca de trim; alsoFitsFor (manheim-options.js:59) lê a tabela vitrines inteira a cada página; optionStamp.hashesFor roda de novo a cada página. Abrir os três grupos de um cartão repete tudo três vezes
- Correção sugerida: ler só a demanda pedida (journey ou Ref da chave) em vez da base inteira, ou guardar a base por alguns segundos por instância; ler vitrines só dos journeys de alsoFitsFor

### 8. A tela BUSCAS calcula o mesmo agrupamento por VIN três vezes por carga
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: M
- Evidência: panel-buscas-view.js:182-186 chama em paralelo panel_manheim_batch_summary, panel_manheim_offer_summary e panel_manheim_batch_cars; as três rodam panel_manheim_grouped_light sobre os 55 mil matches do lote. Medição: 1,7 s, cerca de 1,4 s e cerca de 1,4 s, cada uma refazendo o mesmo agrupamento. Hoje fica longe dos 8 s, mas o custo cresce com o lote e triplica a carga no banco
- Correção sugerida: uma função só que devolve por demanda as contagens das três (match, bate, por valor, apresentados, grupos, selecionados) e o total de carros distintos, com um único grouped_light

## Verificado sem achado

- Cartão Realidade (29e1bd9): servedOptions e realityList juntam por carKey (VIN); fits também
- Páginas de opções, resumo, filtro de trim e seleção no banco agrupam por VIN em cada pedido (grouped_options e grouped_light com a mesma ordem do representante)
- Troca de ordem ou de trim limpa state.loaded antes de recarregar (painel/painel.js:3315-3323), sem carro repetido no PDF
- V1 recusa VIN repetido no servidor (api/panel/vitrines.js:110-111)
