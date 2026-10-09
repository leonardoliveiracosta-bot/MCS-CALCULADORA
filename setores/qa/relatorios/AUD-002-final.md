# AUD-002 Relatório final do Nível 3 Aprovador (qa)

- Data: 2026-10-09
- Pedido: AUD-002, acompanhamento da AUD-001 do setor produto. O setor responsável é produto; o qa entra para conferir se cada correção tem o teste que a AUD-001 exigiu
- Base conferida: código do commit 68cc468. Os commits seguintes, até 0396b88, só acrescentam arquivos em setores/ (conferido com git diff, nenhum arquivo de código mudou)
- O commit 7a25ef1, citado como base da AUD-001, não existe neste repositório. Os dois níveis usaram commits equivalentes; conferi que em 77c9352 estão exatamente as linhas que a AUD-001 cita (setSelected, makeCardClickable da linha e do cartão, auditCanTry, recarga da sincronização, openOptionsCard, optionsPeopleOf)

## Agentes e ordem das etapas

| Ordem | Etapa | Agente | Registro |
|---|---|---|---|
| 1 | Pedido registrado | setor produto | 68cc468, 10:22 |
| 2 | Avaliação cega do revisor, sem abrir o rascunho do executor | Nível 2 Revisor independente qa | 2c7c478, 10:46 |
| 3 | Rascunho do executor | Nível 1 Executor qa | 3bb668d, 10:48 |
| 4 | Comparação do revisor com o rascunho | Nível 2 Revisor independente qa | 0396b88, 10:54, só com linhas novas (0 linhas apagadas), a parte cega ficou como estava |
| 5 | Julgamento e este relatório | Nível 3 Aprovador qa, agente distinto dos dois anteriores | este arquivo |

- Executor e revisor trabalharam ao mesmo tempo; a avaliação cega foi gravada 2 minutos antes do rascunho. O executor declarou não ter aberto a avaliação cega e o revisor declarou não ter aberto o rascunho antes de gravar a parte cega. Não houve troca de material, então a regra anti-ancoragem foi respeitada
- Registro de processo, aceito: o script de testes do revisor encerrava todo servidor de teste da máquina e, uma vez, derrubou uma rodada do executor. O próprio revisor registrou isso. O executor descartou aquele resultado e repetiu em porta própria, sem efeito nos números
- Eu não alterei código, banco, PR nem publicação. Minhas provas rodaram numa cópia do código atual dentro do scratchpad, em porta própria (4613), sem encerrar processo de ninguém. Não consultei o banco de produção

## 1. O que foi pedido

A Leo pediu para saber quais dos achados da AUD-001 marcados para corrigir agora (A1 a A10) e do backlog (B1 a B4) já foram resolvidos e quais seguem abertos, conferido no código atual. A parte do qa: para cada achado, dizer se existe o teste de navegador (Playwright) que a AUD-001 exigiu, ou seja, um teste que falha sem a correção e passa com ela.

Para A1 e A2 a AUD-001 exigiu também testes de seleção, toque no celular, abrir e fechar de caixas que abrem e fecham na tela, e a navegação normal do cartão. Pelos próprios achados, entram ainda o caso "Revisar" de A1 (demanda marcada para revisar e carro trocado) e, para A2, voltar à fila e reabrir a tela do cliente, que é o caminho que a correção protege hoje.

Somente leitura, sem dados pessoais, sem segredos. A Leo pediu agora só a lista dos problemas, sem correção: este relatório descreve, não propõe implementar nada.

Significado dos rótulos usados pelos dois níveis e mantidos por mim:
- COBERTO: o teste existe, passa hoje e falha quando a correção é desligada
- COBERTO SEM PROVA: o teste existe e passa, mas não percebe quando a correção é desligada no código atual
- SEM TESTE: houve mudança no código dirigida ao próprio achado e nenhum teste a confere
- NÃO SE APLICA: não há correção a testar (achado aberto, caminho removido, ou depende de decisão da Leo)

## 2. O que foi entregue

Executor: rodou a suíte de testes rápidos e os testes de navegador, provou "falha antes, passa depois" para A1, A2 e A4 voltando aos commits de antes e depois de cada correção, desligou cada correção numa cópia do código atual para ver se o teste de hoje percebe, e escreveu testes de apoio só no scratchpad (A1 caso Revisar, A2 voltar e reabrir, A6 com outro valor, contagem de leituras de A7, número da aba de A8).

Revisor: fez a mesma conferência às cegas, com sondas próprias (inclusive uma com toque no celular em tela de 390 px), depois comparou, reconferiu os pontos de divergência e retirou uma classificação sua (A6).

Aprovador, conferido por mim:
- Código atual: confirmei as linhas citadas pelos dois níveis (painel.js 357, 1826 a 1843, 1938 a 1940, 3435 a 3445, 3558, 4281 a 4290, 4596, 4643, 4645 a 4655)
- Busca nos testes: o único teste com toque de celular é whatsapp-envio.spec.js, fora do fluxo de opções. Nenhum teste fecha por ação do usuário uma caixa da tela do cliente. Nenhum teste de tela confere o texto de leilão passado da V1 nem o aviso "Vincule o pedido a uma ficha para gerar a V1"
- A6, numa cópia do teste #61: com 500 dólares a mais, falhou 4 vezes em 4 (2 com atraso de rede simulado, 2 sem atraso), digitado 2677100 centavos e gravado 2677140. Com 1 dólar a mais, como no teste original, passou 2 vezes em 2
- A2, com a linha da correção desligada numa cópia: o teste #57 do repositório continuou passando; o teste de apoio de voltar e reabrir falhou (o contador mostrou um carro a menos depois de reabrir)
- A1: desligando só a segunda parte da correção (conferir sempre que o servidor diz pendente), os 17 testes de conferência e de apoio passaram. Confirma o que o revisor disse: essa parte é uma proteção a mais, sem teste próprio, e não um defeito
- Testes de apoio no código atual: 13 de 13 passaram (A1 caso Revisar, A2 voltar e reabrir, toque no celular com abrir e fechar)
- buscas-split.spec.js: rodei os dois testes que falham, 3 vezes cada (resultado no item 4)
- Não rodei a suíte de testes rápidos; os dois níveis rodaram de forma independente com o mesmo resultado (1.077 testes, 1.076 passaram, 1 pulado de propósito, 0 falhas)

Resultado por achado, como fica decidido:

| Achado | Situação no código atual (leitura do qa) | Teste no repositório | Classificação final |
|---|---|---|---|
| A1 Conferência velha trava a V1 | corrigido em fd79328 | manheim-conferencia.spec.js:207, falha sem a correção | COBERTO |
| A2 Seleção volta ao retrato antigo | corrigido em 9a22358; a tela mudou em 43a5f70 | aud001-venda.spec.js:79 (#57), passa mesmo sem a correção | COBERTO SEM PROVA |
| A3 Seleção gravada no id de outro carro do mesmo VIN | aberto | nenhum | NÃO SE APLICA |
| A4 Atualização apaga o trabalho aberto | corrigido em 607644d | aud001-atualizacao.spec.js:80, falha sem a correção | COBERTO |
| A5 Clique abre o pedido duas vezes | o caminho foi removido em b4bcdd2; a causa na proteção do cartão continua | nenhum | NÃO SE APLICA |
| A6 Valor em dólar e Selecionar grava outro preço | aberto, reproduzido | aud001-venda.spec.js:105 (#61), passa com o defeito presente | NÃO SE APLICA |
| A7 "Ver opções" lê a mesma visão duas vezes | aberto, 2 leituras por clique | nenhum conta leituras | NÃO SE APLICA |
| A8 Número da aba e lista não batem | parcial: antes de abrir a aba, 2; depois, 1 (dados fictícios) | opcoes-todos.spec.js confere só depois de abrir | NÃO SE APLICA |
| A9 Função pesada roda três vezes | aberto | nenhum | NÃO SE APLICA |
| A10 Páginas releem base e vitrines; PDF em série | aberto | nenhum | NÃO SE APLICA |
| B1 Erros sem texto próprio | parcial: só a V1 ganhou o texto de leilão passado (73b679f) | nenhum teste de tela | SEM TESTE |
| B2 Observação não salva sozinha | aberto | nenhum | NÃO SE APLICA |
| B3 Reativação | depende de decisão da Leo | nenhum | NÃO SE APLICA |
| B4 Pedido sem ficha seleciona sem V1 | parcial: a tela avisa, mas continua deixando selecionar (b4bcdd2) | nenhum teste do aviso | SEM TESTE |

O estado oficial de cada achado (resolvido, parcial, aberto, mudou) é do setor produto; a coluna de situação acima é a leitura do qa para saber se há correção a testar.

## 3. Divergências encontradas

| Ponto | Executor | Revisor | Evidência | Decisão do aprovador |
|---|---|---|---|---|
| A6 | NÃO SE APLICA: defeito aberto, teste #61 passa com o defeito (3 de 3 falhas com 500 dólares e rede lenta) | Na avaliação cega, COBERTO SEM PROVA. Na comparação retirou e passou a NÃO SE APLICA (6 de 6 falhas: 3 com atraso, 3 sem) | Minha cópia: 4 de 4 falhas com 500 dólares (2 com atraso, 2 sem), 2 de 2 passagens com 1 dólar. O botão Selecionar manda o percentual 7 e o banco recalcula o preço por ele. Com 1 dólar a mais o percentual fica igual ao padrão, o painel não manda percentual e o valor digitado fica | NÃO SE APLICA, defeito aberto. O teste #61 é um falso verde: passa mesmo com o defeito presente |
| A5 | SEM TESTE: o defeito sumiu com a remoção da lista antiga e nenhum teste prova "um clique, uma abertura" | NÃO SE APLICA: a causa não foi corrigida e um teste hoje passaria sem provar nada | Os dois concordam nos fatos. Conferi que guardCardClick (painel.js:1826) continua sem ignorar cartão clicável dentro de outro e que nos 5 usos atuais (1618, 2472, 3134, 3135, 4055) não há cartão dentro de cartão: 0 casos hoje | NÃO SE APLICA. Não houve correção, o caminho deixou de existir. Fica registrado que a causa continua e que nada avisa se um cartão clicável voltar a ficar dentro de outro |
| B1 e B4 | NÃO SE APLICA (parcial), com nota de que a parte mudada não tem teste de tela | SEM TESTE, para deixar visível que a parte mudada não tem teste | Mesmos fatos dos dois lados. Conferi: o texto de leilão passado da V1 (painel.js:4596) e o aviso de pedido sem ficha (painel.js:4643) não aparecem em nenhum teste | SEM TESTE. A mudança foi dirigida ao conteúdo do próprio achado (o texto de um erro citado em B1, o aviso que faltava em B4) e nenhum teste a confere. O restante dos dois continua aberto |
| A1 | COBERTO, com lacunas | COBERTO | Os dois provaram falha antes e falha com a correção desligada | COBERTO. As lacunas ficam listadas à parte no item 4, sem mudar o rótulo |
| A8 | Parcial: 2 antes de abrir a aba, 1 depois | Na avaliação cega, "código refeito", sem medir; na comparação mediu 2 antes e 1 depois em 2 de 2 rodadas e aceitou a leitura do executor | Duas medições independentes iguais | Mesma classificação (NÃO SE APLICA); a descrição certa é parcial, o número da aba ainda não bate com a lista antes de abrir a aba |
| A7 | Mediu 2 leituras por clique | Na avaliação cega não mediu; na comparação mediu 2 em 2 de 2 rodadas | Duas medições independentes iguais | Mantida a medição, NÃO SE APLICA |
| A4 | A recarga da sincronização (painel.js:357) não tem a trava, mas o teste atual cobre o efeito pelo mesmo caminho de redesenho | A recarga da sincronização não passa pela pausa e não tem teste próprio | Confirmei no código que a linha 357 recarrega sem olhar trabalho aberto. Não conferi se o teste atual cobre esse efeito | COBERTO para a pausa da atualização automática. Se o teste atual também cobre a recarga da sincronização fica como pendência |
| Linha da correção de A2 | painel.js:4283 | Na avaliação cega escreveu 4282 (A2) e 4284 (A1); corrigiu na comparação para 4283 e 4285 | Conferi: 4283 e 4285 estão certas | Vale 4283 e 4285 |
| buscas-split.spec.js | 2 falhas, numa rodada | Não rodou na etapa cega; na comparação, teste 19 falhou 3 de 3, teste 24-27 falhou 1 de 6 | Minhas rodadas abaixo | Registrado como observação fora do escopo (item 4) |

## 4. Decisão do aprovador

Classificação final dos 14 achados:
- COBERTO: A1, A4 (2)
- COBERTO SEM PROVA: A2 (1)
- SEM TESTE: B1, B4 (2)
- NÃO SE APLICA: A3, A5, A6, A7, A8, A9, A10, B2, B3 (9)

Problemas sustentados pelos níveis 2 e 3:

1. A6 continua acontecendo no código atual e o teste que existe para ele não percebe. Nas cópias de teste, com um valor digitado que muda o percentual, o preço gravado saiu diferente do digitado em 13 de 13 rodadas somando os três agentes (executor 3, revisor 6, aprovador 4), com e sem atraso de rede simulado. Com o valor do teste original (1 dólar a mais) o preço sai certo, por isso o teste fica verde. Quantas vezes isso acontece no uso real não foi medido; não apresentar como constante até haver essa medida
2. A2 está corrigido, mas o teste do repositório deixou de proteger a correção depois da tela nova. Sem a linha da correção, o teste #57 continua passando e o caminho de voltar à fila e reabrir a tela do cliente perde a seleção recém feita (confirmado por executor, revisor e aprovador)
3. Lacunas que a AUD-001 exigia para A1 e A2, todas sem teste no repositório:
   - Toque no celular: nenhum teste do fluxo de opções usa toque. A sonda do revisor com toque em 390 px passou no código atual (1 de 1 na minha rodada), ou seja, o comportamento está certo hoje, mas nada confere
   - Abrir e fechar de caixas: abrir tem teste (trim e lista de selecionados); fechar por ação do usuário não tem. O "fechar" de opcoes-cliente.spec.js é de um bloco escondido, não de uma caixa que abre e fecha
   - Caso Revisar de A1: está corrigido (o teste de apoio passa hoje e falha sem a correção, conferido por executor e revisor), mas não tem teste no repositório
   - Voltar e reabrir o cliente de A2: ver problema 2
   - Seleção e navegação normal do cartão: têm teste (manheim-conferencia.spec.js:207, aud001-venda.spec.js:79, opcoes-cliente.spec.js:75, manheim-trim.spec.js:155)
4. A1 tem uma segunda proteção (conferir sempre que o servidor diz pendente) que pode ser desligada sem nenhum teste falhar (17 de 17 passaram na minha rodada). Não é defeito, a primeira parte da correção já evita o caso; só fica sem teste próprio
5. A5 não acontece mais porque o caminho foi removido, mas a causa na proteção do cartão continua igual e nenhum teste avisaria se um cartão clicável voltasse a ficar dentro de outro. Hoje: 0 casos
6. B1 e B4 tiveram parte mudada (texto de leilão passado na V1, aviso de pedido sem ficha) sem teste de tela; o resto dos dois continua aberto
7. A3, A7, A8 (parte de antes de abrir a aba), A9, A10 e B2 continuam abertos, sem correção para testar. B3 depende de decisão da Leo

Observação fora do escopo, duas falhas em tests/buscas-split.spec.js no código atual, sem ligação com os achados da AUD-001:
- Teste "19 · desktop": falhou em todas as rodadas, 7 de 7 (executor 1, revisor 3, aprovador 3). Espera 2 pedidos no cartão da pessoa com dois pedidos e a tela mostra 1 (linha 117). É o teste que passa por "Ver opções" de A7, mas quebra antes desse ponto
- Teste "24-27 · lote com vários CSVs": falhou 2 vezes em 10 (executor 1 de 1, revisor 1 de 6, aprovador 0 de 3). O lote fica em "Desfazendo…" quando o teste espera "Desfeito". É intermitente, não constante

Pendências, sem conclusão, devolvidas para verificação:
- Frequência real de A6 no uso do painel: não medida por ninguém
- Recontagem em produção dos 0 casos de A3 e B4: o qa não consultou o banco; cabe ao setor produto nesta AUD-002
- A4: se o teste atual também cobre a recarga disparada pela sincronização (painel.js:357); os dois níveis divergem e eu não conferi
- O estado oficial de cada achado é do relatório do setor produto, que ainda não existe; este relatório cobre só a parte de testes

Esta decisão não substitui a aprovação da Leo.
