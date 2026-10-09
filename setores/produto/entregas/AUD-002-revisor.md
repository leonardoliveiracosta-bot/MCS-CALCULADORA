# AUD-002 Nível 2 Revisor independente (produto)

- Data: 2026-10-09
- Pedido: AUD-002, acompanhamento dos 14 achados da AUD-001 do setor produto (A1 a A10 e B1 a B4)
- Papel: Nível 2 Revisor independente, etapa cega (sem comparação nesta versão; ela será acrescentada depois, sem apagar esta avaliação)
- Limites cumpridos: nenhum código alterado, nenhuma migração, nada publicado, nenhum comentário em PR; no banco só SELECT e EXPLAIN de leitura
- Única escrita no repositório: este arquivo. Testes e sondas rodaram com saída no diretório temporário da sessão, fora do repositório

## Fontes

- setores/README.md, setores/produto/EQUIPE.md, CLAUDE.md, setores/produto/entregas/AUD-002-pedido.md
- setores/produto/relatorios/AUD-001-final.md e setores/AUD-001-achados.json (ids globais 56 a 69 do setor produto)
- Código do diretório de trabalho: painel/painel.js, painel/action.js, api/panel/manheim-options.js, api/panel/vitrines.js, api/panel/v1-send.js, panel-buscas.js, panel-buscas-view.js, panel-counter-summary.js, panel-manheim-batch.js, supabase/migrations
- git log e git show dos commits de main desde a base da AUD-001
- Testes: tests/aud001-venda.spec.js, tests/manheim-conferencia.spec.js, tests/aud001-atualizacao.spec.js (rodados aqui) e a lista de tests/
- Banco de produção (projeto wwmakfaqahlbjzqvzgbr): 1 consulta leve ao catálogo e 2 consultas pesadas (limite do pedido: 3)

## Registro de transparência

- Base da AUD-001: o commit 7a25ef1 não existe no histórico, nem depois de aprofundar o clone (git fetch --deepen). Era um commit da branch de trabalho que foi incorporado por squash no PR #210 (9a22358). Usei como base o main imediatamente antes de fd79328 (20687cd), coerente com o executor da AUD-001 ("guard do commit 77c9352") e com a mensagem do #210 ("#56/#100 já corrigidos em fd79328")
- Durante esta etapa, outros agentes gravaram commits nesta mesma branch (92f320a, 2c7c478, 3bb668d, 0396b88, aa18ff8). Todos só acrescentam arquivos em setores/ (conferido por `git diff --stat`); o código avaliado é o mesmo do commit do pedido (68cc468)
- Uma busca `git log -S` mostrou na tela apenas os títulos desses commits, entre eles "AUD-002 rascunho do executor de produto". Não abri, não li e não fiz diff do conteúdo de nenhum arquivo AUD-002-executor.md nem dos relatórios de QA da AUD-002. A avaliação abaixo vem só do código, dos testes e do banco

## Avaliação cega

| Nº | Achado (resumo) | Estado | Evidência hoje (arquivo:linha) | Commit ou PR | Teste Playwright |
|---|---|---|---|---|---|
| A1 | Conferência velha no navegador trava a V1 | RESOLVIDO | painel.js:4281 a 4288 `setSelected` marca CONFERINDO ou SEM_SELECAO e dispara `audit-changed`; painel.js:4278 o botão da V1 só depende de haver seleção; painel.js:4651 a 4655 em MANHEIM_AUDIT_PENDING sempre confere e tenta de novo | fd79328, levado à tela nova em 43a5f70 (#253) | Existe: manheim-conferencia.spec.js:207 (passou aqui). Não conferi se falhava antes |
| A2 | Seleção volta ao retrato antigo ao reordenar | RESOLVIDO | painel.js:4283 `offer.selectedIds = [...state.selectedIds]`; painel.js:4238 e 4346 a 4350 reordenar só refaz a lista e mantém `state.selectedIds`; as colunas antigas e o GET repetido de v1-send não existem mais | 9a22358 (#210), forma atual em 43a5f70 (#253) | Existe: aud001-venda.spec.js:79 (passou aqui) |
| A3 | Seleção gravada no id de outro membro do VIN (latente) | ABERTO | migração 20261022010000:265 troca `p_match_id` pelo membro e devolve `'matchId', p_match_id` (312); função ao vivo em produção igual; resumo 20261031095000:35 e 42 devolve `first_selected` do membro; painel compara por `option.id` (painel.js:4428, 4456) e o PDF busca por `option.id` (painel.js:3297) | nenhum | Não existe |
| A4 | Sincronização redesenha ENVIAR OPÇÕES e apaga o trabalho | RESOLVIDO | `runOptionsSync` ainda chama `loadCurrent()` sem trava (painel.js:357), mas `renderManheim` só redesenha a fila (painel.js:3849 e 3982); o trabalho vive na tela separada `#options-client` (index.html:335), que nada disso toca; a atualização de 120 s pausa com trabalho aberto (painel.js:6330 a 6343) | 607644d (#213), b4bcdd2 (#218), 43a5f70 (#253) | Existe: aud001-atualizacao.spec.js:80 (passou aqui); cobre o agendador de 120 s, não o caminho da sincronização |
| A5 | Linha clicável dentro de cartão clicável abre o pedido duas vezes | RESOLVIDO | `renderManheimOrderGroup` foi removida; hoje nenhum `makeCardClickable` fica dentro de outro (painel.js:1486, 1618, 2472, 3134, 3135; fila usa `guardCardClick` em 4055). O guard (painel.js:1826 a 1843) continua sem tratar cartão dentro de cartão | b4bcdd2 (#218) | Não existe teste específico |
| A6 | Valor em dólar digitado e Selecionar logo depois grava outro preço | ABERTO | `priceBody` igual (painel.js:3558) manda `pct` enquanto `info.manualFinal` é falso; valor só salvo no `change` (painel.js:3587 a 3595); no banco SELECT com pct recalcula e desliga o valor manual (migração 20261022010000:287 e 288). Reproduzido aqui (detalhe abaixo) | nenhum (o #210 registrou "não reproduzido") | Existe aud001-venda.spec.js:105 e passa, mas não exercita o defeito |
| A7 | "Ver opções" de outra aba lê duas vezes e não abre o que promete | ABERTO | `openOptionsCard` (painel.js:1938 a 1940): `switchPanel('searches')` já espera `loadCurrent` (painel.js:691) e logo vem outro `loadCurrent('searches')`, que usa `request` e não `sharedGet` (painel.js:2045). O destino agora é só destacar a linha da fila (painel.js:1942 a 1950), sem abrir a tela do cliente | nenhum | Não existe |
| A8 | Contador da aba e lista de ENVIAR OPÇÕES não batem | PARCIAL | Dentro da aba o número vem das mesmas linhas da fila (painel.js:3943). Mas a carga inicial e o primeiro desenho ainda usam a regra antiga `matchCount > 0`, que inclui quem já recebeu V1 e demandas sem linha na fila (painel.js:2149, 3808, 3837; panel-counter-summary.js:15 a 17); e o texto "N na fila" conta todas as linhas (painel.js:3983) | 9e00785 (#231) mudou a fila | Não existe teste do contador |
| A9 | Selecionar roda a função pesada de grupos três vezes | ABERTO | migração 20261022010000:262, 280 e 311; a função ao vivo em produção tem as 3 chamadas; uma chamada na maior demanda levou 1,21 s | nenhum (os perf de 2026-10-08 mexeram em outras funções) | Não se aplica |
| A10 | Cada página relê a base inteira e todas as vitrines; PDF em série | ABERTO | manheim-options.js:146 `contextFor` depois da página, em série; 48 a 53 `loadBuscasBase` lê a base inteira por pedido (o cache é só da mesma requisição, panel-buscas.js:16 a 24); 62 `allRows('vitrines')` sem filtro; painel.js:3290 a 3302 PDF pagina de 50 em 50, grupo a grupo | nenhum | Não se aplica |
| B1 | Erros sem texto próprio | PARCIAL | MANHEIM_SALE_ENDED ganhou texto na V1 (painel.js:4596) mas segue fora de `OFFER_ERRORS` (painel.js:3435 a 3445), e o banco o lança no Selecionar e no preço (migração 20261022010000:263). VITRINE_VIN_DUPLICATE continua sem texto (painel.js:4591 a 4598; servidor em vitrines.js:113 e v1-send.js:89 e 140) | 73b679f (#226) | Não existe |
| B2 | Observação interna não é salva sozinha | ABERTO | campo `offer-note` sem listener (painel.js:3549); a nota só viaja junto com select, remove, exclude ou price (painel.js:3559, 3585, 3593) | nenhum | Não existe |
| B3 | Reativação: lista só BATE, seleção mostra todos os grupos | MUDOU | A lista antiga não existe; a fila conta pelos grupos da oferta (`offerTotal`, painel.js:3928), igual à tela do cliente. A regra só BATE ficou em `matchCount` (panel-buscas-view.js:75 a 80), usado no contador da carga inicial e no resumo da ficha. Continua dependendo da decisão da Leo | b4bcdd2 (#218), 43a5f70 (#253) | Não se aplica até a decisão |
| B4 | Pedido sem ficha deixa selecionar sem V1, PDF nem WhatsApp | PARCIAL | A tela do cliente abre para pedido sem ficha e deixa selecionar; Gerar V1 e Copiar link agora explicam "Vincule o pedido a uma ficha para gerar a V1" (painel.js:4643); o PDF ainda responde "Não consegui preparar o PDF agora" (painel.js:4622 e 4623), sem dizer o motivo. Produção hoje: 0 casos | b4bcdd2 (#218) | Não existe |

Resumo da contagem: RESOLVIDO 4 (A1, A2, A4, A5), PARCIAL 3 (A8, B1, B4), ABERTO 6 (A3, A6, A7, A9, A10, B2), MUDOU 1 (B3)

## Detalhes por achado, separando fato, suposição e risco

### A1 RESOLVIDO
- Fato: trocar a seleção volta o selo para Conferindo (painel.js:4285 a 4287); o botão Gerar V1 não depende mais do estado da conferência no navegador (painel.js:4278); quando o servidor responde MANHEIM_AUDIT_PENDING, a tela pede a conferência e tenta a V1 de novo, qualquer que seja o selo (painel.js:4651 a 4655). `auditCanTry` não existe mais no código
- Fato: o spec manheim-conferencia.spec.js passou inteiro aqui (8 testes), incluindo "seleção trocada depois de conferida" (linha 207) e "#101" (linha 226)
- Risco: não rodei o spec contra o código anterior, então não confirmei que ele falhava antes

### A2 RESOLVIDO
- Fato: `setSelected` atualiza o retrato da página (painel.js:4283) e reordenar só recarrega a lista mantendo a seleção (painel.js:4346 a 4350). As duas colunas e o GET repetido de v1-send citados na AUD-001 deixaram de existir com a fila (b4bcdd2) e a tela do cliente (43a5f70)
- Fato: aud001-venda.spec.js:79 passou aqui

### A3 ABERTO (latente)
- Fato: o banco continua trocando o id gravado pelo membro já selecionado do mesmo VIN (migração 20261022010000:265) e a função ao vivo em produção contém essa troca (conferido no catálogo). O resumo devolve o id do membro (`first_selected`, migração 20261031095000:35 e 42), enquanto a tela marca a caixa por `option.id` do representante (painel.js:4428 e 4456) e o PDF procura por `option.id` (painel.js:3297)
- Fato, contagem em produção hoje: no lote ativo há 2.116 carros agrupados em 248 demandas, 1 grupo selecionado e 0 grupos com a seleção gravada em outro membro. A contagem da AUD-001 (0 casos) continua valendo
- Risco: quando acontecer, a caixa aparece desmarcada para um carro selecionado e o PDF percorre todos os grupos sem achar o carro. Pela regra Exceção continua exceção, hoje é caso raro (0 de 1)

### A4 RESOLVIDO
- Fato: a recarga da sincronização continua sem trava (painel.js:357), mas o que ela redesenha é só a fila (painel.js:3849, 3899 a 3944, 3982). Grupos, carros abertos, preço, trim e seleção vivem em `#options-client` (index.html:335), que essa recarga não toca. A atualização de 120 s pausa com trim ou selecionados abertos e avisa (painel.js:6330 a 6343)
- Fato: aud001-atualizacao.spec.js:80 passou aqui
- Suposição: o caminho da sincronização (`runOptionsSync`) não tem teste próprio; considero coberto porque usa o mesmo `loadCurrent` do agendador testado
- Risco: o texto da V1 aberto pela função `v1SendControls` só aparece hoje no exemplo fictício (painel.js:3800); se voltar para a tela real, a recarga da sincronização não respeita a pausa

### A5 RESOLVIDO
- Fato: o cartão do pedido com linha clicável dentro foi removido em b4bcdd2 (#218); nos usos atuais de `makeCardClickable` não há um dentro do outro
- Risco: o guard (painel.js:1826 a 1843) segue sem parar a propagação nem ignorar `.clickable-card` interno; um cartão clicável dentro de outro voltaria a abrir duas vezes. Não há teste para isso

### A6 ABERTO
- Fato, código: igual ao da AUD-001 no painel (painel.js:3547, 3548, 3558, 3587 a 3595) e no banco (migração 20261022010000:285 a 288)
- Fato, reprodução: rodei uma sonda Playwright no diretório temporário, com os handlers reais e o banco PGlite com as migrações do repositório, no mesmo cenário do spec #61. Resultado: com o pedido de preço e o de seleção na ordem natural, o Selecionar foi com `pct` 5,01 e o valor gravado ficou US$ 1 acima do digitado (exemplo fictício: digitado 26.283, gravado 26.284), com `manual_final` falso
- Fato: o spec aud001-venda.spec.js:105 passa, mas soma só US$ 1 ao valor padrão; o percentual arredondado volta a ser igual ao padrão, a tela manda `pct` nulo e o banco mantém o valor digitado. Por isso o #210 registrou "não reproduzido". O teste não falha com o defeito presente
- Risco: o preço da V1 sai diferente do digitado quando o operador digita um valor longe do padrão e clica Selecionar sem sair do campo antes

### A7 ABERTO
- Fato: o botão "Ver as N opções" de BUSCAR CARROS (painel.js:4921) chama `openOptionsCard`, que lê a visão do lote duas vezes seguidas (painel.js:1939 e 1940, com 691 e 2045)
- Fato: a segunda metade mudou de forma: o destino agora é destacar a linha da fila (painel.js:1942 a 1950), sem abrir a tela do cliente; o operador precisa tocar de novo. O "Ver opções" da ficha usa outro caminho (`openClientOptionsFrom`, painel.js:4126 a 4133), que abre a tela e não repete a leitura

### A8 PARCIAL
- Fato: dentro da aba, o número da aba vem das mesmas linhas da fila: pessoas com carro e sem V1 (painel.js:3943)
- Fato: a carga inicial dos contadores e o primeiro desenho da aba ainda usam `optionsPeopleOf` com `matchCount > 0` (painel.js:2149, 3808, 3837; panel-counter-summary.js:15 a 17), que conta também quem já recebeu V1 e demandas cuja ficha não está na lista; o número muda ao abrir a aba
- Fato: o texto acima da fila diz "N na fila" contando todas as linhas, inclusive sem carro e com V1 já enviada (painel.js:3983), enquanto a aba conta só quem tem carro e espera a V1
- Suposição: não medi em produção quantas pessoas caem na diferença

### A9 ABERTO
- Fato: `panel_manheim_offer_select_v2` em produção tem 3 chamadas a `panel_manheim_grouped_options` (contadas no texto da função ao vivo). Uma chamada na demanda com mais combinações do lote ativo levou 1,21 s (EXPLAIN ANALYZE, incluindo a busca da maior demanda); a AUD-001 tinha medido 0,7 a 0,9 s
- Suposição: um Selecionar nessa demanda leva em torno de 3 s só nessas leituras

### A10 ABERTO
- Fato: nada mudou em manheim-options.js desde a base além de 73b679f e 43a5f70, que não tocaram nesses pontos

### B1 PARCIAL
- Fato: na V1, MANHEIM_SALE_ENDED tem texto próprio, com os carros que saíram (painel.js:4596, de 73b679f). No Selecionar e no preço, o mesmo código cai em "Não consegui salvar, tente de novo" (painel.js:3446)
- Fato: VITRINE_VIN_DUPLICATE continua sem texto. Na V1 aparece "Não consegui gerar o link" (painel.js:4598). Se vier no preparo do WhatsApp, a tela diz "V1 criada · Sem telefone para abrir a conversa" (painel.js:4669, 4670 e 4683), texto que não corresponde à causa
- Suposição: VIN duplicado deve ser raro, porque a criação da V1 já recusa VIN repetido (vitrines.js:113); não medi

### B2 ABERTO
- Fato: o campo da observação interna não tem listener próprio (painel.js:3549)

### B3 MUDOU
- Fato: a fila e a tela do cliente usam os mesmos grupos da oferta, então a divergência "lista só BATE x seleção com todos os grupos" não aparece mais na mesma tela. A regra só BATE para reativação segue no servidor (panel-buscas-view.js:75 a 80 e panel-manheim-batch.js:109) e chega ao contador da carga inicial e ao resumo da ficha
- Pendência: precisa ser refeito depois da decisão da Leo sobre por carro x por valor na reativação. Não medi quantos casos de reativação existem hoje

### B4 PARCIAL
- Fato: a seleção continua liberada para pedido sem ficha; a V1 e o Copiar link explicam o motivo (painel.js:4643); o PDF não explica (painel.js:4622 e 4623); não há botão para vincular a ficha
- Fato, contagem em produção hoje: 0 demandas sem ficha com carro no lote ativo e 0 com seleção. A contagem da AUD-001 (0 casos) continua valendo. Pela regra Exceção continua exceção, segue no backlog como caso raro

## Testes e consultas executados

- Playwright local (PANEL_VISUAL_LOCAL=1, Chromium do ambiente, saída no diretório temporário): aud001-venda.spec.js 2 de 2 passaram; manheim-conferencia.spec.js e aud001-atualizacao.spec.js 9 de 9 passaram
- Sonda A6 (arquivo temporário, fora do repositório): 2 execuções. Na primeira o valor gravado ficou diferente do digitado; na segunda o percentual arredondado coincidiu com o padrão e o valor foi mantido, o mesmo efeito que faz o spec #61 passar
- Banco de produção: 1 consulta leve ao catálogo (texto das funções e lotes ativos: 1 lote ativo em produção); 2 consultas pesadas: recontagem de A3 e B4 numa só leitura e EXPLAIN ANALYZE de uma chamada de grupos (1,21 s). Nenhum nome, telefone, texto, VIN ou Ref foi lido ou transcrito

## Pendências para a próxima etapa

- Confirmar se os specs de A1 e A2 falhavam no código anterior (não rodei contra a base)
- A6: o spec #61 precisa de um valor digitado que não volte ao percentual padrão para servir de prova
- A8 e B3: medir em produção quantas pessoas caem na diferença do contador e quantas demandas de reativação existem, antes de qualquer regra
