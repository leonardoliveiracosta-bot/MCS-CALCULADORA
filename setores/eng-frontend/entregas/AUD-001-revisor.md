# AUD-001 · Revisor independente (Nível 2) · eng-frontend

Pedido: AUD-001, auditoria do painel, somente achados, sem mudar código
Base: main atual (último commit 77c9352)
Ordem das etapas: avaliação cega registrada aqui ANTES de abrir o rascunho do executor (AUD-001-executor.md não foi aberto)

## Avaliação cega

Método: leitura de painel/painel.js, painel/action.js, painel/refresh-coordinator.js, api/panel/manheim-options.js, api/panel/v1-send.js, api/panel/vitrines.js e das migrações do Manheim; um teste em navegador (Playwright, Chromium sem tela) com a função makeCardClickable copiada do arquivo real; uma contagem SELECT no Supabase de produção (só número, sem dado pessoal).

### A1 · Linha de carro clicável dentro de cartão clicável abre o pedido duas vezes
- Domínio: CLIQUES · Gravidade: QUEBRA_CLIQUE · Esforço: P
- Evidência: painel/painel.js:3716 chama makeCardClickable(row, abrir pedido) na linha do carro e painel/painel.js:3724 chama makeCardClickable(card, abrir pedido) no cartão que contém essa linha (renderManheimOrderGroup, cartões de pedido da calculadora quando a seleção para o cliente não está ativa). O guard (painel.js:1732 a 1752) não para a propagação. Teste em navegador com a função real: clique no texto do carro dentro da linha gerou ["row","card"], ou seja, a ação rodou duas vezes.
- Efeito: openDetail roda duas vezes (painel.js:2220): dois history.pushState, duas leituras do pedido, e a segunda captura de origem é feita com a ficha já aberta (scrollY baixo). Voltar exige dois toques e a lista pode voltar ao topo.
- Correção sugerida: no guard, ignorar o clique quando event.target estiver dentro de outro .clickable-card mais interno que o cartão atual (closest('.clickable-card') !== card), ou não tornar a linha clicável. Spec: clicar na linha e conferir uma única entrada nova no histórico.

### A2 · Atualização automática a cada 2 min redesenha ENVIAR OPÇÕES e perde o trabalho de venda em andamento
- Domínio: VENDAS · Gravidade: BLOQUEIA_VENDA (atrapalha, não impede) · Esforço: M
- Evidência: painel/painel.js:5516 a 5518, o agendador roda loadCurrent() a cada REFRESH_MS = 120000 (painel.js:5490). Em searches, loadCurrentNow chama renderManheim (painel.js:1944), que faz root.replaceChildren() (painel.js:3777) e recria todos os cartões. Não existe preservação de grupos abertos, páginas de opções carregadas, filtro de trim aberto, caixa de confirmação do envio da V1 nem posição de rolagem. O botão "Apresentei ao cliente" faz o mesmo de imediato (refresh: loadCurrent, painel.js:3593). A trava isBusy só segura enquanto há texto digitado.
- Efeito: o operador abre o grupo Lane/Run, carrega "Ver mais", gera a V1, e em até 2 min tudo fecha e a tela pula. A seleção em si fica salva no servidor, mas o contexto visual some.
- Correção sugerida: na atualização automática de searches, guardar e restaurar os details abertos por demandKey e grupo, e a rolagem (como refreshCurrentPreservingState, painel.js:2064, faz só com a rolagem), ou não redesenhar quando nada mudou.

### A3 · CLIENTES: ação no cartão ou atualização automática volta a lista para a página 1 e tira a visão do lugar
- Domínio: CLIQUES · Gravidade: QUEBRA_CLIQUE · Esforço: M
- Evidência: as ações do cartão de cliente usam refresh: () => loadClients() (5 usos, por exemplo journeySwitch painel.js:1521, "Já resolvi" e "Não é lead" painel.js:1522 e 1523, assunto painel.js:1505). loadClients (painel.js:1597) chama renderClients, que faz root.replaceChildren() (painel.js:1588) e só desenha a página 1 (50 cartões). Quem estava na página 3 perde as páginas 2 e 3, a altura da lista cai e a rolagem pula para cima. A atualização automática (painel.js:5518) chama loadCurrent, que também chama loadClients, sem preservar posição. Existe restoreClientsPosition (painel.js:1608) mas só é usado ao voltar da ficha.
- Correção sugerida: depois das ações e da atualização automática em clients, usar clientsSnapshot + restoreClientsPosition (já existem), ou atualizar só o cartão afetado.

### A4 · ATENDIMENTO: seleção de cartões para "Excluir selecionados" some a cada redesenho
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: a marcação vive só no DOM (pickBox, painel.js:2578 a 2583, classe case-picked). renderToday faz root.replaceChildren() (painel.js:2665) em toda atualização automática (2 min), em todo clique de chip de grupo (painel.js:2656) e de número (painel.js:2706). A barra "N selecionado(s)" volta a zero sem aviso.
- Correção sugerida: guardar as chaves marcadas num Set (entry.key) e remarcar ao redesenhar.

### A5 · Mesma API chamada duas vezes ao abrir BUSCAR CARROS por dois atalhos
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: switchPanel já chama loadCurrent (painel.js:642). Os atalhos fazem switchPanel(view).then(() => loadCurrent(view, ...)): o openTab da ficha (painel.js:2237) e o link "Comparar pedidos com este lote" (painel.js:3766). Como o primeiro carregamento já terminou, o segundo roda inteiro: /api/panel/pesquisas, loadSearchStages e renderSavedSearches de novo, e a tela é desenhada duas vezes.
- Correção sugerida: remover o .then(loadCurrent) dos dois atalhos.

### A6 · Cada redesenho de ENVIAR OPÇÕES dispara um POST de preparo da V1 por cartão que já tem V1
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: painel/painel.js:3629, latestV1For(...).then(... v1Send.restore(item)); restore chama setVitrine (painel.js:3422), que faz POST /api/panel/v1-send action prepare. O prepare (api/panel/v1-send.js:76 a 92) faz várias leituras no banco (vitrine, carros duplicados, último envio, destino, janela de 24 h). Com a atualização de 2 min (A2), isso se repete sozinho. Medição em produção (SELECT): 9 vitrines em 7 fichas nos últimos 30 dias, então até 7 POSTs por redesenho hoje, crescendo com o uso.
- Correção sugerida: no restore, mostrar o histórico sem chamar prepare, e chamar prepare só quando o operador abrir o envio; ou guardar a resposta por token durante a sessão.

### A7 · Guard do cartão: pontos que ele ainda não cobre (baixo risco hoje)
- Domínio: CLIQUES · Gravidade: OUTRO · Esforço: P
- Evidência: painel.js:1738, a lista de controles é button,input,select,textarea,a,label,details,summary. Não cobre [role=button], [contenteditable] nem [tabindex] em elementos não nativos; hoje não encontrei nenhum desses dentro de cartão (grep de role e contenteditable só acha status, alert e switch em botão). A tecla Espaço no cartão não abre (só Enter, painel.js:1749), diferente de um botão.
- Correção sugerida: incluir [role=button],[contenteditable=true],.clickable-card (este último resolve A1) na lista do guard, para que controles novos não voltem a abrir a ficha.

### Verificações sem achado
- Os 9 usos de makeCardClickable (painel.js:1424, 1529, 2615, 2770, 2857, 3664, 3716, 3724, 4905): todos os botões internos ou usam MCSAction.bind (que faz stopPropagation, action.js:84) ou são cobertos pelo guard; o problema real é só o aninhamento de A1.
- Listener amarrado duas vezes: boot() roda uma vez (painel.js:5751); os listeners de cartão nascem com cada cartão novo; não achei religação no mesmo nó.
- Paginação das opções: ordem determinística com id no final (migrações 20261022010000 e 20261020050000) e as páginas com trim usam panel_manheim_grouped_options (um carro por VIN); restart() limpa state.loaded antes de recarregar, então não vi carro repetido no PDF por troca de ordem ou trim.
- Gerar link V1 duas vezes reaproveita a mesma vitrine (api/panel/vitrines.js:125).

## Comparação com o rascunho

Feita depois da avaliação cega, lendo AUD-001-executor.md e conferindo cada achado no código (HEAD 7a25ef1, mesmo código do painel de 77c9352). Tentei refutar cada um.

### Achados do executor
- F1 (linha de carro dentro do cartão abre o pedido duas vezes): SUSTENTADO, concorda com A1. painel.js:3716 e 3724, guard em 1732 a 1752 sem parar a propagação. Mesma correção (ignorar quando closest('.clickable-card') !== card).
- F2 (CLIENTES volta à página 1 após ação): SUSTENTADO, concorda com A3. Ressalva: as linhas citadas (1517 a 1519) estão deslocadas; os usos de refresh: () => loadClients() estão em painel.js:1505, 1520, 1521, 1522 e 1523. O executor não cobriu a atualização automática de 2 min (painel.js:5518), que causa o mesmo salto (A3).
- F3 (link do WhatsApp dentro de bloco com stopPropagation escapa do wa-link): SUSTENTADO, achado que eu não tinha. painel.js:3484 para a propagação no bloco v1-send; o link fallback (painel.js:3382, href wa.me em 3400) fica dentro dele; wa-link.js:87 escuta no document em bolha. MCSWaHandoff.attach (whatsapp-envio.js:55) só troca o texto e cria o botão "No celular", não liga clique no link, então nada compensa. Mesmo padrão confirmado em sugestoes.js:47 e 274 e grupos.js:103. Gravidade: concordo com QUEBRA_CLIQUE no computador (abre wa.me em aba nova em vez da aba mcs-whatsapp); proponho classificar também como VENDAS, porque é o envio da V1.
- F4 (mesma API chamada duas vezes por openTab e link do resumo): SUSTENTADO, concorda com A5. painel.js:642, 2237 e 3766.
- F5 (Retomar busca e Apresentei ao cliente redesenham ENVIAR OPÇÕES): SUSTENTADO, concorda em parte com A2. DIVERGENTE no alcance e na gravidade: o executor deixou de fora o agendador de 2 min (painel.js:5490 e 5516 a 5518), que redesenha a aba sozinho e fecha grupos, páginas e a caixa de confirmação da V1 sem nenhuma ação do operador. Por isso mantenho a classificação VENDAS e não OUTRO.
- F6 (marcar trim durante carga é desfeito sem aviso): SUSTENTADO no código. painel.js:3326 `if (busy) { paintTrims(); return; }` e os checkboxes (painel.js:3270) não ficam desabilitados enquanto busy. DIVERGENTE na gravidade: a janela é curta (uma página carregando) e o operador vê o checkbox voltar; prefiro OUTRO, esforço P.
- F7 (paginação do grupo sem descartar repetido): SUSTENTADO como risco latente, DIVERGENTE da minha verificação cega. Eu tinha concluído que a ordem é determinística (id no final) e não vi repetição; isso continua certo enquanto o lote e o complemento não mudam. Mas o executor tem razão que a paginação é por offset (manheim-options.js:123 e migração 20261022010000:168 a 169), que a ordem depende do complemento atual (manheim_sale_current, linha 136) e que painel.js:3295 faz loadedIds.add sem checar. Se o complemento trocar entre "Ver opções" e "Ver mais", pode repetir ou pular carro. Sem reprodução observada; correção P no cliente (pular id já em loadedIds) é barata e fecha o risco.
- F8 (ouvinte toggle acumulado na triagem): SUSTENTADO. painel.js:1058 e 1077 ligam com once:true a cada desenho em elementos fixos; acumula enquanto o bloco não é aberto. Efeito contido (hydrate marca as caixas), OUTRO, P. Eu tinha afirmado que não achei religação no mesmo nó; esta afirmação da avaliação cega fica REFUTADA por F8.
- Medições do executor (0,88 s, 0,80 s, 1,51 s): não refeitas, coerentes com a reescrita 20261024020000; sem divergência.

### Achados do revisor que o executor não registrou
- A2 (atualização automática de 2 min redesenha ENVIAR OPÇÕES): SUSTENTADO, rechecado em painel.js:5490 e 5516 a 5518; isBusy só cobre digitação.
- A4 (seleção de "Excluir selecionados" em ATENDIMENTO some a cada redesenho): SUSTENTADO, painel.js:2578 a 2583 e 2665; o executor não tratou.
- A6 (cada redesenho faz um POST prepare por cartão com V1): SUSTENTADO, painel.js:3629 chama restore, que chama setVitrine(item.token, true), que faz POST /api/panel/v1-send action prepare. O executor afirma que latestV1For junta leituras em lotes, o que é verdade para a leitura, mas não cobre este POST seguinte.
- A7 (guard não conhece role=button, contenteditable, .clickable-card): SUSTENTADO como prevenção; concorda com o executor que hoje não há controle desses dentro de cartão. Incluir .clickable-card no guard resolve F1/A1.

### Resumo
Concordâncias: F1=A1, F2=A3, F4=A5, F5 parcial de A2. Novos aceitos do executor: F3, F6, F7, F8. Divergências: F5 (alcance, falta o agendador), F6 (gravidade), F7 (risco latente, não observado). Refutado: minha afirmação cega "nenhuma religação no mesmo nó" (por F8). Nenhum achado do executor refutado.
