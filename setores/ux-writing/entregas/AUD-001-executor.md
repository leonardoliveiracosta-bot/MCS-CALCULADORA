# AUD-001 · Executor · ux-writing

- Pedido: AUD-001, auditoria do painel (somente achados, sem alterar código, sem commit, sem publicar)
- Papel: Nível 1 Executor
- Agente: executor ux-writing (subagente do fluxo AUD-001)
- Base: main atual em /home/user/MCS-CALCULADORA (commit 7a25ef1)
- Foco do setor: textos que mostram informação errada ou duplicada, rótulos enganosos (celular x computador)
- Banco: não consultado (os achados deste setor saem do código)

## Achados

### 1. "WhatsApp do celular" no computador, que abre o WhatsApp Web
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/sugestoes.js:119 diz "Ao enviar, abre a conversa no WhatsApp do celular"; painel/sugestoes.js:123 cria o link "Abrir no WhatsApp do celular"; painel/painel.js:3406 e 3470 dizem o mesmo na V1. No computador o link vira "No WhatsApp Web" (painel/whatsapp-envio.js:57) e o clique abre web.whatsapp.com (painel/wa-link.js:38 a 41 e 88 a 96). A explicação logo acima do botão promete o celular e o botão faz outra coisa. Os specs travam o texto antigo (tests/sugestoes.spec.js:79 e 156, tests/lote1.spec.js:88)
- Correção sugerida: texto conforme o aparelho, por exemplo "abre a conversa no WhatsApp (Web neste computador, ou no celular pelo QR code)"; no celular manter "no WhatsApp do celular"; atualizar os três specs

### 2. "O envio é feito por você no aplicativo" depois de abrir o WhatsApp Web
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/sugestoes.js:128 ("WhatsApp aberto com o texto · O envio é feito por você no aplicativo") e painel/painel.js:3483 ("WhatsApp aberto com a mensagem · O envio é feito por você no aplicativo"). No computador o clique abre o WhatsApp Web, não o aplicativo
- Correção sugerida: "WhatsApp aberto com a mensagem · Confira e envie por lá"

### 3. Fila de conversas antigas diz "só pelo WhatsApp no celular"
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/sugestoes.js:205 "Janela de 24 h encerrada · API bloqueada: só pelo WhatsApp no celular". No computador o mesmo cartão oferece "No WhatsApp Web" (sugestões compactas usam sendControls e o attach de whatsapp-envio.js). "API" também é jargão interno
- Correção sugerida: "Janela de 24 h encerrada · envio só pelo WhatsApp, fora do painel"

### 4. iPad: botão diz "No WhatsApp Web" e abre o aplicativo
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: duas regras de celular diferentes. painel/wa-link.js:17 a 19 só olha o userAgent (iPad com Safari atual se apresenta como "Macintosh" e cai como computador). painel/whatsapp-app.js:16 a 19 também trata platform MacIntel com toque como celular (testado em tests/whatsapp-app.test.js:24). Resultado no iPad: whatsapp-envio.js:56 a 58 troca o rótulo para "No WhatsApp Web" e põe o botão "No celular" com QR code ("Aponte a câmera do celular"), mas o clique é capturado antes por whatsapp-app.js:26 a 31 e abre whatsapp://, o aplicativo
- Correção sugerida: uma só função isPhone (a de whatsapp-app.js, que reconhece o iPad) usada por wa-link.js e whatsapp-envio.js

### 5. Mesmo envio da V1 com dois horários diferentes na mesma tela
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/painel.js:3351 `clock` usa toLocaleTimeString sem timeZone (fuso do navegador) e 3352 `sameDay` também; o resto do painel usa Flórida (formatDate em painel/painel.js:80). Depois de recarregar, restore (3485 a 3496) mostra "V1 enviada em [data e hora da Flórida]" e chama setVitrine com keepHistory, que pelo showLast (3408 a 3412) escreve "Enviado às [hora do navegador]" na linha de cima. Com o navegador no horário de Brasília, a mesma V1 aparece, por exemplo, como "Enviado às 15:03" e "V1 enviada em 05/10/2026 14:03". Além do horário divergente, é a mesma informação duas vezes
- Correção sugerida: clock e sameDay com timeZone America/New_York; quando o histórico já mostra o envio, não repetir na linha de estado (ou mostrar só uma das duas)

### 6. Dois nomes para o mesmo botão de WhatsApp
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: na V1, attach escreve "No WhatsApp Web" e a linha seguinte sobrescreve com "Abrir no WhatsApp Web" (painel/painel.js:3390 a 3392); nas sugestões fica "No WhatsApp Web". No celular, a V1 diz "Abrir no WhatsApp" e as sugestões dizem "Abrir no WhatsApp do celular" (painel/sugestoes.js:123). O spec tests/whatsapp-envio.spec.js:11 espera "No WhatsApp Web" na V1, mas usa uma página de exemplo (tests/fixtures/whatsapp-envio.html), não o painel.js real, então não pega a diferença
- Correção sugerida: um nome por aparelho em todo o painel ("No WhatsApp Web" e "No celular" no computador, "Abrir no WhatsApp" no celular); remover a sobrescrita da linha 3392 ou aplicá-la também em sugestoes.js

### 7. "Ver as 1 opção"
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/painel.js:4080 monta `Ver as ${item.optionCount} ${... 'opção' : 'opções'}`; com uma opção o botão fica "Ver as 1 opção"
- Correção sugerida: "Ver a opção" quando for 1, "Ver as N opções" quando for mais

### 8. Contador da aba ENVIAR OPÇÕES conta gente que a tela não lista
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: M
- Evidência: o contador da aba (painel/index.html:57, unidade "pessoas com carros no lote") usa optionsPeopleOf (painel/painel.js:3730): toda demanda com matchCount > 0. A lista (painel/painel.js:3791 a 3793) só mostra a demanda de ficha em reativação quando bateCount > 0, e ignora demanda cuja ficha não está em data.items (3790) ou pedido sem ordem (3784 a 3785). Essas demandas não entram em "Com carros no lote" nem em "Sem carros" (3804 filtra matchCount > 0 fora), então somem da tela mas seguem no número da aba. O comentário da 3761 diz "same rule as the counters", o que o código não cumpre
- Correção sugerida: calcular o contador da aba a partir do mesmo filtro que monta a lista (ou listar as que faltam com o motivo)

### 9. Horário da janela de 24 h sem dizer o fuso na V1
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: nas sugestões a janela aparece "até 14:00 (Flórida)" (painel/sugestoes.js:116 e 143); na V1 aparece "Janela de 24 h aberta até [formatDate]" sem fuso (painel/painel.js:3405 e 3443), embora formatDate use Flórida. Quem opera de outro fuso lê o horário errado
- Correção sugerida: acrescentar " (Flórida)" nas duas frases da V1, como nas sugestões

### 10. Aba "TODOS" abre a tela "Clientes"
- Domínio: TELA · Gravidade: OUTRO · Esforço: P
- Evidência: painel/index.html:58 rótulo da aba "TODOS" (unidade "pessoas no período"); a tela que abre se chama "Clientes" (painel/index.html:143). As outras abas repetem o nome no título (BUSCAR CARROS e Buscar carros, ENVIAR OPÇÕES e Enviar opções)
- Correção sugerida: alinhar os dois nomes (por exemplo "CLIENTES" na aba)

## Fora do escopo deste setor (sem verificação aprofundada)
- Nenhuma alegação sobre cliques, consultas lentas ou VIN duplicado: ficam com os setores donos desses domínios
