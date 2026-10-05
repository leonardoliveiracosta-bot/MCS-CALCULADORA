# AUD-001 · ux-research · Nível 2 Revisor independente

Pedido: AUD-001, auditoria do painel, somente achados (sem alterar código, sem commit, sem publicação)
Foco do setor: pontos em que o operador se perde (clique que navega sem querer, volta ao topo, tela que some)
Ordem das etapas: avaliação cega registrada abaixo ANTES de abrir o rascunho do executor (AUD-001-executor.md não foi aberto)
Base lida: painel/painel.js (main atual, depois de 77c9352 e 29e1bd9), painel/action.js, painel/whatsapp-envio.js, painel/wa-link.js, painel/contexto.js, painel/grupos.js, painel/sugestoes.js, panel-buscas-view.js, api/panel/manheim-options.js
Método: leitura de código com linha e trecho; nenhum teste foi rodado e nenhum dado de produção foi lido nesta etapa

## Avaliação cega

### A1. Linha de carro clicável dentro de cartão clicável abre o pedido duas vezes e o Voltar leva ao topo
- Domínio: CLIQUES · Gravidade: QUEBRA_CLIQUE · Esforço: P
- Evidência: painel/painel.js:3716 `makeCardClickable(row, () => openDetail('order', order.ref))` e painel/painel.js:3724 `makeCardClickable(card, () => openDetail('order', order.ref))`. A linha fica dentro do cartão quando o pedido não tem seleção (`card.append(orderSelection || table, ...)`, 3722; `offer` vem null em panel-buscas-view.js:216 quando a seleção não pôde ser lida). O ouvinte da linha não para a propagação, então o mesmo clique roda openDetail duas vezes.
- Efeito: openDetail (2220) faz pushState nas duas chamadas; na segunda, captureOrigin (2070) já roda com o painel escondido por showDetailShell (2211), e a origem guardada fica com a rolagem da tela da ficha (perto de zero). O histórico ganha duas entradas: o primeiro Voltar cai numa entrada com hash #pedido/... e routeFromHash reabre o mesmo pedido; o segundo Voltar volta à lista. O operador aperta Voltar, vê o mesmo pedido de novo, e quando sai cai no topo da lista
- Correção sugerida: no guard, ignorar o clique quando outro cartão clicável mais interno já tratou (por exemplo `if (event.target.closest('.clickable-card') !== card) return;`) ou remover o makeCardClickable da linha. Spec Playwright: clicar numa linha de pedido sem seleção e contar history.length e chamadas a /api/panel/lead

### A2. A sincronização ao abrir ENVIAR OPÇÕES redesenha a tela inteira sem proteger o trabalho do operador
- Domínio: TELA (também DADOS e VENDAS) · Gravidade: BLOQUEIA_VENDA · Esforço: M
- Evidência: painel/painel.js:1946 `if (!optionsSyncRunning) scheduleOptionsSync(500);` em toda carga da aba; painel/painel.js:339 `if (synced && ['searches', 'manheim'].includes(currentView)) loadCurrent().catch(() => {});`. Esse recarregamento não consulta operatorIsTyping (5482), não guarda a rolagem (diferente de refreshCurrentPreservingState, 2064) e chama renderManheim (3751), que refaz todos os cartões
- Efeito: segundos depois de abrir a aba (até 6 rodadas de sync de até 40 s cada, 328 a 338), as opções abertas com "Ver opções" fecham, a mensagem da V1 gerada com o link (v1SendControls, 3376) some do cartão e a página pula de posição. Quem já tinha gerado a V1 e ia enviar precisa achar o cartão e gerar de novo. Cada carga da aba agenda outro sync, então o ciclo se repete enquanto houver pedido defasado; a mesma leitura /api/panel/records?view=manheim é feita de novo para a mesma visão
- Correção sugerida: depois do sync, só recarregar se o operador não estiver no meio de algo (sem opções abertas, sem V1 gerada, sem foco em campo), senão mostrar um aviso "Há opções novas · Atualizar"; e quando recarregar, usar refreshCurrentPreservingState. Spec: abrir a aba com sync simulado devolvendo synced=1, gerar a V1, esperar o sync e conferir que o bloco de envio continua na tela

### A3. Atualização automática de 2 em 2 minutos apaga seleção, "⋯ Mais" aberto e a V1 que não está sendo digitada
- Domínio: TELA · Gravidade: QUEBRA_CLIQUE · Esforço: M
- Evidência: painel/painel.js:5518 `run: async () => { await loadCurrent(); await loadCaptureWarning(); }` com `isBusy: operatorIsTyping` (5482 a 5487). operatorIsTyping só olha campo de texto com foco ou texto digitado; ignora caixa de seleção marcada (exclui checkbox de propósito), details aberto e V1 gerada sem edição. A seleção do ATENDIMENTO só existe como classe no DOM (pickBox, 2578: `card.classList.toggle('case-picked', ...)`), e renderToday (2661) faz `root.replaceChildren()`
- Efeito: o operador marca cartões para "Excluir selecionados", ou abre "⋯ Mais", ou gera a V1 e lê a mensagem; a atualização chega e tudo volta ao estado inicial, sem aviso. A carga do ATENDIMENTO também redesenha a lista uma segunda vez sozinha quando os pedidos incompletos chegam (1930, `renderToday(todayItems,true)`), poucos segundos depois de abrir
- Correção sugerida: incluir em isBusy "há cartão marcado, details aberto dentro da lista ou V1 gerada e não enviada"; ou guardar a seleção num Set por chave do caso e reaplicar depois do redesenho. Spec: marcar um cartão, disparar window.__mcsRefresh.scheduler.runNow() e conferir que continua marcado

### A4. Espaço vazio do bloco de envio da V1 abre a ficha e descarta a mensagem editada
- Domínio: VENDAS (CLIQUES) · Gravidade: QUEBRA_CLIQUE · Esforço: P
- Evidência: o bloco de envio fica solto no cartão clicável de ENVIAR OPÇÕES: painel/painel.js:3663 `card.append(vitrineButton,exportButton,cardStatus,v1Send.node,more)` e 3664 `makeCardClickable(card, () => openDetail('ficha', journey.id))`. Dentro de v1SendControls (3376) há partes que não são controle: a linha de estado `p.v1-send-state`, o histórico `p.v1-send-history`, a linha "copiado" e o vão entre os botões em `div.inline-actions`. O guard (1740) só reconhece `button,input,select,textarea,a,label,details,summary`
- Efeito: ao mirar "Enviar no WhatsApp" ou "Copiar mensagem" e pegar o vão entre eles, ou tocar na linha "Janela de 24 h aberta", o painel vai para a ficha; ao voltar a aba é recarregada e o texto editado e o link gerado não estão mais no cartão
- Correção sugerida: marcar zonas de trabalho como não navegáveis (por exemplo atributo `data-no-card-nav` em `.v1-send`, `.manheim-card-status` e `.inline-actions`, incluído no seletor do guard), como já se faz com stopPropagation em contexto.js:34 e grupos.js:93. Spec: clicar em `.v1-send-state` e no vão de `.v1-send-actions` e conferir que a URL não muda

### A5. Abrir o cartão de opções a partir de outra tela carrega a mesma visão duas vezes
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: painel/painel.js:1850 e 1851 `await switchPanel('searches'); try { await loadCurrent('searches', viewRequestVersion); } catch (_) {}`; switchPanel (627) já espera loadCurrent. O mesmo padrão aparece no link "Comparar pedidos com este lote" (3766, `switchPanel('requests').then(() => loadCurrent(...))`) e no openTab da ficha (2237)
- Efeito: duas leituras de /api/panel/records?view=manheim (ou /api/panel/pesquisas) seguidas, dois desenhos da tela e dois agendamentos de sync (ver A2); entre o primeiro e o segundo desenho a tela pisca e a rolagem pode pular
- Correção sugerida: remover o loadCurrent extra depois de switchPanel nesses três pontos

### Verificado e sem achado
- Os nove makeCardClickable (1424, 1529, 2615, 2770, 2857, 3664, 3716, 3724, 4905): os botões "Abrir ficha" sem stopPropagation (1424, 2855, 4902) são barrados pelo guard porque o alvo é um button, então não abrem duas vezes
- Diálogo "No celular" (whatsapp-envio.js) é anexado ao body, fora dos cartões; o clique no fundo não chega a cartão nenhum
- Linhas de oferta da seleção ficam dentro de `details.offer-group` (offerGroup), cobertas pelo guard
- Ouvintes globais do boot (5662 a 5747) são ligados uma vez só; MCSAction.bind para a propagação em todos os botões que usa

### Limites desta avaliação
- Não rodei Playwright nem npm test; os efeitos de A1 a A4 foram deduzidos do código e precisam do spec que falha antes da correção
- Não consultei o Supabase; nada aqui afirma tempo de consulta

## Comparação com o rascunho

Etapa feita depois da avaliação cega acima (que não foi alterada). Li AUD-001-executor.md e conferi cada achado dos dois lados no código do main (7a25ef1), tentando refutar.

### Achados do executor
- E1 (atualização automática apaga seleção e fecha "⋯ Mais" no ATENDIMENTO): SUSTENTADO. Mesmo achado que A3. Conferido: renderToday faz root.replaceChildren() (painel/painel.js:2665), a seleção só existe no DOM (pickBox, 2578 a 2583), isBusy é operatorIsTyping (5482 a 5487), que exclui checkbox. O executor ainda mediu (1 caixa para 0), o que reforça.
- E2 (atualização automática em ENVIAR OPÇÕES fecha o grupo aberto e pula a rolagem): SUSTENTADO. Conferido: run chama loadCurrent() (5518) e não refreshCurrentPreservingState (2064 a 2068); os grupos nascem fechados (offerGroup, 3220). Converge com A2 no efeito (redesenho da visão searches sem proteger o trabalho), mas o gatilho é outro: E2 é o intervalo de 2 min, A2 é o recarregamento depois do sync (339). São duas portas para o mesmo defeito; a correção deve cobrir as duas. Divergência só de gravidade: o executor diz QUEBRA_CLIQUE, eu disse BLOQUEIA_VENDA para A2 porque a V1 gerada some do cartão. Mantenho BLOQUEIA_VENDA para o conjunto.
- E3 ("Abrir no WhatsApp Web" ignora a aba única no computador): SUSTENTADO. Achado que eu não tinha. Conferido: wa-link.js escuta click no document em bolha (painel/wa-link.js:87); o bloco da V1 faz node.addEventListener('click', (event) => event.stopPropagation()) (painel/painel.js:3484) e o link fallback está dentro dele (3382 a 3388); sugestoes.js:47 e 274 fazem o mesmo no cartão. O clique nunca chega ao document, então o link cai no target _blank comum. Medição do executor confirma.
- E4 (linha clicável dentro de cartão clicável abre o pedido duas vezes): SUSTENTADO. Mesmo achado que A1. Conferido: makeCardClickable na linha (3716) e no cartão (3724); o guard não para a propagação (1741 a 1750); openDetail faz pushState nas duas chamadas (2222 a 2226). Alcance confirmado: a linha só aparece quando orderSelection é null (3721 a 3723; offer null em panel-buscas-view.js:216). Nenhum dos dois mediu em navegador.

### Meus achados, revistos
- A1: SUSTENTADO (concorda com E4).
- A2: SUSTENTADO. Conferido: scheduleOptionsSync(500) a cada carga da aba (1946), loadCurrent() depois de synced (339), sem isBusy e sem guardar rolagem. O executor não o tem; complementa E2.
- A3: SUSTENTADO (concorda com E1). A segunda pintura ao chegar os pedidos incompletos (1930, renderToday(todayItems,true)) também conferida.
- A4 (espaço vazio do bloco da V1 abre a ficha): REFUTADO. Eu não tinha considerado a linha 3484: o próprio nó v1-send para a propagação de qualquer clique dentro dele, então a linha de estado, o histórico e o vão entre os botões nunca chegam ao makeCardClickable do cartão. O único texto solto que sobra é p.manheim-card-status (3605), fora do bloco da V1; clicar nele abre a ficha, mas isso é navegação legítima do cartão, não perda do trabalho. Retiro A4. Observação: é justamente esse stopPropagation que causa E3, então a correção de E3 deve trocar o stopPropagation por uma marca que o guard respeite sem reabrir A4.
- A5 (abrir opções a partir de outra tela carrega a mesma visão duas vezes): SUSTENTADO. Conferido: switchPanel já espera loadCurrent (painel/painel.js:643) e openOptionsCard chama de novo (1850 e 1851); o mesmo em 3766 e 2237. A carga de searches usa request direto (1942), não sharedGet, então não há reaproveitamento: são duas leituras de /api/panel/records?view=manheim e dois agendamentos de sync. O executor não o tem.

### Resumo
- Concordâncias: E1 = A3, E4 = A1, E2 próximo de A2 (gatilhos diferentes, mesmo defeito).
- Só do executor: E3 (sustentado).
- Só do revisor: A2 (sustentado), A5 (sustentado), A4 (refutado por mim mesmo).
- Divergência: gravidade de E2/A2 (QUEBRA_CLIQUE contra BLOQUEIA_VENDA).
- Pendência comum: E4/A1, A2 e A5 ainda sem reprodução em Playwright.
