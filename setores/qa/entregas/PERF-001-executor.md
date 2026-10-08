# PERF-001 · qa · rascunho do executor

- Pedido: PERF-001, fase 1, diagnóstico independente e comparação completa dos dados (nada implementado)
- Setor: qa
- Papel: Nível 1 Executor
- Agente: subagente executor qa (Claude), sessão de 2026-10-08
- Base: main em 38c2ab0 (inclui 55ccf70, ba4efa4 e o recuo 38c2ab0)
- Fontes: api/panel/boot.js, panel-attend-page.js, api/panel/today.js, panel-server.js, panel-read-model.js, panel-buscas.js, panel-search-stage.js, panel-client-context.js, tests/, vercel.json, git show ba4efa4 e 38c2ab0, Supabase de produção (só SELECT e EXPLAIN), registros do Supabase (query_logs)

## Resumo para a Leo

1. Achei um motivo concreto para os totais terem mudado com a função do banco de ontem: ela pulava uma regra que hoje só existe na leitura do servidor, a que apaga a hora de 7 prints de SMS sem data original. Reproduzi a diferença aqui, num teste isolado
2. Os testes locais passaram porque os dados de teste não tinham nenhum print desses; o volume estava coberto, a variedade não
3. Hoje existem 781 fichas, 3.451 mensagens (45 de clientes nas últimas 24 h) e 7 prints sem data; o número de pedidos incompletos eu não consegui medir só pelo banco
4. Medi que as consultas do banco levam cerca de 2 ms cada, mas o caminho até o painel leva de 50 ms a 4 s por pedido, e as funções do Manheim chegam a 3,5 s; os 8,4, 6,9 e 10,5 segundos eu não consegui repetir (sem login do painel e sem registros da Vercel)
5. Proponho uma comparação que roda o jeito antigo e o novo sobre os mesmos dados, com o relógio parado, e reprova qualquer diferença, mesmo de 1 linha
6. Com o que medi não dá para garantir os 3 segundos; dá para dizer onde o tempo está e como provar que nada muda

## O que foi executado (fato medido, com o comando)

### Testes locais
- `node --test tests/abertura-rapida.test.js tests/boot-leitura-unica.test.js tests/paginacao-estavel.test.js tests/panel-speed-invalidation.test.js tests/print-data-original.test.js tests/panel-counter-summary.test.js tests/contexto-cliente.test.js`: 37 testes, 37 passaram, 0 falharam
- No banco simulado pequeno, o boot faz de 67 a 81 leituras distintas (registro `[boot-timing]` do teste abertura-rapida)
- Não rodei os specs Playwright (panel-speed-equivalence.spec.js, panel-speed-cache.spec.js, boot-concorrente.spec.js, atendimento-lista.spec.js); não alego resultado deles
- Não rodei `npm test` inteiro

### Reprodução da diferença do PR #286 (fora do repositório)
- Cópia do commit ba4efa4 extraída com `git archive ba4efa4` na pasta temporária da sessão; o repositório não foi alterado
- Teste descartável: banco simulado (PGlite com todas as migrações) + dados de demonstração + 1 mensagem fictícia SMS_PRINT com `occurred_at_utc` nulo e `original_datetime_text = 'data original desconhecida'`
- Resultado, nas duas leituras conjuntas (operational e buscas):
  - leitura antiga (`allRows`): `created_at = null`, `date_unknown = true`
  - leitura conjunta (`panel_boot_read_bundle`): `created_at` preenchido, `date_unknown` ausente

### Produção, banco (somente SELECT e EXPLAIN), medido em 2026-10-08 05:08 UTC
- A função `panel_boot_read_bundle` não existe mais (`select count(*) from pg_proc where proname='panel_boot_read_bundle'` = 0): o recuo está aplicado
- Fuso da sessão: UTC. Papel `authenticator`: `statement_timeout=8s`
- EXPLAIN (ANALYZE, BUFFERS) de uma página de 1.000 linhas, igual à que o painel pede:
  - `calc_runs` por id: 2,1 ms, índice da chave primária, tudo em memória (1.004 blocos em cache)
  - `messages` de produção por id: 2,0 ms, índice da chave primária com filtro de ambiente, tudo em memória
- pg_stat_statements (acumulado desde o último reinício das estatísticas, não só de hoje): as consultas do PostgREST sobre calc_runs, journeys, journey_checklist, contacts e messages têm média de 13 a 106 ms e máximos de 1,9 a 7,1 s

### Produção, registros do Supabase (query_logs, edge_logs)
- A função conjunta foi chamada 8 vezes entre 04:36 e 04:38 UTC, todas com resposta 200, em 1,18 a 1,87 s cada no servidor do Supabase. Ou seja, o painel usou de fato a leitura conjunta, não a leitura antiga de reserva
- Janela 03:15 a 05:15 UTC, tempo no servidor do Supabase por caminho (mediana, p90, máximo):
  - `/rest/v1/messages`: 3.567 pedidos, 106 ms, 392 ms, 1.264 ms
  - `/rest/v1/journeys`: 1.652 pedidos, 79 ms, 497 ms, 1.268 ms
  - `/rest/v1/calc_runs`: 1.911 pedidos, 84 ms, 288 ms, 1.284 ms
  - `/rest/v1/rpc/panel_manheim_score_mmr` (usada pelo HOJE, panel-ready.js:32): 282 pedidos, 1.834 ms, 3.470 ms, 6.313 ms
  - `/rest/v1/rpc/panel_manheim_batch_overview` (panel-buscas-view.js:53): 88 pedidos, 3.422 ms, 4.961 ms, 7.397 ms
  - `/rest/v1/rpc/panel_manheim_batch_people` (records.js:31, searches.js:46): 90 pedidos, 1.595 ms, 3.042 ms, 4.973 ms
- Os pedidos chegam em rajadas de 45 a 89 por segundo, e dentro da mesma rajada há pedidos de 3 a 4 s (exemplo: 04:36:12 UTC, 67 pedidos, máximo 4.038 ms)

### O que não medi e por quê
- Os 8,4 s, 6,9 s e 10,5 s: não há login do painel de produção nem registros da Vercel nesta sessão. Os registros `[boot-timing]` e `[today-timing]` já existem no código (boot.js:121, today.js:295) e ficam na Vercel
- O resultado completo de hoje (cada linha da fila): exige rodar o boot de produção com a chave do servidor, que não está disponível (SUPABASE_URL e SUPABASE_SECRET_KEY ausentes no ambiente)
- Quantos pedidos incompletos existem hoje: o estado PRECISA_DETALHE é calculado em JavaScript (api/panel/pesquisas.js), não fica gravado no banco. Não inventei um número
- Quantos casos ficam em cada grupo (NAO_ATENDIDO, ATENDIDO, COMPLETAR, DECISOES): idem, é cálculo do servidor

## Por que os testes locais do PR #286 passaram e os totais mudaram em produção

### Fato
- No caminho antigo, toda leitura de `messages` passa por `rows()` em panel-server.js:81. Ali há uma regra de negócio (panel-server.js:59 a 79): print de SMS sem data original tem `created_at` apagado e ganha `date_unknown = true`, para nunca contar como mensagem recente
- A leitura conjunta do PR #286 (panel-boot-reads.js e a migração 20261008042413) devolvia as mensagens direto do banco e não passava por `rows()`. A função SQL também não lia `original_datetime_text`, então nem teria como aplicar a regra
- Quem usa essa marca: today.js:244 (`ownMessages.filter(message => !message.date_unknown)`) e panel-groups.js:91 (escolha da última mensagem e do grupo do caso)
- Produção hoje: 7 mensagens nessa condição, das 3.451 (0,2%), em 7 fichas das 781 (0,9%). Consulta: `count(*) from messages where environment='production' and source_kind='SMS_PRINT' and occurred_at_utc is null and original_datetime_text='data original desconhecida'`
- Os dados de teste (tests/fixtures/caso-demonstracao.js) não têm nenhuma mensagem SMS_PRINT. O teste do PR #286 criou 1.105 contatos e 1.105 simulações a mais (volume), mas nenhuma variedade nova
- Reproduzi a diferença com uma única mensagem desse tipo (seção acima)

### Hipótese (forte, não confirmada como causa única)
- Com a leitura conjunta, essas 7 fichas passaram a ter como última mensagem um print com a hora da confirmação, em vez de "data original desconhecida". Isso muda a espera, o grupo (sem resposta ou atendido), a ordem por recência e o contador de "mais de 24 h", então mudam os totais
- Não confirmo que foi a única causa porque não há registro dos totais antes e depois da publicação. Não encontrei outra diferença no código: fuso igual (UTC), mesma ordem com desempate por id, mesmos filtros de ambiente e de vínculo desfeito

### O que isso ensina (causa de processo)
1. A regra estava escondida na camada de transporte. O comentário do PR dizia "as regras recebem as mesmas projeções", mas uma regra mora dentro da leitura
2. O teste comparou novo contra antigo sobre dados inventados. Dados inventados cobrem o que o autor lembra; produção tem formas que ninguém lembrou
3. Não houve comparação contra produção antes de publicar; a diferença só apareceu nos olhos da Leo

### O que precisa existir para não repetir
1. Comparação do resultado completo contra os dados reais, antes de publicar, com o jeito antigo e o novo rodando sobre os mesmos dados (protocolo abaixo)
2. Catálogo de formas raras medido em produção, cada uma com contagem, e uma ficha fictícia de cada forma nos dados de teste (lista abaixo)
3. Teste fixo: qualquer leitura nova de `messages` (função do banco, visão, leitura conjunta) tem de devolver `created_at = null` e `date_unknown = true` para o print sem data. Custo zero para o caminho comum: é a mesma condição aplicada dentro da leitura, sem passo novo
4. Regra de revisão: toda regra que hoje vive em panel-server.js (`rows`, `maskUnknownDates`, `allRows`, ordem com desempate) é listada e conferida em qualquer transporte novo

## Linha de base: o que qualquer mudança terá de reproduzir

### Fato medido: entradas de hoje (2026-10-08 05:08 UTC)
Contagem e impressão digital (md5 das linhas em ordem de id, só os 12 primeiros caracteres; nenhum dado pessoal) de cada leitura que o boot faz. Serve para provar que as duas versões leram exatamente os mesmos dados

| Leitura | Linhas | Impressão |
|---|---|---|
| journeys (produção) | 781 | cdb328756dd0 |
| contacts | 781 | 4ac3b1357df8 |
| contact_phones | 774 | 8dc9704f3644 |
| journey_refs | 399 | 5d93e3ae98c6 |
| message_journeys vivos | 3.451 | f481d68e717b |
| messages (com original_datetime_text) | 3.451 | 2373477a3341 |
| journey_checklist | 4.686 | 0ad245f8dbdc |
| units | 7 | 5981e1725c16 |
| calc_runs (sem filtro de ambiente) | 4.585 | 7b0ee7f6ef3f |
| calculator_request_links | 1 | 743859b6f2cf |
| panel_item_dispositions vivas | 34 | dbbc7a9b2907 |
| whatsapp_user_ids | 191 | b294a96c5823 |
| journey_divergences | 0 | vazio |
| journey_alert_suppressions | 0 | vazio |

### Fato medido: formas que a comparação precisa cobrir (contagens de produção)
- Mensagens novas: 45 de clientes nas últimas 24 h, 74 no total nas últimas 24 h, 346 de clientes em 7 dias; 17 fichas com mensagem nas últimas 24 h; última gravação de mensagem às 04:08 UTC
- Fichas novas nas últimas 24 h: 15; simulações da calculadora nas últimas 24 h: 127
- Print de SMS sem data original: 7 (todas as 7 mensagens sem `occurred_at_utc` são esses prints)
- Mensagens com hora incerta: 7; automáticas: 280; SMS: 201; WhatsApp: 3.250
- Simulações marcadas como teste: 13
- Sugestões de vínculo pendentes: 53 (alimentam a caixa de decisões)
- Fichas sem nenhuma mensagem: 2
- Descartes vivos: 34
- Zerados hoje, mas lidos pelo boot (precisam de ficha fictícia, porque produção não os exercita): journey_divergences, journey_alert_suppressions, journey_toggle_states, promises, eventos QUICK_*, conversas não resolvidas (0 cada); WANT_CAR em 30 dias: 1
- Pedidos incompletos (PRECISA_DETALHE): não medido; medir pelo boot (abaixo)

### Definição: saída que forma a linha de base
Para cada combinação, guardar a resposta completa de `POST /api/panel/boot`:
- `part: 'main'`, `includeCounters: true`, `page.limit: 10000` (fila inteira, não só 30)
- as 8 ordens (`ready`, `recent`, `oldest`, `ref_recent`, `value_desc`, `value_asc`, `location`, `vehicle`)
- os 4 filtros de Ref (`all`, `with`, `recover`, `without`) e os 3 filtros de número (`late24`, `hot`, `sent`)
- de cada resposta, comparar: `page.rows` na ordem (chave do caso, `group`, `area`, `subject`), `page.total`, `page.counts`, `page.refCounts`, `page.stats`, `page.windows`, `page.shownCount`, `page.allKeys`, `page.identities`, os itens do HOJE, e as partes entry, triage, whatsapp, pesquisas, manheim e v1
- campos excluídos da comparação: somente `generatedAt`, `dataUpdatedAt` e `waitedMs` (como já fazia o teste do PR #286); todo o resto, inclusive textos de tempo como "há 3 h", entra, por isso o relógio precisa estar parado
- número de pedidos incompletos = `parts.pesquisas.body.items.length` (o resumo só traz os PRECISA_DETALHE, panel-counter-summary.js:9); número de casos em COMPLETAR = linhas com `data.group === 'COMPLETAR'`

## Protocolo de comparação (recomendação)

### Camada 1, local, sem dados reais (roda em todo PR)
- Dados fictícios com pelo menos uma ficha de cada forma do catálogo acima, inclusive as zeradas
- Antigo contra novo pelo boot real, como o último teste do PR #286, mais o teste fixo do print sem data
- Isso pega a classe de erro que derrubou o PR #286, mas sozinho não basta

### Camada 2, dados reais congelados (antes de publicar)
- Gravar uma vez todas as respostas do banco que um boot de produção recebe (só leituras), num arquivo fora do repositório, apagado ao final; contém dados pessoais, então depende de autorização da Leo e de privacidade
- Rodar o código antigo e o novo sobre a mesma gravação, com `Date.now` fixo, nas 8 × 4 × 3 combinações acima, e comparar campo a campo
- Serve para mudanças no servidor (como montar a página). Não serve para mudança dentro do banco (função ou visão nova), porque a gravação não tem a resposta nova

### Camada 3, banco real (para função, visão ou índice novos)
- Script de leitura com a chave do servidor, rodado pela Leo ou com autorização dela: impressão digital (tabela acima), boot antigo, boot novo, impressão digital de novo
- Se as duas impressões forem iguais, nada foi gravado no meio e a comparação vale; se mudaram (mensagem nova chegou), descartar e repetir
- Repetir em horário de movimento, para incluir uma mensagem nova chegando entre duas aberturas: a abertura seguinte das duas versões precisa mostrar a mensagem nova do mesmo jeito
- Índice novo não muda resultado, mas pode mudar a ordem de linhas empatadas; a comparação da ordem pega isso

## Como medir a abertura sem cache (recomendação; não executado)

Há três camadas de cache e cada medida precisa dizer quais estavam ligadas:
1. Cópia no navegador: o painel desenha a última lista guardada no IndexedDB `mcs-painel` (painel.js:2763) antes da resposta do servidor. Medir "apareceu na tela" com essa cópia engana; a medida certa é até chegar a resposta nova do boot e as 30 linhas serem redesenhadas com ela
2. Leitura repetida dentro do mesmo boot (`ctx.readCache`): existe só durante um pedido; não atrapalha a medida
3. Servidor frio na Vercel: a primeira chamada depois de publicar carrega o código do zero

Cenários, cada um com pelo menos 10 aberturas, informando mediana e p90:
- A. Primeira abertura depois de publicar: navegador limpo (sem IndexedDB `mcs-painel`, sem cache HTTP) e servidor recém publicado. É o caso dos 10,5 s
- B. Navegador limpo, servidor quente (logo depois de outra abertura)
- C. Recarga normal (com a cópia local). É o caso dos 6,9 s

Como medir:
- Playwright em contexto novo a cada abertura, logado no painel de produção; medir do início da navegação até a resposta de `/api/panel/boot` (Resource Timing) e até as 30 linhas da resposta nova estarem na tela
- Na Vercel, para cada abertura, os registros `[boot-timing]` (ms e número de leituras) e `[today-timing]` (fases operational, phase1, phase2, compute)
- No Supabase, os edge_logs da mesma janela (tempo de cada pedido e quantos por abertura), como fiz acima
- Anotar a hora, porque as rajadas de outros processos (crons a cada 1 e 5 minutos em vercel.json) disputam o mesmo banco

## Critério objetivo de aprovado ou reprovado (recomendação)

Reprovado se qualquer um falhar:
1. Comparação completa (camadas 1, 2 e, se mexer no banco, 3): zero diferença em todas as combinações. Uma linha fora de ordem, um contador diferente ou um campo a mais ou a menos reprova; não há tolerância
2. Teste fixo do print sem data passa em todo transporte de mensagens
3. Cada forma do catálogo tem ficha fictícia e passa na camada 1
4. Caminho comum sem passo novo: `tests/atendimento-lista.test.js` "caminho comum" e o spec de equivalência da paginação continuam verdes
5. Fonte indisponível nunca vira página curta: se a leitura nova falhar, o painel mostra a fila completa pelo caminho antigo (boot.js já faz isso; o teste precisa cobrir o transporte novo)
6. Nenhum cenário (A, B, C) fica mais lento que a linha de base medida antes da mudança, na mediana, com a mesma quantidade de aberturas; a margem de ruído é definida medindo a linha de base duas vezes
7. Meta de 3 s: medida separadamente nos cenários A, B e C. Aprovado para 3 s somente o cenário em que a mediana ficar em até 3,0 s; os outros são relatados com o número real, sem arredondar para a meta

## O que é alcançável e o que não é, com a evidência de hoje
- Fato: a parte do banco que lê as tabelas é rápida (cerca de 2 ms por página de 1.000 linhas com o dado em memória). O tempo está no caminho até o painel (50 ms a 4 s por pedido no Supabase, dezenas de pedidos por abertura) e em funções do Manheim que levam de 1,6 a 3,4 s na mediana
- Hipótese: índice novo, sozinho, ganha pouco nas tabelas lidas inteiras, porque elas já usam o índice da chave primária; o ganho provável está em menos pedidos em sequência e nas funções do Manheim. Quem confirma é o diagnóstico do backend
- Hipótese: montar a página no banco teria de levar junto a regra do print sem data e todas as regras de panel-attend-page.js e painel/atendimento.js, que hoje são JavaScript compartilhado com a tela; é a alternativa com mais risco de diferença. A leitura conjunta de ontem, que era bem mais simples, levou de 1,2 a 1,9 s por chamada
- Não alcançável com a evidência atual: afirmar que 3 s serão atingidos preservando todas as regras. Primeiro é preciso repetir as três medidas de referência nos cenários A, B e C

## Regra "Exceção continua exceção"
- O caso raro que quebrou o PR #286 acontece em 7 de 3.451 mensagens (0,2%) e 7 de 781 fichas (0,9%)
- A proteção recomendada (aplicar a mesma condição dentro de qualquer leitura nova e um teste fixo) não acrescenta passo, aviso nem tempo ao caminho comum
- A comparação completa é feita antes de publicar, fora do painel; não muda nada para quem usa

## Checklist do setor qa
- [x] Critérios de aceitação conferidos contra o pedido original: comparação completa, mensagens novas, pedidos incompletos, abertura sem cache, sem mudar layout e sem créditos de IA
- [x] Caminhos principais, limites e casos de falha: catálogo de formas com contagens; queda da fonte coberta no critério 5
- [x] Testes automatizados relevantes, sem alegar execução não feita: 37 rodados e verdes; Playwright não rodado, dito acima
- [ ] Uso diário do próprio painel no ambiente autorizado: bloqueado, sem login de produção nesta sessão
- [x] Efeitos nas funções relacionadas: a regra do print sem data afeta HOJE, grupos e contadores; listada nos critérios

## Pendências para os níveis 2 e 3
- Confirmar com os totais da época (se a Leo tiver print ou anotação) que a diferença bate com as 7 fichas do print sem data
- Medir os pedidos incompletos e o resultado completo de hoje pelo boot de produção (precisa de login ou chave do servidor)
- Repetir 8,4 s, 6,9 s e 10,5 s nos cenários A, B e C
