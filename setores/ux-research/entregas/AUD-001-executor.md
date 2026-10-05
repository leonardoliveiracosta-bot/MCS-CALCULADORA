# AUD-001 · ux-research · rascunho do executor

- Pedido: AUD-001, auditoria do painel (somente achados, sem mudar código, sem commit, sem publicar)
- Papel: Nível 1 Executor
- Agente: executor ux-research (subagente da orquestração AUD-001)
- Base: main atual (7a25ef1)
- Foco do setor: pontos em que o operador se perde (clique que navega sem querer, volta ao topo, tela que some)
- Não li o arquivo do revisor nem de outro setor antes de gravar este rascunho

## Como foi verificado

- Leitura do código: os 9 usos de makeCardClickable (painel/painel.js 1424, 1529, 2615, 2770, 2857, 3664, 3716, 3724, 4905), o guard em painel/painel.js:1732-1751 e os listeners de clique de painel/*.js (111 em painel.js)
- Medição com Playwright em Chromium local, specs descartáveis no scratchpad (fora de tests/), dados fictícios, sem tocar em produção
- Controles conhecidos pelo guard: button, input, select, textarea, a, label, details, summary. Procurei role="button", contenteditable e cliques em span ou div dentro de cartão: não achei nenhum controle fora dessa lista dentro de cartão clicável (sem achado aqui)
- Clique no texto de um carro dentro do grupo de opções aberto (ENVIAR OPÇÕES): não navegou (hash continuou vazio), o guard segura porque o grupo é um details

## Achados

### 1. Atualização automática apaga a seleção de cartões e fecha o "⋯ Mais" em ATENDIMENTO
- Domínio: CLIQUES
- Gravidade: QUEBRA_CLIQUE
- Esforço: M
- Evidência:
  - renderToday faz root.replaceChildren() e redesenha todos os cartões (painel/painel.js:2661-2665); a seleção existe só na classe case-picked e no checkbox do cartão (painel/painel.js:2578-2583), não há estado guardado fora do DOM
  - O redesenho acontece na atualização automática a cada 2 min (painel/painel.js:5491 e 5518, run chama loadCurrent, que chama applyAttend e renderToday), em toda ação que chama scheduleAttendRender (painel/painel.js:2473-2477) e duas ou três vezes ao abrir a aba (cópia salva, resposta fresca e chegada dos pedidos incompletos, painel/painel.js:1918-1932)
  - isBusy só segura a atualização quando há digitação (painel/painel.js:5482-5487); marcar caixa ou abrir "⋯ Mais" não conta
  - Medição: cartão marcado, 1 caixa marcada; depois de uma atualização automática (intervalo encurtado para o teste), 0 caixas marcadas. "Excluir selecionados" perde a escolha do operador sem aviso
- Correção sugerida: guardar as chaves selecionadas (entry.key) e os "⋯ Mais" abertos num Set fora do DOM e reaplicar no fim de renderToday; contar caixa marcada ou details aberto como "ocupado" no isBusy

### 2. Atualização automática em ENVIAR OPÇÕES fecha o grupo aberto, some com os carros e pula a rolagem
- Domínio: VENDAS
- Gravidade: QUEBRA_CLIQUE
- Esforço: M
- Evidência:
  - renderManheim redesenha as duas colunas com root.replaceChildren() (painel/painel.js:3782-3784); os grupos (details offer-group) nascem fechados e sem linhas (painel/painel.js:3220-3229, carregam só ao abrir, 3316)
  - A atualização automática chama loadCurrent() e não refreshCurrentPreservingState, então não guarda nem devolve a rolagem (painel/painel.js:5518 comparado com 2064-2068)
  - Medição: grupo Lane/Run aberto com 10 carros e um carro selecionado para o cliente, tela rolada até ele; depois de uma atualização automática: 0 grupos abertos, 0 linhas de carro na tela, rolagem de 5338 para 2285. O operador está no meio de escolher carros para a V1 e perde o lugar
- Correção sugerida: não redesenhar a visão searches na atualização automática enquanto houver offer-group aberto ou bloco V1 com link gerado; ou guardar demanda e grupo abertos (com ordem e trim) e reabrir depois do redesenho, usando refreshCurrentPreservingState no lugar de loadCurrent

### 3. "Abrir no WhatsApp Web" da V1 e das sugestões ignora a aba única do WhatsApp no computador
- Domínio: VENDAS
- Gravidade: QUEBRA_CLIQUE
- Esforço: P
- Evidência:
  - wa-link.js escuta o clique no document na fase de bolha para abrir todo link wa.me na aba "mcs-whatsapp" (painel/wa-link.js:84-93)
  - O bloco de envio da V1 para a propagação de qualquer clique dentro dele: node.addEventListener('click', (event) => event.stopPropagation()) (painel/painel.js:3484); o link fica dentro dele com target _blank (painel/painel.js:3382-3383, 3388)
  - O mesmo acontece no cartão de sugestão e no de resposta orientada (painel/sugestoes.js:47 e 274), que têm o link "Abrir no WhatsApp" (painel/sugestoes.js:123)
  - Medição (Chromium, wa-link.js real): link fora do bloco abriu web.whatsapp.com na aba "mcs-whatsapp"; o mesmo link dentro de um bloco com stopPropagation abriu wa.me numa aba nova sem nome. Cada envio abre outra aba e o WhatsApp Web reclama de estar aberto em outra janela
  - tests/v1-envio.spec.js:94 só confere o href, não onde o link abre
- Correção sugerida: wa-link escutar na fase de captura (como whatsapp-app.js:26 já faz no celular) ou trocar o stopPropagation desses blocos por uma marca no evento que o makeCardClickable respeite

### 4. Linha de carro clicável dentro de cartão clicável abre o pedido duas vezes e o Voltar cai no topo
- Domínio: CLIQUES
- Gravidade: QUEBRA_CLIQUE
- Esforço: P
- Evidência:
  - Em renderManheimOrderGroup a linha recebe makeCardClickable(row, ...) (painel/painel.js:3716) e o cartão que a contém também (painel/painel.js:3724)
  - O guard não para a propagação (painel/painel.js:1741-1750): o clique na linha chama openDetail e sobe ao cartão, que chama openDetail de novo
  - A primeira chamada esconde as listas (showDetailShell, painel/painel.js:2210-2216); a segunda chama captureOrigin, que lê window.scrollY já encolhido, faz replaceState na entrada da ficha recém aberta e empilha outra (painel/painel.js:2222-2226 e 2072-2075). Resultado esperado: o Voltar restaura a origem com rolagem perto de zero e é preciso voltar duas vezes
  - Alcance: só acontece no caminho sem seleção para o cliente (demand.offer ausente ou pendente, painel/painel.js:3721-3723); com a seleção ligada a linha não é desenhada. Não medi em navegador
- Correção sugerida: tirar o makeCardClickable da linha (o cartão já abre o mesmo pedido) ou, no guard, ignorar um clique já tratado por um cartão interno (marca no evento)

## Pendências

- Achado 4 sustentado só por leitura do código; falta reprodução em Playwright
- Não medi o efeito da atualização automática em CLIENTES e na ficha aberta
