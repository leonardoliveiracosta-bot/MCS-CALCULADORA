# AUD-001 · Rascunho do Executor

- Pedido: AUD-001, auditoria do painel My Car Scout, somente achados (sem mudar código, sem commit, sem publicar)
- Setor: eng-frontend
- Papel: Nível 1 Executor
- Agente: subagente executor eng-frontend (Claude), sessão do fluxo AUD-001
- Base: main atual (77c9352)
- Método: leitura do código (painel/painel.js, painel/*.js, api/panel/manheim-options.js, migrações do Manheim), duas reproduções no Chromium do Playwright com o código real copiado do arquivo, e SELECT/EXPLAIN ANALYZE só de leitura no Supabase de produção (nenhuma função que escreve, nenhum dado pessoal transcrito)

## Achados

### F1. Linha de carro dentro do cartão de pedido abre o pedido duas vezes e a volta perde a posição
- Domínio: CLIQUES
- Gravidade: QUEBRA_CLIQUE
- Esforço: P
- Evidência: painel/painel.js:3716 `makeCardClickable(row, () => openDetail('order', order.ref))` dentro de painel/painel.js:3724 `makeCardClickable(card, () => openDetail('order', order.ref))`. O guard (painel.js:1732 a 1752) não para a propagação, então o clique na linha chega ao cartão. Reprodução no Chromium com a função real: um clique na linha registrou `["row","card"]`, ou seja, duas ações. Cada openDetail faz pushState (painel.js:2223 a 2227): ficam duas entradas no histórico, Voltar precisa ser apertado duas vezes, e o segundo captureOrigin (painel.js:2070) roda depois que showDetailShell escondeu a lista, então guarda scrollY perto de zero e a volta leva a visão ao topo. Também faz duas leituras do pedido (a primeira é descartada pela versão). O caminho aparece quando a demanda vem sem o resumo de seleção (demand.offer nulo, painel.js:3720 e panel-buscas-view.js:216), por exemplo quando o resumo falha.
- Correção sugerida: no guard, só agir no cartão mais interno (por exemplo, marcar o evento como tratado e ignorar no ancestral, ou ignorar quando event.target.closest('.clickable-card') !== card); ou não tornar a linha clicável, já que faz a mesma ação do cartão. Spec Playwright: clique na linha deve gerar uma única entrada no histórico e Voltar deve restaurar o scroll.

### F2. Ação dentro do cartão em CLIENTES recarrega só a primeira página e a visão sobe
- Domínio: CLIQUES
- Gravidade: QUEBRA_CLIQUE
- Esforço: M
- Evidência: os botões do cartão (Já resolvi, Não é lead, Ligado/Desligado, assunto) usam `refresh:()=>loadClients()` (painel.js:1517, 1518, 1519). loadClients (painel.js:1597) busca só `page:'1'`, zera clientsPagesLoaded e renderClients faz `root.replaceChildren()` (painel.js:1587). Quem rolou até o cartão 120 (página 3 de 50) e apertou um botão fica com uma lista de 50 cartões, a página encurta e o navegador puxa a visão para cima, longe do cartão em que estava. Já existe a lógica de restaurar posição (clientsSnapshot e restoreClientsPosition, painel.js:2083 e 2103), mas ela só é usada na volta da ficha.
- Correção sugerida: no refresh pós ação, guardar clientsSnapshot() antes, recarregar as páginas já carregadas e chamar restoreClientsPosition; ou atualizar só o cartão mexido. Spec: rolar até um cartão da página 2, apertar Já resolvi, conferir que a visão continua no mesmo cartão vizinho.

### F3. Link "Abrir no WhatsApp Web" do bloco V1 não passa pelo wa-link e abre wa.me em aba nova
- Domínio: VENDAS
- Gravidade: QUEBRA_CLIQUE
- Esforço: P
- Evidência: painel/painel.js:3484 `node.addEventListener('click', (event) => event.stopPropagation())` no bloco v1-send. O wa-link.js instala o tratamento dos links wa.me no document, em fase de bolha (painel/wa-link.js:87). Com a propagação parada, o document nunca recebe o clique. Reprodução no Chromium com o wa-link.js real: link fora do bloco abriu `https://web.whatsapp.com/send?...` na aba `mcs-whatsapp`; o mesmo link dentro de um nó com stopPropagation não foi interceptado e seguiu a navegação padrão (target _blank, wa.me). No computador o botão diz "Abrir no WhatsApp Web" (painel.js:3392) mas abre a página intermediária do wa.me numa aba nova a cada clique. O mesmo padrão aparece em painel/sugestoes.js:47 e 274 (cartão da sugestão) e painel/grupos.js:103 (Sugerir ou gerar resposta no cartão), onde fica o link "Abrir no WhatsApp do celular" (sugestoes.js:123).
- Correção sugerida: tirar o stopPropagation genérico desses blocos (o guard do makeCardClickable já ignora a, button, input, textarea, details) ou, no clique do link, chamar MCSWaLink.open(href) e preventDefault quando não for celular. Spec: clicar o link dentro do cartão de ENVIAR OPÇÕES deve chamar window.open com web.whatsapp.com e alvo mcs-whatsapp.

### F4. Mesma lista carregada duas vezes ao trocar de aba pela ficha e pelo link do resumo
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: P
- Evidência: painel/painel.js:2237 `openTab: (view) => switchPanel(view).then(() => loadCurrent(view, viewRequestVersion))` e painel/painel.js:3766 `switchPanel('requests').then(() => loadCurrent('requests', viewRequestVersion))`. switchPanel já faz `await loadCurrent(view, requestVersion)` (painel.js:642). Resultado: a mesma API da aba (por exemplo /api/panel/records?view=manheim ou /api/panel/pesquisas) é chamada duas vezes seguidas e a tela é desenhada duas vezes; o segundo desenho fecha o que o operador já tivesse aberto entre as duas respostas.
- Correção sugerida: usar só `switchPanel(view)` nos dois lugares. Spec: contar as chamadas à API da aba depois do clique (esperado 1).

### F5. Ação em cartão de ENVIAR OPÇÕES redesenha a aba inteira e fecha grupos abertos
- Domínio: CLIQUES
- Gravidade: OUTRO
- Esforço: M
- Evidência: Retomar busca e Apresentei ao cliente usam `refresh:()=>loadCurrent()` (painel.js:3564 e 3593). loadCurrent da aba searches chama renderManheim (painel.js:1937), que faz `root.replaceChildren()` em cada coluna (painel.js:3778) e recria todos os cartões: grupos de carros abertos, páginas carregadas, filtro de trim aberto e o bloco V1 preenchido somem, e o operador precisa reabrir tudo. A seleção fica no servidor, então não se perde, mas o trabalho visual sim.
- Correção sugerida: depois dessas ações, atualizar só o cartão da demanda (ou só os contadores) em vez da aba inteira. Vai para backlog se não couber.

### F6. Marcar trim enquanto a lista carrega é desfeito sem aviso
- Domínio: CLIQUES
- Gravidade: QUEBRA_CLIQUE
- Esforço: P
- Evidência: painel/painel.js:3325 a 3326 `function setTrims(next) { if (busy) { paintTrims(); return; } ...`. Se o operador marca um trim enquanto a página do grupo ainda está chegando, paintTrims recoloca o checkbox como estava e o clique some sem mensagem.
- Correção sugerida: guardar o pedido e aplicar quando a carga terminar (ou desabilitar os checkboxes com "Carregando…" visível enquanto busy).

### F7. Paginação do grupo não descarta carro repetido
- Domínio: TELA
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: painel/painel.js:3295: cada opção da página entra com `loadedIds.add(option.id); state.loaded.push(option)` e é desenhada, sem checar se o id já estava. O servidor pagina por offset (api/panel/manheim-options.js:113 e migração 20261022010000_manheim_v34_group_vin.sql:168 a 169) e o grupo depende do complemento atual (manheim_sale_current, linha 135 da mesma migração): se o complemento ou um carro mudar entre "Ver opções" e "Ver mais", a ordem desloca e o mesmo carro (mesmo VIN) aparece duas vezes, além de pular outro. O banco tem matéria para isso: no lote ativo há 55.454 linhas para 47.758 pares demanda+VIN (7.694 pares repetidos em 334 demandas), hoje agrupados por VIN no banco.
- Correção sugerida: no cliente, ignorar opção cujo id (ou VIN) já está em loadedIds; no servidor, considerar cursor estável (como o encodeCursor do caminho antigo).

### F8. Ouvinte "toggle" acumulado a cada atualização da triagem
- Domínio: CLIQUES
- Gravidade: OUTRO
- Esforço: P
- Evidência: painel/painel.js:1058 `$('topic-out')?.addEventListener('toggle', ..., {once:true})` e painel/painel.js:1077 `$('triage-out')?.addEventListener('toggle', ..., {once:true})` ficam dentro das funções de desenho, chamadas a cada recarga. Os elementos são fixos, então cada recarga sem abrir o bloco soma mais um ouvinte; ao abrir, todos disparam juntos. Hoje o efeito é contido porque hydrateTranslations marca as caixas antes de pedir (painel/grupos.js:192), mas são chamadas e trabalho repetidos.
- Correção sugerida: ligar os dois ouvintes uma única vez no boot, ou guardar com dataset.bound como já é feito em painel.js:1363.

## Medições sem achado (registro)
- panel_manheim_offer_page na maior demanda do lote ativo (3.097 linhas, grupo LANE): 0,88 s
- panel_manheim_offer_trims na mesma demanda: 0,80 s
- panel_manheim_offer_summary do lote ativo (385 demandas): 1,51 s
- Longe do limite de 8 s. latestV1For já junta as leituras em lotes de 100 (painel.js:3357). Os 9 usos de makeCardClickable foram conferidos; fora do F1, os controles internos são button, input, label, a, details e summary, que o guard reconhece.
