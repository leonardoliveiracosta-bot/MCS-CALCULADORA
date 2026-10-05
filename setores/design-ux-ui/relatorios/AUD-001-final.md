# AUD-001 · design-ux-ui · relatório final do aprovador

- Pedido: AUD-001, auditoria do painel, somente achados, sem alterar código
- Papel: Nível 3 Aprovador, agente distinto do executor e do revisor
- Base conferida: main atual na branch de trabalho (commit 7a25ef1)
- Ordem das etapas: executor gravou o rascunho, revisor registrou a avaliação cega e depois comparou, aprovador conferiu cada evidência no código e decidiu

## 1. O que foi pedido

Auditar o painel no domínio do setor (badges e contagens duplicados, itens repetidos na tela, comportamento de cartões clicáveis) cobrindo CLIQUES, TELA, DADOS e VENDAS, com evidência concreta, gravidade, esforço e correção sugerida para cada achado, sem mudar código, sem commit e sem publicar

## 2. O que foi entregue

- Executor: 8 achados (E1 a E8) e uma lista "conferido sem achado"
- Revisor: avaliação cega com 4 achados (A1 a A4) e reprodução do caso A1 com Playwright numa página mínima com a função literal; depois, comparação com o rascunho sem alterar a avaliação cega
- Aprovador: conferiu no código cada linha citada (painel/painel.js 144, 1497 a 1523, 1597, 1686 a 1704, 1716 a 1751, 1762, 2839 a 2843, 3009 a 3048, 3230 a 3321, 3549, 3678 a 3724, 4444 a 4454, 4891 a 4899; painel/action.js 63 a 66; api/panel/manheim-options.js 157)

Achados aprovados, com evidência confirmada pelo aprovador

| Nº | Achado | Domínio | Gravidade | Esforço | Corrigir agora |
|---|---|---|---|---|---|
| 1 | Linha de carro clicável dentro do cartão de pedido clicável em ENVIAR OPÇÕES abre o pedido duas vezes, cria duas entradas no histórico e grava a origem com a página já encolhida, a visão volta ao topo (painel.js 3716 e 3724; a linha é um div e o guard em 1738 deixa o clique subir) | CLIQUES | QUEBRA_CLIQUE | P | sim |
| 2 | Toque no texto da confirmação inline (askInline, painel.js 4446) dentro do bloco "Falta o print do SMS" (1727, anexado ao cartão em 3694) navega para o pedido e a confirmação fica sem resposta | CLIQUES | QUEBRA_CLIQUE | P | sim |
| 3 | Ações dentro do cartão de TODOS (Ligado, Já resolvi, Não é lead, assunto) recarregam só a página 1 com loadClients (painel.js 1520 a 1523 e 1597) e renderClients apaga a lista (1588); a posição do operador se perde | CLIQUES | QUEBRA_CLIQUE | M | sim |
| 4 | Badge da janela de compra duas vezes no cartão de TODOS: contactMeta já põe heatBadge no resumo de um details (1687) e o "⋯ Mais" acrescenta outro (1511); heatBadge nunca devolve vazio (1686) | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| 5 | Canal dito duas vezes fora do modo compacto: directLeadBadge (1703) e contactMeta sem noChannel (1704), visível em ENVIAR OPÇÕES por ficha (3549) | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| 6 | Ref repetida no cartão de pedido de ENVIAR OPÇÕES: fato "Ref" (144, dropWishFacts em 3009 não o remove), badge "Ref ABC12" (3685) e "Ref do pedido" em cada carro (3700) | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim |
| 7 | Páginas de carros sem descarte de repetidos: loadedIds só recebe add em 3295, sem conferir antes de desenhar; lazyOptions (3024) também não confere; paginação por offset (manheim-options.js 157). Risco de o mesmo carro aparecer duas vezes se o lote ativo mudar entre páginas | TELA | INFO_ERRADA_OU_DUPLICADA | P | sim, como prevenção barata |
| 8 | Visão Fichas, sem aba hoje: heatBadge duplicado (4891 com 4899) e "DESLIGADO" ao lado do botão "Desligado, religar" (4895 e 1762) | TELA | INFO_ERRADA_OU_DUPLICADA | P | não, visão fora da barra |
| 9 | Guard com lista fixa de tags (1738), sem papéis ARIA nem marcador de bloco interativo; hoje sem caso quebrado além do item 2 | CLIQUES | OUTRO | P | não, mas o marcador data-no-card-click pode entrar junto da correção do item 2 |
| 10 | Cartão clicável sem role e sem tecla Espaço (1733 e 1749 a 1751) | CLIQUES | OUTRO | P | não |

## 3. Divergências encontradas

- Item 2 (executor E4): o executor estendeu o defeito ao staleNotice e à linha de status; o revisor entendeu que clicar em texto comum desses blocos e abrir o pedido é o comportamento normal do cartão. Evidência: staleNotice (3044) não abre confirmação que fique pendente; só o askInline deixa uma promessa sem resposta. Decisão: vale o entendimento do revisor, o achado fica restrito ao askInline dentro de cartão
- Item 3 (revisor A2): só o revisor achou. O aprovador confirmou loadClients zerando para a página 1 e clientsSnapshot e restoreClientsPosition usados apenas na volta da ficha. Aprovado
- Item 4 (executor E2) e item 6 (executor E3): só o executor achou; o revisor concordou na comparação e o aprovador confirmou nas linhas citadas
- Item 7 (revisor A4): não reproduzido em produção, por regra de não ler o lote ativo; aprovado como risco com evidência de código, sem apresentar ocorrência real como fato
- Item 8: executor e revisor concordam no conteúdo; o aprovador rebaixa para backlog porque a visão não está na barra (index.html 55 a 59)
- Nenhum achado de nenhum lado foi refutado. Não houve achados nos domínios DADOS e VENDAS por este setor além do efeito do item 1 (duas leituras do mesmo pedido) e do risco do item 7

## 4. Decisão do aprovador

Aprovados para correção imediata (bloqueia venda, quebra clique ou mostra informação duplicada, com esforço P ou M): itens 1, 2, 3, 4, 5, 6 e 7

Aprovados para backlog, por impacto e esforço: item 8 (P, visão sem aba), item 9 (P, prevenção do guard, recomendado junto do item 2), item 10 (P, acessibilidade)

Rejeitados: nenhum

Condições para a correção, conforme o comando: spec Playwright que falha antes e passa depois em cada item de clique (1, 2 e 3), npm test verde, specs existentes verdes incluindo o filtro de trim, sem erro novo no console, sem quebrar abrir e fechar de details, seleção, toque no celular e navegação legítima dos cartões

Esta decisão não substitui a aprovação da Leo
