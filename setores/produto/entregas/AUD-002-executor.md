# AUD-002 · produto · rascunho do Nível 1 Executor

- Pedido: AUD-002 (acompanhamento da AUD-001 do setor produto)
- Papel: Nível 1 Executor
- Data: 2026-10-09
- Base conferida: diretório de trabalho na branch claude/mcs-system-connection-tsq6ex, commit 68cc468 (já com o main, último merge f13fee6)
- Fontes: setores/produto/relatorios/AUD-001-final.md, setores/produto/entregas/AUD-001-executor.md e AUD-001-revisor.md, setores/AUD-001-achados.json (ids 56 a 69), painel/painel.js, painel/action.js, api/panel/manheim-options.js, api/panel/vitrines.js, api/panel/v1-send.js, panel-buscas.js, panel-buscas-view.js, panel-manheim-batch.js, supabase/migrations, specs em tests/, git log e git show, banco de produção (projeto wwmakfaqahlbjzqvzgbr, só SELECT)

## Como foi feito

- Correspondência entre os nomes do relatório e a lista consolidada: A1 a A10 são os ids 56 a 65 de setores/AUD-001-achados.json; B1 a B4 são os ids 66 a 69. Os commits citam esses ids (por exemplo "AUD-001 #57")
- O commit 7a25ef1 (base da AUD-001) não existe no repositório, nem depois de buscar o histórico completo. Usei como base o pai de fd79328 (primeiro commit de correção, 2026-10-05) e o commit 9a22358 (#210), que trouxe os relatórios da AUD-001 junto com a correção C3. Para trazer o histórico completo rodei `git fetch --deepen`, que só baixa histórico para dentro da pasta .git; nenhum arquivo do diretório de trabalho mudou
- Segui o caminho de cada defeito pelo nome das funções no código de hoje. A tela ENVIAR OPÇÕES foi refeita depois da AUD-001: virou uma fila com uma linha por cliente (#218, #230, #231, bf3927a) e a seleção mora agora na tela "Opções do cliente" (#253, #257). As funções `offerSection`, `renderManheimOrderGroup` e o bloco "Reativar" não existem mais
- Não rodei os testes: o pedido é somente leitura e o Playwright grava resultados no diretório. Onde digo que um teste existe, li o arquivo; não confirmei que ele falha antes e passa depois
- Banco de produção: 4 consultas SELECT, só 1 pesada (leitura de `panel_manheim_grouped_options` do lote ativo inteiro); as outras 3 leem o catálogo de funções ou 20 linhas por chave. Nenhum dado pessoal lido ou transcrito

## Achado por achado

### A1 · Conferência velha ao mudar a seleção trava a V1 · RESOLVIDO

- Fato verificado: `state.setSelected` (painel/painel.js:4281 a 4291) agora marca a demanda como CONFERINDO (ou SEM_SELECAO ao zerar) em `manheimData.audit.byDemand` e dispara `audit-changed` na tela (4286). O botão da V1 só depende de haver seleção (`paintCount`, 4271 a 4279). Em `fichaGenerateV1` (4641 em diante), se o servidor responde MANHEIM_AUDIT_PENDING, a tela pede a conferência e tenta a V1 de novo
- Commit: fd79328 (fix(v1): seleção trocada depois de conferida gera a V1 com os carros novos), mantido em 43a5f70 (#253)
- Teste: tests/manheim-conferencia.spec.js:207 "seleção trocada depois de conferida: o selo volta a Conferindo e Gerar V1 confere os carros novos e cria a V1" (só na largura 1366). Não encontrei spec para tap no celular nem abrir e fechar de `details`, que a AUD-001 pediu para A1 e A2

### A2 · Seleção volta ao retrato antigo ao reordenar · RESOLVIDO

- Fato verificado: `setSelected` atualiza o retrato da página (`offer.selectedIds = [...state.selectedIds]`, painel.js:4283). Reordenar na tela do cliente (`sortSelect`, 4238) chama `restart()`, que reaproveita o mesmo `state` e não reconstrói a seleção a partir de `manheimData`. O "Ordenar" da fila só repinta a fila (`sortQueue` e `paintOptionsQueue`), sem redesenhar colunas nem repetir o GET de v1-send
- Commits: 9a22358 (#210, "o retrato da página acompanha a seleção"), depois a tela nova em 43a5f70 (#253)
- Teste: tests/aud001-venda.spec.js:79 "AUD-001 #57: seleção continua depois de reordenar o grupo", reescrito para a tela nova em 43a5f70 e 8630994. Só em 1366 px; mesma observação de A1 sobre celular e `details`

### A3 · Seleção gravada no id de outro membro do mesmo VIN (latente) · ABERTO

- Fato verificado: a função de produção `panel_manheim_offer_select_v2` ainda troca `p_match_id` pelo membro que já tem linha de seleção e devolve esse id (`select coalesce((select ss.match_id ...` e `'matchId', p_match_id`; migração 20261022010000, linhas 265 e 312, e o mesmo trecho confirmado no catálogo de produção). Nenhuma migração posterior redefine a função. No painel, `apply` chama `state.setSelected(option.id, ...)` (painel.js:3564) e ignora `result.matchId`; "Remover" na lista de selecionados usa `car.matchId` (4383)
- Recontagem em produção (lote ativo): 20 seleções SELECTED; 1 no id do representante, 0 em membro diferente do representante; 19 fora de qualquer grupo, e as 19 são de carros com leilão passado (`panel_manheim_offer_expired` verdadeiro), que a tela trata à parte como "Saíram da seleção (leilão passado)"
- Conclusão: a contagem da AUD-001 continua valendo, 0 casos hoje. O defeito segue possível quando o representante do VIN muda
- Teste: não há

### A4 · Sincronização e atualização automática apagam o trabalho aberto · RESOLVIDO

- Fato verificado: o trabalho (carros abertos, páginas carregadas, preço, trim) mora agora em `#options-client` (painel/index.html:335), uma seção separada da fila. `renderManheim` e `renderOptionsQueue` só trocam `#options-queue`; nada em `loadCurrent('searches')` fecha a tela do cliente (só os botões de aba chamam `closeOptionsClient`, painel.js:4081). O agendador de 120 s espera com trim ou selecionados abertos (`openWork`, 6334) e avisa "Atualização automática em pausa"
- Ponto que continua igual: `runOptionsSync` ainda chama `loadCurrent()` sem olhar trabalho aberto (painel.js:357). Hoje essa recarga só redesenha a fila por trás da tela do cliente, então não apaga trabalho
- Commits: 607644d (#213, pausa com trabalho aberto) e 43a5f70 (#253, tela do cliente separada)
- Teste: tests/aud001-atualizacao.spec.js:80 "grupo aberto: a atualização automática não fecha o grupo e oferece Atualizar" (reescrito para a tela nova). Ele cobre o agendador; o caminho da sincronização (357) não tem teste próprio

### A5 · Linha clicável dentro de cartão clicável abre o pedido duas vezes · RESOLVIDO (por remoção da tela)

- Fato verificado: o cartão de pedido com linhas clicáveis (`renderManheimOrderGroup`) saiu do código em b4bcdd2 (#218). Hoje `makeCardClickable` é usado em painel.js:1618, 2472, 3134 e 3135, e não achei um desses dentro de outro cartão clicável
- Ponto que continua igual: o guard (`guardCardClick`, painel.js:1826 a 1843) ainda não ignora clique que já passou por um `.clickable-card` mais interno. Se a combinação voltar, o defeito volta
- Teste: não há spec do clique duplo

### A6 · Valor em dólar digitado e "Selecionar" logo depois pode gravar outro preço · ABERTO

- Fato verificado: `priceBody` (painel.js:3558) continua mandando `pct` enquanto `info.manualFinal` é falso; ao digitar o valor, o campo de percentual recebe o valor arredondado a duas casas (3548). No banco, quando chega `p_manual_pct`, o valor é recalculado (`v_final := round(v_mmr * (100 + coalesce(v_pct, v_default)) / 100)`, migração 20261022010000, mesma função de produção)
- O commit 9a22358 (#210) registrou "#61 não reproduzido" e deixou o teste tests/aud001-venda.spec.js:105. O teste soma 1 dólar ao preço padrão; com MMR perto de 25 mil dólares, o percentual arredondado volta a ser igual ao padrão, o painel manda `pct: null` e o banco mantém o valor digitado. Ou seja, o teste não passa pelo caminho do defeito
- Exemplo fictício (mesmo cenário do teste): MMR US$ 25.020, padrão 5%. Digitando US$ 26.771, o percentual vira 7; se o "Selecionar" chegar ao banco depois do salvamento do valor, grava US$ 26.771,40. Cálculo feito com as fórmulas do código; não reproduzi no navegador
- Teste: existe, mas não cobre o caso

### A7 · "Ver opções" vindo de outra aba lê a mesma visão duas vezes · ABERTO (a parte do grupo fechado MUDOU)

- Fato verificado: `openOptionsCard` (painel.js:1938 a 1955) ainda faz `await switchPanel('searches')`, que já espera `loadCurrent` (switchPanel, 664 em diante), e logo depois `await loadCurrent('searches', ...)` (1940). As duas chamadas usam `request` (2045), não `sharedGet`, e acontecem uma depois da outra, então são duas leituras de /api/panel/records?view=manheim
- Parte que mudou: não existe mais grupo dentro do cartão. O botão de BUSCAR CARROS (4921) agora leva à linha da fila e só a destaca; a tela "Opções do cliente" não abre. O comentário do código e o teste tratam isso como decisão de desenho
- Teste: tests/buscas-split.spec.js:156 confere que o clique chega à linha da fila; nenhum teste conta as leituras

### A8 · Contador da aba e lista de ENVIAR OPÇÕES não batem · PARCIAL

- Fato verificado: a lista agora mostra todas as pessoas, com o motivo de quem não tem carro (#230), então ninguém some da tela. Ao desenhar a fila, o contador vira "pessoas com carros e sem V1" (painel.js:3943, contando por `offerTotal(demand.offer)`, 3928)
- O que continua: a rotina geral de contadores (painel.js:2149) usa `optionsPeopleOf` (3808), que conta toda demanda com `matchCount > 0`, inclusive quem já recebeu V1. São duas regras para o mesmo número; o contador da aba muda conforme qual das duas rodou por último. O texto do topo diz "N na fila", contando todas as linhas (com e sem carro)
- Commit: 9c992cf (#230)
- Teste: só testes de texto (tests/buscas-split-isolamento.test.js:168 e tests/buscas-split.test.js:544) que confirmam o uso de `optionsPeopleOf`; nenhum spec compara contador e lista

### A9 · Selecionar roda a função pesada de grupos três vezes · ABERTO

- Fato verificado: a função de produção `panel_manheim_offer_select_v2` ainda cita `panel_manheim_grouped_options` três vezes (contagem no catálogo de produção; migração 20261022010000, linhas 262, 280 e 311). As otimizações de 2026-10-08 (794ece8, 7351146) mexeram em `manheim_grouped_prepared` e na visão do lote, não nessa função
- Não medi o tempo de novo, para não passar do limite de consultas pesadas. Pendência: medir antes e depois na correção, como a AUD-001 pediu
- Teste: não há

### A10 · Cada página relê a base inteira e a tabela de vitrines; PDF lê grupos em série · ABERTO

- Fato verificado: `groupPage` ainda chama `contextFor` depois da página, em série (api/panel/manheim-options.js:146); `contextFor` chama `loadBuscasBase`, que só reaproveita a base dentro da mesma requisição (panel-buscas.js:16 a 24), então cada página relê a base. `alsoFitsFor` ainda lê `vitrines` inteira, sem filtro de ficha (manheim-options.js:62). O PDF ainda usa `selectedOptions` (painel.js:3290 a 3302), grupo por grupo, de 50 em 50, em série (chamado em 4628)
- Melhora indireta: as leituras internas da base agora rodam juntas (d0863e5, #292), o que encurta cada releitura, mas não evita a releitura
- Teste: não há

### B1 · Erros do fluxo de venda sem texto próprio · PARCIAL

- Corrigido: `v1ErrorText` (painel.js:4591 a 4598) ganhou texto para MANHEIM_SALE_ENDED (commit 73b679f, #226)
- Continua: `OFFER_ERRORS` (painel.js:3435 a 3445) não tem MANHEIM_SALE_ENDED, que `select_v2` lança e a rota devolve como 409; o operador vê "Não consegui salvar, tente de novo" (3446). VITRINE_VIN_DUPLICATE (vitrines.js:113; v1-send.js:89 e 140) não aparece em nenhum lugar do painel; na criação da V1 cai em "Não consegui gerar o link"
- Observação do caminho de hoje (fato no código, efeito não reproduzido): se o preparo da mensagem em v1-send falha, o erro é descartado (`catch (_) { info = null; }`, painel.js:4670) e a tela mostra "V1 criada · Sem telefone para abrir a conversa", mesmo com telefone
- Teste: não encontrei teste para os textos de MANHEIM_SALE_ENDED

### B2 · Observação interna do carro não é salva sozinha · ABERTO

- Fato verificado: o campo `offer-note` (painel.js:3549) continua sem listener; a nota só vai junto com price, select, remove ou exclude (3559, 3585, 3593). O spec tests/opcoes-cliente.spec.js:134 só confere que o campo aparece
- Teste: não há do salvamento

### B3 · Reativação: lista antiga só BATE, seleção mostra todos os grupos · MUDOU

- Fato verificado: o bloco "Reativar" que trocava `matchCount` por `bateCount` saiu com a fila nova (#218, #230, #231). Hoje a linha da fila e a tela do cliente usam o mesmo número, `offerTotal(demand.offer)` (painel.js:3928 e 4122). O servidor continua contando só BATE para ficha em reativação (`batchCounts`, panel-buscas-view.js:78), e a comparação com o lote só grava BATE para ela (panel-manheim-batch.js:109, desde 6918bda, antes da AUD-001)
- Por que refazer: a divergência descrita não existe mais na forma descrita; a pergunta agora é se `demand.offer` de uma ficha em reativação pode trazer carro que não é BATE (por exemplo, combinação gravada antes de a ficha parar). Não medi isso no banco
- Continua dependendo de decisão da Leo sobre a regra por carro x por valor na reativação; não proponho regra

### B4 · Pedido sem ficha deixa selecionar sem V1, PDF nem WhatsApp · PARCIAL

- Fato verificado: o pedido sem ficha entra na fila e abre a tela do cliente com seleção (`openRow`, painel.js:4018). Os botões existem; "Gerar V1" responde "Vincule o pedido a uma ficha para gerar a V1" (4643, commit b4bcdd2, #218). "Baixar PDF" responde "Não consegui preparar o PDF agora" (4623), sem dizer que falta a ficha. A seleção continua liberada
- Recontagem em produção (lote ativo): 0 demandas `ref:` com carros, de 250 demandas com carros (todas com ficha); 0 seleções em demanda `ref:`. A contagem da AUD-001 continua valendo
- Teste: não há

## Fato, suposição e risco

- Fatos verificados: tudo que cita arquivo e linha acima, os commits citados e as quatro contagens de produção (20 seleções no lote ativo, 1 no representante, 0 em membro, 19 de leilão passado; 250 demandas com carros, 0 sem ficha)
- Suposições: em A6, o valor errado só aparece quando o "Selecionar" chega ao banco depois do salvamento do valor; não medi com que frequência isso acontece. Em B3, não sei se hoje existe ficha em reativação com carro POR_VALOR na oferta. Em A9, que o tempo continua perto de 0,7 a 0,9 s por leitura não foi medido de novo
- Riscos: A3 e B4 têm 0 casos hoje; são exceção e não justificam passo novo no caminho comum. A5 pode voltar se alguém montar um cartão clicável dentro de outro. A6 tem um teste que passa sem cobrir o defeito, o que pode dar falsa segurança. Os testes de A1 e A2 cobrem só a largura de 1366 px

## Tabela final

| Nº | Achado | Estado | Commit ou PR | Teste Playwright |
|---|---|---|---|---|
| A1 | Conferência velha trava a V1 | RESOLVIDO | fd79328; 43a5f70 (#253) | sim, manheim-conferencia.spec.js:207 (só 1366 px) |
| A2 | Seleção volta ao retrato antigo ao reordenar | RESOLVIDO | 9a22358 (#210); 43a5f70 (#253) | sim, aud001-venda.spec.js:79 (só 1366 px) |
| A3 | Seleção no id de outro membro do VIN | ABERTO (latente, 0 casos hoje) | nenhum | não |
| A4 | Recarga apaga trabalho aberto | RESOLVIDO | 607644d (#213); 43a5f70 (#253) | sim, aud001-atualizacao.spec.js:80 (não cobre a sincronização) |
| A5 | Clique abre o pedido duas vezes | RESOLVIDO (tela removida; guard igual) | b4bcdd2 (#218) | não |
| A6 | Valor em dólar trocado ao selecionar | ABERTO | 9a22358 (#210) só acrescentou teste | existe, mas não cobre o caso |
| A7 | "Ver opções" lê a visão duas vezes | ABERTO (parte do grupo MUDOU) | nenhum para a leitura dupla | não conta leituras |
| A8 | Contador e lista não batem | PARCIAL | 9c992cf (#230) | não |
| A9 | Função pesada três vezes ao selecionar | ABERTO | nenhum | não |
| A10 | Base e vitrines relidas a cada página; PDF em série | ABERTO | d0863e5 (#292) só acelera a leitura | não |
| B1 | Erros sem texto próprio | PARCIAL | 73b679f (#226) | não |
| B2 | Observação interna não salva sozinha | ABERTO | nenhum | não |
| B3 | Reativação só BATE x seleção completa | MUDOU (depende da Leo) | b4bcdd2 (#218), 9c992cf (#230), 9e00785 (#231) | não |
| B4 | Pedido sem ficha seleciona sem V1 nem PDF | PARCIAL (0 casos hoje) | b4bcdd2 (#218) | não |

Resumo: 4 resolvidos (A1, A2, A4, A5), 3 parciais (A8, B1, B4), 6 abertos (A3, A6, A7, A9, A10, B2), 1 mudou (B3)
