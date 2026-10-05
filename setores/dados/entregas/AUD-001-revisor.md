# AUD-001 · Revisor independente (Nível 2) · setor dados

Pedido: AUD-001, auditoria do painel, somente achados (sem mudar código, sem commit, sem publicação)
Base: main atual (7a25ef1)
Ordem: avaliação cega registrada abaixo ANTES de abrir o rascunho do executor (entregas/AUD-001-executor.md não foi aberto)
Produção: somente SELECT e medição de tempo de funções de leitura (STABLE, nada gravado); nenhum dado pessoal transcrito; lote ativo do Manheim não foi tocado

## Avaliação cega

### Conferências que deram certo (sem achado)

- Um carro por VIN em cada pedido do lote ativo: 0 repetidos por pedido (chave pedido + VIN) em panel_manheim_grouped_light
- Resumo do lote e resumo da seleção batem: 385 pedidos, 0 diferenças entre match_count e Lane/Run + Buy Now + incompleto
- Soma dos trims bate com o total de cada grupo nos 5 maiores pedidos (ex.: 1668 = 1668, 693 = 693)
- Seleção no banco: 7 seleções ativas, todas apontam para o carro representante do grupo, nenhuma escondida
- Nenhum match do lote ativo sem demand_key (0 de 55.454)

### Achados

D1. Ficha conta carros já encerrados no cartão Realidade e nos "cabe" (diverge de ENVIAR OPÇÕES)
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: M
- Evidência: panel-lead.js:216-251 lê manheim_vehicles e roda o matcher em JS sem filtrar venda encerrada (endsAt) e sem o complemento de venda (manheim_complement_items). A contagem do banco (panel_manheim_grouped_light, migração 20261024020000) só conta venda ativa com MMR. Medição no lote ativo: ford 8.465 linhas com 1.495 já encerradas, toyota 8.260 com 1.620, jeep 6.670 com 1.026 (cerca de 18%)
- Correção: aplicar a mesma regra de venda ativa e o mesmo complemento na ficha (ou ler a contagem do banco) para o veredito "N opções" bater com ENVIAR OPÇÕES

D2. Lista de lotes mistura unidades: "veículos" é linha do CSV, "carros com combinação" é VIN; lote desfeito usa número congelado por linha
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/painel.js:4295 e 3763 mostram vehicle_count (66.359 no lote ativo) como carros, mas são 56.694 VINs distintos. matchCount usa panel_manheim_batch_cars (25.147 por VIN e venda ativa) no lote ativo e matched_vehicle_count congelado (34.906, count distinct row_fingerprint, migração 20261021010000:438) nos desfeitos e no aviso do upload (painel.js:4585-4586). painel.js:4335 chama esse mesmo número de "matches"
- Correção: rotular "linhas do CSV" ou contar VIN distinto; no aviso de upload e em lotes desfeitos usar a mesma regra por VIN; trocar "matches" por "carros com combinação"

D3. Mesma leitura pesada repetida ao abrir ENVIAR OPÇÕES e BUSCAR CARROS
- Domínio: DADOS · Gravidade: OUTRO (lentidão, risco perto de 8 s) · Esforço: M
- Evidência: panel-buscas-view.js:183-188 roda em paralelo panel_manheim_batch_summary, panel_manheim_offer_summary e panel_manheim_batch_cars, e loadScoreIndex (panel_manheim_score_mmr); as quatro varrem o lote inteiro via panel_manheim_grouped_light. Medido em produção, uma a uma: resumo 1,7 s, seleção 1,35 s, carros 1,66 s, score 1,43 s (cerca de 6 s de banco por abertura, 55 mil matches). Na aba BUSCAR CARROS (painel.js:1964 e 1972) a mesma visão chama /api/panel/pesquisas (outro batch_summary, api/panel/pesquisas.js:47) e /api/panel/records?view=manheim (as quatro de novo)
- Correção: uma única passada em grouped_light devolvendo resumo, grupos, carros e pessoas juntos (ou materializar por lote ativo); reaproveitar o resumo entre pesquisas e manheim

D4. Abrir a aba ignora a resposta que os contadores acabaram de buscar (mesma API duas vezes)
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: refreshCountersNow (painel.js:2010-2011) e o boot de contadores (painel.js:1928) usam sharedGet/primeBoot para /api/panel/pesquisas e /api/panel/records?view=manheim, mas as visões searches (painel.js:1946), manheim (1974) e requests (1964) usam request() direto, que não passa pelo pool (painel.js:344). Resultado: a mesma visão pesada (D3) é pedida duas vezes em poucos segundos
- Correção: abrir a aba com sharedGet com TTL curto (ou ler do pool quando a resposta tiver poucos segundos) e só forçar leitura nova no "Atualizar"

D5. Contexto do cliente refaz a contagem do lote inteiro a cada pedaço da lista
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: panel-client-context.js:324-337 (batchCars) chama panel_manheim_batch_people para o lote inteiro em toda chamada de /api/panel/client-context (medido 2,0 s). O navegador pede o contexto em lotes conforme a rolagem (painel/contexto.js:105-113, a cada 120 ms) e em pedaços de 100 (painel.js:2625-2626), então a mesma leitura roda várias vezes seguidas. Já existe memo de 15 s para o estágio logo abaixo (panel-client-context.js:341), mas não para batchCars. api/panel/records.js:27-33 faz a mesma leitura inteira para filtrar uma só ficha
- Correção: memo curto por lote ativo (mesmo padrão de STAGE_MEMO_MS) ou função que filtre pelas fichas pedidas

D6. Ficha baixa o estoque inteiro da marca a cada abertura
- Domínio: DADOS · Gravidade: OUTRO · Esforço: M
- Evidência: panel-lead.js:216-220 lê manheim_vehicles com vehicle_json completo de todos os lotes vivos de 60 dias para as marcas pedidas. Medido no lote ativo: ford 8.465 linhas (cerca de 6,1 MB de JSON), toyota 8.260 (cerca de 6,0 MB), jeep 6.670 (cerca de 4,9 MB), só do lote ativo
- Correção: filtrar no banco por modelo e ano (make_key + model), ou pedir ao banco a contagem e só as linhas exibidas

D7. Contador de seleção da tela ignora o total do servidor (seleção em dois lugares)
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/painel.js:3513 state.setSelected(id, on, total) recebe result.selectedCount (painel.js:3174) e não usa; o "N de 10 selecionados" (3512) conta só o Set local montado na abertura. Se outra aba ou outro operador seleciona, a tela e o servidor divergem até recarregar; a V1 (3634) manda o Set local e o servidor recusa com MANHEIM_OPTION_NOT_SELECTED
- Correção: usar o total do servidor no contador e recarregar selectedIds quando ele divergir do Set local
- Observação: hoje, em produção, não há divergência (7 seleções, todas visíveis)

## Comparação com o rascunho

Rascunho lido depois da avaliação cega (entregas/AUD-001-executor.md). Cada achado foi conferido de novo no código (main 7a25ef1), tentando refutar.

### Achados do executor

- E1 (ficha conta venda encerrada): SUSTENTADO. panel-lead.js:240 monta allOffers sem filtro de endsAt nem MMR; grouped_light (20261024020000:23-25) filtra. Concorda com o meu D1. Divergência só no esforço: executor P, eu M (precisa também do complemento de venda e da ordem do representante; fico com M)
- E2 (seleção em dois lugares com ids diferentes): SUSTENTADO, latente. painel.js:3174 chama setSelected(option.id, ...) e ignora result.matchId; select_v2 (20261022010000:265) grava no membro que já tinha linha; selectedIds nasce de first_selected (20261024020000:39); selectedOptions (painel.js:2890) compara só option.id; V1 (painel.js:3634) manda o Set local e vitrines.js:111 recusa VIN repetido. Cobre e amplia o meu D7. Divergência de gravidade: executor BLOQUEIA_VENDA, eu INFO_ERRADA; aceito BLOQUEIA_VENDA (latente, 0 casos hoje), esforço M
- E3 ("carros analisados" conta linhas): SUSTENTADO. painel/manheim.js:235 inclui lane e run no fingerprint com VIN, e dedupeAcrossFiles (manheim-upload.js:165) usa esse fingerprint. Concorda com o meu D2 (o meu acrescenta matched_vehicle_count congelado nos lotes desfeitos e o rótulo "matches")
- E4 (MMR típico e mediana contam o mesmo VIN mais de uma vez): SUSTENTADO. panel-lead.js:225 junta por row_fingerprint; typical (229-234) e reference (252) usam esse mapa, e panel-reality.js:24 empilha por modelo sem juntar por VIN. Não estava na minha avaliação cega; impacto pequeno (mediana), esforço P
- E5 (badges de BUSCAS com regras diferentes): DIVERGENTE. O código confirma que o badge 'manheim' usa current_lead_count (BATE e POR_VALOR) e o 'searches' usa matchCount (inclui QUASE). Mas o comentário de painel.js:3762 diz "mesma regra dos contadores" e o contador de painel.js:2027 usa o mesmo optionsPeopleOf, então o comentário está certo. Os dois badges são de abas diferentes e medem coisas diferentes por desenho; vira achado só de rótulo (OUTRO, P), não informação errada
- E6 (resumo ignora grupo gravado no complemento): SUSTENTADO, latente. grouped_light (20261024020000:26-29) usa só a regra inline; página e filtro de trim usam coalesce(stored_group, regra) (20261025010000:30 e 85); a versão anterior (20261018010000:34) preferia o grupo gravado. Não estava na minha avaliação; 0 itens de complemento hoje
- E7 (base pesada relida a cada página de opções): SUSTENTADO. manheim-options.js:46-47 contextFor roda loadBuscasBase (panel-buscas.js:20-31, dez leituras) em cada groupPage (143) e na outra rota (203); alsoFitsFor (59) lê vitrines inteira; hashesFor (146 e 210) a cada página. Não estava na minha avaliação
- E8 (BUSCAS calcula o agrupamento três vezes): SUSTENTADO. Igual ao meu D3 (eu conto quatro com o score e a repetição em BUSCAR CARROS)

### Achados do revisor que o executor não trouxe

- D4 (abrir a aba ignora o pool dos contadores): SUSTENTADO na nova conferência. painel.js:1957, 1964 e 1975 usam request() direto; painel.js:2010-2011 usam sharedGet com 60 s
- D5 (contexto do cliente refaz batch_people a cada pedaço): SUSTENTADO. panel-client-context.js:330 chama panel_manheim_batch_people sem memo
- D6 (ficha baixa o estoque inteiro da marca): SUSTENTADO. panel-lead.js:216-220; o executor viu o mesmo trecho mas não o tratou como custo

### Refutados

- Nenhum achado refutado por inteiro. E5 rebaixado para rótulo (OUTRO)

### Lista consolidada para o Aprovador

E1=D1 (INFO, M), E2+D7 (BLOQUEIA_VENDA latente, M), E3=D2 (INFO, P), E4 (INFO, P), E5 (OUTRO, P, divergente), E6 (INFO latente, P), E7 (OUTRO, M), E8=D3 (OUTRO, M), D4 (OUTRO, P), D5 (OUTRO, P), D6 (OUTRO, M)
