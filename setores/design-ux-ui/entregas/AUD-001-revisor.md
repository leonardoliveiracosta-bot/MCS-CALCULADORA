# AUD-001 · design-ux-ui · Nível 2 Revisor independente

Pedido: AUD-001 (auditoria do painel, somente achados, sem alterar código)
Base: main atual (commit 7a25ef1 na branch de trabalho, guard reforçado em 77c9352, Realidade em 29e1bd9)
Ordem das etapas: esta avaliação cega foi registrada ANTES de abrir o rascunho do executor (AUD-001-executor.md não foi lido)
Foco do setor: badges e contagens duplicados, elementos repetidos, comportamento visual de cartões clicáveis

## Avaliação cega

Método: leitura de painel/painel.js, painel/action.js, painel/contexto.js, painel/grupos.js, painel/sugestoes.js, panel-buscas-view.js, api/panel/manheim-options.js e migrações do Manheim; reprodução do guard com Playwright (Chromium headless) copiando a função makeCardClickable literal do painel.js para uma página mínima.

Conferido e sem achado: os 9 usos de makeCardClickable (1424, 1529, 2615, 2770, 2857, 3664, 3716, 3724, 4905); o guard cobre button, input, select, textarea, a, label, details e summary, inclusive botão removido pelo próprio clique; MCSAction.bind para a propagação; os listeners globais são ligados uma única vez em boot(); as páginas de carros do Manheim têm desempate por id no ORDER BY e agrupamento por VIN no banco (20261022010000).

### A1 · Cartão clicável dentro de cartão clicável abre o pedido duas vezes e volta a visão ao topo
- Domínio: CLIQUES · Gravidade: QUEBRA_CLIQUE · Esforço: P
- Evidência: painel/painel.js:3716 `makeCardClickable(row, () => openDetail('order', order.ref))` e painel/painel.js:3724 `makeCardClickable(card, () => openDetail('order', order.ref))`; a linha (row) fica dentro do cartão (lazyOptions insere a linha na tabela que é anexada ao card em 3722). A linha não é controle, então o clique sobe para o cartão e o guard deixa passar.
- Reprodução (Playwright, função literal do painel): página rolada até y=3000, um clique na linha gera 2 chamadas: `{"who":"row","scrollY":3000},{"who":"card","scrollY":0}` e history.length 3 (duas entradas novas). A segunda chamada de openDetail roda captureOrigin depois de showDetailShell, quando a página já encolheu, e grava scrollY 0 como origem.
- Efeito: duas leituras de /api/panel/lead para o mesmo pedido, duas entradas no histórico (o Voltar precisa ser apertado duas vezes) e, ao voltar, a visão vai para o topo em vez do cartão.
- Quando ocorre: ENVIAR OPÇÕES em pedido da calculadora quando a seleção para cliente não está disponível (demand.offer nulo ou offerPending, panel-buscas-view.js:216-218), caminho de reserva com "Ver opções".
- Correção sugerida: no guard, ignorar o clique quando event.target estiver dentro de outro .clickable-card mais interno que o card atual (`event.target.closest('.clickable-card') !== card`), ou não tornar a linha clicável. Teste Playwright: clicar na linha conta 1 openDetail e preserva scrollY da origem.

### A2 · Ação dentro de cartão em CLIENTES recarrega só a página 1 e a visão salta
- Domínio: CLIQUES · Gravidade: QUEBRA_CLIQUE · Esforço: M
- Evidência: painel/painel.js:1520-1523 (journeySwitch, "Já resolvi", "Não é lead", assunto) usam `refresh:()=>loadClients()`; painel/painel.js:1597 loadClients zera `clientsPagesLoaded=1` e renderClients (1588) faz `root.replaceChildren()`. painel/action.js:61 chama refresh após todo sucesso. Não existe snapshot/restauração de posição nesse caminho (restoreClientsPosition só é usado na volta da ficha, 2107).
- Efeito: operador na página 3 da lista (cartão número 120, exemplo fictício) aperta "Ligado" ou "Já resolvi"; a lista volta a ter só 50 cartões, a página encolhe e a visão pula para longe do cartão (fim da página 1 ou topo).
- Correção sugerida: no refresh dessas ações, capturar clientsSnapshot() antes e chamar restoreClientsPosition(snapshot, scrollY) depois de loadClients, ou atualizar só o cartão afetado.

### A3 · Canal repetido no cabeçalho do cartão (badge de lead direto e badge de canal)
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: painel/painel.js:1703-1704, em identityHeader sem `compact`, acrescenta directLeadBadge ("📱 Veio por mensagem · Via WhatsApp (sem calculadora)") e contactMeta com o canal ("💬 WhatsApp", contactChannelLabel em 1682). O comentário da 1702 já reconhece a regra "origin and channel once", mas só o modo compact (CLIENTES, 1497) a aplica. Chamadas sem compact: 2839 (QUALIFICAÇÃO), 3549 (ENVIAR OPÇÕES, cartão de venda V1) e 4891 (FICHAS).
- Efeito: num lead direto por WhatsApp o cartão mostra o canal duas vezes, em dois badges.
- Correção sugerida: quando directLeadBadge existir, chamar contactMeta com noChannel true (manter só o horário de chegada).

### A4 · Páginas de carros sem descarte de repetidos no navegador
- Domínio: TELA · Gravidade: INFO_ERRADA_OU_DUPLICADA (risco) · Esforço: P
- Evidência: painel/painel.js:3230 cria `loadedIds` e 3295 só faz `loadedIds.add(option.id)`, sem conferir `has` antes de desenhar; lazyOptions (3024) também não confere. A paginação é por offset (api/panel/manheim-options.js:157, `nextCursor: String(offset + limit)`). Se o lote ativo receber carros por "Acrescentar ao lote ativo" (painel/painel.js:5722) entre "Ver opções" e "Ver mais", a ordem muda e o mesmo carro pode vir nas duas páginas.
- Não reproduzido em produção (sem leitura do lote ativo, por regra); fica como risco com evidência de código.
- Correção sugerida: `if (loadedIds.has(option.id)) return;` antes de desenhar a linha, nos dois caminhos.

### Observações sem gravidade (não entram como achado)
- O guard só trata Enter no teclado (painel/painel.js:1750); Espaço não abre o cartão. Acessibilidade, fora da regra de correção imediata.
- `pressed` não é zerado quando um filho para a propagação do clique (details "⋯ Mais" em 2608 e 2766); o próximo pointerdown sobrescreve, sem efeito observado.

## Comparação com o rascunho do executor

Pendente: será acrescentada somente depois desta avaliação cega, sem alterar o texto acima.

## Comparação com o rascunho

Feita depois da avaliação cega acima (que não foi alterada). Cada achado foi conferido de novo no código do main atual, tentando refutar.

### Concordâncias (os dois lados acharam)
- Executor 1 = Revisor A1 · cartão dentro de cartão (painel/painel.js:3716 linha e 3724 cartão; a linha fica dentro do cartão via lazyOptions e não é controle para o guard em 1738). SUSTENTADO, reproduzido com Playwright na avaliação cega (2 chamadas, 2 entradas no histórico, origem gravada com scrollY 0). Gravidade QUEBRA_CLIQUE, esforço P.
- Executor 7 = Revisor A3 · canal dito duas vezes fora do modo compact (1703 directLeadBadge + 1704 contactMeta sem noChannel). SUSTENTADO. INFO_ERRADA_OU_DUPLICADA, P.
- Executor 6 = observação do Revisor (só Enter, sem role). SUSTENTADO como OUTRO (acessibilidade); fica fora da regra de correção imediata, vai para backlog.

### Achados só do executor, conferidos
- Executor 2 · heatBadge duas vezes no cartão de TODOS. SUSTENTADO: clientCard usa identityHeader compact (1497), contactMeta sempre põe heatBadge num details (1687, heatBadge nunca devolve nulo, 1686) e o "⋯ Mais" acrescenta outro heatBadge (1511). O revisor não tinha visto. INFO_ERRADA_OU_DUPLICADA, P.
- Executor 3 · Ref repetida no cartão de pedido de ENVIAR OPÇÕES. SUSTENTADO: identityFacts escreve "Ref" (144, dropWishFacts em 3009 não remove Ref), badge `Ref ${order.ref}` (3685) e "Ref do pedido" em cada linha (3700). INFO_ERRADA_OU_DUPLICADA, P.
- Executor 4 · clique no texto de askInline dentro de cartão abre o pedido. SUSTENTADO no caso do askInline: a caixa `div.inline-confirm` com `p` (4446) é anexada dentro do bloco sms-print-missing (1727), que fica dentro do cartão clicável (3694); o `p` não está no seletor do guard (1738), então o clique navega e a pergunta fica sem resposta. DIVERGENTE só no alcance: no staleNotice (3044) e na linha de status o clique em texto puro do cartão abrir o pedido é o comportamento normal do cartão, não defeito; o defeito real é navegar com uma confirmação aberta. Gravidade QUEBRA_CLIQUE para o askInline, P.
- Executor 5 · guard com lista fixa de tags. SUSTENTADO como risco (OUTRO): não há hoje controle com role fora de button dentro de cartão. Concordo com a correção (seletor único com `data-no-card-click`), que também resolve o 4; backlog ou junto do item 1 da correção.
- Executor 8 · visão Fichas: heatBadge duplicado e "DESLIGADO" repetido. SUSTENTADO: identityHeader (4891) já traz heatBadge e controls acrescenta outro (4899); badge de status DESLIGADO (4895) ao lado de journeySwitch "Desligado — religar" (1762). Visão sem aba, prioridade baixa, P.

### Achados só do revisor, conferidos de novo
- Revisor A2 · ação em cartão de TODOS recarrega só a página 1. SUSTENTADO: refresh `()=>loadClients()` em 1520-1523, action.js:65 chama refresh após sucesso, loadClients (1597) zera clientsPagesLoaded=1 e redesenha; clientsSnapshot/restoreClientsPosition (1601, 1607) só são usados na volta da ficha (2081, 2103). O executor não registrou. QUEBRA_CLIQUE (a visão salta), M.
- Revisor A4 · páginas de carros sem descarte de repetidos. SUSTENTADO como risco de código (3295 só faz add, sem has; paginação por offset). Não reproduzido em produção. INFO_ERRADA_OU_DUPLICADA (risco), P.

### Refutados
- Nenhum achado de nenhum lado foi refutado. O "Conferido sem achado" do executor (contagem por VIN, RESPONDIDO, linhas de decisão movidas, bindV2Photos uma vez) é coerente com o que o revisor conferiu.

### Lista consolidada para o aprovador
1. A1/E1 cartão dentro de cartão · QUEBRA_CLIQUE · P · corrigir agora
2. E4 confirmação inline navega · QUEBRA_CLIQUE · P · corrigir agora (junto do guard, com E5)
3. A2 recarga de TODOS perde posição · QUEBRA_CLIQUE · M · corrigir agora
4. E2 heatBadge duplo em TODOS · INFO_DUPLICADA · P · corrigir agora
5. A3/E7 canal duplo · INFO_DUPLICADA · P · corrigir agora
6. E3 Ref tripla no pedido · INFO_DUPLICADA · P · corrigir agora
7. A4 descarte de repetidos por id · INFO_DUPLICADA (risco) · P · corrigir agora (prevenção barata)
8. E8 Fichas sem aba · INFO_DUPLICADA · P · backlog
9. E5 seletor único do guard · OUTRO · P · backlog ou junto do item 2
10. E6 acessibilidade do cartão · OUTRO · P · backlog
