# AUD-001 · produto · Nível 2 Revisor independente

Pedido: AUD-001, auditoria do painel, somente achados, foco no fluxo de vender (seleção, V1, WhatsApp, conferência, regra por carro x por valor)
Base: main atual (commit 7a25ef1)
Ordem: avaliação cega registrada antes de qualquer leitura do rascunho do executor (AUD-001-executor.md não foi aberto)

## Avaliação cega

Leituras no banco de produção: só SELECT e EXPLAIN de funções de leitura (STABLE). Registro de transparência: uma chamada criou por engano uma tabela temporária vazia de sessão (`create temp table _x as select 1`), que some sozinha ao fim da sessão e não toca dado nenhum. Nenhum dado de cliente foi transcrito.

### 1. Seleção do cartão fica velha quando a coluna é reordenada (VENDAS, BLOQUEIA_VENDA, esforço P)
Evidência: `painel/painel.js:3508` cria `state.selectedIds` a partir de `demand.offer.selectedIds`, que vem do retrato guardado em `manheimData` (`panel-buscas-view.js:40`). `state.setSelected` (3513) só muda a cópia local. Mudar o "Ordenar" da coluna (`painel.js:3750`) ou o "Ordenar" de manheim (`painel.js:5682`) chama `renderManheim(manheimData)` com o retrato antigo, sem buscar no servidor.
Cenário fictício: o operador seleciona 2 carros e depois reordena a coluna. O cartão volta a dizer "0 de 10 selecionados", e "Gerar link V1" responde "Selecione pelo menos um carro para o cliente". No caso inverso (carro removido antes de reordenar), a V1 manda um id que já não está selecionado e o servidor recusa com "Só carros selecionados para o cliente entram na V1". A seleção fica guardada em dois lugares que divergem.
Correção sugerida: em `state.setSelected`, atualizar também `offerCounts.selectedIds` e `selected`, ou recarregar `/api/panel/records?view=manheim` antes de redesenhar.

### 2. Atualização automática e sincronização redesenham OPÇÕES e fecham os grupos abertos (TELA/VENDAS, QUEBRA_CLIQUE, esforço M)
Evidência: o agendador (`painel.js:5516-5518`) chama `loadCurrent()` a cada 120 s. Ele só espera quando o operador está digitando (`operatorIsTyping`, 5482), não quando há grupo de carros aberto. `runOptionsSync` (`painel.js:339`) chama `loadCurrent()` de novo 500 ms depois de abrir OPÇÕES (1946), sempre que algum pedido for sincronizado. `renderManheim` faz `root.replaceChildren()` (3779) e não guarda os `details.offer-group` abertos, as páginas já carregadas nem o filtro aberto.
Cenário fictício: o operador abre "Lane/Run (40)", rola até o carro 25 e clica em "Selecionar". Depois de no máximo 2 min o cartão é redesenhado fechado, a lista some e a página encolhe e pula de lugar.
Correção sugerida: antes de redesenhar, guardar quais `[data-demand-key] details.offer-group` estão abertos e, depois, reabrir e recarregar só esses grupos. Outra saída é tratar "grupo de opções aberto" como ocupado no `isBusy`.

### 3. "Ver opções" vindo da ficha busca a mesma visão duas vezes e não abre o grupo (DADOS + TELA, INFO_ERRADA_OU_DUPLICADA, esforço P)
Evidência: `openOptionsCard` (`painel.js:1850-1851`) faz `await switchPanel('searches')`, que já chama `loadCurrent` (643), e depois chama `loadCurrent('searches')` de novo. São duas leituras de `/api/panel/records?view=manheim`, dois redesenhos e duas sincronizações agendadas. Em seguida ele clica no primeiro `.manheim-options-toggle` (1860-1861), que no layout com seleção fica dentro do `details` LANE ainda fechado: os carros são carregados num grupo que continua fechado, e a promessa "abrem na hora" não se cumpre.
Correção sugerida: tirar o segundo `loadCurrent` e abrir o `details.offer-group` (que dispara `loadPage` pelo `toggle`) em vez de clicar no botão escondido.

### 4. Cada página de carros recarrega a base inteira e a tabela inteira de vitrines (DADOS, OUTRO, esforço M)
Evidência: `api/panel/manheim-options.js:142` chama `contextFor`, ou seja `loadBuscasBase` com fichas, contatos e pedidos, em cada GET de página de grupo, e só depois de ler a página (não em paralelo). `alsoFitsFor` (58) lê `allRows(... 'vitrines')` sem filtro em cada página. O PDF com carro selecionado em grupo fechado usa `selectedOptions` (`painel.js:2883`), que pagina de 50 em 50 por grupo. Na maior demanda de produção hoje (1668 em LANE e 693 em OFFLANE) isso pode chegar a cerca de 48 chamadas, cada uma com a base inteira, quando um id selecionado não é encontrado.
Medição no banco: `panel_manheim_offer_page_sorted` na posição 1600 levou 0,88 s, `panel_manheim_offer_trims` levou 0,72 s e `panel_manheim_offer_summary` levou 1,7 s. As funções SQL estão longe dos 8 s; o custo vem da leitura repetida da base no servidor.
Correção sugerida: ler a base em paralelo com a página (ou guardá-la em cache curto por requisição), filtrar vitrines por `journey_id in (...)` dos donos dos VINs e ter uma rota que devolva os carros selecionados pelos ids.

### 5. Seleção gravada no id de um "membro" do VIN diverge do id mostrado na linha (VENDAS, BLOQUEIA_VENDA latente, esforço M)
Evidência: desde v3.4 (`20261022010000_manheim_v34_group_vin.sql`) cada VIN é uma linha representante com `memberMatchIds`. `panel_manheim_offer_select_v2` grava a seleção no membro que já tinha seleção (linha 265), e `panel_manheim_offer_summary` devolve em `selected_ids` o `ss.match_id`, que é o membro. A página do grupo devolve o id do representante. No painel, `state.selectedIds.has(option.id)` (`painel.js:3613`) e `state.setSelected(option.id, ...)` (3176) usam o id do representante.
Efeito quando membro e representante diferem: "Remover da seleção" não tira o id do contador, a V1 manda o id antigo e é recusada, e o PDF procura o id em todas as páginas sem achar.
Medição no banco hoje: 7 seleções ativas, todas no representante (0 em membro, 0 órfãs). O risco é latente e aparece quando o representante muda (venda encerrada, mudança de Lane ou de complemento).
Correção sugerida: o resumo deve devolver o id do representante (g.id), ou a página e o painel devem comparar por `memberMatchIds`.

### 6. Cartão de pedido da calculadora sem ficha deixa selecionar, mas não tem V1, PDF nem WhatsApp (VENDAS, OUTRO, esforço M)
Evidência: `renderManheimOrderGroup` (`painel.js:3668-3726`) monta `offerSection` com "Selecionar para cliente", mas não tem "Gerar link V1", "Baixar PDF" nem `v1SendControls`. `api/panel/vitrines.js:97` exige `journeyId`.
Medição no banco hoje: 0 demandas `ref:` no lote ativo (385 são `journey:`), então não bloqueia ninguém agora.
Correção sugerida: no cartão de pedido, esconder a seleção ou mostrar "Crie ou vincule a ficha para gerar a V1", com o botão que leva à ficha.

### 7. Linha clicável dentro de cartão clicável abre o pedido duas vezes (CLIQUES, QUEBRA_CLIQUE leve, esforço P)
Evidência: `painel.js:3716` (linha) e `painel.js:3724` (cartão do mesmo pedido) usam `makeCardClickable`. O clique na linha chama `openDetail('order')` e borbulha até o cartão, onde o guard (1740-1748) deixa passar porque a linha não é controle. O resultado são dois `pushState` (o Voltar precisa de dois toques) e duas leituras do pedido. Só acontece na lista antiga, quando a seleção não está disponível (`offerPending`).
Correção sugerida: `event.stopPropagation()` no clique tratado por um `makeCardClickable` interno, ou no guard ignorar o clique que já passou por outro `.clickable-card` mais interno.

### 8. Área de seleção e preço dentro do cartão OPÇÕES ainda navega para a ficha (CLIQUES, QUEBRA_CLIQUE, esforço P)
Evidência: o cartão de OPÇÕES é clicável (`painel.js:3664`). Dentro dele, `offer-row`, contador, "Cliente pediu", textos de VIN, MMR e CR não são controles. Um toque no espaço vazio de uma linha de carro, ao lado de "Selecionar para cliente" ou do campo de valor, abre a ficha e tira o operador da seleção. Na volta, OPÇÕES é redesenhado com os grupos fechados (achado 2). O bloco da V1 já se protege com `node.addEventListener('click', stopPropagation)` (3485); a seção de seleção (`offerSection`, 3507) não faz o mesmo.
Correção sugerida: fazer `stopPropagation` no clique em `.offer-section`, como já faz o `.v1-send`, ou incluir `.offer-section` no `isControl` do guard.

### 9. Contadores de OPÇÕES não batem entre si (TELA, INFO_ERRADA_OU_DUPLICADA, esforço P)
Evidência: o badge da aba (`setCount('searches', optionsPeopleOf(data))`, 3756 e 3747) conta todas as pessoas com `matchCount > 0`. A lista (3783-3795) pula a demanda cuja ficha não está em `manheimJourneys`, o pedido não achado em `byOrder` e a reativação com `bateCount` 0, e o badge "Com carros no lote" conta cartões (demandas), não pessoas. A mesma visão mostra dois números diferentes para "com carros".
Correção sugerida: contar o badge da aba com as mesmas regras de quem foi desenhado, ou mostrar "N pessoas · M pedidos".

### 10. Cartão de reativação limita a lista antiga a BATE, mas a seleção mostra e deixa escolher todos os grupos (VENDAS, OUTRO, esforço P)
Evidência: `renderManheimGroup(reactivate, journey, true, { ...demand, matchCount: demand.bateCount })` (3793) filtra a lista antiga para BATE (3647), mas `offerSection` usa `demand.offer` com lane, offLane e incomplete de todos os carros (3507-3516). A regra "por carro x por valor" para reativar fica inconsistente entre os dois modos de exibição.
Correção sugerida: decidir a regra com a Leo. Até lá, mostrar no cartão de reativação o aviso de que os grupos incluem carros POR VALOR.

### Conferido e sem defeito encontrado
- Guard do `makeCardClickable` (1732-1754): botões, inputs, selects, labels, details e summary internos não navegam. Um botão que se remove no próprio clique (Cancelar, Limpar filtro) também não navega, porque `origin.isConnected` é falso. Texto selecionado não abre. Cada toque começa com `pointerdown`, que renova a origem, então rolar no celular não prende o próximo toque.
- Envio da V1 no WhatsApp (3376-3488): exige confirmação, gera `requestKey` novo, trata janela fechada, envio em andamento e envio rápido demais, e os cliques não borbulham para o cartão.
- Ordenação do grupo no banco é determinística (desempate por `row_fingerprint, id`) e não depende da seleção, então a paginação por offset não repete carros.

## Comparação com o rascunho

Feita depois da avaliação cega, lendo AUD-001-executor.md e conferindo cada achado no código do main atual. A avaliação cega acima não foi alterada.

### Achados do executor
| Exec | Título | Resultado | Conferência |
|---|---|---|---|
| E1 | Conferência velha no navegador trava "Gerar link V1" | Sustentado (novo, eu não tinha) | `state.listeners` nunca recebe ninguém (só a definição em painel.js:3508); `setSelected` (3513) não dispara `audit-changed`; REVISAR não está em `AUDIT_OK` (2935) nem em `AUDIT_CHECK_FIRST` (2941), e `canRetry` só vale para PENDENTE (panel-manheim-audit.js:444). Gravidade BLOQUEIA_VENDA confirmada. |
| E2 | Valor em dólar digitado + clique em Selecionar grava outro preço | Sustentado, depende de corrida | `priceBody` (3164) manda `pct` enquanto `info.manualFinal` é falso; o `select` sai em paralelo com o `price` do `change` (3207). No banco o pct gera `round(mmr*(100+pct)/100)` em centavos (migração v34, trecho de `v_final`), então o final pode sair com centavos e diferente do digitado. Só erra quando o `select` termina por último. |
| E3 | Sincronização redesenha OPÇÕES e apaga o trabalho | Sustentado, concorda com meu R2 | Executor acrescenta perda de valor digitado, texto da V1 e caixa de confirmação; eu acrescento o agendador de 120 s (5516). Gravidade: QUEBRA_CLIQUE nos dois. |
| E4 | Seleção em dois lugares, id do membro x representante | Sustentado, concorda com meu R5 | Mesma evidência (select_v2 linha 262 grava no membro; resumo devolve o membro). Concordamos: latente, 0 casos hoje. Divergência pequena só na gravidade: eu marquei BLOQUEIA_VENDA latente, executor INFO_ERRADA. Fico com BLOQUEIA_VENDA latente, porque a V1 é recusada. |
| E5 | "Ver opções" carrega ENVIAR OPÇÕES duas vezes | Sustentado, concorda com meu R3 | Executor acrescenta o segundo GET de v1-send e o `sharedGet` ignorado; eu acrescento que o grupo continua fechado. Divergência de gravidade: executor OUTRO, eu INFO_ERRADA (o grupo não abre como prometido). |
| E6 | Ordenar uma coluna redesenha as duas e relê V1 | Sustentado, complementa meu R1 | Mesmo ponto de código (3750). O executor vê o custo; eu vejo o efeito mais grave: `renderManheim(manheimData)` usa o retrato antigo e a seleção feita volta a zero no contador e na V1. Proponho juntar E6 e R1 num item só, gravidade BLOQUEIA_VENDA. |
| E7 | Erros sem texto próprio | Sustentado | `MANHEIM_SALE_ENDED` existe no banco (v34 linha 263) e em vitrines.js:114 e 158, e não está em `OFFER_ERRORS` nem em `v1Error`; `VITRINE_VIN_DUPLICATE` (vitrines.js:112, v1-send.js:79) também cai em "tente de novo". |
| E8 | Selecionar chama a função pesada três vezes | Sustentado | `panel_manheim_grouped_options` aparece em select_v2 nas linhas 262, 280 e 311 da migração v34. Medições do executor batem com as minhas (0,8 s, 0,7 s, 1,4 a 1,7 s). |
| E9 | PDF com carro fora da tela lê grupos em série | Sustentado, concorda com meu R4 | Mesmo `selectedOptions` (2883). Eu acrescento a releitura da base inteira e das vitrines em cada página (manheim-options.js:142 e 58). |
| E10 | Linha clicável dentro de cartão clicável abre o pedido duas vezes | Sustentado, concorda com meu R7 | 3716 e 3724; o guard não para a propagação. |
| E11 | Observação interna não é salva sozinha | Sustentado (novo, eu não tinha) | O campo `offer-note` (3159) não tem listener; a nota só vai com price, select, remove ou exclude. |

### Meus achados confrontados
| Rev | Título | Resultado | Conferência |
|---|---|---|---|
| R1 | Seleção velha quando a coluna é reordenada | Sustentado | Ver E6. O executor não registrou o efeito na seleção. |
| R2 | Redesenho fecha os grupos abertos | Sustentado | Ver E3. |
| R3 | "Ver opções" busca duas vezes e não abre o grupo | Sustentado | Ver E5. |
| R4 | Página de carros recarrega base e vitrines | Sustentado | Ver E9. |
| R5 | Id do membro x representante | Sustentado | Ver E4. |
| R6 | Cartão de pedido sem ficha: seleciona sem V1, PDF nem WhatsApp | Sustentado, o executor não tem | Em `renderManheimOrderGroup` (3668 a 3726) existe `offerSection`, mas não há "Gerar link V1", "Baixar PDF" nem `v1SendControls`. Hoje 0 demandas `ref:` no lote. |
| R7 | Linha dentro de cartão abre o pedido duas vezes | Sustentado | Ver E10. |
| R8 | Área de seleção e preço dentro de OPÇÕES navega para a ficha | REFUTADO em grande parte | As linhas de carro, preço e botões ficam dentro de `details.offer-group` (3221), e o guard trata `details` como controle (1740). O executor está certo no "conferido sem defeito". Sobra só o toque no contador `offer-counter` e no espaço entre grupos, que abre a ficha; isso é navegação legítima do cartão, não defeito. Retiro o achado. |
| R9 | Badge da aba e "Com carros no lote" não batem | Sustentado, o executor não tem | `optionsPeopleOf` (3730) conta pessoas com `matchCount > 0`, incluindo reativação com `bateCount` 0 e ficha ausente de `manheimJourneys`, que a lista pula (3783 a 3795); o badge do grupo conta cartões. |
| R10 | Reativação: lista antiga só BATE, seleção mostra todos | Sustentado, o executor não tem | 3793 troca `matchCount`, mas `offerSection` usa `demand.offer` inteiro (3507). Depende de decisão de regra com a Leo. |

### Conferidos sem defeito pelo executor
- Mesmo VIN duas vezes na tela: concordo, páginas, contagens e seleção passam por `panel_manheim_grouped_options` (um VIN por demanda).
- Cliques dentro dos grupos não abrem a ficha: concordo (e por isso retiro R8).
- Botão desligado não gera clique no cartão e "No celular" some com o link: não reproduzi, sem evidência contrária.

### Lista consolidada para o Aprovador (por gravidade)
1. BLOQUEIA_VENDA: E1 (conferência velha), R1+E6 (seleção velha ao reordenar), E4/R5 (membro x representante, latente).
2. QUEBRA_CLIQUE: E3/R2 (redesenho fecha grupos e apaga trabalho), E10/R7 (pedido aberto duas vezes).
3. INFO_ERRADA_OU_DUPLICADA: E2 (preço da corrida), E5/R3 (leitura dupla e grupo fechado), R9 (contadores).
4. OUTRO: E7, E8, E9/R4, E11, R6, R10.
5. Refutado: R8.
