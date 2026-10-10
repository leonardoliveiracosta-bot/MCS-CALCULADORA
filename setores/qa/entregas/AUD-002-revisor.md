# AUD-002 Nível 2 Revisor independente (qa)

- Pedido: AUD-002 (acompanhamento da AUD-001 do setor produto); qa confere se cada correção tem o teste que a AUD-001 exigiu
- Papel: Nível 2 Revisor independente do setor qa, etapa cega
- Data: 2026-10-09
- Ordem registrada: esta avaliação foi feita sem abrir nenhum AUD-002-executor.md e sem abrir a pasta aud002-qa-exec. Transparência: durante a busca no histórico, um `git log -S` listou o título do commit 92f320a ("setores: AUD-002 rascunho do executor de produto"), que chegou ao ramo enquanto eu trabalhava. Não abri o conteúdo; só confirmei com `git diff --stat` que ele não muda nenhum arquivo fora de setores/, então o código testado é o mesmo
- Limites respeitados: nenhuma alteração no repositório além deste arquivo, nenhuma consulta ao banco, nada publicado, nenhum comentário em PR. Os experimentos rodaram em git worktrees temporários no scratchpad, já removidos

## Fontes

- setores/produto/relatorios/AUD-001-final.md (os 14 achados e a exigência de teste Playwright que falhe antes e passe depois; para A1 e A2, também seleção, toque no celular, abrir e fechar de details e a navegação legítima do cartão)
- setores/produto/entregas/AUD-001-executor.md e setores/AUD-001-achados.json (para ligar A1 a A10 e B1 a B4 aos números globais: A1 = #56/#100, A2 = #57, A3 = #58/#45, A4 = #59, A5 = #60, A6 = #61, A7 = #62, A8 = #63, A9 = #64, A10 = #65, B1 a B4 = #66 a #69)
- Código atual: painel/painel.js, api/panel/manheim-options.js, supabase/migrations, commit 68cc468 (igual a 92f320a fora de setores/)
- Commits das correções, pelo histórico: fd79328 (A1), 9a22358 (#210, A2 e o teste de A6), 607644d (#213, A4), b4bcdd2 (#218, fila de ENVIAR OPÇÕES), 43a5f70 (#253, tela "Opções do cliente"), 73b679f (#226, leilão passado)
- O commit 7a25ef1 citado como base da AUD-001 não existe neste repositório (os relatórios da AUD-001 entraram pelo squash 9a22358); usei os commits acima como antes e depois de cada correção

## Como verifiquei

1. `npm test` no código atual: 1077 testes, 1076 passaram, 1 pulado, 0 falhas (7 min 25 s)
2. Specs Playwright no código atual (Chromium local, porta 4173 liberada antes): manheim-conferencia, aud001-venda, aud001-atualizacao, aud001-tela (14 de 14 passaram); opcoes-cliente, opcoes-todos, opcoes-leilao-passado, manheim-selecao (13 de 13 passaram)
3. Prova histórica "falha antes, passa depois": worktree no commit anterior à correção com a versão do teste trazida pelo commit da correção, e worktree no próprio commit da correção
4. Prova no código atual (mutação): worktree do código atual com a linha da correção desligada, rodando o teste do repositório; se o teste continua passando, ele não protege mais a correção
5. Sondas próprias, só no scratchpad (não entram no repositório): Voltar e reabrir a tela do cliente (A2), atualização sem a pausa (A4) e toque no celular com `hasTouch` em 390 px

## Avaliação cega

Legenda: COBERTO = teste existe, passa hoje e falha sem a correção; COBERTO SEM PROVA = teste existe e passa, mas não consegui mostrar que falha sem a correção no código atual; SEM TESTE = houve mudança no código para o achado e nenhum teste a exercita; NÃO SE APLICA = não há correção para testar (achado aberto, código removido ou refeito, ou depende de decisão da Leo)

| Achado | O que encontrei no código atual | Teste | Passa hoje | Falharia sem a correção | Classificação |
|---|---|---|---|---|---|
| A1 Conferência velha trava a V1 | `state.setSelected` da tela do cliente volta a conferência para Conferindo e dispara `audit-changed` (painel.js:4281 a 4290); "Gerar V1" sempre confere quando o servidor diz pendente (4651) | manheim-conferencia.spec.js:207 "seleção trocada depois de conferida" | Sim | Sim. Antes de fd79328 falhou ("A conferência desta demanda ainda não liberou a V1"), em fd79328 passou. No código atual, desligar a volta para Conferindo faz o teste falhar (recebeu "Conferido") | COBERTO |
| A2 Seleção volta ao retrato antigo | `offer.selectedIds` acompanha a seleção (painel.js:4282) | aud001-venda.spec.js:79 "#57" | Sim | Antes de 9a22358 a versão original falhou ("0 de 10 selecionados") e passou depois. No código atual, sem a linha 4282, o #57 e outros 12 testes de opções continuam passando: reordenar agora recomeça a lista sem recriar a seleção. Minha sonda (selecionar, Voltar, reabrir o cliente) falha sem a linha ("0 de 10 selecionados") e passa com ela | COBERTO SEM PROVA |
| A3 Id de outro membro do VIN | Painel ainda usa `option.id` e ignora `result.matchId` e `selectedCount` (painel.js:3564) | Nenhum | Não se aplica | Não se aplica | NÃO SE APLICA |
| A4 Atualização apaga o trabalho aberto | Pausa da atualização automática com trim ou selecionados abertos (painel.js:6332 a 6343); a tela do cliente fica fora do redesenho da fila | aud001-atualizacao.spec.js:80 | Sim | Sim. Antes de 607644d falhou (7 leituras contra 3 esperadas), depois passou. No código atual, desligar a pausa faz o teste falhar (7 contra 3) | COBERTO |
| A5 Linha dentro de cartão abre duas vezes | `renderManheimOrderGroup` saiu com a fila (b4bcdd2, #218); o guard (painel.js:1826) não mudou | Nenhum | Não se aplica | Não se aplica | NÃO SE APLICA |
| A6 Valor em dólar e Selecionar | `priceBody` igual (painel.js:3558) | aud001-venda.spec.js:105 "#61"; manheim-selecao.spec.js:174 | Sim | Não. O teste passou também antes de 9a22358, como o próprio commit diz ("não reproduzido"); é teste de proteção | COBERTO SEM PROVA |
| A7 "Ver opções" lê duas vezes | `openOptionsCard` ainda chama `switchPanel('searches')`, que sempre carrega, e depois `loadCurrent` de novo (painel.js:1938 a 1940) | Nenhum (opcoes-pedido.test.js:27 só confere o texto da função) | Não se aplica | Não se aplica | NÃO SE APLICA |
| A8 Contador e lista não batem | Fila refeita: lista todos e a aba conta quem tem carro e não recebeu V1 (renderOptionsQueue) | opcoes-todos.spec.js:74 a 76 confere a regra nova (6 na fila, aba 1), mas não é teste de antes e depois | Sim | Não se aplica | NÃO SE APLICA |
| A9 Função pesada três vezes | `panel_manheim_offer_select_v2` (migração 20261022010000, linhas 240 a 320) ainda chama `panel_manheim_grouped_options` 3 vezes; 794ece8 e 7351146 aceleraram o agrupamento sem nenhum teste em tests/ | Nenhum | Não se aplica | Não se aplica | NÃO SE APLICA |
| A10 Página relê base e vitrines; PDF em série | `contextFor` depois da página (manheim-options.js:146), `allRows('vitrines')` sem filtro (62), `selectedOptions` de 50 em 50 em série (painel.js:3290) | Nenhum | Não se aplica | Não se aplica | NÃO SE APLICA |
| B1 Erros sem texto próprio | `v1ErrorText` ganhou MANHEIM_SALE_ENDED (painel.js:4596, 73b679f); `OFFER_ERRORS` (3435) ainda sem ele; VITRINE_VIN_DUPLICATE sem texto | Só o servidor: opcoes-leilao-passado.test.js:50. Nenhum spec mostra o texto na tela | Não se aplica | Não se aplica | SEM TESTE |
| B2 Observação não salva sozinha | Campo `offer-note` sem listener (painel.js:3549) | Nenhum | Não se aplica | Não se aplica | NÃO SE APLICA |
| B3 Reativação | Depende de decisão da Leo | Nenhum | Não se aplica | Não se aplica | NÃO SE APLICA |
| B4 Pedido sem ficha seleciona sem V1 | Seleção continua liberada; a V1 diz "Vincule o pedido a uma ficha para gerar a V1" (painel.js:4643, b4bcdd2); o PDF diz "Não consegui preparar o PDF agora" (4623) | Nenhum teste da mensagem nova | Não se aplica | Não se aplica | SEM TESTE |

Totais: 2 COBERTO (A1, A4), 2 COBERTO SEM PROVA (A2, A6), 2 SEM TESTE (B1, B4), 8 NÃO SE APLICA (A3, A5, A7, A8, A9, A10, B2, B3)

### Exigência extra da AUD-001 para A1 e A2

| Item | Situação nos testes do repositório |
|---|---|
| Seleção | Coberta (manheim-conferencia.spec.js:207, aud001-venda.spec.js:79, opcoes-cliente.spec.js:75) |
| Toque no celular | Sem teste. Nenhum spec das opções usa toque (`hasTouch` ou `tap`); os testes em 390 px usam clique e não trocam a seleção. Minha sonda com toque em 390 px (abrir a tela, selecionar, abrir e fechar o carro, abrir e fechar os selecionados) passou no código atual |
| Abrir e fechar de details | Parcial. opcoes-cliente abre e fecha o carro (hoje um bloco escondido, não details) e abre a lista de selecionados; aud001-atualizacao abre o trim. Nenhum teste fecha um details da tela do cliente |
| Navegação legítima do cartão | Coberta por opcoes-cliente.spec.js:75 (toque na linha abre a tela do cliente e não a ficha, Voltar devolve a fila na mesma posição, "Abrir ficha completa" abre a ficha), fora dos testes específicos de A1 e A2 |

### Pontos para o aprovador

- A2: a correção continua necessária (a sonda de Voltar e reabrir quebra sem ela), mas o teste #57 do repositório deixou de protegê-la depois da tela nova (#253). Um teste de Voltar e reabrir, ou de troca entre "Por valor" e "Por carro", resolveria
- A1: o caso "Revisar, remover o carro" não tem teste próprio; hoje o botão da V1 só depende de haver carro selecionado e a volta para Conferindo é a mesma já coberta. A segunda parte de fd79328 (conferir sempre que o servidor diz pendente) pode ser desligada sem nenhum teste falhar, porque a primeira parte já evita o caso; é proteção dupla, não falha
- A4: sem a pausa, a sonda mostrou que trim, lista e carro aberto continuam abertos depois de 3 recargas, porque a tela do cliente fica fora do redesenho. O teste protege a pausa; a recarga da sincronização (painel.js:357) não passa pela pausa e não tem teste próprio
- A6: o teste #61 não é prova de correção; ele passa antes e depois
- Contagens de produção (A3 e B4) não foram refeitas por qa; ficam com quem consulta o banco nesta AUD-002

## Comparação com o rascunho do executor

- Ordem: a avaliação cega acima foi registrada (commit 2c7c478) antes de eu abrir setores/qa/entregas/AUD-002-executor.md e a pasta aud002-qa-exec. A seção "Avaliação cega" não foi alterada
- Reconferência independente feita nesta etapa, numa cópia do código atual no scratchpad (git archive de 68cc468, igual ao HEAD fora de setores/), com servidor próprio na porta 4517, sem encerrar servidor de ninguém
- Transparência: o executor registrou que o comando de liberar a porta 4173 derrubou o servidor dele no meio de uma rodada. As minhas rodadas da etapa cega usaram esse comando no mesmo horário; é provável que tenha sido eu. Ele descartou aquele resultado e repetiu em porta própria, então não há efeito nos números dele

### Onde concordamos

| Ponto | Executor | Revisor | Evidência |
|---|---|---|---|
| npm test | 1.077 testes, 1.076 passaram, 1 pulado | o mesmo | logs dos dois |
| A1 | COBERTO, com lacunas | COBERTO | os dois fizeram falhar antes de fd79328 e passar em fd79328, e os dois fizeram o teste atual falhar desligando a volta para Conferindo |
| A2 | COBERTO SEM PROVA | COBERTO SEM PROVA | os dois mostraram que o #57 passa sem a correção hoje e que voltar e reabrir a tela do cliente falha sem ela ("0 de 10 selecionados") |
| A4 | COBERTO | COBERTO | os dois: 7 leituras contra 3 antes de 607644d e com a pausa desligada; a recarga da sincronização (painel.js:357) fica sem a trava |
| A3, A9, A10, B2, B3 | NÃO SE APLICA | NÃO SE APLICA | mesmas linhas no código e na migração 20261022010000 |
| Exigência extra de A1 e A2 | seleção e navegação do cartão com teste; toque no celular sem teste; fechar details sem teste | o mesmo | nenhum spec das opções usa `hasTouch` ou `tap` |

### Divergências, com a evidência de cada lado

| Achado | Executor | Revisor (cega) | Reconferência | Posição final do revisor |
|---|---|---|---|---|
| A6 | NÃO SE APLICA: defeito aberto, reproduzido 3 de 3 com rede lenta; o #61 é falso verde | COBERTO SEM PROVA | Minha sonda própria com o #61 trocando "1 dólar a mais" por "500 dólares a mais": 6 de 6 falharam, 3 com o pedido de seleção atrasado 1,5 s e 3 sem atraso nenhum. Digitado US$ 26.771,00, gravado US$ 26.771,40 em todas; o "Selecionar" sai com `"pct":"7"`. Com 1 dólar a mais sai `"pct":null` e o valor fica certo (3 de 3), por isso o #61 passa | Não sustento o meu COBERTO SEM PROVA. O executor está certo: defeito aberto e teste falso verde. Fica NÃO SE APLICA (sem correção a testar). Na cópia local o defeito apareceu também sem atraso; a frequência no uso real não foi medida |
| A8 | Parcial: 2 na aba antes de abrir ENVIAR OPÇÕES, 1 depois | NÃO SE APLICA por código refeito | Sonda própria sobre opcoes-todos.spec.js: 2 antes, 1 depois, 2 de 2 rodadas. Antes de abrir a aba o número vem de `optionsPeopleOf` (painel.js:2149 e 3808, conta `matchCount > 0`, inclusive quem já recebeu V1); depois vem da fila (só quem tem carro e não recebeu V1) | A classificação é a mesma, mas a minha descrição estava incompleta: a divergência entre número e lista continua antes de abrir a aba. O executor está certo; A8 é parcial, não "refeito" |
| A7 | 2 leituras por clique | NÃO SE APLICA, sem medir | Sonda própria em "Ver opções" de BUSCAR CARROS: 2 leituras de `/api/panel/records?view=manheim` por clique, 2 de 2 rodadas | Confirmo a medição dele. Mesma classificação |
| A5 | SEM TESTE: o defeito sumiu com a lista antiga e nenhum teste prova "um clique, uma abertura" | NÃO SE APLICA | Confirmei os fatos dos dois lados: `renderManheimOrderGroup` saiu em b4bcdd2; `guardCardClick` (painel.js:1826) não ignora cartão clicável mais interno; nos usos atuais de `makeCardClickable` e `guardCardClick` (1618, 2472, 3134, 3135, 4055) não achei cartão dentro de cartão | Divergência só de critério, com os mesmos fatos. Mantenho NÃO SE APLICA porque a causa (o guard) não foi corrigida e hoje um teste de "um clique, uma abertura" passaria sem provar nada; aceito que, pela leitura do executor, a remoção do código conta como mudança sem teste. Fica para o aprovador decidir o critério |
| B1 e B4 | NÃO SE APLICA (parcial), com a parte corrigida sem teste de tela | SEM TESTE | Mesmos fatos dos dois lados (B1: texto de MANHEIM_SALE_ENDED só na V1, painel.js:4596; B4: aviso "Vincule o pedido a uma ficha para gerar a V1", painel.js:4643) | Divergência só de rótulo. Mantenho SEM TESTE para deixar visível que a parte já mudada não tem teste de tela |
| buscas-split.spec.js | 2 falhas no código atual (19 e 24-27) | não vi, porque não rodei esse arquivo na etapa cega | Rodei agora: "19 · desktop" falhou 3 de 3 na linha 117 (espera 2 células `.options-queue-demand` no cartão da pessoa com dois pedidos e a linha compacta desenha 1). "24-27 · lote com vários CSVs" falhou 1 vez em 6 ("Desfazendo…" no lugar de "Desfeito") e passou nas outras 5 | Confirmo as duas falhas. A 19 é constante; a 24-27 é intermitente (1 em 6 nas minhas rodadas). Nenhuma das duas é de um achado da AUD-001; a 19 é a que passa por "Ver opções" de A7, mas falha antes desse ponto |

### Afirmações do executor que confirmei

- A1 caso A (demanda em Revisar e seleção trocada): rodei o teste de apoio dele na minha cópia; passa no código atual e, com a volta para Conferindo desligada, falha com o selo parado em "Revisar". O caso A está corrigido e não tem teste no repositório
- A2 voltar e reabrir: mesmo resultado da minha sonda da etapa cega, feita de forma independente
- A6, A7 e A8: confirmados com sondas próprias (detalhes na tabela de divergências)
- Commits de antes e depois: os pais que ele usou (20687cd, fd79328, 083dadc) são os mesmos `fd79328^`, `9a22358^` e `607644d^` que usei
- Linha da correção de A2: ele cita painel.js:4283, e está certo. Na minha avaliação cega escrevi 4282 (A2) e 4284 (A1); as linhas exatas são 4283 (`offer.selectedIds = ...`) e 4285 (volta para Conferindo). Registro a correção aqui sem mexer na seção cega

### Afirmações do executor que não reconferi

- Uso de 77c9352 como equivalente do commit base 7a25ef1 e a conferência das linhas citadas pela AUD-001 nesse commit
- Os testes de manheim-trim.spec.js citados para abrir details e navegação do cartão (155 e 195); eu usei opcoes-cliente.spec.js e aud001-atualizacao.spec.js para os mesmos pontos

### Pendências

- A6: decidir a correção; o #61 precisa usar um valor que mude o percentual, senão continua verde com o defeito presente
- A2: falta no repositório o teste de voltar e reabrir a tela do cliente, que é o caminho que a correção protege hoje
- A1: falta no repositório o teste do caso Revisar
- A1 e A2: faltam teste com toque no celular e teste de fechar details, como a AUD-001 pediu
- A5: o aprovador decide entre NÃO SE APLICA e SEM TESTE; os fatos são os mesmos
- buscas-split.spec.js: a 19 está desatualizada em relação à linha compacta e a 24-27 é intermitente; precisam de dono fora desta auditoria
- Sondas desta etapa (só no scratchpad, fora do repositório): aud002-qa-rev/sondas/zz-a6.spec.js, zz-a7.spec.js e zz-a8.spec.js
