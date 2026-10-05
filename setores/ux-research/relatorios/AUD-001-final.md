# AUD-001 · ux-research · relatório final do aprovador

- Papel: Nível 3 Aprovador (agente distinto do executor e do revisor)
- Base conferida: main atual (7a25ef1), painel/painel.js, painel/wa-link.js, painel/sugestoes.js, panel-buscas-view.js
- Fontes julgadas: entregas/AUD-001-executor.md e entregas/AUD-001-revisor.md

## 1. O que foi pedido

Auditoria do painel, somente achados, sem alterar código, sem commit e sem publicação, no foco do setor: pontos em que o operador se perde (clique que navega sem querer, tela que volta ao topo, trabalho que some da tela). Cada achado com domínio, gravidade, esforço, evidência concreta e correção sugerida

## 2. O que foi entregue

Executor: 4 achados (E1 a E4), com medição em Playwright para E1, E2 e E3 em specs descartáveis fora de tests/
Revisor: avaliação cega com 5 achados (A1 a A5), depois comparação; retirou A4 por conta própria e sustentou os demais e os quatro do executor

Achados aprovados, todos conferidos por mim no código

1. Linha de carro clicável dentro de cartão clicável abre o pedido duas vezes (E4 = A1)
   - CLIQUES · QUEBRA_CLIQUE · esforço P
   - painel/painel.js:3716 `makeCardClickable(row, ...)` e 3724 `makeCardClickable(card, ...)`, mesma ação openDetail('order'); o ouvinte de clique do guard (1741 a 1750) não para a propagação; openDetail (2220 a 2226) faz replaceState e pushState a cada chamada, e na segunda captureOrigin lê a rolagem com a lista já escondida por showDetailShell (2211 a 2216). A linha só existe quando não há seleção para o cliente (3721 a 3723; offer null em panel-buscas-view.js:216)
   - Correção: tirar o makeCardClickable da linha ou, no guard, ignorar o clique quando o cartão clicável mais interno não é o próprio cartão. Spec deve contar history.length e chamadas a /api/panel/lead
2. Redesenho de ENVIAR OPÇÕES fecha os grupos abertos, perde a mensagem editada e pula a rolagem (E2 junto com A2)
   - VENDAS · QUEBRA_CLIQUE · esforço M
   - Duas portas para o mesmo defeito: atualização automática chama loadCurrent() (5518) e não refreshCurrentPreservingState (2064 a 2068); depois do sync de opções, `if (synced && ...) loadCurrent()` (339) roda sem isBusy, e cada carga da aba agenda outro sync (1946). renderManheim refaz as colunas com root.replaceChildren() (3778) e os grupos nascem fechados (offerGroup, 3220)
   - Correção: não redesenhar searches enquanto houver offer-group aberto, V1 com texto editado ou foco em campo (mostrar aviso para atualizar), e quando redesenhar usar refreshCurrentPreservingState; as duas portas no mesmo ajuste
3. Atualização automática apaga a seleção de cartões e fecha "⋯ Mais" em ATENDIMENTO (E1 = A3)
   - CLIQUES · QUEBRA_CLIQUE · esforço M
   - Seleção só existe no DOM (pickBox, 2578 a 2583); renderToday faz root.replaceChildren() (2665); isBusy é operatorIsTyping (5482 a 5487), que exclui checkbox; além do intervalo de 2 min, a lista é redesenhada sozinha quando chegam os pedidos incompletos (1930) e em scheduleAttendRender (2473 a 2477). Medição do executor: 1 caixa marcada passou a 0
   - Correção: guardar as chaves selecionadas e os "⋯ Mais" abertos num Set fora do DOM e reaplicar no fim de renderToday, e contar caixa marcada ou details aberto como ocupado no isBusy
4. "Abrir no WhatsApp Web" da V1 e dos cartões de sugestão ignora a aba única do WhatsApp (E3)
   - VENDAS · QUEBRA_CLIQUE · esforço P
   - wa-link.js escuta no document em bolha (painel/wa-link.js:87); o bloco da V1 para toda propagação (painel/painel.js:3484) e o link fica dentro dele (3382, 3383); sugestoes.js:47 e 274 fazem o mesmo nos cartões. O clique nunca chega ao document e o link abre aba nova. Medição do executor confirma
   - Correção: wa-link escutar na fase de captura, ou trocar esses stopPropagation por uma marca que o guard do makeCardClickable respeite, sem reabrir o caso A4 (vão do bloco da V1 abrindo a ficha)
5. Abrir o cartão de opções a partir de outra tela lê a mesma visão duas vezes (A5)
   - DADOS · OUTRO · esforço P
   - switchPanel já espera loadCurrent (painel/painel.js:643) e openOptionsCard chama loadCurrent de novo (1850, 1851); o mesmo em 3766 e no openTab da ficha (2237). A carga de searches usa request direto (1942), sem reaproveitamento: duas leituras de /api/panel/records?view=manheim, dois desenhos e dois agendamentos de sync
   - Correção: remover o loadCurrent extra nesses três pontos

## 3. Divergências encontradas

- Gravidade do item 2: executor disse QUEBRA_CLIQUE, revisor disse BLOQUEIA_VENDA porque a V1 gerada some do cartão. Conferi: depois do redesenho a V1 mais recente volta do servidor (latestV1For e restore, painel/painel.js:3629 e 3486 a 3496) e a seleção para o cliente é lida do servidor (selectedIds, 3509). O que se perde é o grupo aberto, a rolagem e o texto editado da mensagem. A venda continua possível, com retrabalho. Decido QUEBRA_CLIQUE
- A4 do revisor (vão do bloco da V1 abre a ficha): retirado pelo próprio revisor; confirmo a retirada, o nó v1-send para a propagação (3484), então o clique não chega ao cartão
- Itens só de um lado: E3 só do executor, A2 e A5 só do revisor; todos sustentados no código
- Pendência comum: itens 1, 2 (porta do sync) e 5 sem reprodução em navegador; a correção deve começar pelo spec Playwright que falha antes
- Item 5 tem gravidade OUTRO, mas entra na lista de correção imediata do comando da Leo (leituras duplicadas); por isso fica marcado para corrigir agora

## 4. Decisão do aprovador

- Aprovados: itens 1 a 5
- Rejeitado: A4 do revisor (refutado no código)
- Corrigir agora: 1, 2, 3 e 4 (quebram clique, esforço P ou M) e 5 (leitura duplicada, item 3 do comando, esforço P)
- Nada vai para backlog neste setor
- Esta decisão não substitui a aprovação da Leo
