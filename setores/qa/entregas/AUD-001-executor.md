# AUD-001 · qa · rascunho do executor

- Pedido: AUD-001, auditoria do painel (somente achados, sem mudar código, sem commit, sem publicação)
- Papel: Nível 1 Executor do setor qa
- Agente: subagente executor qa (Claude), sessão de auditoria de 2026-10-04/05
- Base: main local em 7a25ef1 (inclui 77c9352 e 29e1bd9)
- Fontes: painel/painel.js, painel/whatsapp-envio.js, tests/*.spec.js, tests/*.test.js, Supabase de produção (só SELECT)

## O que foi executado (medido, não suposto)

- `npm test`: 871 testes, 871 passaram, 0 falharam
- Playwright, todos os specs exceto panel-responsive (exige PANEL_PREVIEW_URL), servidor local: 120 testes, 89 passaram, 31 falharam, 1 pulado, 2 não rodaram
- Os 10 que falharam por clique ou tempo foram rodados de novo sozinhos (1 worker): os 10 falharam de novo, então não é instabilidade
- Specs do filtro de trim (tests/manheim-trim.spec.js, 3 testes): verdes
- Reprodução isolada do guard: a função makeCardClickable copiada do painel.js para uma página de teste no Chromium, com cartões fictícios
- Reprodução no painel real (servidor local + banco PGlite dos specs), contando chamadas de API por visão
- Produção: um SELECT de contagem de VIN repetido na seleção para cliente (resultado 0 em 31 VINs selecionados)

## Achados

### 1. Clique numa linha de carro dentro do cartão de pedido abre o pedido duas vezes
- Domínio: CLIQUES · Gravidade: QUEBRA_CLIQUE · Esforço: P
- Evidência: painel/painel.js:3716 chama makeCardClickable(row) para cada linha, e a linha fica dentro do cartão que também é clicável (painel.js:3724). O guard (painel.js:1732 a 1752) não sabe de cartão clicável dentro de cartão clicável. Reprodução isolada no Chromium, clique no texto do carro: ações disparadas `["row","card"]`. No painel, cada ação chama openDetail, que faz pushState e captureOrigin (painel.js:2220 a 2226); a segunda captura já acontece com a lista escondida, então a origem salva fica perto do topo e o Voltar não volta ao ponto da lista, e o histórico ganha uma entrada a mais
- Onde aparece: caminho antigo do cartão de pedido da calculadora, usado quando a seleção não carregou (demand.offer nulo ou offerPending, panel-buscas-view.js:216 a 218)
- Correção sugerida: no click do guard, sair quando `event.target.closest('.clickable-card') !== card` (o cartão de dentro é o dono do clique), ou chamar stopPropagation depois da ação do cartão interno; spec Playwright que clica na linha e conta uma entrada de histórico só

### 2. Texto dentro do envio da V1 e das confirmações abre a ficha e desmonta a confirmação
- Domínio: VENDAS e CLIQUES · Gravidade: QUEBRA_CLIQUE · Esforço: P
- Evidência: o bloco de envio da V1 (painel.js:3380 a 3453) fica dentro do cartão clicável da busca (painel.js:3662 e 3664). Linha de destino, "Link V1: ...", prévia da mensagem (blockquote) e os avisos são p, blockquote e div, que o guard não reconhece como controle (lista em painel.js:1739: button, input, select, textarea, a, label, details, summary). Reprodução isolada, computador e celular (toque): clique na prévia da mensagem `["ficha"]`, clique na linha "Para Cliente Exemplo" `["ficha"]`, duplo clique no link V1 para selecionar `["ficha","ficha"]`; só o botão "Confirmar envio" não abre. O mesmo vale para as caixas de confirmação em linha (askInline, painel.js:4444, e painel.js:3044) dentro de cartões clicáveis, por exemplo "Não chegou SMS · descartar" (painel.js:1727) no cartão de pedido
- Efeito: quem está no meio do "Confirmar envio" e clica no texto para conferir ou copiar o link sai para a ficha; ao voltar a lista é redesenhada e a confirmação some
- Correção sugerida: incluir no seletor do guard `.inline-confirm, .v1-send, blockquote` (ou um atributo `data-no-card-click` posto nesses blocos); spec que clica na prévia e no link e confirma que a ficha não abre e a confirmação continua

### 3. "Comparar pedidos com este lote" e as abas abertas pela ficha carregam a visão duas vezes
- Domínio: DADOS · Gravidade: OUTRO (leitura repetida do banco) · Esforço: P
- Evidência: switchPanel já espera loadCurrent(view) (painel.js, função switchPanel, linha `try { await loadCurrent(view, requestVersion); }`), e dois lugares chamam de novo depois: painel.js:3766 (`switchPanel('requests').then(() => loadCurrent('requests', viewRequestVersion))`) e painel.js:2237 (openTab da ficha, mesmo padrão). Medição no painel local, clique em "Comparar pedidos com este lote": `GET /api/panel/pesquisas` 2 vezes e `GET /api/panel/searches` 2 vezes
- Correção sugerida: tirar o `.then(() => loadCurrent(...))` dos dois lugares; spec que conta uma chamada de cada

### 4. 31 specs Playwright vermelhos no main: a trava anti-regressão não tem base verde
- Domínio: QA (afeta CLIQUES e TELA) · Gravidade: OUTRO · Esforço: M a G
- Evidência (rodada completa e repetição isolada):
  - Ambiente (7 + 1): find-one.spec.js (4) e service-fee.spec.js (3) forçam o Chromium headless 1193, que não existe na máquina (`Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1193`); contexto-cliente.spec.js falha com `PANEL_NOT_CONFIGURED` sem variáveis do Supabase
  - Texto ou estrutura mudou e o spec ficou para trás: lote4.spec.js (2: aba "ATENDER AGORA" em vez de "ATENDIMENTO"), manheim-selecao.spec.js (4: contador agora "16 em Lane/Run · 1 em Buy Now / Make Offer · 0 de 10 selecionados"), organizacao.spec.js (2), pesquisas.spec.js (2: "ATENDIMENTO MANUAL" em vez de "SEM OPÇÃO NO LOTE"), resposta-orientada.spec.js (2: botão "Traduzir conversa (n)" não existe mais), triagem-entrada.spec.js (3) e lote3.spec.js:67 (o "⋯ Mais" do cartão do ATENDIMENTO é removido quando não há decisão pendente, painel.js:2788), lote3.spec.js:133 e marcacao-modo.spec.js (2: o menu ⋯ da mensagem só aparece ao passar o mouse, identidade.css:959 a 973), botoes-varredura.spec.js (1), manheim-import.spec.js (1: grupo INCOMPLETE com 0 linhas, esperado 10), manheim-complemento.spec.js (1: 2 combinações, esperado 3, coerente com a regra nova de um carro por VIN)
  - `npx playwright test` sem lista também pega os arquivos *.test.js do node (playwright.config.js sem testMatch) e para no erro de carga de panel-responsive.spec.js, então "rodar todos os specs" num comando só não funciona
- Correção sugerida: atualizar os specs que ficaram para trás conferindo um a um se a mudança foi intencional (principalmente manheim-import INCOMPLETE e manheim-complemento, que tocam contagem de carros); tirar o caminho fixo do Chromium 1193 de find-one e service-fee; pôr `testMatch: /.*\.spec\.js$/` no playwright.config.js e fazer panel-responsive pular (test.skip) em vez de lançar erro sem PANEL_PREVIEW_URL

### 5. O guard do cartão não tem teste de navegador fora da aba de buscas
- Domínio: CLIQUES · Gravidade: OUTRO (cobertura) · Esforço: M
- Evidência: são 9 chamadas de makeCardClickable (painel.js:1424, 1529, 2615, 2770, 2857, 3664, 3716, 3724, 4905). O único spec que exercita o guard é o terceiro teste de tests/manheim-trim.spec.js (cartão de busca). Nos testes node, tests/daily-use.test.js:79 só confere que a função existe (`assert.match(client, /function makeCardClickable/)`). Nenhum teste cobre cartão dentro de cartão, texto de confirmação, tela de toque ou duplo clique
- Correção sugerida: um spec único que, para cada tipo de cartão, clica em cada controle e em textos internos (confirmação, prévia, link) e confere que a ficha não abre e a rolagem não muda, e que um clique em parte livre abre a ficha uma vez só (computador e 390 px com toque)

### 6. Voltar da ficha não devolve a lista exatamente no mesmo ponto
- Domínio: CLIQUES · Gravidade: OUTRO · Esforço: M (a investigar)
- Evidência: no painel local (aba de opções, janela 1366 x 400), rolagem antes de abrir a ficha 2349 px, depois do Voltar 2027 px (322 px acima). Não volta ao topo, mas desloca
- Correção sugerida: investigar se a lista ainda está crescendo (grupos e contexto carregando) quando restoreOrigin aplica o scrollTo (painel.js:2108); ancorar no cartão de origem como já se faz em CLIENTES (restoreClientsPosition)

## Verificações que não viraram achado
- VIN repetido na seleção para cliente em produção: 0 grupos repetidos em 31 VINs selecionados (SELECT em manheim_option_selections com manheim_matches)
- Duplo clique num cartão no painel real: só uma entrada de histórico e uma chamada de /api/panel/lead, porque o primeiro clique já esconde a lista
- Chamadas por aba (início, buscas, pedidos, clientes, importações, atendimento): as repetidas foram boot (partes main e counters, de propósito) e v1-send demo_prepare (dois cartões de exemplo diferentes)
- Listeners de documento (wa-link.js:87, whatsapp-app.js:26) instalados uma vez só, na carga do script
