# AUD-001 · ux-writing · Nível 2 Revisor independente

Pedido: AUD-001, auditoria do painel, somente achados, sem alterar código
Base: main atual (commit 7a25ef1), leitura de painel/*.js, manheim-offer.js, vehicle-match.js, panel-reality.js, panel-manheim-batch.js, api/panel/manheim-options.js, painel/identidade.css e tests/manheim-trim.spec.js
Ordem: avaliação cega registrada abaixo antes de abrir o rascunho do executor (AUD-001-executor.md não foi aberto)

## Avaliação cega

### R1 · Texto da janela fechada diz "WhatsApp do celular" no computador
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/painel.js:3406 (V1, janela encerrada) diz "ao enviar, abre a conversa no WhatsApp do celular com a mensagem e você envia por lá"; painel.js:3348 (OFF) e 3470 (WINDOW_CLOSED) repetem "abra no WhatsApp do celular"; painel/sugestoes.js:89, 119 e 205 fazem o mesmo ("só pelo WhatsApp no celular"). No computador, wa-link.js:43 troca o link para web.whatsapp.com e whatsapp-envio.js:57 renomeia o botão para "No WhatsApp Web" e põe "No celular" ao lado. Resultado no computador: a frase manda ao celular, o botão principal abre o WhatsApp Web
- Correção: texto por aparelho com MCSWaLink.isPhone: no computador "abre a conversa no WhatsApp Web ou no celular pelo QR code"; no celular manter "no WhatsApp do celular". Uma função única de texto usada por painel.js e sugestoes.js

### R2 · Aviso depois do clique diz "no aplicativo" quando abriu o WhatsApp Web
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/sugestoes.js:128 escreve "WhatsApp aberto com o texto · O envio é feito por você no aplicativo" no clique de "No WhatsApp Web" (no computador o link vira web.whatsapp.com, wa-link.js:113)
- Correção: no computador "WhatsApp Web aberto com o texto · O envio é feito por você na aba do WhatsApp"

### R3 · Mesmo botão com dois nomes: "Abrir no WhatsApp Web" na V1 e "No WhatsApp Web" nas sugestões
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: whatsapp-envio.js:57 define "No WhatsApp Web" e painel.js:3392 sobrescreve logo depois com "Abrir no WhatsApp Web" só na V1; nas sugestões fica "No WhatsApp Web" ao lado de "No celular"
- Correção: um nome só, decidido em whatsapp-envio.js, e remover a sobrescrita em painel.js:3392

### R4 · Badges repetidos no cartão de opções (caminho sem seleção para o cliente)
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: vehicle-match.js:167 grava em BATE reason igual a notice ("acima do valor informado"); panel-manheim-batch.js:114 e 118 guardam o mesmo texto em parsed.matchNotice e em match_reason; painel.js:3584 e 3586 (e 3708 e 3710 no cartão de pedido) desenham os dois, o mesmo texto aparece duas vezes. Em POR_VALOR, painel.js:3587 mostra "MMR acima do lance" (mmr_status) e 3589 mostra "MMR acima do lance · dentro da faixa de valor..." (fitsBid, api/panel/manheim-options.js:85); com MMR menor, "MMR dentro do lance" e "cabe no lance" dizem a mesma coisa. Esse caminho aparece quando o pedido não tem seleção (demand.offer ausente, panel-buscas-view.js:216 e 218). offerFit (painel.js:3076) já evita a repetição no caminho novo
- Correção: no caminho antigo, aplicar a mesma regra de offerFit: não mostrar matchNotice quando igual a match_reason, e não mostrar o badge de mmr_status quando fitsBid já existir

### R5 · Grupo com filtro de trim salvo mostra "(25 de 25)" antes de abrir
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel.js:3241 inicia filteredTotal = count; painel.js:3337 chama paintTrims quando há trim salvo, e paintTrims (3253) escreve `${groupLabel} (${filteredTotal} de ${count})`, ou seja "Passa em Lane/Run (25 de 25)" com o grupo fechado, embora o filtro reduza a lista. O botão diz "Ver opções (25)" e o resumo "Trim (2)" fica escondido (trimBox.hidden = true até a primeira página). O spec tests/manheim-trim.spec.js:118 e 119 só confere o texto depois de abrir o grupo
- Correção: com trim salvo e grupo fechado, escrever "Passa em Lane/Run (25) · filtro de trim ativo" até a primeira página, ou buscar só o total filtrado na abertura da visão

### R6 · Contagem do grupo repetida três vezes no mesmo cartão
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel.js:3511 escreve "25 em Lane/Run · 5 em Buy Now / Make Offer · 1 de 10 selecionados"; logo abaixo cada grupo repete no resumo "Passa em Lane/Run (25)" (3224) e no botão "Ver opções (25)" (3227)
- Correção: deixar no contador só "1 de 10 selecionados" e o número de cada grupo no resumo do grupo; botão "Ver opções" sem número

### R7 · Cartão Realidade: total repetido e "Ver mais" que promete menos do que existe
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: panel-reality.js:36 e 38 põem o total no veredito ("142 opções no lote") e de novo no rótulo ("Opções no lote · 142 (mostrando 80)"); lead.js:163 limita a 10 e mostra "Ver mais (70)", que abre só até 80 sem dizer que as outras 62 não aparecem em lugar nenhum
- Correção: rótulo sem o número ("Opções no lote"), e o botão "Ver mais 70 de 132 restantes" ou nota "a lista mostra os 80 primeiros por ano e milhas"

### R8 · Travessão em textos de interface
- Domínio: TELA · Gravidade: OUTRO · Esforço: P
- Evidência: painel.js:1760 e 1767 "Desligado — religar"; lead.js:14 cabeçalhos "5 — REALIDADE · SÓ PARA VOCÊ"; lead.js:81 "Nome — Ref"; lead.js:28, 37, 90, 294, 417; painel.js:390, 1133, 1334. A regra do setor proíbe travessão
- Correção: trocar por " · " (os "—" usados como valor vazio podem ficar como "não informado")

### R9 · "API bloqueada" é jargão para quem opera
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: painel/sugestoes.js:205 "Janela de 24 h encerrada · API bloqueada: só pelo WhatsApp no celular"; painel.js:3452 "o envio sai pela API"
- Correção: "Janela de 24 h encerrada · o painel não envia, abra no WhatsApp" e "o envio sai pelo painel"

Sem achado sustentado nesta revisão: o botão "No celular" da V1 não aparece com o link escondido (identidade.css:984 esconde .wa-phone quando o link tem .hidden)

## Comparação com o rascunho do executor

Pendente: será acrescentada depois desta avaliação cega, sem alterar o texto acima

## Comparação com o rascunho

Feita depois da avaliação cega, com o rascunho AUD-001-executor.md aberto. Cada achado foi conferido de novo no código (main 7a25ef1), tentando refutar.

### Concordâncias (os dois lados acharam)
- E1 = R1 · "WhatsApp do celular" no computador: SUSTENTADO. painel.js:3406, 3348, 3470 e sugestoes.js:89, 119, 123 confirmados; no computador whatsapp-envio.js:57 troca o rótulo e wa-link.js:38 a 41 troca o link. O executor acrescenta que os specs tests/sugestoes.spec.js e tests/lote1.spec.js travam o texto antigo; a correção precisa atualizá-los
- E2 = R2 · "no aplicativo" depois de abrir o WhatsApp Web: SUSTENTADO. O executor achou também o caso da V1 (painel.js:3483, "O envio é feito por você no aplicativo"), que a avaliação cega não listou; vale para os dois lugares
- E3 = R9 (em parte) e R1 · fila de conversas antigas: SUSTENTADO. sugestoes.js:205 confirmado; o cartão usa box(... compact) que passa por sendControls e attach (sugestoes.js:133), então no computador o botão é "No WhatsApp Web". Mesma correção de R1 e R9
- E6 = R3 · dois nomes para o mesmo botão: SUSTENTADO. painel.js:3390 a 3392 sobrescreve o rótulo de attach; sugestoes.js:123 usa "Abrir no WhatsApp do celular" no celular. O executor amplia para o rótulo do celular, correto

### Achados só do executor
- E4 · iPad diz "No WhatsApp Web" e abre o aplicativo: SUSTENTADO. wa-link.js:17 a 19 só olha userAgent; whatsapp-app.js:16 a 19 também aceita MacIntel com toque; whatsapp-envio.js:8 usa a regra de wa-link. No iPad, whatsapp-app.js:26 a 31 instala o clique em captura e faz preventDefault; o clique de wa-link.js (bolha) sai cedo por defaultPrevented. Rótulo e QR dizem computador, o clique abre o aplicativo
- E5 · V1 com dois horários na mesma tela: SUSTENTADO. painel.js:3350 e 3351 (clock e sameDay) sem timeZone; formatDate (80) usa America/New_York; restore (3487 a 3496) mostra o histórico e setVitrine(token, true) pode chamar showLast. Divergência só na numeração: o rascunho cita 3351 e 3352, no main as linhas são 3350 e 3351
- E7 · "Ver as 1 opção": SUSTENTADO. painel.js:4080 monta `Ver as ${item.optionCount} ${... 'opção' : 'opções'}` sem tratar o singular do artigo
- E8 · contador da aba ENVIAR OPÇÕES conta quem a tela não lista: SUSTENTADO no código. optionsPeopleOf (3730) usa matchCount > 0; a lista descarta pedido sem ordem (3784 a 3785), ficha fora de data.items (3790) e ficha em reativação com bateCount 0 (3792); e "Sem carros" (3804) só pega matchCount 0. O comentário da 3761 ("same rule as the counters") não vale. Não medido em produção quantas pessoas caem nesse vão
- E9 · horário da janela sem fuso na V1: SUSTENTADO. painel.js:3405 sem "(Flórida)"; sugestoes.js:116 e 143 com
- E10 · aba "TODOS" abre "Clientes": SUSTENTADO. index.html:58 e 143. Gravidade OUTRO, concordo

### Achados só do revisor (o executor não trouxe)
- R4 · badges repetidos no caminho sem seleção: mantido, não refutado nesta releitura
- R5 · "(25 de 25)" com trim salvo e grupo fechado: SUSTENTADO. painel.js:3241 (filteredTotal = count) e 3253 (paintTrims) confirmados
- R6 · contagem do grupo três vezes: SUSTENTADO. painel.js:3512 (contador; a avaliação cega citou 3511) e resumo e botão do grupo
- R7 · Realidade com total repetido e "Ver mais" que promete menos: SUSTENTADO. panel-reality.js:36 e 38, MAX_ROWS = 80 (linha 18); correção de citação: o "Ver mais" é definido em lead.js:13 (limitList) e chamado em lead.js:163
- R8 · travessão em textos de interface: mantido; é regra de texto do setor, gravidade OUTRO
- R9 · "API bloqueada" como jargão: SUSTENTADO; coincide em parte com E3

### Refutados
- Nenhum achado de nenhum lado foi refutado. Ajustes só de número de linha (E5, R6, R7)

### Divergências
- E3 x R9: o executor classifica como INFO_ERRADA_OU_DUPLICADA (texto manda ao celular, o botão abre o Web); a revisão tinha como OUTRO (jargão). Fico com a gravidade do executor, porque a frase é falsa no computador
- E2: o executor propõe texto neutro ("Confira e envie por lá"), a revisão propõe texto por aparelho. Os dois resolvem; o neutro é menor e não depende de isPhone, preferível enquanto E4 não for corrigido
- E4 deve ser corrigido antes ou junto de R1, E1 e E2: textos por aparelho com a regra atual de wa-link.js ficariam errados no iPad
