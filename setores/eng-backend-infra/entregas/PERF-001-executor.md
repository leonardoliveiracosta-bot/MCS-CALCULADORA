# PERF-001 fase 1: diagnóstico da abertura do painel

- Pedido: PERF-001, fase 1 (diagnóstico independente e comparação completa dos dados; nada implementado)
- Setor: eng-backend-infra (responsável principal)
- Papel: Nível 1 Executor
- Data: 2026-10-08, código em main no commit 38c2ab0
- Fontes: repositório, banco de produção (somente SELECT e EXPLAIN), registros do gateway do Supabase (edge_logs) das últimas 6 horas, pg_stat_statements desde 2026-09-19

## Resumo para a Leo

1. O banco em si é rápido para as listas: cada leitura de tabela leva de 4 a 19 milésimos de segundo; índices novos quase não mudariam a abertura
2. O que pesa são três cálculos do lote Manheim que a abertura espera terminar: 1,6 s, 2,5 s e 1,5 s cada um sozinho, e de 2 a 6 s quando rodam juntos
3. Enquanto esses cálculos estiverem no caminho da abertura, 3 segundos não são alcançáveis, com ou sem a página montada no banco
4. A função do banco revertida (#286) pulava uma regra que esconde a data de 7 prints de SMS sem data original; isso muda a última mensagem de 7 fichas e explica, como hipótese forte, a mudança dos totais
5. Ordem sugerida: medir e montar a comparação completa primeiro, depois tirar os cálculos do lote do caminho da abertura, e só então avaliar o resto
6. Não medi o tempo do servidor da Vercel nem a tela (sem acesso); digo abaixo como medir

## 1. O que foi medido e o que não foi

| Item | Situação | Como |
|---|---|---|
| Tempo de cada leitura no banco | Medido | EXPLAIN (ANALYZE, BUFFERS) e pg_stat_statements |
| Tempo de cada chamada vista pelo gateway (banco mais API) | Medido | edge_logs, campo response.origin_time |
| Volume lido por tabela | Medido | count e octet_length(row_to_json) |
| Diferença do panel_boot_read_bundle | Medido no código e nos dados | git show ba4efa4 e 38c2ab0, consultas nos casos afetados |
| Tempo total da abertura no servidor (Vercel) | NÃO medido | Sem conector da Vercel nesta sessão |
| Tempo na tela (8,4 s, 6,9 s, 10,5 s) | NÃO medido, só referência da Leo | Sem login do painel |
| Tempo de processamento em JavaScript das listas | NÃO medido | Precisa dos registros [boot-timing] e [today-timing] da Vercel |
| Carregamento dos módulos (parte da primeira execução) | Medido localmente | node 22, require de boot e das listas: 74 a 79 ms em 3 rodadas |

## 2. Onde o tempo da abertura vai (fatos medidos)

### 2.1 O que a abertura espera

FATO (código): `api/panel/boot.js` roda as listas em paralelo e só responde quando todas terminam (`await Promise.all`). Com a página pedida, entram today, entry, triage, whatsapp, pesquisas e vitrine-funnel; com `includeCounters`, entram também pesquisas resumo e `records?view=manheim`.

FATO (código): `painel/painel.js:363` começa cada carregamento da página com `counterCacheAt = 0`, e a linha 2008 manda `includeCounters: Date.now() - counterCacheAt > 60000`. Portanto toda abertura e toda recarga incluem os contadores no mesmo pedido da fila.

FATO (código): depois de todas as listas, `boot.js:76-86` ainda chama `buildContexts(..., {listOnly:true})` para os casos sem item, em sequência, antes de responder.

### 2.2 As três funções pesadas no caminho da abertura

| Função | Quem chama na abertura | Sozinha no banco (EXPLAIN ANALYZE) | No gateway, 6 h (mediana / p95 / máx) | No banco desde 19/09 (média / máx) |
|---|---|---|---|---|
| panel_manheim_batch_overview | pesquisas, via `panel-buscas-view.js:53` | 2.517 ms, com cerca de 64 MB em disco temporário (temp written 8.172 blocos) | 3.364 / 5.847 / 8.129 ms (320 chamadas, todas acima de 1 s) | 3.577 / 7.910 ms |
| panel_manheim_score_mmr | today, via `panel-ready.js:32` (sem cache entre listas) | 1.638 ms | 2.189 / 3.591 / 6.313 ms (986 chamadas) | 1.260 / 7.583 ms |
| panel_manheim_batch_people | records?view=manheim, `records.js:31` (só com contadores) | não repeti | 1.621 / 3.292 / 4.973 ms | 1.080 / 6.977 ms |

FATO: as duas primeiras recalculam `panel_manheim_grouped_light` sobre o mesmo lote ativo (59.309 combinações); esse cálculo sozinho levou 1.486 ms (EXPLAIN ANALYZE, 9.366 linhas). Na mesma abertura ele roda ao menos duas vezes, em paralelo, disputando o mesmo banco.

FATO: o limite de tempo das consultas pela API é 8 s (`statement_timeout=8s` no papel authenticator). Os máximos de 7,6 a 8,1 s mostram chamadas encostando nesse corte.

FATO (edge_logs, janela 04:29:30 a 04:30:00 UTC): a sequência de leituras de uma abertura mostra score_mmr com 2.565 a 3.582 ms e batch_overview com 3.243 e 4.292 ms, e batch_people com 3.044 ms. Não consegui separar uma abertura isolada porque havia 7 sessões autenticadas e crons no mesmo intervalo.

### 2.3 Leituras de tabelas (listas completas)

| Tabela (produção) | Linhas | Tamanho em JSON das colunas lidas | Páginas de 1.000 em sequência | Uma página sozinha (EXPLAIN) | No gateway (mediana / p95) |
|---|---|---|---|---|---|
| calc_runs (sem filtro de ambiente) | 4.585 | 2,6 MB | 5 | 11,7 ms, índice pkey, tudo em memória | 94 / 406 ms |
| messages | 3.451 | 2,3 MB (com body_text) | 4 | 18,7 ms, índice pkey | 105 / 466 ms |
| message_journeys | 3.451 | pequeno | 4 | 4,2 ms | 83 / 417 ms |
| journey_checklist | 4.686 | pequeno | 5 | não repeti | 107 / 444 ms |
| journeys | 781 | 0,64 MB | 1 | não repeti | 94 / 709 ms |
| contacts, contact_phones, journey_refs | 781, cerca de 770, cerca de 400 | pequeno | 1 | não repeti | 53 a 123 / 440 a 650 ms |

FATO: nenhuma página leu do disco (shared read 0 por chamada em pg_stat_statements; EXPLAIN só com shared hit). Os índices usados são os certos (chave primária, com o filtro de ambiente aplicado em cima). A diferença entre 4 a 19 ms no banco e cerca de 100 ms no gateway é API, serialização e concorrência, não falta de índice.

FATO: `allRows` (`panel-server.js:166-198`) pede as páginas uma depois da outra (cursor por id). calc_runs e journey_checklist precisam de 5 idas e voltas em sequência; messages e message_journeys, 4.

FATO: as mesmas tabelas são lidas várias vezes com colunas diferentes na mesma abertura (por exemplo messages em `panel-read-model.js:28`, `panel-buscas.js` e pesquisas; calc_runs em today, em `panel-search-stage.js` e em records). O cache de leitura do boot só junta leituras idênticas (mesmo caminho e filtros).

FATO: chamadas ao banco feitas pelo servidor saem da AWS em Ashburn (Virgínia) e entram no Supabase pelo ponto IAD (edge_logs: request.cf.city Ashburn, colo IAD). Servidor e banco já estão na mesma região.

### 2.4 Primeira execução após publicar (10,5 s informado)

FATO: carregar todos os módulos da abertura leva cerca de 75 ms localmente; isso não explica 3,6 s a mais.

HIPÓTESE (não medida): somam-se a instância nova da Vercel, dezenas de conexões novas com o Supabase abertas ao mesmo tempo (cada uma com negociação de segurança), o navegador sem cópia salva (pede tudo, sem o atalho de "só o que mudou") e o arquivo painel.js de cerca de 0,8 MB baixado sem cache (vercel.json manda no-store para /painel). Medir: tempo do [boot-timing] da primeira chamada após publicar comparado às seguintes, e o [panel-performance] do navegador.

## 3. Consultas mais lentas e por quê

1. panel_manheim_batch_overview: refaz o agrupamento do lote inteiro (59.309 combinações) a cada abertura e ainda transborda para disco (work_mem de 32 MB não basta). O resultado só muda quando o lote, as seleções ou os vínculos mudam
2. panel_manheim_score_mmr: refaz o mesmo agrupamento para tirar uma mediana por pessoa (361 pessoas). Também só muda com o lote
3. panel_manheim_batch_people: idem, para os contadores
4. panel_identity_evidence (fora da abertura, mas disputa o banco): média 2.813 ms, 4.084 chamadas, roda a cada 5 min pela subject-cron. Já registrado na AUD-001
5. Leituras de tabela: rápidas no banco; o custo está no número de idas e voltas em sequência e no volume (cerca de 5 MB só de calc_runs e messages por leitura completa, repetidas)

Volume lido versus usado: a abertura lê as 3.451 mensagens com texto e as 4.585 simulações inteiras para entregar 30 linhas. Porém, medido, essas leituras custam centenas de milissegundos, enquanto as três funções do lote custam segundos.

## 4. Por que os totais mudaram com panel_boot_read_bundle

### 4.1 Diferença encontrada (fato no código)

A leitura original de mensagens passa por `rows()` em `panel-server.js:64-84` (messageDateParams, maskUnknownDates e rows), que acrescenta a coluna original_datetime_text e, para print de SMS sem data original (`source_kind='SMS_PRINT'`, `occurred_at_utc` vazio e texto "data original desconhecida"), apaga created_at e marca date_unknown. Assim essa mensagem nunca fica "recente", nunca é a última da ficha.

A função do #286 devolvia as linhas pelo `rpc()` e `panel-boot-reads.js` as entregava direto às regras, sem passar por `rows()`. A coluna original_datetime_text nem estava no select da função. Resultado: created_at dessas mensagens voltava a valer como data.

Isso valia nos dois pacotes (operational e buscas), porque ambos liam messages com created_at.

### 4.2 Frequência medida nos dados

Consulta: contagem em messages com source_kind SMS_PRINT, occurred_at_utc nulo e o texto de data desconhecida, ligadas a fichas por message_journeys ativo.

- 200 prints de SMS em produção; 7 sem data original (3,5% dos prints; 0,2% das 3.451 mensagens)
- As 7 estão ativas, ligadas a 7 fichas diferentes (de 781), todas do cliente (CUSTOMER), todas criadas em 2026-10-01
- Nas 7 fichas, a data de criação dessas mensagens é mais nova que a última mensagem real da ficha: com o pacote, elas passavam a ser a última mensagem e a última do cliente de cada uma das 7 fichas

Efeito esperado (código de `api/panel/today.js:124-140` e `panel-attend-page.js`): muda latestMessage, lastCustomerAt, a hora de atividade e, com isso, a ordem e possivelmente o grupo dessas 7 fichas (por exemplo cliente esperando resposta). Não muda o filtro de atraso de 24 h, porque ele usa occurred_at_utc.

HIPÓTESE FORTE, não comprovada: essa é a causa da mudança dos totais. Para comprovar, preciso saber quais totais a Leo viu mudar e comparar com estas 7 fichas.

### 4.3 Por que os testes locais passaram (fato no código)

- O teste do #286 (`tests/boot-read-bundle.test.js`) não tinha nenhum print de SMS sem data original
- A comparação do teste normalizava os valores antes de comparar (lance convertido em número, datas convertidas para um formato único). Diferenças de tipo ou de formato entre a API e a função eram apagadas no teste, mas chegavam às regras em produção. Não verifiquei se havia diferença real de formato; só que o teste não conseguiria vê-la

### 4.4 Outras diferenças conferidas, sem efeito encontrado

- Filtros de ambiente, `undone_at is null` e `cleared_at is null`: iguais aos originais
- Limite de linhas: a função não tinha limite e allRows lê tudo; mesmo conjunto
- Ordenação: a função ordenava por id e o código reordenava com o mesmo comparador do allRows; mesma ordem
- calc_runs sem filtro de ambiente: igual ao original
- Tempo: a função levou de 1.025 a 1.672 ms no banco (8 chamadas em produção, pg_stat_statements) e de 1.332 a 1.869 ms no gateway; não era mais rápida que as leituras que substituía

### 4.5 O que ficou em produção

FATO: o #287 manteve a identidade leve (`buildContexts` com listOnly) e as páginas paralelas de mensagens no contexto. Essas mudanças vieram no mesmo #286. Recomendo confirmar que os totais atuais são iguais aos de antes do #286, para descartar essa parte (não medi).

## 5. Alternativas, ganho estimado e risco

Ganhos estimados a partir das medianas do gateway; o tempo real da abertura depende do que não medi (Vercel e tela).

| Alternativa | Ganho estimado no caminho da abertura | Risco de mudar ordem, grupos ou contagens | Precisa de migração |
|---|---|---|---|
| A. Tirar os contadores do pedido da fila (hoje toda abertura os inclui) | Tira batch_people (mediana 1,6 s) do caminho e alivia o banco; sozinho, ganho de parede pequeno porque overview segue no caminho | Baixo para a fila; os números das abas chegam numa segunda chamada (mudança no painel.js, envolve eng-frontend) | Não |
| B. Na abertura, pesquisas sem o resumo do lote, se a página não depender dele | Até cerca de 3,4 s (mediana do overview) a menos no caminho | Médio: precisa provar que os pedidos incompletos (PRECISA_DETALHE) e as decisões não usam o resumo do lote. HIPÓTESE: não usam, porque o estado vem de completeness; não verificado | Não |
| C. Calcular o agrupamento do lote uma vez e guardar (na ativação do lote e quando seleções ou vínculos mudam), e as três funções lerem o resultado guardado | Score e overview passam de segundos para dezenas de ms (estimativa pela leitura de tabela pequena); alivia o banco para tudo | Médio a alto: o guardado precisa ser invalidado em toda mudança que hoje entra no cálculo; erro aqui muda a ordem "pronto" e os contadores do lote | Sim (tabela e funções): entram qa e privacidade |
| D. Score uma vez por abertura (cache dentro do boot, como readRpc) | Evita repetir score quando mais de uma lista o pede; ganho de parede pequeno | Baixo | Não |
| E. Menos idas e voltas nas tabelas: páginas maiores ou páginas em paralelo, e juntar leituras da mesma tabela com colunas diferentes numa leitura só | Estimo 0,2 a 0,5 s na mediana e mais no p95 (5 páginas de cerca de 100 ms em sequência para calc_runs) | Baixo se continuar passando por `rows()`; a lição do #286 vale aqui | Não |
| F. Índices | Quase nenhum para as listas: páginas já usam índice e memória (4 a 19 ms) | Nenhum na ordem | Sim |
| G. Ajustar memória de trabalho do overview (evitar 64 MB em disco) | Parte dos 2,5 s; não medido quanto | Nenhum nos dados | Sim (alteração da função) |
| H. Preparar a página de 30 linhas no banco | Corta o envio das listas completas ao servidor; pelas medidas, isso é a parte menor do tempo. Não resolve as funções do lote | Alto: as regras de ordem, grupos, completar pedido e identidade estão em JavaScript (`panel-attend-page.js`, `painel/atendimento`, `panel-groups`); reescrever em SQL repete o risco do #286 em escala maior | Sim |
| I. Guardar a resposta pronta da abertura no servidor e invalidar por aviso de mudança | Pode chegar perto do tempo de transferência | Alto: risco de mostrar dado velho; contraria a regra de dados frescos | Talvez |
| J. Primeira execução: manter instância aquecida e conexões reaproveitadas | Parte dos 3,6 s a mais da primeira abertura; não medido | Nenhum nos dados | Não (infra; apoio de confiabilidade-sre) |

Caso raro e regra "Exceção continua exceção": o print sem data original é raro (7 de 3.451 mensagens). Qualquer alternativa deve tratá-lo como hoje, dentro de `rows()`, sem passo extra no caminho comum. O custo de manter esse tratamento é um campo a mais na leitura de mensagens, medido como desprezível perto do resto.

## 6. O que é alcançável

- FATO: enquanto overview (mediana 3,4 s no gateway) estiver no caminho da abertura, a resposta do servidor não fica abaixo de cerca de 3,4 s na mediana, antes de somar transferência e desenho da tela. Logo, 3 s não são alcançáveis sem tirar ou guardar esse cálculo
- FATO: a página montada no banco (alternativa H), sozinha, não remove esse piso
- HIPÓTESE: com A, B ou C e mais E, o caminho restante seria de leituras de tabela (cerca de 0,5 s na mediana, até 2 s no p95, somando 4 a 5 páginas em sequência), o contexto da página e o processamento em JavaScript (não medido). 3 s parecem possíveis na mediana, mas não tenho evidência para garantir, nem para o p95, nem para a primeira abertura após publicar
- Os setores organizam e revisam; não aceleram por si

## 7. Validação proposta (antes de qualquer mudança)

1. Medição sem cache, repetida: com acesso à Vercel, ler [boot-timing] (ms total e leituras) e [today-timing] (fases) de 10 aberturas frias e 10 recargas; no navegador, [panel-performance] e o tempo até a fila aparecer, com cache limpo. Repetir as três referências (8,4 s, 6,9 s, 10,5 s) antes de mudar
2. Comparação completa sem normalizar valores: gravar uma vez as respostas de leitura do banco de uma abertura e reproduzir as mesmas respostas para o código antigo e o novo, no mesmo processo. Comparar a ordem inteira (`selected.order`, não só 30 linhas), counts, refCounts, stats, windows, identidades, decisões, pedidos incompletos e cada corpo de lista. Saída só com contagens e chaves embaralhadas, sem dados pessoais
3. Casos obrigatórios na comparação: as 7 fichas com print sem data original; mensagens novas (últimas 24 h); pedidos incompletos (PRECISA_DETALHE, frequência ainda não medida, depende do JavaScript); Ref em duas fichas; ficha desligada ou encerrada
4. Teste do caminho comum mostrando que ele não ganhou passo novo

## 8. Checklist do setor

- [x] Limites de tempo e tamanho: 8 s por consulta na API; funções do lote com máximos de 7,6 a 8,1 s, encostando no corte; respostas de 2,3 a 2,6 MB por leitura completa de messages e calc_runs
- [x] Lote de 66 mil carros: o lote ativo tem 59.309 combinações e o agrupamento leva 1,5 s sozinho. HIPÓTESE: com 66 mil, cresce na mesma proporção (cerca de 1,7 s); não testado em cenário autorizado
- [x] Divisão em partes e paginação: allRows pagina por id com 1.000 linhas, em sequência; consultas sem limite de linhas por desenho (listas completas)
- [ ] Retomada e repetição segura: não se aplica à leitura da abertura; se a alternativa C for escolhida, o recálculo guardado precisa ser repetível sem duplicar
- [x] Concorrência e consistência: as funções do lote rodam em paralelo na mesma abertura e com crons (panel_identity_evidence a cada 5 min); nenhuma alteração de banco feita

## 9. Pendências

- Medir na Vercel o tempo total e por fase da abertura (sem acesso nesta sessão)
- Saber com a Leo quais totais mudaram no #286, para confirmar ou descartar a hipótese das 7 fichas
- Confirmar se os pedidos incompletos da página dependem do resumo do lote (alternativa B)
- Ver o plano interno de panel_manheim_grouped_light (não abri a definição)
- Confirmar que os totais atuais são iguais aos de antes do #286 (parte listOnly que ficou)
- Roteamento: se a decisão envolver migração (C, F, G, H), entram qa e privacidade pela regra do repositório; se envolver painel.js (A), eng-frontend; confiabilidade-sre pode apoiar em J ou em disponibilidade

## 10. Consultas e comandos usados

- `git show ba4efa4`, `git show 38c2ab0`, leitura de api/panel/boot.js, panel-server.js, panel-read-model.js, api/panel/today.js, pesquisas.js, records.js, panel-ready.js, panel-buscas-view.js, painel/painel.js
- pg_stat_user_tables (linhas e tamanho por tabela)
- pg_stat_statements filtrado por service_role e por tabela ou função (calls, mean, max, shared_blks, temp_blks)
- `explain (analyze, buffers)` das páginas de calc_runs, messages e message_journeys no formato da API (json_agg, limit 1000)
- `explain (analyze, buffers, timing off)` de panel_manheim_score_mmr, panel_manheim_batch_overview e panel_manheim_grouped_light com o lote ativo
- Contagem dos prints sem data original e teste de "seria a última mensagem" por ficha
- information_schema.columns para tipos (numeric, bigint, timestamp sem fuso)
- pg_settings e configuração dos papéis (statement_timeout)
- edge_logs: tempos por caminho (mediana, p95, máximo) e a janela de 04:29:30 a 04:30:00 UTC
- `node -e` com require dos módulos da abertura, 3 rodadas
