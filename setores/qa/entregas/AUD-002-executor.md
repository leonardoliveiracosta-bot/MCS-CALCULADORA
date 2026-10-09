# AUD-002 · qa · rascunho do executor

- Pedido: AUD-002, acompanhamento da AUD-001 do produto; o qa confere se cada correção tem o teste que a AUD-001 exigiu
- Setor: qa (setor responsável: produto)
- Papel: Nível 1 Executor
- Agente: subagente executor qa (Claude), sessão de 2026-10-09
- Data: 2026-10-09
- Base conferida: código de 68cc468 (branch de trabalho, que já traz o main b0ba83d pelo merge f13fee6). Durante o trabalho entraram 92f320a e 2c7c478, que só acrescentam arquivos em setores/; o código é o mesmo. Não abri esses dois arquivos (rascunho do produto e avaliação cega do revisor de qa)
- Commit base da AUD-001: 7a25ef1 não existe neste repositório (nem em outra branch local). Usei 77c9352 como equivalente: é o último commit do main antes da AUD-001 e nele estão exatamente as linhas que o relatório cita (painel.js:3513 `setSelected`, 3716 e 3724 `makeCardClickable`, 2942 `auditCanTry`, 339 `loadCurrent` da sincronização, 1849 a 1851 `openOptionsCard`, 3730 `optionsPeopleOf`)
- Fontes: setores/produto/relatorios/AUD-001-final.md, setores/produto/entregas/AUD-001-executor.md, setores/AUD-001-achados.json (A1 a A10 são os itens 56 a 65; B1 a B4 são 66 a 69), git log e git show de 77c9352 até o HEAD (127 commits), tests/, painel/painel.js, api/panel/manheim-options.js, supabase/migrations/
- Banco de produção: não consultei. A recontagem de casos (A3, B4) é do setor produto
- Limites respeitados: nenhum arquivo do repositório alterado além deste; cópias antigas e alteradas do código ficaram só no scratchpad, feitas com `git archive` (sem worktree, sem mexer em .git); nada publicado, nenhum comentário em PR

## Resumo para a Leo

1. Dos 14 achados, só 3 têm teste que comprovadamente falha sem a correção e passa com ela: A1, A2 e A4. Para A1 e A4 o teste de hoje ainda pega a volta do defeito; para A2 o teste de hoje passa mesmo sem a correção
2. A6 (valor em dólar trocado ao clicar Selecionar) continua acontecendo. O teste que existe para ele passa porque usa um valor que não aciona o defeito. Com outro valor, reproduzi o defeito 3 vezes em 3 no código de hoje, numa simulação de rede lenta
3. A5 sumiu porque a lista antiga foi removida, mas não existe teste que prove "um clique, uma abertura"
4. Os outros (A3, A7, A8, A9, A10, B1 a B4) seguem abertos no todo ou em parte, então ainda não há correção para testar
5. A AUD-001 pediu, para A1 e A2, testes de seleção, toque no celular, abrir e fechar e navegação do cartão. Seleção e navegação do cartão existem; toque no celular não existe em nenhum teste; abrir existe, fechar não

## O que foi executado (com o comando)

### Suíte node
- `npm test` no código atual: 1.077 testes, 1.076 passaram, 0 falharam, 1 pulado (`abertura inteira A/B/A`, marcado como SKIP no próprio teste), 438 s

### Specs Playwright no código atual
- Outro agente rodava os mesmos specs ao mesmo tempo na porta 4173 e o comando de liberar a porta encerrou o meu servidor no meio (resultado descartado). Para não interferir, usei uma configuração própria no scratchpad: mesma `playwright.config.js` do projeto, Chromium em /opt/pw-browsers/chromium, servidor estático em outra porta (4391 em diante) e saída de resultados no scratchpad
- `tests/aud001-venda.spec.js tests/aud001-atualizacao.spec.js tests/aud001-tela.spec.js tests/manheim-conferencia.spec.js`: 14 de 14 passaram
- `tests/buscas-split.spec.js tests/manheim-trim.spec.js tests/opcoes-cliente.spec.js tests/opcoes-todos.spec.js tests/manheim-selecao.spec.js tests/integracao-navegacao.spec.js`: 23 de 25 passaram; as 2 falhas são de buscas-split e estão em Observações

### Prova de "falha antes e passa depois" (cópias no scratchpad)

| Achado | Código antes | Código depois | Teste rodado | Antes | Depois |
|---|---|---|---|---|---|
| A1 | 20687cd (pai de fd79328) | fd79328 | manheim-conferencia.spec.js, "seleção trocada depois de conferida" (versão de fd79328) | falhou: "A conferência desta demanda ainda não liberou a V1" no lugar de "Link V1 criado" | passou |
| A2 | fd79328 (pai de 9a22358) | 9a22358 | aud001-venda.spec.js, "AUD-001 #57" (versão de 9a22358) | falhou: contador "0 de 10 selecionados" depois de reordenar | passou |
| A6 | fd79328 | 9a22358 | aud001-venda.spec.js, "AUD-001 #61" | passou | passou (o próprio commit diz "não reproduzido") |
| A4 | 083dadc (pai de 607644d) | 607644d | aud001-atualizacao.spec.js (versão de 607644d) | falhou: 7 atualizações em 6 s com o grupo aberto, esperado 3 | passou |

### O teste de hoje pega a volta do defeito? (código atual com a correção desfeita, só no scratchpad)

| Achado | O que desfiz numa cópia do código atual | Teste atual | Resultado |
|---|---|---|---|
| A1 | tirei de `setSelected` (painel.js:4285 a 4288) a volta para "Conferindo" e voltei a condição antiga da nova tentativa da V1 (painel.js:4651) | manheim-conferencia.spec.js:207 | falhou, como deveria; os outros 7 testes do arquivo passaram |
| A2 | tirei a linha do retrato da seleção (painel.js:4283, `offer.selectedIds = ...`) | aud001-venda.spec.js:79 (#57), manheim-trim.spec.js, opcoes-cliente.spec.js | os 12 passaram: nenhum teste do repositório percebe |
| A4 | fiz `refreshBusy` ignorar o trabalho aberto (painel.js:6338) | aud001-atualizacao.spec.js:80 | falhou, como deveria |

### Testes de apoio que escrevi (só no scratchpad, não estão no repositório)
- A2, voltar à fila e reabrir a tela do cliente (`aud002-a2-reabrir.spec.js`): passa no código atual; sem a linha de painel.js:4283 falha com "0 de 10 selecionados" no lugar de "1 de 10". A linha da correção de A2 ainda protege esse caminho, e nenhum teste do repositório o cobre
- A1 caso A, demanda em "Revisar" e seleção trocada (`aud002-a1-revisar.spec.js`): passa no código atual; sem a correção falha com o selo parado em "Revisar". O caso A da AUD-001 está corrigido, mas sem teste no repositório
- A6 com valor que muda o percentual: cópia do teste #61 trocando "1 dólar a mais" por "500 dólares a mais". Falhou 3 vezes em 3 no código atual: digitado 26.771,00, gravado 26.771,40. O corpo do "Selecionar" sai com `"pct":"7"`; no teste original sai com `"pct":null` porque 1 dólar a mais arredonda para o percentual padrão, e aí o banco mantém o valor digitado. Condição do teste: o pedido de seleção chega 1,5 s depois do salvamento do valor (rede lenta simulada); a frequência no uso real não foi medida
- A7, leituras por clique em "Ver opções" de BUSCAR CARROS (cópia instrumentada de buscas-split.spec.js:103): 2 leituras de `/api/panel/records?view=manheim` para um clique
- A8, número da aba antes e depois de abrir ENVIAR OPÇÕES (cópia instrumentada de opcoes-todos.spec.js, dados fictícios): 2 antes de abrir, 1 depois. Quem já recebeu V1 entra na conta de antes (painel.js:2149 usa `optionsPeopleOf`, que conta `matchCount > 0`) e sai na de depois (painel.js:3943)

## Achado por achado

O estado de cada achado aqui é a leitura do qa para decidir se há correção a testar; o estado oficial é o do setor produto.

### A1 · Conferência velha ao mudar a seleção trava a V1
- Correção: fd79328 (`setSelected` volta o selo para "Conferindo" e a V1 sempre confere de novo quando o servidor diz pendente). Hoje em painel.js:4281 a 4290 e 4651
- Teste: tests/manheim-conferencia.spec.js:207, "seleção trocada depois de conferida: o selo volta a Conferindo e Gerar V1 confere os carros novos e cria a V1"
- Hoje: passa. Antes da correção: falha. Correção desfeita no código atual: falha
- Cobre o caso B da AUD-001 (Conferido e carro acrescentado). O caso A (Revisar e carro trocado) não tem teste no repositório; o teste de apoio mostrou que está corrigido
- Exigências extras da AUD-001: seleção, sim (manheim-conferencia.spec.js:207, opcoes-cliente.spec.js:75); toque no celular, não (nenhum spec usa `hasTouch` ou `tap` na seleção; o único com toque é whatsapp-envio.spec.js); abrir de details, sim (manheim-trim.spec.js:155 abre o trim, manheim-trim.spec.js:195 abre a lista de selecionados); fechar de details, não verificado em teste; navegação legítima do cartão, sim (manheim-trim.spec.js:155: apertar e soltar no cartão da fila abre a tela, e dentro da tela o trim não navega)
- Classificação: COBERTO, com lacunas (caso A, toque no celular, fechar details)

### A2 · Seleção volta ao retrato antigo ao reordenar
- Correção: 9a22358 (o retrato da página acompanha a seleção). Hoje em painel.js:4283
- Teste: tests/aud001-venda.spec.js:79, "AUD-001 #57: seleção continua depois de reordenar o grupo"
- Hoje: passa. Antes da correção (versão do teste de 9a22358 sobre fd79328): falha. Com a correção desfeita no código atual: continua passando
- Motivo: em 43a5f70 a seleção passou para a tela "Opções do cliente", onde reordenar não recria a seleção a partir do retrato; o teste foi reescrito para essa tela e deixou de depender da correção. A linha da correção hoje protege voltar à fila e reabrir a tela, caminho sem teste no repositório (o teste de apoio falha sem ela)
- Exigências extras: as mesmas de A1 (toque no celular ausente, fechar details não verificado)
- Classificação: COBERTO SEM PROVA no código atual (a prova de falha antes vale só para a versão antiga do teste e da tela)

### A3 · Seleção gravada no id de outro membro do mesmo VIN
- Estado: aberto. A função `panel_manheim_offer_select_v2` não foi redefinida depois da AUD-001 e ainda troca o id pelo do membro (supabase/migrations/20261022010000_manheim_v34_group_vin.sql:265) e devolve esse id (linha 312); o painel continua usando `option.id` e ignorando `result.matchId` (painel.js:3564)
- Teste: nenhum
- Classificação: NÃO SE APLICA (aberto). A AUD-001 citou 0 casos em produção; não recontei

### A4 · Sincronização e atualização automática apagam o trabalho aberto
- Correção: 607644d (atualização automática em pausa com trabalho aberto) e, na prática, 43a5f70 (o trabalho fica na tela "Opções do cliente", que a recarga da fila não redesenha)
- Teste: tests/aud001-atualizacao.spec.js:80, "grupo aberto: a atualização automática não fecha o grupo e oferece Atualizar"
- Hoje: passa. Antes da correção: falha. Correção desfeita no código atual: falha
- Observação: a recarga disparada pela sincronização (painel.js:357) continua sem a trava de trabalho aberto; hoje ela redesenha só a fila atrás da tela. A primeira parte do teste (atualização com um carro aberto, a tela e o carro continuam) cobre esse efeito pelo mesmo caminho de redesenho
- Classificação: COBERTO

### A5 · Linha clicável dentro de cartão clicável abre o pedido duas vezes
- Estado: o cartão com linhas clicáveis (`renderManheimOrderGroup`) foi removido em b4bcdd2. A proteção do cartão (`guardCardClick`, painel.js:1826 a 1843) continua sem ignorar um cartão clicável mais interno; não achei outro cartão clicável dentro de cartão clicável hoje
- Teste: nenhum verifica "um clique, uma abertura" nem uma entrada só no histórico
- Classificação: SEM TESTE

### A6 · Valor em dólar seguido de Selecionar grava outro preço
- Estado: aberto, reproduzido no código atual (ver Testes de apoio). `priceBody` (painel.js:3558) manda o percentual enquanto o valor digitado ainda não voltou do servidor, e a função do banco recalcula o preço pelo percentual (migração 20261022010000, trecho `elsif p_action = 'PRICE' or p_manual_pct is not null`)
- Teste: tests/aud001-venda.spec.js:105, "AUD-001 #61". Passa hoje e passava antes do commit 9a22358; não detecta o defeito porque 1 dólar a mais vira o percentual padrão e o painel manda `pct: null`
- Classificação: NÃO SE APLICA (aberto). O teste existente é um falso verde e precisa usar um valor que mude o percentual

### A7 · "Ver opções" lê a mesma visão duas vezes
- Estado: aberto. `openOptionsCard` ainda chama `switchPanel('searches')`, que já carrega a aba, e logo depois `loadCurrent('searches')` (painel.js:1938 a 1940); a aba lê com `request` e não com `sharedGet` (painel.js:2045). Medido: 2 leituras por clique. A parte "deixa o grupo fechado" mudou: a fila não abre grupos, só destaca o cartão
- Teste: tests/buscas-split.spec.js:103 clica em "Ver opções" mas não conta leituras (e falha antes por outro motivo, ver Observações)
- Classificação: NÃO SE APLICA (aberto)

### A8 · Número da aba e lista de ENVIAR OPÇÕES não batem
- Estado: parcial. Com a aba aberta, o número sai da própria fila (painel.js:3943); antes de abrir, sai da regra antiga (painel.js:2149 e 3808; panel-counter-summary.js:15 e 16). No cenário fictício: 2 antes, 1 depois
- Teste: tests/opcoes-todos.spec.js:35 confere o número só depois de abrir a aba; não foi escrito para A8 e não há como mostrar que falharia antes (a fila não existia em 77c9352)
- Classificação: NÃO SE APLICA (parcial, a parte de antes de abrir a aba continua)

### A9 · Selecionar roda a função pesada de grupos três vezes
- Estado: aberto. `panel_manheim_offer_select_v2` ainda chama `panel_manheim_grouped_options` três vezes (migração 20261022010000, linhas 262, 280 e 311) e não foi redefinida depois
- Teste: nenhum
- Classificação: NÃO SE APLICA (aberto)

### A10 · Cada página relê a base e as vitrines; PDF lê grupos em série
- Estado: aberto. `contextFor` roda depois da página, em série (api/panel/manheim-options.js:146); `alsoFitsFor` lê todas as vitrines sem filtro (linha 62); `selectedOptions` do PDF continua lendo de 50 em 50, grupo por grupo (painel.js:3290 a 3303, chamado em 4628 quando falta carro)
- Teste: nenhum
- Classificação: NÃO SE APLICA (aberto)

### B1 · Erros do fluxo de venda sem texto próprio
- Estado: parcial. A V1 ganhou texto para MANHEIM_SALE_ENDED em 73b679f (painel.js:4596); a seleção continua sem ele (`OFFER_ERRORS`, painel.js:3435 a 3445) e VITRINE_VIN_DUPLICATE continua sem texto
- Teste: nenhum teste de navegador confere esses textos (há testes do servidor que devolvem os códigos: opcoes-leilao-passado.test.js, manheim-v34.test.js)
- Classificação: NÃO SE APLICA (parcial); a parte corrigida está sem teste de tela

### B2 · Observação interna do carro não é salva sozinha
- Estado: aberto. O campo `offer-note` (painel.js:3549) continua sem ouvinte próprio
- Teste: nenhum (opcoes-cliente.spec.js:134 só confere que o campo aparece)
- Classificação: NÃO SE APLICA (aberto)

### B3 · Reativação: lista antiga só BATE, seleção mostra todos os grupos
- Estado: a lista antiga saiu em b4bcdd2; `bateCount` hoje só aparece no selo (painel.js:3421). Continua dependendo da decisão da Leo sobre a regra
- Teste: nenhum
- Classificação: NÃO SE APLICA (depende de decisão da Leo)

### B4 · Pedido sem ficha deixa selecionar sem V1, PDF nem WhatsApp
- Estado: a tela agora avisa "Vincule o pedido a uma ficha para gerar a V1" (painel.js:4643, desde b4bcdd2), mas continua deixando selecionar. A AUD-001 citou 0 casos no lote ativo; não recontei
- Teste: nenhum teste confere esse aviso
- Classificação: NÃO SE APLICA (parcial)

## Lacunas para o setor produto decidir
- A6: o teste #61 precisa de um valor que mude o percentual; hoje ele passa com o defeito presente
- A2: falta teste de voltar à fila e reabrir a tela do cliente; é o caminho que a correção ainda protege
- A1: falta teste do caso "Revisar e seleção trocada"
- A1 e A2: falta teste de toque no celular (contexto com toque e `tap`) e de fechar details, como a AUD-001 pediu
- A5: falta teste de "um clique, uma abertura e uma entrada no histórico"
- Os testes de apoio estão no scratchpad desta sessão e podem servir de ponto de partida; não foram copiados para o repositório

## Observações (sem relação direta com os achados)
- tests/buscas-split.spec.js:103 ("19 · desktop") falha no código atual: o cartão "Cliente Dois Modos" mostra 1 pedido e o teste espera 2 (linha 117), e mais 3 textos esperados não aparecem. É o teste que passa pelo "Ver opções" de A7, mas a falha é anterior a esse ponto
- tests/buscas-split.spec.js:203 ("24-27 · lote com vários CSVs") falha no código atual: o lote fica em "Desfazendo…" e o teste espera "Desfeito"
- O comando de liberar a porta 4173 encerra qualquer servidor `python3 http.server` da máquina; dois agentes rodando specs ao mesmo tempo se derrubam. A primeira rodada pela config do projeto deixou a pasta test-results/ (ignorada pelo Git) com o registro da última execução

## Tabela final

| Achado | Estado lido pelo qa | Teste (arquivo e teste) | Passa hoje | Falha sem a correção | Cobertura |
|---|---|---|---|---|---|
| A1 | resolvido (fd79328) | manheim-conferencia.spec.js:207 "seleção trocada depois de conferida" | sim | sim (antes do commit e no código atual) | COBERTO, com lacunas: caso Revisar, toque no celular, fechar details |
| A2 | resolvido (9a22358); cenário mudou em 43a5f70 | aud001-venda.spec.js:79 "AUD-001 #57" | sim | só a versão antiga do teste; a atual passa sem a correção | COBERTO SEM PROVA |
| A3 | aberto | nenhum | | | NÃO SE APLICA |
| A4 | resolvido (607644d e 43a5f70) | aud001-atualizacao.spec.js:80 | sim | sim (antes do commit e no código atual) | COBERTO |
| A5 | sumiu com a remoção da lista antiga (b4bcdd2) | nenhum | | | SEM TESTE |
| A6 | aberto, reproduzido 3 de 3 com rede lenta simulada | aud001-venda.spec.js:105 "AUD-001 #61" (falso verde) | sim | não | NÃO SE APLICA |
| A7 | aberto (2 leituras por clique) | nenhum conta leituras | | | NÃO SE APLICA |
| A8 | parcial (2 antes de abrir a aba, 1 depois, dados fictícios) | opcoes-todos.spec.js:35 confere só depois de abrir | sim | não demonstrável | NÃO SE APLICA |
| A9 | aberto | nenhum | | | NÃO SE APLICA |
| A10 | aberto | nenhum | | | NÃO SE APLICA |
| B1 | parcial (texto só na V1, 73b679f) | nenhum de tela | | | NÃO SE APLICA |
| B2 | aberto | nenhum | | | NÃO SE APLICA |
| B3 | depende de decisão da Leo | nenhum | | | NÃO SE APLICA |
| B4 | parcial (aviso na V1, b4bcdd2) | nenhum | | | NÃO SE APLICA |
