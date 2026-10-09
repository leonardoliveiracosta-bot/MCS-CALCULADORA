# AUD-002 Relatório final do Nível 3 Aprovador (produto)

- Data: 2026-10-09
- Pedido: AUD-002, acompanhamento dos 14 achados da AUD-001 do setor produto (A1 a A10 para corrigir agora, B1 a B4 do backlog)
- Setor responsável: produto. Setor que entrou: qa, para conferir os testes
- Base conferida: código do commit 68cc468 (pedido registrado). Os commits seguintes só acrescentam arquivos em setores/, sem mudar código
- O commit 7a25ef1, base da AUD-001, não existe no repositório (conferido por mim com git). Executor e revisor usaram como base o código de antes da primeira correção (fd79328) e o PR #210; aceito
- O aprovador só leu código, testes e git. Não rodou teste, não consultou o banco e não alterou código, banco, PR nem publicação

## Agentes e ordem das etapas

| Ordem | Etapa | Agente | Registro |
|---|---|---|---|
| 1 | Pedido registrado | setor produto | 68cc468, 10:22 |
| 2 | Rascunho do executor | Nível 1 Executor produto | 92f320a, 10:31 |
| 3 | Etapas do qa (cega, rascunho, comparação, relatório final do qa) | agentes do setor qa | 2c7c478, 3bb668d, 0396b88, aa18ff8, até 11:03 |
| 4 | Avaliação cega do revisor, sem abrir o rascunho | Nível 2 Revisor independente produto | 99421e8, 12:19 |
| 5 | Comparação do revisor com o rascunho e com o relatório do qa | Nível 2 Revisor independente produto | 01306fe, 12:21, só linhas acrescentadas (46 novas, 0 apagadas); a parte cega ficou como estava |
| 6 | Julgamento e este relatório | Nível 3 Aprovador produto, agente distinto dos anteriores | este arquivo |

Registro sobre a regra anti-ancoragem: o rascunho do executor já estava no repositório quando o revisor gravou a parte cega. O revisor declarou que viu só os títulos dos commits numa busca e não abriu o conteúdo. A parte cega traz evidências próprias (linhas, contagens e medição diferentes das do executor, inclusive números diferentes em A3, A6 e B4), o que é coerente com trabalho independente. Aceito, com o registro feito aqui.

## 1. O que foi pedido

A Leo pediu para saber quais dos 14 achados da AUD-001 já foram resolvidos pelas publicações recentes e quais seguem abertos, conferido no código atual. Para cada achado: estado (RESOLVIDO, PARCIAL, ABERTO ou MUDOU), evidência no código, commit que resolveu, se a contagem em produção citada na AUD-001 continua valendo e se existe o teste de navegador que a AUD-001 exigiu.

Nesta etapa a Leo pediu só a lista dos problemas, sem correção. Este relatório descreve; não propõe implementação nem regra comercial nova. B3 continua dependendo de decisão da Leo.

## 2. O que foi entregue

O executor classificou os 14 achados com evidência e fez 4 consultas de leitura no banco. O revisor fez a avaliação cega com evidência própria, rodou 11 testes de navegador (todos passaram), reproduziu A6 numa cópia fora do repositório e fez 3 consultas de leitura no banco; depois comparou com o rascunho. Os dois chegaram aos mesmos estados nos 14 achados. O qa conferiu os testes. Eu conferi no código as linhas que sustentam cada estado.

Contagem final: 4 RESOLVIDOS, 3 PARCIAIS, 6 ABERTOS, 1 MUDOU.

### Resolvidos

| Nº | Achado | Evidência curta | Teste |
|---|---|---|---|
| A1 | Conferência velha trava a V1 | painel.js:4281 a 4290: trocar a seleção volta o selo para Conferindo; o botão da V1 só depende de haver seleção (4278). Commit fd79328, levado à tela nova em 43a5f70 (#253) | Existe e o qa provou que falha sem a correção (manheim-conferencia.spec.js:207). Só na tela de computador |
| A2 | Seleção volta ao retrato antigo ao reordenar | painel.js:4283: a página guarda a seleção nova; reordenar mantém a seleção. Commit 9a22358 (#210) e 43a5f70 (#253) | Existe (aud001-venda.spec.js:79), mas o qa mostrou que ele passa mesmo sem a correção: não protege a correção hoje |
| A4 | Atualização apaga o trabalho aberto | o trabalho fica na tela "Opções do cliente" (index.html:335), que a recarga não redesenha; a atualização de 120 s pausa com trabalho aberto (painel.js:6330 a 6343). Commits 607644d (#213) e 43a5f70 (#253) | Existe e falha sem a correção (aud001-atualizacao.spec.js:80). A recarga depois da sincronização (painel.js:357) continua sem a pausa e sem teste próprio; hoje ela só redesenha a fila |
| A5 | Um clique abre o pedido duas vezes | o cartão com linha clicável dentro foi removido em b4bcdd2 (#218); nos usos atuais não há cartão clicável dentro de outro (0 casos) | Não há. A causa na proteção do clique (painel.js:1826 a 1843) continua igual; se um cartão clicável voltar a ficar dentro de outro, o defeito volta |

### Mudou

| Nº | Achado | Evidência curta |
|---|---|---|
| B3 | Reativação: lista só BATE x seleção com todos os grupos | a lista antiga não existe mais; a fila e a tela do cliente usam o mesmo número (painel.js:3928). A regra só BATE continua no servidor (panel-buscas-view.js:75 a 80) e chega ao contador da carga inicial e ao resumo da ficha. Precisa ser refeito depois da decisão da Leo. Quantas fichas em reativação existem hoje não foi medido |

### Abertos e parciais, do maior para o menor impacto na venda

| Ordem | Nº | Estado | O que acontece (evidência curta) | Impacto na venda | Frequência medida |
|---|---|---|---|---|---|
| 1 | A6 | ABERTO | o operador digita o valor em dólar e clica "Selecionar" sem sair do campo: o Selecionar manda o percentual arredondado (painel.js:3558) e o banco recalcula o preço por ele (migração 20261022010000:288), por cima do valor digitado | o preço gravado e mostrado na V1 ao cliente sai diferente do que o operador digitou: centavos a até cerca de US$ 1,25 num carro de US$ 25 mil, e o valor pode ficar com centavos | No uso real: não medida por ninguém. Em cópias de teste, com valor que muda o percentual: 13 de 13 rodadas erraram (executor, revisor e aprovador do qa). Com valor que mantém o percentual padrão: 0 erros. O teste do repositório (aud001-venda.spec.js:105) usa esse segundo caso e fica verde com o defeito presente |
| 2 | A8 | PARCIAL | dentro da aba, o número conta quem tem carro e ainda espera a V1 (painel.js:3943). Mas a rotina geral de contadores (painel.js:2149, com 3808) usa a regra antiga, que inclui quem já recebeu V1, e roda de novo depois de várias ações (painel.js:643, 926, 1120, 1313, 2246). O texto "N na fila" conta todas as linhas (3983) | o número da aba pode dizer que há mais clientes esperando V1 do que há, e mudar sozinho; o operador pode priorizar errado | Em produção: não medida. Com dados fictícios: 2 antes de abrir a aba e 1 depois, em 2 medições independentes do qa |
| 3 | A9 | ABERTO | cada "Selecionar" roda três vezes a leitura pesada de grupos no banco (migração 20261022010000:262, 280 e 311; a função em produção é a mesma) | selecionar carro fica mais lento em toda venda, mais nas demandas com muitos carros | Acontece em todo Selecionar (está no código). Tempo: 1 medição do revisor, 1,21 s numa chamada na maior demanda (incluindo a busca dessa demanda); a AUD-001 tinha 0,7 a 0,9 s. Os cerca de 3 s por Selecionar são estimativa, não medida |
| 4 | A10 | ABERTO | cada página de carros relê a base inteira e todas as vitrines (api/panel/manheim-options.js:146 e 62); o PDF busca os carros grupo a grupo, 50 por vez, em sequência (painel.js:3290 a 3302). O PR #292 só acelerou a leitura, sem evitar a releitura | abrir mais carros e gerar o PDF demoram mais para todo cliente | Acontece em toda página e todo PDF (está no código). Tempo não medido de novo |
| 5 | B1 | PARCIAL | a V1 ganhou texto para leilão passado (painel.js:4596, commit 73b679f, #226). No Selecionar e no preço o mesmo erro mostra "Não consegui salvar, tente de novo" (3446), e tentar de novo nunca resolve. VIN duplicado não tem texto em lugar nenhum (cai em "Não consegui gerar o link"). Se o preparo do WhatsApp falha, a tela diz "Sem telefone para abrir a conversa" mesmo com telefone (4669 a 4670) | o operador recebe mensagem que não explica a causa e perde tempo tentando de novo | Não medida |
| 6 | A7 | ABERTO | "Ver as N opções" de BUSCAR CARROS lê a mesma visão duas vezes seguidas (painel.js:1939 e 1940). A segunda metade do achado mudou: o botão agora só destaca a linha da fila e o operador precisa tocar de novo para abrir as opções | um passo e uma espera a mais para chegar às opções do cliente | 2 leituras por clique, medido em 2 de 2 rodadas pelo qa. Quantas vezes o botão é usado no dia não foi medido |
| 7 | B2 | ABERTO | o campo de observação interna do carro não salva sozinho (painel.js:3549, sem listener); a nota só vai junto com selecionar, remover, manter fora ou preço | a anotação do operador some se ele só escrever a nota e sair; não aparece para o cliente | Não medida |
| 8 | A3 | ABERTO, latente | o banco grava a seleção no id de outro carro do mesmo VIN e devolve esse id (migração 20261022010000:265 e 312); a tela e o PDF procuram pelo id mostrado (painel.js:4428, 4456, 3297) | quando acontecer, o carro selecionado aparece desmarcado, some do PDF e a V1 pode ser recusada | 0 casos hoje: no lote ativo há 20 seleções, 1 dentro dos grupos de carros e 0 no id de outro carro do mesmo VIN (contagem confirmada pelos dois níveis). A contagem da AUD-001 continua valendo. É exceção |
| 9 | B4 | PARCIAL | pedido sem ficha abre a tela do cliente e deixa selecionar; Gerar V1 e Copiar link agora explicam "Vincule o pedido a uma ficha para gerar a V1" (painel.js:4643, b4bcdd2, #218); o PDF responde só "Não consegui preparar o PDF agora" (4623) | o operador pode montar seleção que não vira V1 nem PDF | 0 casos hoje: 0 demandas sem ficha com carro e 0 seleções nelas (os dois níveis). A contagem da AUD-001 continua valendo. É exceção |

### Testes (parte do qa, aceita)

- Com teste que falha sem a correção: A1 e A4
- Com teste que não percebe a correção desligada: A2
- Mudança sem teste de tela: B1 (texto de leilão passado na V1) e B4 (aviso de pedido sem ficha)
- Sem correção a testar: A3, A5, A6, A7, A8, A9, A10, B2, B3
- Fora do escopo, registrado pelo qa: o teste "19 · desktop" de tests/buscas-split.spec.js falhou 7 de 7 rodadas, antes de chegar ao ponto de A7; o teste "24-27" do mesmo arquivo falhou 2 de 10 (intermitente)

## 3. Divergências encontradas

| Ponto | Executor | Revisor | Evidência | Decisão do aprovador |
|---|---|---|---|---|
| A6, tamanho do erro | calculou US$ 0,40 a mais | reproduziu US$ 1,00 a mais | o revisor refez as contas: os dois estão certos, a diferença depende do preço base e do valor digitado | Não é divergência de fato. Vale o intervalo: centavos a cerca de US$ 1,25 num carro de US$ 25 mil |
| A6, prova | só cálculo | 1 reprodução em cópia | qa: 13 de 13 | Sustentado: ABERTO e reproduzido em teste. Frequência real não medida; não apresentar como constante |
| A8, como o número muda | duas regras se alternam, vale a última que rodou | muda ao abrir a aba | conferi: a rotina de contadores roda depois de várias ações (painel.js:643, 926, 1120, 1313, 2246) e grava a regra antiga (2149) | Fica a leitura do executor, aceita pelo revisor |
| A8, quem pode sumir | ninguém some da lista | demanda sem linha na fila poderia entrar no número | o próprio revisor não sustentou na comparação | Não entra como conclusão |
| A8, commit | 9c992cf (#230) | 9e00785 (#231) | os dois e b4bcdd2 (#218) fazem parte; nenhum corrige a regra da carga inicial | Os três ficam citados |
| A3, as 19 seleções fora dos grupos | todas de leilão passado | não mediu; confirmou 20, 1 e 0 | conferir pediria consulta pesada | 20, 1 e 0 sustentados. "As 19 são de leilão passado" vira pendência |
| B4, base da contagem | 250 demandas com carros | 248 demandas com carros | métodos e horários diferentes | Sem efeito na conclusão (0 casos nos dois). A diferença fica sem explicação |
| A9, tempo | não mediu | 1,21 s numa chamada | uma medição só, incluindo a busca da maior demanda | As 3 chamadas são fato do código. O tempo fica como indicação de uma medição, não confirmada por dois níveis |
| A1 e A2, testes | existem, só na tela de computador; faltam celular e abrir e fechar caixas | na parte cega não olhou; na comparação confirmou | qa: nenhum teste do fluxo de opções usa toque; fechar caixa por ação do usuário não tem teste; o teste de A2 não protege a correção | Sustentado. RESOLVIDO no código, com lacuna de testes |
| A4, recarga da sincronização | sem a pausa, hoje só redesenha a fila | igual; considera coberta pelo mesmo caminho do teste | o qa não conferiu se o teste cobre esse caminho | RESOLVIDO no efeito. Se o teste cobre a sincronização fica como pendência |
| A5, lista de usos | omitiu painel.js:1486 | incluiu | 1486 também não fica dentro de outro cartão | Sem efeito na conclusão |
| Ordem das etapas | rascunho às 10:31 | parte cega às 12:19, declarando não ter aberto o rascunho | ver "Agentes e ordem das etapas" | Aceito, com o registro feito |

## 4. Decisão do aprovador

Estados finais, sustentados pelos níveis 2 e 3:
- RESOLVIDO: A1, A2, A4, A5
- PARCIAL: A8, B1, B4
- ABERTO: A3, A6, A7, A9, A10, B2
- MUDOU: B3

Problemas abertos e parciais, do maior para o menor impacto na venda: A6, A8, A9, A10, B1, A7, B2, A3 (0 casos hoje), B4 (0 casos hoje).

Ressalvas dos resolvidos: A2 tem teste que não protege a correção; A1 e A2 não têm os testes de celular e de abrir e fechar caixas que a AUD-001 exigiu; A5 sumiu porque a tela foi removida, mas a causa continua.

Pendências, sem conclusão, devolvidas para verificação:
- A6: frequência real no uso do painel (quantas vezes o operador digita o valor e clica Selecionar sem sair do campo). Ninguém mediu
- A8: qual regra vale para o número da aba; hoje duas regras se alternam. Quantas pessoas caem na diferença em produção não foi medido
- A3: origem das 19 seleções fora dos grupos; "todas de leilão passado" foi afirmado só pelo executor
- B3: depende da decisão da Leo sobre a regra por carro x por valor na reativação; depois disso o achado precisa ser refeito. Quantas fichas em reativação existem hoje não foi medido
- Lacuna de testes apontada pelo qa: teste de A2 que não percebe a correção desligada; falta de testes de toque no celular, de fechar caixas, do caso Revisar de A1 e de voltar e reabrir o cliente em A2; a segunda proteção de A1 sem teste próprio; B1 e B4 sem teste de tela; teste de A6 que fica verde com o defeito presente; e se o teste de A4 cobre a recarga da sincronização
- A9: tempo atual confirmado por uma só medição

Esta decisão não substitui a aprovação da Leo.
