# AUD-001 · qa · Nível 2 Revisor independente

Pedido: AUD-001, auditoria do painel, somente achados, sem alterar código, sem commit, sem publicar
Agente: Nível 2 Revisor independente do setor qa
Ordem das etapas: 1) avaliação cega abaixo, gravada sem abrir o rascunho do executor; 2) comparação com o rascunho fica para depois, em seção própria

## Avaliação cega

Base: main atual (7a25ef1). Banco de produção só com SELECT (leituras de funções STABLE com tempo medido). Reproduções com Playwright num spec descartável fora do repositório (scratchpad), com API simulada e dados fictícios (Ref ABCDE, VIN 1HGTESTE000000001)

### Achado 1 · CLIQUES · QUEBRA_CLIQUE · esforço P
Título: linha de carro dentro de cartão clicável abre o pedido duas vezes e o Voltar não volta

Evidência
- painel/painel.js:3716 faz makeCardClickable(row) em cada linha .manheim-row, e a linha fica dentro do cartão que também recebe makeCardClickable(card) em painel/painel.js:3724 (renderManheimOrderGroup, lista "Ver opções" de pedido da calculadora sem seleção)
- O guard (painel/painel.js:1732 a 1751) só reconhece button, input, select, textarea, a, label, details, summary. Um cartão clicável dentro de outro não é reconhecido: o clique roda a ação da linha e sobe para o cartão, que roda de novo
- Reprodução Playwright (ENVIAR OPÇÕES, abrir "Ver opções", clicar no nome do carro): history.length +2, GET /api/panel/lead +2; depois de clicar em "Voltar" o painel continua no detalhe (#pedido/ABCDE), precisa de dois Voltar
- Nenhum spec existente cobre cartão clicável aninhado (tests/manheim-trim.spec.js:146 cobre só apertar e soltar no mesmo lugar)

Correção sugerida: no guard, ignorar o clique quando event.target.closest('.clickable-card') não for o próprio cartão (o filho já tratou); spec que falha antes (history +2) e passa depois (+1, Voltar volta à lista na mesma posição)

### Achado 2 · DADOS · OUTRO · esforço P
Título: atalhos para outra aba carregam a aba duas vezes

Evidência
- painel/painel.js:3766 (link "Comparar pedidos com este lote (BUSCAR CARROS)") e painel/painel.js:2237 (openTab da ficha, botão "Abrir ENVIAR OPÇÕES") fazem switchPanel(view).then(() => loadCurrent(view, ...)). switchPanel (painel/painel.js:642) já chama loadCurrent, então a aba carrega e desenha duas vezes
- Reprodução Playwright no link de BUSCAR CARROS: chamadas depois do clique = /api/panel/pesquisas, /api/panel/searches, /api/panel/pesquisas, /api/panel/searches
- Na aba ENVIAR OPÇÕES a leitura repetida é /api/panel/records?view=manheim, que em produção roda três funções em paralelo de cerca de 2 s cada (batch_summary 1,9 s, offer_summary 1,9 s, batch_cars 2,1 s, medidos agora); o segundo desenho também refaz a lista depois de a posição ter sido restaurada

Correção sugerida: trocar por switchPanel(view) só, nos dois lugares; spec contando uma chamada por aba

### Achado 3 · QA · OUTRO · esforço M
Título: cinco specs Playwright já falham no main, a trava "todos os specs verdes" não fecha hoje

Evidência (rodado agora no main, um worker)
- tests/manheim-selecao.spec.js:79, :236, :266 esperam o texto antigo do contador ("16 passam em Lane/Run ... Selecionados 0 de 10"); a tela mostra "16 em Lane/Run · 1 em Buy Now / Make Offer · 0 de 10 selecionados"
- tests/manheim-selecao.spec.js:203 espera "6 incompletos" antes do complemento; a tela mostra "3 em Buy Now / Make Offer". Três carros sem Lane/Run nem Buy Now não aparecem em grupo nenhum. Em produção incomplete_count soma 0 no lote ativo, coerente com a regra de venda ativa em panel_manheim_grouped_options; falta decidir se o spec está velho ou se o grupo "Informação incompleta" deixou de funcionar
- tests/botoes-varredura.spec.js:74 falha: '#record-detail button' nth(3) fica oculto ao abrir a ficha em CLIENTES
- Os specs do filtro de trim (tests/manheim-trim.spec.js, 4 testes) passam; tests/protecoes.spec.js passa inteiro; npm test passa 871 de 871

Correção sugerida: atualizar os textos esperados nos três specs do contador; o aprovador decide o caso dos incompletos (spec velho ou regressão) antes de mexer no :203; investigar a varredura de botões na ficha. Sem isso nenhuma correção da Fase 2 consegue provar "todos verdes"

### Achado 4 · VENDAS · OUTRO · esforço M
Título: seleção para o cliente guardada em dois lugares (Set local e banco)

Evidência
- painel/painel.js:3508 cria state.selectedIds a partir do servidor; painel/painel.js:3513 setSelected ignora o terceiro argumento total; painel/painel.js:3174 recebe result.selectedCount do banco e não usa
- O contador "N de 10 selecionados" (3512), o Baixar PDF (3613) e a V1 (3634) leem só o Set local, com o id da linha que representa o VIN
- A seleção é gravada no id de uma venda do grupo do VIN (memberMatchIds); se a venda representante mudar (complemento do lote), o id antigo fica no Set e a V1 manda id que não está mais na tela
- Medido em produção agora: 6 seleções ativas em 2 pedidos, todas com id igual ao representante (0 divergentes). Risco, não falha observada hoje

Correção sugerida: usar result.selectedCount no contador e, após selecionar ou remover, reler selected_ids do servidor (ou mapear por memberMatchIds) antes de montar PDF e V1

### Achado 5 · CLIQUES · QUEBRA_CLIQUE (caso de borda) · esforço P
Título: clique em filtro de CLIENTES grava no localStorage sem proteção

Evidência
- painel/painel.js:1537 (chips de situação em CLIENTES) chama localStorage.setItem antes de loadClients, sem try/catch; painel/painel.js:5294 (ordenar conversa) idem. Em navegador com armazenamento bloqueado o setItem lança e o clique não filtra
- Outros pontos já protegem (painel/painel.js:2656 usa try/catch)

Correção sugerida: envolver os setItem em try/catch

### Achado 6 · QA · OUTRO · esforço P
Título: teste do guard só confere que a função existe

Evidência: tests/daily-use.test.js:79 faz apenas assert.match(client, /function makeCardClickable/); a regra do guard (controles, aninhamento, texto selecionado, teclado Enter) só tem um spec de navegador (tests/manheim-trim.spec.js:146)

Correção sugerida: spec único cobrindo os nove usos de makeCardClickable (1424, 1529, 2615, 2770, 2857, 3664, 3716, 3724, 4905) com clique em controle, em details/summary, em cartão aninhado e tap no celular

### Conferido sem achado (com evidência)
- Mesmo VIN duas vezes em ENVIAR OPÇÕES: as páginas (panel_manheim_offer_page, _sorted, _trim, demand_options) leem panel_manheim_grouped_options, que agrupa por pedido e VIN. A tabela crua tem 55.454 linhas para 47.758 pares pedido e VIN no lote ativo, mas nenhuma tela lê a tabela crua sem agrupar
- Contagens: soma de match_count (batch_summary) 39.422 igual à soma de carros agrupados por VIN 39.422; batch_people por modo com 0 divergências em 385 pedidos; offer_summary contra batch_summary com 0 divergências
- Limite de 8 s: maior pedido do lote (2.362 carros agrupados) responde página em 0,75 s, trims em 0,64 s; resumos do lote em cerca de 2 s. panel_manheim_grouped_options sem pedido leva 10 s, mas só é chamada assim no caminho de reserva (panel-buscas-view.js:113, quando falta a tabela de seleção)
- "também bate para": no máximo 24 linhas por VIN no lote ativo, longe do limite de 2.000 em api/panel/manheim-options.js:57
- Listeners globais: só amarrados uma vez no boot (painel/painel.js:5665 em diante)

### Observação de processo
- A primeira rodada com o config padrão gerou a pasta test-results na raiz do repositório e eu a removi; as rodadas seguintes gravaram fora do repositório. Specs Playwright de vários agentes disputam a porta 4173, o que dá falso ERR_CONNECTION_REFUSED; usei a porta 4199 nas reproduções

## Comparação com o rascunho

Feita depois de gravada a avaliação cega. Cada achado conferido de novo no código do main (7a25ef1) tentando refutar.

### Achados do executor
- E1 linha de carro dentro de cartão abre o pedido duas vezes: SUSTENTADO, concorda com o meu Achado 1 (painel/painel.js:3716 e :3724, guard em :1739 não conhece cartão aninhado). Mesma correção sugerida
- E2 texto do envio da V1 e das confirmações abre a ficha: SUSTENTADO, achado que eu não tinha. painel/painel.js:3662 põe v1Send.node dentro do cartão e :3664 o torna clicável; a prévia é blockquote (bloco da V1, ~:3453) e askInline (:4444) e staleNotice (:3044) montam div.inline-confirm com p, nenhum deles está no seletor do guard (:1739). O botão "Não chegou SMS" para a propagação (:1727), mas o texto da confirmação que ele abre não. Não reproduzi o duplo clique no link; o guard confere seleção de texto, então o caso do duplo clique fica como provável, não medido por mim. Classifico VENDAS + QUEBRA_CLIQUE, esforço P
- E3 atalho para outra aba carrega duas vezes: SUSTENTADO, concorda com o meu Achado 2 (painel/painel.js:3766 e :2237; medições iguais nas duas avaliações)
- E4 31 specs vermelhos: DIVERGENTE na contagem e em parte da causa. Concordo que a base não está verde (meu Achado 3 cobre manheim-selecao e botoes-varredura). Conferido: "ATENDER AGORA" em painel/index.html:53 contra "ATENDIMENTO" em tests/lote4.spec.js:42; "Traduzir conversa (n)" ainda existe em painel/lead.js:374, então resposta-orientada precisa de outra causa. REFUTADO o trecho "find-one e service-fee forçam o Chromium 1193": os dois specs usam CHROMIUM_PATH ou o padrão (tests/find-one.spec.js:10, tests/service-fee.spec.js:9), igual aos outros; sem CHROMIUM_PATH falta o navegador 1193, com CHROMIUM_PATH=chromium-1194 ainda falham porque esperam a calculadora no servidor de PANEL_VISUAL_LOCAL. É falha de ambiente e de forma de rodar, não de código do spec. Sustentado: playwright.config.js não tem testMatch e tests/panel-responsive.spec.js:6 lança erro sem PANEL_PREVIEW_URL
- E5 guard sem teste de navegador: SUSTENTADO, concorda com o meu Achado 6 (tests/daily-use.test.js:79)
- E6 Voltar da ficha devolve 322 px acima: PLAUSÍVEL, não reproduzido por mim. O código confirma o mecanismo possível: restoreOrigin chama switchPanel e depois aplica scrollTo num requestAnimationFrame (painel/painel.js:2102 e :2108), sem âncora fora de CLIENTES. Gravidade OUTRO, fica para backlog com reprodução antes

### Achados meus que o executor não tem
- R4 seleção em dois lugares (Set local e banco): SUSTENTADO de novo no código (painel/painel.js:3513 setSelected ignora total). É risco, 0 divergências medidas em produção; o executor mediu 0 VIN repetido em 31 selecionados, coerente. Backlog, não correção imediata
- R5 setItem sem try/catch em clique de filtro: SUSTENTADO (painel/painel.js:1537 e :5294), caso de borda, esforço P
- R3 detalhe do grupo incompleto (tests/manheim-selecao.spec.js:203, e o executor viu o mesmo em manheim-import INCOMPLETE 0 de 10 e manheim-complemento 2 de 3): CONCORDAM os dois lados; decisão do aprovador se é spec velho ou regressão de contagem

### Resumo
- Sustentados nos dois lados: guard com cartão aninhado, carga dupla da aba, base Playwright vermelha, cobertura fraca do guard
- Novo sustentado vindo do executor: texto da V1 e das confirmações abre a ficha (entra na Fase 2, item 1 do guard)
- Refutado: Chromium 1193 forçado pelos specs
- Plausível sem reprodução: deslocamento de 322 px no Voltar
