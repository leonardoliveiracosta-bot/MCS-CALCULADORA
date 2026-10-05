## 1. O que foi pedido

AUD-001: auditoria do painel My Car Scout, somente achados, sem alterar código, sem commit e sem publicar
Caçar achados com evidência em quatro domínios (cliques, tela, dados, vendas), cada um com título, domínio, gravidade, esforço, evidência e correção sugerida
Foco deste setor: textos e rótulos que mostram informação errada ou duplicada, ou que atrapalham o fluxo de vender (seleção, V1, WhatsApp)
Base conferida: main no commit 7a25ef1

## 2. O que foi entregue

O executor (Nível 1) entregou 10 achados em setores/ux-writing/entregas/AUD-001-executor.md
O revisor (Nível 2) registrou 9 achados na avaliação cega e depois comparou com o rascunho em setores/ux-writing/entregas/AUD-001-revisor.md, sem refutar nenhum achado e corrigindo números de linha

O aprovador (Nível 3) conferiu cada evidência no código, linha por linha. Resultado

| Id | Achado | Domínio | Gravidade | Esforço | Corrigir agora |
|---|---|---|---|---|---|
| A1 (E1 = R1) | "WhatsApp do celular" no computador, onde o botão abre o WhatsApp Web | VENDAS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A2 (E2 = R2) | "O envio é feito por você no aplicativo" depois de abrir o WhatsApp Web | VENDAS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A3 (E3 + R9) | Fila de conversas antigas: "API bloqueada: só pelo WhatsApp no celular" | VENDAS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A4 (E4) | iPad: rótulo "No WhatsApp Web" e QR code, mas o clique abre o aplicativo | VENDAS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A5 (E5) | Mesmo envio da V1 com dois horários diferentes na mesma tela | VENDAS | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A6 (E7) | Botão "Ver as 1 opção" | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A7 (E8) | Contador da aba ENVIAR OPÇÕES conta pessoas que a tela não lista | TELA | INFO_ERRADA_OU_DUPLICADA | M | sim |
| A8 (R4) | Mesmo aviso duas vezes no cartão de opções ("acima do valor informado") e badges de MMR repetidos | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A9 (R5) | Grupo com filtro de trim salvo mostra "(25 de 25)" antes de abrir | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A10 (R6) | Contagem do grupo repetida três vezes no mesmo cartão | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A11 (R7, parte) | Cartão Realidade repete o total no veredito e no rótulo | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| A12 (E6 = R3) | Dois nomes para o mesmo botão de WhatsApp | VENDAS | OUTRO | P | não, backlog |
| A13 (E9) | Horário da janela de 24 h sem "(Flórida)" na V1 | VENDAS | OUTRO | P | não, backlog |
| A14 (E10) | Aba "TODOS" abre a tela "Clientes" | TELA | OUTRO | P | não, backlog |
| A15 (R8) | Travessão em textos de interface | TELA | OUTRO | P | não, backlog |

Evidências confirmadas pelo aprovador

- A1: painel/painel.js:3348, 3406 e 3470 e painel/sugestoes.js:89, 119 e 123 falam em "WhatsApp do celular"; no computador painel/whatsapp-envio.js:57 troca o rótulo para "No WhatsApp Web" e painel/wa-link.js:85 a 93 abre web.whatsapp.com. Os specs tests/sugestoes.spec.js e tests/lote1.spec.js precisam acompanhar a troca
- A2: painel/sugestoes.js:128 e painel/painel.js:3483
- A3: painel/sugestoes.js:205; o cartão passa pelo mesmo attach de whatsapp-envio.js (sugestoes.js:133). "API" é jargão para quem opera
- A4: painel/wa-link.js:17 a 19 reconhece celular só pelo userAgent; painel/whatsapp-app.js:16 a 19 também aceita MacIntel com toque e, em captura (26 a 31), faz preventDefault e abre whatsapp://; o listener de wa-link.js:88 sai por defaultPrevented. Rótulo e QR dizem computador, o clique abre o aplicativo
- A5: painel/painel.js:3350 e 3351 (clock e sameDay sem fuso) contra formatDate em painel/painel.js:80 (Flórida); restore (3487 a 3496) escreve "V1 enviada em" em Flórida e chama setVitrine(token, true), que termina em showLast (3441) com "Enviado às" no fuso do navegador
- A6: painel/painel.js:4080, com 1 opção o texto vira "Ver as 1 opção"
- A7: optionsPeopleOf (painel/painel.js:3730) conta toda demanda com matchCount > 0; a lista descarta pedido sem ordem (3784 a 3785), ficha ausente (3790) e ficha em reativação com bateCount 0 (3792), e "Sem carros" (3804) só pega matchCount 0. O comentário da 3761 ("same rule as the counters") não vale. Quantidade real em produção não medida
- A8: vehicle-match.js:167 grava reason e notice com o mesmo texto; panel-manheim-batch.js:114 e 118 guardam em matchNotice e em match_reason; painel/painel.js:3584 e 3586 (e 3708 e 3710) desenham os dois. No caminho novo, offerFit (painel/painel.js:3076) junta match_reason e matchNotice sem tirar repetição, então o mesmo texto também sai duas vezes na linha "Atende ao pedido · acima do valor informado · acima do valor informado"
- A9: painel/painel.js:3241 inicia filteredTotal = count e 3337 chama paintTrims, que escreve `(${filteredTotal} de ${count})` (3253) antes de qualquer leitura
- A10: painel/painel.js:3512 (contador "25 em Lane/Run"), 3224 (resumo "Passa em Lane/Run (25)") e 3227 (botão "Ver opções (25)")
- A11: panel-reality.js:36 (veredito "142 opções no lote") e 38 (rótulo "Opções no lote · 142 (mostrando 80)"), desenhados em painel/lead.js:153 e 156
- A12: painel/painel.js:3390 a 3392 sobrescreve o rótulo de attach com "Abrir no WhatsApp Web"; sugestoes.js:123 usa "Abrir no WhatsApp do celular" no celular
- A13: painel/painel.js:3405 e 3452 sem "(Flórida)"; painel/sugestoes.js:116 e 143 com
- A14: painel/index.html:58 e 143
- A15: painel/painel.js:1760 e 1767 ("Desligado — religar"), painel/painel.js:3565 ("Parado — reativar"), painel/lead.js:14 (cabeçalhos dos cartões)

Correções sugeridas (para o executor da Fase 2, sem código nesta etapa)

- A4 primeiro: uma só regra de celular (a de whatsapp-app.js, que reconhece o iPad) usada por wa-link.js e whatsapp-envio.js; sem isso, A1 a A3 ficam errados no iPad
- A1 e A3: texto conforme o aparelho; no computador "abre a conversa no WhatsApp Web, ou no celular pelo QR code"; no celular manter "no WhatsApp do celular"; na fila, "Janela de 24 h encerrada · o painel não envia, abra no WhatsApp"
- A2: texto neutro "WhatsApp aberto com a mensagem · Confira e envie por lá" nos dois lugares
- A5: clock e sameDay com timeZone America/New_York; quando o histórico já mostra o envio, não repetir na linha de estado
- A6: "Ver a opção" com 1, "Ver as N opções" com mais
- A7: contador da aba calculado pelo mesmo filtro que monta a lista
- A8: não mostrar matchNotice quando igual a match_reason, no caminho antigo e em offerFit; no caminho antigo, não mostrar o badge de mmr_status quando fitsBid já existe
- A9: com trim salvo e grupo fechado, mostrar só o total do grupo com a nota "filtro de trim ativo" até a primeira leitura
- A10: contador só com "N de 10 selecionados"; número de cada grupo só no resumo do grupo; botão "Ver opções" sem número
- A11: rótulo "Opções no lote" sem o total, mantendo "mostrando 80" quando houver corte

## 3. Divergências encontradas

| Ponto | Executor | Revisor | Evidência e decisão do aprovador |
|---|---|---|---|
| Gravidade da fila de conversas antigas (A3) | INFO_ERRADA_OU_DUPLICADA | OUTRO na avaliação cega (jargão), depois aderiu ao executor | A frase manda ao celular e o botão do mesmo cartão abre o WhatsApp Web (sugestoes.js:205 e 133). Fica INFO_ERRADA_OU_DUPLICADA |
| Texto depois do clique (A2) | Texto neutro | Texto por aparelho | Texto neutro, porque não depende da regra de celular que hoje diverge (A4) |
| R4 e offerFit | Não trouxe | Disse que offerFit já evita a repetição no caminho novo | Refutado em parte: offerFit (painel/painel.js:3076) tira só o que fala de MMR e ainda junta match_reason e matchNotice, que em BATE fora do orçamento são o mesmo texto (vehicle-match.js:167). A repetição existe também no caminho em uso com seleção; a correção cobre os dois |
| R7, "Ver mais" que promete menos | Não trouxe | Achado | Rejeitado: o rótulo já diz "(mostrando 80)" (panel-reality.js:38) logo acima da lista, então "Ver mais (70)" não esconde o corte. Fica aprovada só a repetição do total |
| Números de linha (E5, R6, R7) | 3351 e 3352 | 3350 e 3351; 3512; lead.js:13 | Conferido no main 7a25ef1: valem os números do revisor |

Nenhuma alegação sem evidência ficou no relatório. A medição de quantas pessoas caem no vão de A7 continua pendente, sem impedir a correção

## 4. Decisão do aprovador

Aprovados para correção imediata (informação errada ou duplicada, esforço P ou M): A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, com A4 antes de A1 a A3
Aprovados para o backlog (gravidade OUTRO): A12, A13, A14, A15, todos de esforço P, em ordem de impacto na venda: A12, A13, A15, A14
Rejeitado: a parte de R7 sobre "Ver mais" prometer menos do que existe
Toda correção da Fase 2 precisa atualizar os specs que travam o texto antigo (tests/sugestoes.spec.js, tests/lote1.spec.js, tests/manheim-trim.spec.js quando mexer no resumo do grupo) e passar por novo revisor cego e aprovador
Esta decisão não substitui a aprovação da Leo
