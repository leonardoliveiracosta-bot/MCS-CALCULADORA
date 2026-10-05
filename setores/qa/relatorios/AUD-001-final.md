# AUD-001 · qa · relatório final do aprovador

Papel: Nível 3 Aprovador do setor qa, distinto do executor e do revisor
Base conferida: main local em 7a25ef1
Fontes lidas: setores/README.md, setores/qa/entregas/AUD-001-executor.md, setores/qa/entregas/AUD-001-revisor.md e o código citado por eles

## 1. O que foi pedido

Auditoria do painel no domínio de qa, somente achados, sem mudar código, sem commit e sem publicar. Caçar problemas de cliques (guard do makeCardClickable, listeners repetidos, clique dentro de cartão que navega ou volta ao topo), de tela (mesmo VIN duas vezes, contagens repetidas), de dados (mesma API chamada duas vezes, leituras repetidas, consultas perto de 8 s, seleção guardada em dois lugares) e de vendas (seleção, V1, WhatsApp). Cada achado com domínio, gravidade, esforço, evidência e correção sugerida

## 2. O que foi entregue

- Executor: 6 achados, rodada de npm test (871 de 871) e Playwright (31 vermelhos), reproduções isoladas do guard e uma consulta de leitura em produção (0 VIN repetido em 31 selecionados)
- Revisor: avaliação cega com 6 achados, depois comparação com o rascunho; sustentou 4 do executor, aceitou 1 novo do executor, refutou parte de outro e deixou 1 como plausível sem reprodução
- Aprovador: conferi no código cada evidência abaixo

Achados aprovados

| # | Título | Domínio | Gravidade | Esforço | Corrigir agora |
|---|---|---|---|---|---|
| A1 | Linha de carro dentro do cartão de pedido abre o pedido duas vezes | CLIQUES | QUEBRA_CLIQUE | P | sim |
| A2 | Texto do envio da V1 e das confirmações em linha abre a ficha | VENDAS | QUEBRA_CLIQUE | P | sim |
| A3 | Atalhos para outra aba carregam a aba duas vezes | DADOS | OUTRO (leitura repetida) | P | sim, item 3 do comando |
| A4 | Clique em filtro de CLIENTES e ordenar conversa sem proteção do armazenamento | CLIQUES | QUEBRA_CLIQUE (borda) | P | sim |
| A5 | Base Playwright vermelha no main | QA | OUTRO | M | não pela regra, mas é pré-requisito da trava |
| A6 | Guard do cartão sem teste de navegador fora da aba de buscas | CLIQUES | OUTRO | M | não, o spec nasce junto com A1 e A2 |
| A7 | Seleção para o cliente guardada em dois lugares | VENDAS | OUTRO (risco) | M | não, backlog |

Evidência que conferi

- A1: painel/painel.js:3716 faz makeCardClickable(row) em cada linha e painel/painel.js:3724 faz makeCardClickable(card) no cartão que contém a tabela. O guard em painel/painel.js:1739 só reconhece button, input, select, textarea, a, label, details, summary, então o clique na linha roda a ação da linha e sobe para o cartão. Correção: no click do guard, sair quando event.target.closest('.clickable-card') não for o próprio cartão
- A2: painel/painel.js:3662 põe v1Send.node dentro do cartão e painel/painel.js:3664 torna o cartão clicável. A confirmação da V1 (painel/painel.js:3449 a 3453) é div.inline-confirm com p e blockquote; askInline (painel/painel.js:4446) e o aviso de painel/painel.js:3044 montam o mesmo tipo de caixa. Nenhum desses está no seletor do guard. Correção: incluir .inline-confirm, .v1-send e blockquote no seletor do guard (ou atributo data-no-card-click)
- A3: painel/painel.js:3766 e painel/painel.js:2237 fazem switchPanel(view).then(() => loadCurrent(view, ...)), e switchPanel já espera loadCurrent (painel/painel.js:643). As duas avaliações mediram as chamadas em dobro (pesquisas e searches). Correção: deixar só switchPanel(view)
- A4: painel/painel.js:1537 e painel/painel.js:5294 chamam localStorage.setItem sem try/catch, enquanto painel/painel.js:2656 já protege. Correção: envolver em try/catch
- A5: tests/manheim-selecao.spec.js:86 espera o texto antigo do contador ("16 passam em Lane/Run ... Selecionados 0 de 10"), e o código atual (painel/painel.js:3512) pinta "16 em Lane/Run · ... de 10 selecionados". playwright.config.js não tem testMatch e tests/panel-responsive.spec.js:6 lança erro sem PANEL_PREVIEW_URL. Correção: atualizar os specs velhos um a um, pôr testMatch para *.spec.js, trocar o throw de panel-responsive por test.skip
- A6: tests/daily-use.test.js:79 só confere que a função existe; um único spec de navegador exercita o guard (tests/manheim-trim.spec.js)
- A7: painel/painel.js:3508 cria o Set local e painel/painel.js:3513 setSelected ignora o terceiro argumento total, que vem de result.selectedCount (painel/painel.js:3174). Medido em produção pelo revisor: 0 divergências hoje. Risco, sem falha observada

## 3. Divergências encontradas

- Chromium 1193 forçado em find-one e service-fee: o executor afirmou, o revisor refutou. Conferi: tests/find-one.spec.js:10 e tests/service-fee.spec.js:9 usam process.env.CHROMIUM_PATH ou o padrão, igual aos outros. Vale o revisor; é falha de ambiente, não do spec
- Causa da falha de resposta-orientada.spec.js: o executor disse que o botão "Traduzir conversa (n)" não existe mais; o texto ainda existe em painel/lead.js:374. A causa fica pendente de verificação
- Contagem de specs vermelhos: executor 31 (rodada ampla), revisor 5 (recorte menor). As duas sustentam que a base não está verde; a lista exata fica para a primeira tarefa da Fase 2
- Grupo "informação incompleta": tests/manheim-selecao.spec.js:213 espera "6 incompletos" e a tela não mostra o grupo; o executor viu o mesmo em manheim-import e manheim-complemento. Nenhum dos dois provou se é spec velho ou regressão de contagem. Pendência: reproduzir antes de mexer no spec, porque pode ser informação errada na tela
- Voltar da ficha 322 px acima: o executor mediu, o revisor não reproduziu, eu também não reproduzi. Não entra como achado aprovado; volta para verificação
- Duplo clique no link V1 abrindo a ficha duas vezes: o guard confere texto selecionado (painel/painel.js:1747), então o caso fica provável e coberto pela correção de A2, sem ser afirmado como fato

## 4. Decisão do aprovador

- Aprovados para correção imediata, todos de esforço pequeno e dentro da regra do comando: A1 e A2 (guard do makeCardClickable, item 1), A3 (leitura duplicada, item 3), A4 (clique que pode falhar)
- Pré-requisito antes de qualquer correção: deixar a base Playwright verde (A5), conferindo spec por spec se a mudança foi intencional; o caso do grupo incompleto só se resolve depois de reproduzido
- Backlog por impacto e esforço: A6 (M, nasce junto com as correções de A1 e A2), A7 (M, risco de V1 com id fora da tela)
- Rejeitados como fato: Chromium 1193 forçado pelos specs; botão de tradução inexistente; deslocamento de 322 px no Voltar (devolvido para verificação)
- Esta decisão não substitui a aprovação da Leo
