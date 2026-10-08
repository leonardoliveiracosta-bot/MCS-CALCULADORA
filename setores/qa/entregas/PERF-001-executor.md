# PERF-001 · qa · Nível 1 Executor

Identificador: PERF-001
Setor: qa (comparação completa dos dados)
Papel: Nível 1 Executor (rascunho; ainda sem revisão do Nível 2)
Data: 2026-10-08
Limites cumpridos: somente leitura. Nenhum código do repositório alterado, nenhuma migração, nada publicado, nenhum comentário em PR. No banco de produção só rodei SELECT (4 consultas de contagem, todas rápidas). Scripts de apoio ficaram só no diretório de rascunho da sessão. Única escrita no repositório: este arquivo.

## Resumo para a Leo

1. A tentativa do PR 286 mudou números em produção por um motivo que encontrei e reproduzi no banco simulado. O painel tem uma regra antiga: um print de SMS sem data original ("data original desconhecida") nunca conta como mensagem recente. Essa regra é aplicada no caminho normal de leitura de mensagens. A leitura nova do PR 286 buscava as mensagens por outro caminho e pulava essa regra. Com isso o print passava a ser a última mensagem da ficha, com a hora da confirmação. Mudam a última mensagem, o tempo de espera, a ordem por recentes e o contador "atrasadas 24 h"
2. Em produção existem hoje 7 prints assim, em 7 fichas ativas, de 3.451 mensagens (0,2%). Nas 7 o print viraria a última mensagem. O banco simulado dos testes não tinha nenhum caso assim, por isso os testes passaram
3. Ainda falta você confirmar quais totais viu mudar. Sem isso a causa fica como provável, não como comprovada
4. Mesmo o caminho do servidor mais rápido hoje leva cerca de 3,3 a 4 segundos só dentro da função, antes de rede e navegador. A meta de 3 segundos não cabe sem reduzir esse tempo
5. Abaixo estão o método de comparação para qualquer mudança futura, o roteiro de medição sem cache que fica com você e o teste do caminho comum para cada tipo de mudança

## 1. Método de comparação completa antes e depois

### 1.1 O que comparar

Comparar a resposta inteira de POST /api/panel/boot, não só algumas partes. Cada linha abaixo é um item de comparação. Diferença em qualquer um deles reprova.

| Parte | O que comparar campo a campo |
|---|---|
| main · today | itens na ordem exata (lista `order` remontada com `items`), cada campo de cada caso: grupo, área, assunto, última mensagem (id, canal, direção, horários, automática), última do cliente, `lastCustomerAt`, `contactAt`, `contactChannel`, `contactMedium`, `unattended` (since, waitedText, timeLabel), Ref, estado da Ref, janela de compra, `discardedJourneys`, `contactResults`, `meta` sem `dataUpdatedAt` |
| main · page (página montada no servidor) | `rows` na ordem, `identities` de cada ficha da página, `total`, `limit`, `counts`, `refCounts`, `shownCount`, `stats` (late24, hot, sent), `windows` (30D, 3M, NONE), `allKeys`, `v1Today`, `key` |
| main · entry, triage, whatsapp | listas completas na ordem, contagens, conversas para revisar, sugestões de vínculo, revisões de telefone |
| counters · pesquisas | itens na ordem, estado de cada item, em especial os pedidos incompletos (estado PRECISA_DETALHE: `missing`, `lacksText`, `criteriaText`), contagens do resumo |
| counters · manheim | resumo e contagens |
| v1 (quando há página) | `v1Today`, `v1JourneyIds` |
| hashes | o `hash` de cada parte e de cada caso calculado pelo próprio boot. Se o conteúdo for igual, o hash é igual, então o painel não baixa de novo o que já tem |
| registros | zero `[boot-page-fallback]` e zero leitura que caiu no caminho reserva. Uma página que caiu no caminho reserva pode mostrar a mesma lista por outro caminho e esconder a diferença |

Combinações que precisam ser rodadas, porque cada uma passa por outro trecho do código:
- `part: main` com `includeCounters: true` e `page` nas ordenações `ready` (padrão da abertura) e `recent`
- página com `limit` 30 (padrão) e com `limit` 10000 (lista inteira, para ver o corte)
- filtros de Ref `all`, `with`, `recover`, `without`; filtros `late24`, `hot`, `sent`; uma busca por texto e uma por 3 dígitos de telefone fictício
- `part: counters` sozinho
- abertura com cópia salva: segunda chamada mandando os `have` da primeira. O resultado remontado como o navegador faz (`bootLoadNow` em painel/painel.js) tem que ser igual a uma abertura completa

Cenários de dados obrigatórios, com a frequência medida em produção hoje (contagens agregadas, ambiente production):

| Cenário | Produção | Banco simulado atual (caso-demonstracao.js) |
|---|---|---|
| Print de SMS sem data original (`occurred_at_utc` vazio, "data original desconhecida") | 7 mensagens em 7 fichas ativas, de 3.451 | 0 |
| Mensagem com hora incerta | 7 | 0 |
| Tabela acima de 1.000 linhas (paginação) | messages 3.451; calc_runs 4.585 (todos os ambientes, 13 de teste) | só quando o teste injeta linhas |
| Fichas com o mesmo `updated_at` (desempate por id) | 3 grupos | não medido |
| Pedidos lidos da conversa | 604 | 1 |
| Disposições ativas (descartes e similares) | 34 | não medido |
| Vínculos da calculadora | 1 | poucos |
| Mensagem nova chegando entre duas aberturas | acontece todo dia | não existe teste |
| Pedido incompleto (PRECISA_DETALHE) | não medido daqui (é calculado no código, não numa coluna) | existe em testes de completar pedido |

### 1.2 Normalização: só o que muda com o relógio

Pode ser retirado da comparação, e nada além disso:
- `generatedAt`, `dataUpdatedAt`, `waitedMs` (já são os voláteis que o boot ignora no hash, mais o carimbo do meta)

Não pode ser retirado: textos relativos como "há 3 h" e `waitedText`. Eles mudaram no caso do PR 286 e são o que você vê na tela. Para que não variem por causa do relógio, as duas versões rodam com o mesmo instante:
- no banco simulado: relógio fixo no Node (`mock.timers` com a API Date, disponível no Node 22 que está instalado) e as duas versões rodando no mesmo processo, contra o mesmo banco, uma logo depois da outra
- controle de ruído A, B, A: rodar a versão antiga, a nova e a antiga de novo. Se A1 e A2 diferem num campo, esse campo depende do relógio ou de dado que mudou no meio. Ele só pode ser aceito se estiver na lista acima. Caso contrário a rodada é repetida

Cuidado específico com o banco simulado: ele devolve datas como objeto Date e números decimais como texto, enquanto o Supabase real devolve texto ISO com microssegundos e números. O teste do PR 286 converteu tudo para o mesmo formato antes de comparar, e isso esconde diferenças de tipo. Regra: na comparação com dados reais nenhuma conversão de tipo é permitida. No banco simulado a conversão só vale para comparar o mesmo dado que veio por dois transportes diferentes, nunca para comparar a resposta final do boot.

### 1.3 Como rodar contra o banco simulado

1. Extrair as duas versões do código (antes e depois) para pastas separadas com `git archive <commit> | tar -x`, sem mexer no repositório
2. Criar um único banco PGlite (`tests/fixtures/banco-simulado.js`) com as migrações da versão nova, a semente `caso-demonstracao.js` e os cenários da tabela 1.1, todos com dados fictícios
3. Chamar o handler `api/panel/boot.js` de cada versão sobre o mesmo banco, com `__mcsCtx` de um usuário fictício, em todas as combinações de 1.1
4. Comparar por caminho JSON. Relatar só o caminho e a contagem de diferenças
5. Rodar `npm test` completo na versão nova

Eu fiz isso para três versões. Detalhes na seção 2.

### 1.4 Como rodar contra dados reais sem dados pessoais nas entregas

Daqui não dá para chamar o boot de produção. Ele exige a sessão do painel e a chave do servidor, e não uso segredos. Opções, da mais segura para a menos:

1. Comparação em sombra num deploy de preview, apontado para os dados de produção só para leitura. A mesma requisição calcula o caminho antigo e o novo com o mesmo instante e grava no registro só isto: nome da parte, hash antigo, hash novo, quantidade de diferenças e os caminhos JSON diferentes (por exemplo `today.items.12.latestMessage.id`), nunca os valores. Exige mudança de código e aprovação sua, por isso fica como proposta. A Leo abre o painel de preview normalmente; o caminho comum dela não ganha passo
2. Conferência por contagens no banco: SELECT agregados que medem cada cenário (como fiz acima). Isso não prova igualdade, mas mostra quantos casos raros existem para cada regra que o código aplica
3. Cópia anonimizada para o banco simulado: só com o setor de privacidade e trocando todo texto, nome, telefone e Ref por valores fictícios que preservem igualdade. Não recomendo agora

Nas entregas entram só: contagens, caminhos JSON, hashes e ids fictícios. Nunca nomes, telefones, textos de mensagem ou Refs reais.

### 1.5 Critério de aprovação

Aprovado somente se todos forem verdade:
- zero diferença em todas as combinações de 1.1, no banco simulado com todos os cenários de 1.1 e no modo sombra com dados reais, depois de retirar só os três campos de 1.2
- controle A, B, A sem diferença fora da lista de 1.2
- zero `[boot-page-fallback]` e zero leitura reserva durante a comparação
- `npm test` inteiro passando, com o teste do caminho comum da seção 4
- medição da seção 3 feita por você, mostrando o ganho

Uma única diferença reprova, mesmo que seja num caso raro. A correção do caso raro é feita à parte e não pode acrescentar passo ao caminho comum (regra do CLAUDE.md).

## 2. Por que o PR 286 passou nos testes e mudou totais em produção

### 2.1 Fatos

- O PR 286 (ba4efa4) trocou 13 leituras da abertura (parte operational) e 10 da busca (parte buscas) por uma função do banco, `panel_boot_read_bundle`, que devolvia tudo de uma vez
- No caminho normal, toda leitura da tabela `messages` passa pela função `rows` de panel-server.js. Ela aplica uma regra a mais: um print de SMS sem data original fica com `created_at` vazio e `date_unknown` verdadeiro, para nunca contar como recente. A regra existe desde o commit 63f6178, antes do PR 286
- A leitura conjunta lia `messages` direto do banco e só reordenava e cortava colunas. A regra do print sem data não era aplicada nas duas partes (operational e buscas)
- Em produção a função rodou: o pg_stat_statements registra 8 chamadas pelo PostgREST, média de 1.306 ms e máximo de 1.672 ms por chamada, todas devolvendo resposta. Há também 2 execuções diretas de comparação, média de 2.127 ms
- Nos registros da Vercel, o deploy do PR 286 (dpl_6FWd…, commit ba4efa4) atendeu www entre 04:36 e 04:38 UTC com menos leituras (106, 70, 45). Depois disso www volta a ser atendido pelo deploy anterior (dpl_58C1…, commit 55ccf70) de 04:40 a 04:48, e pelo do PR 287 (dpl_Qxfp…, commit 38c2ab0) a partir de 04:50. Nenhum `[boot-bundle-fallback]` aparece entre 04:00 e 06:00 UTC. Limite: a consulta devolve no máximo 100 linhas
- Produção hoje: 7 prints sem data, ligados a 7 fichas ativas (nenhuma encerrada). Nas 7 o print tem `created_at` mais novo que a última mensagem com data real, então viraria a última mensagem pela leitura conjunta. Em 1 delas a última mensagem real tem mais de 24 h
- O PR 287 (38c2ab0) não desfez tudo. Ele retirou a leitura conjunta e a função do banco, mas manteve a identidade leve da lista (`listOnly` em api/panel/boot.js e panel-client-context.js) e as páginas paralelas de mensagens. Essas partes continuam em produção

### 2.2 O que os testes do PR 286 comparavam

- cada leitura conjunta contra as leituras antigas: linhas, colunas e ordem, com mais de 1.000 contatos e calc_runs, sem misturar ambientes, cada consumidor com sua cópia
- volta às leituras antigas quando a função falha ou vem incompleta
- permissão só para service_role
- o boot inteiro (main com contadores, ordenação `recent`, página com limit 10000) pelo caminho antigo e pelo novo, ignorando `generatedAt`, `dataUpdatedAt`, `waitedMs`
- identidade leve igual à identidade completa, com Ref compartilhada

### 2.3 O que não comparavam

- nenhum print de SMS sem data na semente, então a regra pulada nunca foi exercitada. Esta é a diferença de dados reais que o banco simulado não cobre
- a ordenação padrão `ready` e a página padrão de 30; só `recent` com 10000
- os contadores `stats` com um caso de mais de 24 h, os filtros de Ref e a busca
- o caminho com cópia salva (`have`), que é o que a recarga usa
- mensagem nova entre duas aberturas
- `messages` acima de 1.000 linhas (só contatos e calc_runs passaram de 1.000)
- tipos reais: a função `normalize` do teste convertia datas e o campo `lance` para o mesmo formato, porque o banco simulado devolve Date e texto onde o Supabase devolve texto ISO e número
- o teste confirmava que todas as colunas existiam, mas não que as linhas recebiam o mesmo pós-processamento do caminho normal

### 2.4 Reprodução local (feita)

Banco simulado, dados fictícios, nada saiu da máquina. Passos:

1. `git archive ba4efa4`, `git archive 55ccf70` e `git archive 38c2ab0` extraídos em pastas de rascunho, com node_modules ligado ao do repositório
2. Banco PGlite com as migrações de ba4efa4 e a semente `caso-demonstracao.js`
3. Inserido um chat SMS fictício e uma mensagem SMS_PRINT com `occurred_at_utc` vazio, `time_uncertain` verdadeiro, `original_datetime_text` "data original desconhecida", `created_at` agora, ligada à ficha de demonstração
4. Comparadas a leitura antiga e a conjunta, e o boot antigo e o novo

Resultados:
- sem o print: 0 diferença em main (`recent` e `ready`) e em counters. Foi isso que o teste do PR 286 viu
- com o print, leitura isolada: no caminho antigo `created_at` vazio e `date_unknown` verdadeiro; na leitura conjunta `created_at` preenchido e `date_unknown` ausente, nas duas partes
- com o print, boot: 15 caminhos diferentes no caso da ficha (última mensagem, canal de contato, `unattended.since`, `waitedText` de "3 h" para "1 min", `timeLabel` de "WhatsApp há 3 h" para "SMS há 1 min", `lastCustomerAt`, `contactAt`)
- com o print e a última mensagem real com 30 h: `page.stats.late24` caiu de 1 para 0 nas ordenações `ready` e `recent`. Um total mudou
- 55ccf70 contra 38c2ab0, mesmo banco com o print: 0 diferença em main e counters. A parte que ficou do PR 286 (identidade leve) não mudou nada neste cenário

### 2.5 Pendências

- Saber da Leo quais totais ela viu mudar. A reprodução explica última mensagem, tempo de espera, ordem por recentes e atrasadas 24 h. Se ela viu outro total mudar (por exemplo grupos ou Ref), há outra causa ainda não achada
- Confirmar que, depois do PR 287, os totais voltaram exatamente aos de antes do PR 286. A identidade leve continua em produção; localmente ela não mudou nada, mas não foi comparada com dados reais
- Confirmar se algum dos 7 prints foi confirmado depois da janela do incidente (04:36 a 04:38 UTC). O SELECT mostra que nenhum foi confirmado nas últimas 24 h, o que indica que já existiam na hora

## 3. Roteiro de medição da abertura sem cache

### 3.1 Camadas de cache que precisam ser controladas

- Navegador: cópia salva no IndexedDB (`mcs-painel`, store `snap`). Ela desenha a lista na hora e manda os `have`, e o servidor devolve só o que mudou. Arquivos estáticos (painel.js, css) no cache HTTP
- Servidor: instância da função quente ou fria (primeira abertura após publicar = função fria e deploy novo). O `readCache` dura só uma requisição
- Banco: páginas em memória do Postgres. Não dá para limpar e não é preciso

### 3.2 Cenários

| Cenário | Como preparar | O que conta como "aberto" |
|---|---|---|
| A. Primeira abertura após publicar | logo depois de a Leo publicar, numa janela anônima nova (sem IndexedDB e sem cache HTTP) | `list-ready` sem cópia salva |
| B. Recarga | mesma aba, F5 e também Ctrl+Shift+R, com a cópia salva presente | duas marcas: tela com cópia salva e `list-ready` com dados novos |
| B2. Recarga sem cópia | DevTools com "Disable cache" e IndexedDB apagado em Application | `list-ready` |
| C. Aba nova | nova aba no mesmo perfil, digitando o endereço | as duas marcas de B |

As referências 8,4 s, 6,9 s e 10,5 s precisam ser repetidas nos mesmos cenários, para comparar o mesmo tipo de abertura.

### 3.3 O que medir no navegador

- Console, marca `[panel-performance]`: `kind: list-ready` com `sinceNavigationMs` (do início da navegação até a lista pronta) é a medida principal para a meta de 3 s. `kind: boot` com `ms` de main e de counters
- Rede (DevTools, Network): tempo até o primeiro byte e tempo total de `/api/panel/session`, `/api/panel/boot` main e counters, e o tamanho de cada resposta
- Anotar se a tela mostrou "Mostrando os dados de … atualizando" (cópia salva)
- Mesmo aparelho, mesma rede, mesmo horário para antes e depois

### 3.4 O que medir no servidor (daqui eu consigo)

- `[boot-timing]` (ms e leituras por parte), `[today-timing]` (fases), `[buscas-timing]`, `[pesquisas-timing]`, filtrando pelo domínio www e pelo deploy, e a região que aparece na linha do registro (hoje sfo1)
- `[boot-page-fallback]` tem que ser zero
- pg_stat_statements: foto antes e depois da janela (sem zerar a estatística), diferença de chamadas e tempo médio das consultas da abertura

Linha de base de hoje, 100 registros `[boot-timing]` entre 04:00 e 05:17 UTC, região sfo1, tempo dentro da função:

| Versão e chamada | Amostras | Mínimo | Mediana | Máximo |
|---|---|---|---|---|
| 38c2ab0, www, main com página (139 leituras) | 10 | 4.467 ms | 4.860 ms | 7.390 ms |
| 38c2ab0, www, main sem página (97 a 99 leituras) | 8 | 3.625 ms | 4.062 ms | 7.082 ms |
| 38c2ab0, www, counters | 8 | 4.133 ms | 4.343 ms | 5.202 ms |
| 55ccf70, www, main sem página | 18 | 3.282 ms | 3.850 ms | 6.489 ms |
| 55ccf70, endereço do deploy, main (147 a 157 leituras) | 27 | 6.348 ms | 7.220 ms | 11.735 ms |

Ruído encontrado: até 05:00 UTC, o endereço próprio do deploy dpl_58C1 (não o www) recebia uma abertura main a cada 2 minutos, mais ou menos. Parece uma aba esquecida aberta nesse endereço. Ela pesa no banco durante a medição e precisa ser fechada ou filtrada.

### 3.5 Quantas amostras

- B, B2 e C: 10 de cada por versão, alternando antes e depois (A, B, A, B), para não comparar horários diferentes. Relatar mínimo, mediana e máximo. Com 10 amostras o máximo é o pior caso visto, não um percentil
- A: só existe uma por publicação. Fazer 3 publicações (pode ser o mesmo commit publicado de novo, a critério da Leo). Como alternativa, abrir depois de 20 minutos sem uso (função fria), registrando que é outro cenário

### 3.6 O que fica com a Leo

- entrar no painel de produção e fazer as medições de navegador de 3.2 e 3.3
- publicar quando quiser medir o cenário A
- fechar a aba aberta no endereço do deploy antigo, ou dizer se ela é intencional
- aprovar ou não a comparação em sombra de 1.4
- dizer quais totais mudaram no PR 286 (2.5)

## 4. Teste do caminho comum por tipo de mudança

Regra: em toda mudança, um teste mostra que a abertura comum continua direta: as mesmas chamadas do navegador ou menos, nenhum aviso, botão, confirmação ou campo novo, e a mesma lista. Quando há caminho reserva, ele é silencioso (só registro).

| Tipo de mudança | Teste do caminho comum | Teste do caso raro (à parte) |
|---|---|---|
| Índice novo (migração) | as consultas da abertura devolvem as mesmas linhas no PGlite com e sem o índice; o boot inteiro igual pelo método 1.1; a abertura faz o mesmo número de chamadas | EXPLAIN mostra o índice em uso (efeito, não regra) |
| Função do banco que junta leituras | o boot sem casos raros é igual e usa menos idas ao banco; se a função falhar, a lista é igual e nenhum aviso aparece | toda linha de `messages` vinda da função passa pela mesma regra de `rows` (print sem data com `created_at` vazio e `date_unknown`), com um print desses na semente |
| Página ou lista montada no banco | boot igual em todas as combinações de 1.1, incluindo a recarga com `have`; o navegador faz as mesmas chamadas | pedido incompleto, mensagem nova entre aberturas, empate de `updated_at`, tabela acima de 1.000 linhas |
| Região das funções (vercel.json, PR 288) | tests/regiao-funcoes.test.js (região definida, nenhuma rota, duração ou agendamento mudado) e boot igual; ganho só pela medição da seção 3 | não se aplica |
| Cache novo no servidor ou no navegador | abrir, chegar mensagem nova (fictícia), abrir de novo: a mensagem aparece sem botão "atualizar" e sem passo extra | invalidação quando a cópia salva é de outra versão (já existe `BOOT_STORE_VERSION`) |
| Paralelismo (Promise.all, páginas paralelas) | mesma ordem de resultados com respostas fora de ordem (como o teste da conversa longa em contexto-cliente.test.js) | falha de uma página não vira lista menor |
| Mudança em painel/painel.js na abertura | teste Playwright (por exemplo inicio-painel.spec.js, boot-concorrente.spec.js): abrir o painel e ver a lista sem clique, aviso ou espera nova | cópia salva incompleta pede a versão completa sem aviso |

## 5. Fatos, suposições e riscos

Fatos (com fonte):
- a regra do print sem data é aplicada em `rows` de panel-server.js e a leitura conjunta do PR 286 não a aplicava (git show ba4efa4)
- a diferença foi reproduzida no banco simulado, incluindo a mudança de atrasadas 24 h (seção 2.4)
- 7 prints sem data em 7 fichas ativas, de 3.451 mensagens (SELECT agregado)
- a função rodou 8 vezes em produção pelo PostgREST, média de 1,3 s cada (pg_stat_statements)
- o PR 287 manteve a identidade leve e as páginas paralelas (git diff 55ccf70 38c2ab0)
- a abertura main mais rápida em www hoje fica entre 3,3 e 4 s só dentro da função (registros da Vercel)
- os testes de boot e contexto que rodei na versão atual passam: abertura-rapida, boot-leitura-unica, contexto-cliente e print-data-original, 29 de 29. Não rodei o `npm test` inteiro

Suposições:
- os totais que a Leo viu mudar são os explicados pelo print sem data. Não confirmado
- o Supabase real devolve datas no mesmo formato pelo PostgREST e pela função (ambos usam conversão JSON do Postgres). Não testei contra o real, porque isso exigiria chamar a função removida
- a aba que abre a cada 2 minutos no endereço do deploy é uma aba esquecida

Riscos:
- qualquer novo transporte de leitura que não passe por `rows` repete o mesmo erro. Hoje só `messages` tem pós-processamento, mas outro pode ser criado depois
- o banco simulado devolve Date e texto onde o real devolve texto e número. Testes que normalizam tipos podem esconder diferenças reais
- a semente de demonstração não cobre os casos raros que existem em produção (tabela 1.1)
- mesmo a função mais rápida ultrapassa 3 s dentro do servidor. Ganhos só no navegador não bastam para a meta
- a leitura conjunta custava 1,3 s por chamada no banco, porque devolvia todas as mensagens com texto. Juntar leituras não é ganho garantido

## Fontes

- Pedido: setores/eng-backend-infra/entregas/PERF-001-pedido.md
- Código: api/panel/boot.js, api/panel/today.js, panel-server.js (rows, allRows, maskUnknownDates, orderComparator, memoRead), panel-client-context.js, panel-attend-page.js, painel/painel.js (bootLoadNow, marcas `[panel-performance]`), tests/fixtures/banco-simulado.js, tests/fixtures/caso-demonstracao.js, tests/print-data-original.test.js
- Histórico: git show ba4efa4, git show 38c2ab0, git show b7ea66e, git log -S maskUnknownDates
- Banco de produção (wwmakfaqahlbjzqvzgbr), só SELECT: pg_stat_statements filtrado por panel_boot_read_bundle; contagens agregadas de messages, journeys, contacts, calc_runs, message_journeys, calculator_request_links, panel_item_dispositions, vehicle_requests; prints sem data por ficha (só contagens)
- Vercel (prj_rvTTgtaQ8o682GtphtYQ9TTEt80e, production): registros `[boot-timing]` e `[boot-bundle-fallback]` de 2026-10-08 entre 04:00 e 06:00 UTC; lista de deploys de produção
- Testes locais: node --test com os 4 arquivos citados; scripts de reprodução no rascunho da sessão (repro-pr286.js, comparar-arvores.js, tipos-simulado.js), fora do repositório
