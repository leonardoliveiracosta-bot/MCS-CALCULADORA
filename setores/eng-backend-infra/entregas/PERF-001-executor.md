# PERF-001 · Rascunho do Nível 1 Executor

Identificador: PERF-001
Papel: Nível 1 Executor, setor eng-backend-infra (responsável principal: API e banco)
Data: 2026-10-08
Ordem das etapas: pedido registrado, este rascunho (executor), depois revisão cega (Nível 2) e aprovação (Nível 3)
Limites respeitados: somente leitura; nenhum código, migração, publicação, comentário em PR ou mensagem. No banco só SELECT e EXPLAIN; EXPLAIN ANALYZE apenas em duas funções marcadas STABLE (conferido em pg_proc.provolatile = 's'), uma execução de cada (as únicas consultas acima de meio segundo). Uma reprodução local com dados fictícios rodou fora do repositório, na pasta temporária da sessão

## Resumo em linguagem simples

1. Hoje o servidor leva cerca de 4,9 segundos (mediana) para montar a abertura do Atendimento, e o pior caso medido foi 7,4 segundos logo depois de publicar. O tempo se divide em três partes que se somam: o caminho até o banco e de volta, repetido muitas vezes em fila; contas pesadas no banco sobre o lote Manheim; e processamento na própria função, que roda várias listas ao mesmo tempo e uma atrasa a outra
2. A tentativa do PR 286 mudou os totais porque a leitura nova pulou uma regra que a leitura antiga aplica às mensagens: o print de SMS sem data original perde a hora em que foi confirmado. Sem essa regra, 6 fichas que só têm esse tipo de print passaram a contar como contato com data. Isso aparece nos registros de produção (5 itens a mais em HOJE no mesmo minuto) e foi reproduzido localmente com dados fictícios. Os testes locais passaram porque o banco simulado não tinha nenhum print sem data
3. A troca de região do PR 288 tem fundamento, mas a região atual das funções não está confirmada: os registros dizem São Francisco (sfo1) e os dados da publicação dizem Washington (iad1). Se for São Francisco, o ganho esperado é grande (1 a 2 segundos por parte); se for Washington, é pequeno. Há uma forma barata de confirmar antes de publicar
4. Nenhuma alternativa sozinha garante 3 segundos. A combinação mais segura começa pelas que não mudam dados nem exigem migração (região, reduzir processamento na função, fechar abas antigas que repetem a abertura a cada 2 minutos) e só depois as que exigem migração (leitura conjunta corrigida, resumo do lote Manheim guardado, página montada no banco)

## 1. Onde vai o tempo da abertura hoje

### 1.1 Medidas da Vercel (registros de produção, 2026-10-08 entre 03:58 e 05:17 UTC)

A abertura do Atendimento chama POST /api/panel/boot com part main e a página pedida (lista de 30 casos). Desde 05:07 essa chamada faz 139 leituras distintas e inclui as listas today, entry, triage, whatsapp, pesquisas e v1. A parte counters (pesquisas e manheim, 63 leituras) é chamada depois, ou é atendida pela própria main quando o contador tem mais de 60 segundos

| Chamada (publicação atual, PR 287) | Amostras | Mediana | Pior caso | Observação |
|---|---|---|---|---|
| main com página (139 leituras) | 10 | 4,86 s | 7,39 s | o pior caso foi a primeira chamada 3 minutos após publicar |
| main sem página (97 leituras, versão anterior da tela) | 8 | 4,06 s | 7,08 s | idem, primeira após publicar |
| counters (63 leituras) | 8 | 4,34 s | 5,20 s | |
| main sem página, publicação anterior (PR 280) | 18 | 3,78 s | 6,49 s | |
| counters, publicação anterior (PR 280) | 17 | 4,14 s | 7,13 s | |
| main de uma aba aberta no endereço antigo da publicação PR 280 (157 leituras) | 30 | cerca de 7,1 s | 11,7 s | repete a cada 2 minutos; ver 1.5 |

Esses tempos começam depois da conferência de login (duas idas ao banco que não entram na conta) e terminam antes da resposta viajar até o navegador e da tela ser desenhada

### 1.2 Fases dentro da main com página (10 amostras, mesmas requisições)

| Fase | Mediana | Faixa | Natureza |
|---|---|---|---|
| today, fase 1 (leituras em paralelo) | 3,15 s | 2,88 a 4,18 s | rede e banco |
| dentro dela: operational (13 tabelas, paginadas) | 2,0 s | 1,64 a 2,65 s | rede |
| dentro dela: stageIndex (andamento da busca) | 2,7 s | 2,20 a 3,58 s | rede (cadeia de páginas de calc_runs) |
| today, cálculo (compute) | 1,03 s | 0,95 a 1,08 s | processamento na função |
| today, total | 4,2 s | 3,83 a 5,23 s | |
| pesquisas, leitura base | 4,0 s | 2,86 a 5,04 s | rede, inflada pela disputa dentro da função |
| pesquisas, total | 4,57 s | 4,19 a 6,81 s | |
| montagem da página (identidade dos 30 casos) e hash | 0,30 s | 0,26 a 0,58 s | rede e processamento |

Leitura das fases: a main termina quando a mais lenta entre today e pesquisas termina, mais cerca de 0,3 s da página. As duas ficam perto de 4,2 a 4,6 s

Disputa dentro da função (fato medido): a mesma leitura base de pesquisas leva 2,04 a 2,29 s quando roda na parte counters e 2,86 a 5,04 s quando roda junto com today na main. A diferença, de 1,5 a 2 s, vem de várias listas dividindo o mesmo processador da função (o cálculo de today ocupa cerca de 1 s seguido, e cada leitura compartilhada é copiada inteira para cada lista que a usa)

### 1.3 Rede: cadeias de leituras uma depois da outra

Fatos medidos no banco (contagens agregadas, sem conteúdo):

| Tabela lida inteira na abertura | Linhas | Tamanho aproximado em JSON | Páginas de 1000 em fila |
|---|---|---|---|
| calc_runs (sem filtro de ambiente) | 4.585 | 2,5 MB | 5 |
| journey_checklist (produção) | 4.686 | 0,9 MB | 5 |
| messages, projeção de operational (produção) | 3.451 | 2,2 MB | 4 |
| message_journeys (produção) | 3.451 | 0,5 MB | 4 |

A paginação por id (allRows em panel-server.js) só pede a página seguinte depois de receber a anterior. Cada página de calc_runs tem cerca de 560 KB, o que exige várias idas e voltas de rede para chegar. calc_runs entra no stageIndex, em today e em pesquisas (a mesma leitura é compartilhada dentro da chamada, mas a cadeia de 5 páginas continua em fila)

Indício de distância grande entre função e banco: nas publicações de teste (ambiente preview, quase sem dados: 2 fichas, 6 mensagens), uma leitura isolada leva 89 a 157 ms, operational leva 187 a 222 ms e stageIndex leva cerca de 1,3 s, quase todo nas 5 páginas de calc_runs (tabela sem filtro de ambiente, igual à de produção). Com o banco na mesma região, uma leitura pequena costuma levar poucos milissegundos de rede; isso é suposição baseada em ordem de grandeza, não medida aqui

Volume: pg_stat_statements registra 1,54 milhão de chamadas do PostgREST (uma por leitura) desde 2026-09-19

### 1.4 Banco: funções caras e repetidas

pg_stat_statements desde 2026-09-19 13:06 UTC (cerca de 448 horas, papel service_role):

| Função | Chamadas | Média | Pior | Onde entra | Medida isolada agora |
|---|---|---|---|---|---|
| panel_identity_evidence | 4.088 | 2,81 s | 7,0 s | tarefa automática a cada 5 min (subject-cron), fora da abertura | não executada |
| panel_manheim_score_mmr | 7.198 | 1,26 s | 7,6 s | today, fase 1 (pontuação) | 1,49 s, 17.557 blocos lidos da memória, 361 linhas |
| panel_manheim_batch_overview | 1.143 | 3,58 s | 7,9 s | counters (lista Manheim) | 2,13 s, com 64 MB gravados em disco temporário (work_mem de 7 MB) |
| panel_manheim_batch_summary_v2 | 355 | 5,13 s | 8,0 s | caminho alternativo da lista Manheim | não executada |
| panel_journey_explicit_refs | 6.411 | 101 ms | 448 ms | pesquisas | não executada |
| leituras de calc_runs (primeira página / seguintes) | 14.408 / 48.968 | 81 ms / 27 ms | 5,9 s / 5,0 s | today, stageIndex, pesquisas | não executada |

As duas funções Manheim da abertura (score_mmr e overview) refazem o mesmo agrupamento (panel_manheim_grouped_light) sobre as 59.309 opções do lote vivo a cada abertura, e o resultado só muda quando um lote é carregado ou uma opção é selecionada. A média em produção (3,58 s) acima da medida isolada (2,13 s) indica disputa de processador no banco quando várias aberturas e tarefas coincidem. Na média, o banco fica ocupado o equivalente a 0,036 núcleo; a disputa acontece em picos, não o tempo todo. A configuração (1 GB de memória compartilhada, 120 conexões, 2 trabalhadores paralelos) sugere uma máquina pequena de 2 núcleos (suposição)

Índices: as tabelas lidas na abertura são pequenas (menos de 5 mil linhas). Não há evidência de que falte índice nas leituras da abertura; o custo do banco está nas funções Manheim. A tabela journey_refs tem 5,3 milhões de varreduras completas, mas tem 400 linhas e as varreduras vêm de dentro de funções; o efeito na abertura não foi medido

### 1.5 Carga repetida que disputa o mesmo banco

Fato medido nas últimas 3 horas: 75 registros de abertura vieram de uma aba aberta no endereço antigo da publicação PR 280 (157 leituras cada, 6,4 a 11,7 s, a cada cerca de 2 minutos) e 205 registros vieram de duas publicações de teste (preview) que também abrem o painel a cada 2 minutos no mesmo banco. A tarefa de identidade roda a cada 5 minutos com 2,8 s de banco. Quanto isso atrasa a abertura da Leo não foi medido; é suposição que contribui nos picos

### 1.6 Primeira abertura após publicar

A primeira chamada após cada publicação levou 7,08 s e 7,39 s, contra mediana de 4,06 s e 4,86 s. A diferença de 2,5 a 3 s bate com o padrão relatado (10,5 s na primeira abertura contra 6,9 s nas recargas) e é efeito da função começar do zero. Trocar de região não resolve esse ponto

### 1.7 Comparação com as medidas da Leo (8,4 s, 6,9 s, 10,5 s)

Não é possível reconciliar daqui: o servidor mede só a montagem. A diferença até o que a Leo vê inclui login (duas idas ao banco), viagem da resposta, desenho da tela e, em algumas versões da tela, a parte counters chamada em seguida. Fica como pendência com roteiro (seção 6)

## 2. Por que o PR 286 mudou os totais em produção

### 2.1 Causa provável

A leitura conjunta (panel_boot_read_bundle) devolvia as mensagens direto do banco. A leitura antiga passa por rows() em panel-server.js, que para a tabela messages faz duas coisas que a leitura conjunta não fazia:

1. acrescenta source_kind, occurred_at_utc e original_datetime_text à projeção quando created_at é pedido (messageDateParams)
2. para todo print de SMS sem data original (source_kind SMS_PRINT, occurred_at_utc vazio, original_datetime_text igual a "data original desconhecida") apaga created_at e marca date_unknown (maskUnknownDates)

Sem isso, o print sem data passa a ter a data em que foi confirmado. Em panel-contact.js, contactIndex só conta como contato a mensagem que tem data; em today.js e panel-groups.js, date_unknown tira o print das contas de última mensagem. Com a leitura conjunta, fichas que só têm esse print passam a "ter entrado" e aparecem nas listas

### 2.2 Evidências

| Evidência | Resultado |
|---|---|
| Frequência no banco de produção | 7 mensagens em 3.451 (0,2%), em 7 fichas de 781; em 6 dessas fichas o print é a única mensagem |
| Frequência no ambiente preview e no banco simulado dos testes | 0 prints sem data em ambos |
| Registros de produção no mesmo minuto, com as duas publicações vivas ao mesmo tempo (PR 286 no domínio principal e PR 280 no endereço antigo) | Leitura conjunta: HOJE 670 itens, pesquisas 1.075, buscas 749 itens e 464 demandas. Leitura antiga: 665, 1.072, 744 e 461. Fichas (774) e mensagens (3.451) iguais nos dois. Depois do PR 287, os números voltaram a 665, 1.072, 744 e 461 |
| A leitura conjunta funcionou de fato | nenhum aviso [boot-bundle-fallback] no período; leituras caíram de 97 para 70 (main) e de 63 para 45 (counters) |
| Reprodução local, dados fictícios, código do commit ba4efa4 | sem print sem data: totais idênticos nos dois caminhos. Com uma ficha fictícia cujo único contato é um print sem data: a leitura antiga devolve o print com created_at vazio e date_unknown; a leitura conjunta devolve created_at preenchido e sem date_unknown; HOJE passa de 1 para 2 itens |

Por que os testes passaram: o teste do PR 286 comparava as duas leituras sobre o banco simulado, que não tem nenhum print sem data, e normalizava datas e números antes de comparar

### 2.3 Comparação linha a linha do que mais podia diferir

| Ponto | Leitura antiga (allRows e rows via PostgREST) | Leitura conjunta (panel_boot_read_bundle) | Diferença |
|---|---|---|---|
| Projeção de colunas | as colunas pedidas, mais chaves de paginação e de ordem, removidas no fim | as colunas pedidas, mais id (e environment, bsuid em whatsapp_user_ids), removidas no fim | nenhuma no resultado |
| Regra das mensagens (rows) | aplica messageDateParams e maskUnknownDates | não aplica; além disso o recorte final por campos descartaria date_unknown | causa da diferença |
| Ordem | páginas por id (PAGE_KEYS); depois orderComparator com a ordem pedida e id como desempate | ordem por id no banco; depois o mesmo orderComparator com as mesmas chaves | nenhuma encontrada |
| Datas | texto JSON gerado pelo Postgres pelo PostgREST, fuso UTC | to_jsonb no Postgres, fuso UTC | nenhuma esperada (mesmo gerador); suposição não medida em produção |
| Números e JSON | numeric como número, jsonb como objeto | idem | nenhuma esperada; o teste local precisou normalizar porque o banco simulado devolve numeric como texto |
| Filtros | environment, undone_at, cleared_at iguais; calc_runs sem filtro de ambiente nos dois | idem | nenhuma |
| Limites de linhas | páginas de 1000 até a última | um único valor JSON, sem corte de linhas | nenhuma enquanto toda página chega inteira; risco de tempo limite de 8 s do papel de serviço e de resposta grande |
| Momento da leitura | cada página é lida em um momento | todas as tabelas no mesmo instante | só difere quando chega mensagem ou mudança durante a abertura |

### 2.4 Ponto que continua em produção

O PR 287 desfez a leitura conjunta, mas manteve a leitura leve da identidade dos casos da página (listOnly em panel-client-context.js). Pela leitura do código, essa versão usa as mesmas mensagens já tratadas por rows() e as mesmas regras de prova de Ref e de grupo; há teste comparando com a ficha completa. Não foi feita comparação em produção; fica como pendência para o revisor

## 3. Proposta do PR 288 (funções em cle1)

### 3.1 Onde as funções rodam hoje

| Fonte | O que diz |
|---|---|
| Banco (Supabase) | us-east-2, Ohio (confirmado) |
| Dados das publicações de produção na Vercel (PR 286 e PR 287) | regiões: iad1 (Washington) |
| Registros de execução na Vercel, produção e preview, todas as chamadas | region=sfo1 (São Francisco) |
| Publicação de teste do PR 288 (este ramo) | regiões: cle1; nenhuma chamada registrada |
| vercel.json antes do PR 288 | sem região definida |

As fontes divergem. A mensagem do commit do PR 288 afirma sfo1, e os tempos de leituras pequenas no preview (89 a 222 ms por etapa) combinam mais com sfo1 do que com iad1. Isso é indício, não prova. Pendência: confirmar pelo cabeçalho x-vercel-id de uma resposta de /api/panel/boot (o segundo trecho é a região onde a função rodou)

### 3.2 Ganho esperado

| Cenário | Ganho estimado por parte | De onde vem a estimativa |
|---|---|---|
| Funções hoje em sfo1 | 1 a 2 s | a cadeia de 5 páginas de calc_runs (cerca de 560 KB cada) e as demais cadeias de 4 a 5 páginas pagam várias idas e voltas de rede por página; no preview, com quase nenhum dado, essa cadeia sozinha leva cerca de 1,3 s. Suposição a confirmar |
| Funções hoje em iad1 | 0,2 a 0,4 s | 20 a 25 etapas em fila no caminho mais longo, com cerca de 10 ms a menos por etapa. Suposição |

Mesmo no melhor cenário, a região não reduz o cálculo na função (cerca de 1 s em today), a disputa entre listas, as funções Manheim no banco (1,5 a 3,6 s) nem a primeira abertura após publicar

### 3.3 Riscos

1. Não muda dados nem totais: nenhuma consulta, regra ou rota muda
2. Todas as funções mudam de região, inclusive tarefas automáticas e o recebimento do WhatsApp; os serviços externos que elas chamam podem ficar mais perto ou mais longe (não medido)
3. Se o projeto tiver uma região escolhida no painel da Vercel que hoje vale por cima do arquivo, o efeito real precisa ser conferido depois de publicar pelo mesmo cabeçalho x-vercel-id
4. Volta simples: reverter uma linha do vercel.json

### 3.4 Como confirmar antes de publicar em produção

A publicação de teste do PR 288 (cle1) já existe e lê o mesmo banco no ambiente preview. Abrir o painel nela e numa publicação de teste em sfo1, cinco vezes cada, e comparar [boot-timing] e o stageIndex de [today-timing]. Os dados do preview são pequenos, mas calc_runs é a mesma tabela nos dois, então a cadeia de páginas é comparável

## 4. Alternativas para chegar a 3 segundos

| # | Alternativa | Ganho estimado | De onde vem | Risco de mudar dados ou totais | Como comparar antes e depois | Migração (aciona privacidade) |
|---|---|---|---|---|---|---|
| A | Região cle1 (PR 288) | 1 a 2 s por parte se hoje for sfo1; 0,2 a 0,4 s se for iad1 | seção 3.2 | nenhum (não muda leitura) | [boot-timing] e fases, mais itens, fichas e mensagens iguais nos registros | não |
| B | Reduzir processamento e disputa na função: não copiar inteira cada leitura compartilhada para cada lista, trocar buscas repetidas dentro de laços por índices, separar today e pesquisas para não dividirem o mesmo processador, ou dar mais memória à função (na Vercel mais memória traz mais processador) | 1 a 2 s na main | cálculo de today 1,03 s; pesquisas leva 2,1 s sozinha e 4,0 s junto com today | baixo se for só reorganização; precisa da comparação completa | comparação completa da seção 4.1 mais fases nos registros | não |
| C | Resumo do lote Manheim calculado uma vez por lote (pontuação e visão geral), refeito quando um lote é carregado ou uma opção é selecionada | até 1,5 s de banco em today e 2 a 3,5 s em counters | score_mmr 1,49 s e overview 2,13 s medidos; médias 1,26 s e 3,58 s | médio: resumo desatualizado se a atualização falhar | comparar o resumo guardado com o calculado na hora, em todas as pessoas e demandas, a cada carga de lote | sim, se guardado no banco; não, se guardado só na memória da função (perde na primeira abertura) |
| D | Leitura conjunta corrigida (PR 286 com a regra das mensagens aplicada igual a rows) | 0,5 a 1,5 s, a confirmar | elimina as cadeias de 4 e 5 páginas; nas 3 amostras do PR 286 em produção não houve ganho visível (3,9 s, 5,2 s, 5,8 s), mas eram logo após publicar | médio: já mudou totais uma vez; a causa está identificada | comparação completa, incluindo prints sem data e mensagens que chegam durante a abertura | sim |
| E | Fechar a aba no endereço antigo da publicação e as aberturas automáticas dos testes; rever a frequência da tarefa de identidade | não estimado; reduz picos de disputa no banco | 75 e 205 aberturas extras em 3 horas; identidade 2,8 s a cada 5 min | nenhum | média e pior caso de [boot-timing] em uma hora com e sem essa carga | não |
| F | Ajuste de memória de trabalho só nas funções Manheim (hoje gravam 64 MB em disco) | parte dos 2,1 s da visão geral, não estimado | EXPLAIN ANALYZE com disco temporário | nenhum (mesmo cálculo) | mesmo resultado, tempo menor | sim |
| G | Montar a página no banco (alternativa a validar) | potencialmente o maior; servidor abaixo de 1 s | uma ida ao banco no lugar de cerca de 140 | alto: todas as regras de filas, grupos e contadores teriam de ser reescritas e mantidas em dobro | comparação completa em modo sombra por vários dias antes de trocar | sim |
| H | Conferir o login sem ir ao banco a cada chamada | 0,1 a 0,3 s | duas idas ao banco antes de cada abertura | nenhum nos dados; sensível para segurança | tempo total no navegador | não |

Leitura da tabela: com A e B juntas, a main poderia ficar perto de 2,5 a 3 s no servidor, mais login e transmissão; C tira o peso maior da parte counters. Nenhuma estimativa foi medida depois da mudança; todas são suposições com a origem indicada

### 4.1 Comparação completa antes e depois (para qualquer alternativa)

1. Rodar os dois caminhos (antigo e novo) na mesma chamada, em modo sombra, e registrar só contagens e resumos sem dados pessoais: itens por lista, ordem completa por hash, contadores, grupos, filtros de Ref, pedidos incompletos de pesquisas
2. Comparar fonte por fonte, linha por linha (por hash de cada linha), além do resultado final
3. Casos que precisam estar cobertos: print de SMS sem data (7 mensagens hoje), mensagens que chegam durante a abertura (a diferença legítima de momento deve ser separada da diferença de regra), pedidos incompletos, Ref em duas fichas, fichas desligadas e encerradas, mensagens desfeitas
4. Acrescentar ao banco simulado dos testes pelo menos um print sem data, para que o teste local enxergue o que produção tem

### 4.2 Regra de exceção (CLAUDE.md)

O print sem data é caso raro: 7 de 3.451 mensagens, 6 fichas de 781. Ele não pede regra nova; pede que qualquer leitura nova aplique a regra que já existe. Nenhuma das alternativas acima acrescenta passo ao caminho comum

## 5. Fatos, suposições e riscos

Fatos medidos
1. Mediana de 4,86 s e pior caso de 7,39 s da main com página; counters 4,34 s e 5,20 s (seção 1.1)
2. Fases e disputa dentro da função (seção 1.2)
3. Funções Manheim custam 1,49 s e 2,13 s isoladas e são refeitas a cada abertura (seção 1.4)
4. O PR 286 mudou os totais em 3 a 5 itens por lista no mesmo minuto em que a leitura antiga não mudou; a regra das mensagens ausente explica e foi reproduzida (seção 2)
5. Banco em us-east-2; registros indicam sfo1; dados de publicação indicam iad1 (seção 3.1)

Suposições
1. Que a região real seja sfo1
2. Ganhos das alternativas A a H
3. Que a carga repetida de abas antigas e testes pese nos picos
4. Que datas e números saiam iguais nos dois geradores em produção
5. Que a máquina do banco tenha 2 núcleos

Riscos
1. Repetir a leitura conjunta sem a regra das mensagens volta a mudar totais
2. Resumo Manheim guardado pode ficar desatualizado
3. Montar a página no banco duplica regras e aumenta a chance de divergência
4. Troca de região move também tarefas automáticas e o recebimento do WhatsApp

## 6. Pendências

1. Confirmar a região real das funções pelo cabeçalho x-vercel-id
2. Comparar a publicação de teste em cle1 com uma em sfo1 (seção 3.4)
3. Medir no navegador, sem cache, para a Leo (roteiro abaixo)
4. Comparar em produção a identidade leve (listOnly) com a ficha completa
5. Medir o efeito da carga extra (abas antigas, testes, tarefa de identidade) nos picos

Roteiro de medição no navegador (Leo)
1. Fechar a aba aberta no endereço antigo da publicação e as abas de teste
2. Abrir o painel numa janela anônima (sem a cópia salva no aparelho, que desenha a lista antiga na hora e esconde o tempo real), com as ferramentas do navegador abertas, aba Rede, opção de desativar cache marcada
3. Entrar, abrir o Atendimento e anotar: o tempo da chamada boot na aba Rede, a linha [panel-performance] que o painel já escreve no console e o momento em que a lista aparece
4. No cabeçalho da resposta do boot, anotar o valor de x-vercel-id (mostra a região)
5. Repetir 5 vezes recarregando, e uma vez logo depois de uma publicação; enviar mediana e pior caso

## 7. Fontes consultadas

- Documentos: setores/README.md, setores/eng-backend-infra/EQUIPE.md, CLAUDE.md, setores/eng-backend-infra/entregas/PERF-001-pedido.md
- Código: api/panel/boot.js, api/panel/today.js, api/panel/records.js (trechos), api/panel/subject-cron.js, panel-server.js, panel-read-model.js, panel-search-stage.js, panel-client-context.js (via diffs), panel-contact.js, panel-groups.js, panel-identity.js, panel-ready.js, panel-buscas.js, painel/painel.js (chamadas da abertura), vercel.json, tests/regiao-funcoes.test.js, tests/fixtures/banco-simulado.js, tests/fixtures/caso-demonstracao.js, tests/print-data-original.test.js
- Histórico: git show ba4efa4 (PR 286), git show 38c2ab0 (PR 287), git show b7ea66e (PR 288), git log
- Vercel: projeto e publicações de produção (PR 280, 286, 287) e a de teste do PR 288; registros [boot-timing], [today-timing], [pesquisas-timing], [buscas-timing], [boot-bundle-fallback] (nenhum) e [boot-page-fallback] (nenhum em 2 dias); documentação de regiões
- Supabase: dados do projeto, pg_stat_statements e pg_stat_statements_info, pg_stat_user_tables, pg_settings, pg_roles, pg_proc (volatilidade e código das funções Manheim), contagens agregadas, EXPLAIN ANALYZE de panel_manheim_score_mmr e panel_manheim_batch_overview (uma vez cada)
- Reprodução local com dados fictícios do código do commit ba4efa4, rodada fora do repositório (pasta temporária da sessão); npm test não foi rodado
