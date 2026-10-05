# AUD-001 · rascunho do executor

- Pedido: AUD-001, auditoria do painel (somente achados, sem mudar código)
- Setor: design-ux-ui
- Papel: Nível 1 Executor
- Agente: subagente executor design-ux-ui (Claude Opus 5.5), base main atual (7a25ef1)
- Foco: badges e contagens duplicados na tela, elementos repetidos, comportamento visual de cartões clicáveis
- Método: leitura do código (painel/painel.js, painel/grupos.js, api/panel/manheim-options.js, migração 20261024020000); nenhum código alterado, nada publicado, nenhuma consulta ao banco

Visões visíveis na barra hoje: ATENDER AGORA (today), BUSCAR CARROS (requests), ENVIAR OPÇÕES (searches), TODOS (clients), IMPORTAÇÕES. As visões pending, qualification, manheim e records continuam no código, mas sem aba (painel/index.html:55-59; painel/painel.js:638).

## Achados

### 1. Cartão de pedido em ENVIAR OPÇÕES: cartão clicável dentro de cartão clicável abre o pedido duas vezes e o Voltar perde a posição
- Domínio: CLIQUES
- Gravidade: QUEBRA_CLIQUE
- Esforço: P
- Evidência: painel/painel.js:3716 `makeCardClickable(row, () => openDetail('order', order.ref))` na linha do carro e painel/painel.js:3724 `makeCardClickable(card, () => openDetail('order', order.ref))` no cartão que contém a linha. A tabela é um `div.manheim-table` (painel/painel.js:3013), não um `details`, então o guard do cartão (painel/painel.js:1738) não trata a linha como controle e o clique sobe: openDetail roda duas vezes. Cada chamada faz `history.pushState` (painel/painel.js:2226) e a segunda chama `captureOrigin()` (painel/painel.js:2224) depois que `showDetailShell` já escondeu os painéis (painel/painel.js:2213), gravando um scrollY da página encolhida. Resultado: duas entradas no histórico (o primeiro Voltar não sai do pedido), a origem gravada fica errada e a lista volta perto do topo; MCSLead.open também dispara duas leituras do pedido (a primeira é descartada por requestVersion, mas a chamada à API acontece). Ocorre quando o pedido aparece sem a seleção para o cliente (`demand.offer` ausente ou `offerPending`, painel/painel.js:3719-3721).
- Correção sugerida: tirar o makeCardClickable da linha (o cartão já abre o mesmo pedido) ou fazer o guard ignorar clique já tratado por um cartão interno (marcar o evento e checar no cartão externo); em openDetail, ignorar chamada repetida para o mesmo kind e key enquanto a anterior está abrindo. Spec Playwright: clicar numa linha do pedido sem seleção e conferir 1 pushState, 1 chamada a /api/panel/orders (ou equivalente) e scrollY restaurado no Voltar.

### 2. TODOS: badge da janela de compra aparece duas vezes no mesmo cartão
- Domínio: TELA
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: clientCard chama `identityHeader(item,{compact:true})` (painel/painel.js:1497), que chama `contactMeta` (painel/painel.js:1704); contactMeta sempre põe `heatBadge(item)` dentro de `details.temperature-details` (painel/painel.js:1687). Em "⋯ Mais" o mesmo cartão acrescenta de novo `const heat=heatBadge(item);if(heat)extra.append(heat)` (painel/painel.js:1511). heatBadge nunca devolve vazio (painel/painel.js:1686), então ao abrir "⋯ Mais" o operador vê duas vezes o mesmo rótulo, por exemplo "Pronto para comprar agora".
- Correção sugerida: remover o heatBadge de `extra` em clientCard (o cabeçalho já mostra, com a explicação).

### 3. ENVIAR OPÇÕES, cartão de pedido da calculadora: Ref repetida no cabeçalho
- Domínio: TELA
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: renderManheimOrderGroup monta `identityFacts(order.ref, ...)` (painel/painel.js:3678), que escreve o fato "Ref ABC12" (painel/painel.js:144); `dropWishFacts` só remove "Carro" e "Lance máx." (painel/painel.js:3009). Logo abaixo, o cartão acrescenta o badge `makeBadge(\`Ref ${order.ref}\`, 'blue')` (painel/painel.js:3685). Na lista sem seleção, cada carro ainda repete "Ref do pedido: ABC12" (painel/painel.js:3700).
- Correção sugerida: tirar o badge "Ref" do resumo (o cabeçalho já mostra a Ref, igual ao cartão de ficha) e a linha "Ref do pedido" por carro.

### 4. Confirmação dentro do cartão: clicar no texto da pergunta abre a ficha e a confirmação some sem resposta
- Domínio: CLIQUES
- Gravidade: QUEBRA_CLIQUE
- Esforço: P
- Evidência: askInline cria `div.warning.inline-confirm` com um `p` de texto e dois botões (painel/painel.js:4444-4454). O guard só conhece `button,input,select,textarea,a,label,details,summary` (painel/painel.js:1738); o `p` da pergunta não é controle, então um clique nele, dentro de cartão clicável, chama openDetail. Caso visível: o bloco "Falta o print do SMS" (smsPrintMissing, painel/painel.js:1716-1730) entra no cartão de pedido de ENVIAR OPÇÕES (painel/painel.js:3694) e no cartão de qualificação; o botão "Não chegou SMS · descartar" abre a pergunta com askInline (painel/painel.js:1727). Tocar no texto da pergunta (comum no celular) sai da lista e a promessa da confirmação nunca resolve. O mesmo vale para o aviso `staleNotice` (painel/painel.js:3044, também `inline-confirm`) e para a linha de status `manheim-card-status`.
- Correção sugerida: incluir no guard um marcador de bloco interativo (por exemplo `.inline-confirm` e um atributo `data-no-card-click`) e marcar com ele os blocos de ação dentro de cartões (sms-print-missing, staleNotice, auditBlock, offer-section).

### 5. Guard com lista fixa de tags: controles novos não entram sozinhos
- Domínio: CLIQUES
- Gravidade: OUTRO
- Esforço: P
- Evidência: a lista do guard é fixa (painel/painel.js:1738). Não cobre `[role=button]`, `[role=switch]` em elemento que não seja button, `[contenteditable]`, `img`, `audio`, `video`, nem `[tabindex]` interno. Hoje, na busca por `setAttribute('role'` só aparece role em button ou em mensagens de status (painel/painel.js:1763, 2040, 3605, 5494, 5604), então não há caso quebrado agora; o risco é o próximo controle novo. Hoje, várias peças compensam com `stopPropagation` manual (painel/painel.js:1509, 2581, 2608, 2766, 3484; painel/grupos.js:93, 103; painel/contexto.js:34), um padrão que já falhou antes (commit 77c9352).
- Correção sugerida: um único seletor de "não navega" com os papéis ARIA, mídia e o atributo `data-no-card-click`, mais um teste que percorre cada cartão clicável e confere que clicar em cada controle não muda a URL nem o scroll.

### 6. Cartão clicável sem papel acessível e sem tecla Espaço
- Domínio: CLIQUES
- Gravidade: OUTRO
- Esforço: P
- Evidência: makeCardClickable dá `tabIndex = 0` ao `article` (painel/painel.js:1733) mas não dá `role` nem rótulo, e o teclado só reage a Enter (painel/painel.js:1749-1751). Leitor de tela anuncia um "article" focável sem dizer que abre a ficha.
- Correção sugerida: `role="link"` (ou button) com `aria-label` "Abrir ficha de Nome" e Espaço tratado igual a Enter quando o alvo é o próprio cartão.

### 7. Canal de contato dito duas vezes nos cartões não compactos
- Domínio: TELA
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: identityHeader sem `compact` acrescenta `directLeadBadge` ("📱 Veio por mensagem · Via WhatsApp (sem calculadora)", painel/painel.js:1688-1689 e 1703) e logo depois contactMeta com o canal ("💬 WhatsApp", painel/painel.js:1682 e 1687). O próprio comentário em painel/painel.js:1702 diz que só o modo compacto mostra o canal uma vez. Cartões afetados: ENVIAR OPÇÕES por ficha (painel/painel.js:3549, visível) e os das visões sem aba (qualificação, painel/painel.js:2839; fichas, painel/painel.js:4891). Aparece quando o item traz `directLeadSource` e `contactChannel`.
- Correção sugerida: quando houver directLeadBadge, chamar contactMeta com `noChannel`.

### 8. Visão Fichas (sem aba): janela de compra e "Desligado" duplicados
- Domínio: TELA
- Gravidade: INFO_ERRADA_OU_DUPLICADA (baixa prioridade, visão sem aba)
- Esforço: P
- Evidência: renderRecords usa identityHeader (que já traz heatBadge via contactMeta, painel/painel.js:4891 e 1687) e acrescenta outro `heatBadge(item)` (painel/painel.js:4899). Em fichas e qualificação, o badge de status mostra "DESLIGADO" (painel/painel.js:4895 e 2843) e o journeySwitch ao lado mostra "Desligado — religar" (painel/painel.js:1762), além do motivo em outro badge (painel/painel.js:1786).
- Correção sugerida: tirar o heatBadge extra de renderRecords e não mostrar o badge de status quando o switch já diz Desligado. Ou registrar a visão como legado e removê-la.

## Conferido sem achado

- Contagem de opções por pedido e grupos Lane/Buy Now: os dois lados contam por VIN (`car_key` em supabase/migrations/20261024020000_manheim_resumo_rapido.sql:19-20 e 76), então "N opções no lote" e o contador da seleção partem da mesma regra.
- Badge "RESPONDIDO" repetido em qualificação: não ocorre, `stage` e `status` usam enums diferentes (status nunca é RESPONDIDO).
- Linhas de decisão em ATENDER AGORA: são movidas (não clonadas) para dentro do "⋯ Mais" do caso (painel/painel.js:2786) e voltam para a área de espera antes de redesenhar (painel/painel.js:2466-2470); não há duplicação nem religação de eventos.
- bindV2Photos é chamado uma vez só (painel/painel.js:2346).
