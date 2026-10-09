# PERF-001 fase 1, diagnóstico: verificação do Revisor

- Pedido: PERF-001, fase 1 (diagnóstico independente e comparação completa dos dados, nada implementado)
- Setor: qa
- Papel: Nível 2 Revisor independente
- Data: 2026-10-08, medições no banco entre 05:15 e 05:35 UTC
- Ordem das etapas: avaliação cega gravada primeiro; comparação com o rascunho do executor só depois, ao final
- Registro de transparência: ao conferir a árvore de trabalho com `git status`, apareceram os NOMES de três arquivos PERF-001-executor.md (qa, eng-backend-infra, confiabilidade-sre). Nenhum conteúdo foi aberto ou lido antes de gravar a avaliação cega

## Resumo para a Leo

1. A tentativa revertida (#286) mudou os totais por um motivo que encontrei no código: a leitura pelo banco pulava a regra que esconde a data de 7 prints de SMS sem data original. Nos 7 casos essa mensagem passaria a ser a mais recente da pessoa
2. Os testes locais não pegaram porque os dados de teste não têm nenhum desses prints, e o ambiente de teste do banco tem só 2 fichas e 6 mensagens; produção tem 781 fichas e 3.451 mensagens
3. Antes de qualquer mudança, é preciso uma comparação da lista completa (toda a ordem, grupos e contagens) contra os dados reais, no mesmo instante, versão antiga e nova lado a lado
4. Medi no banco: a maioria das leituras leva 2 milissegundos; uma função de pontuação leva 1,5 segundo sozinha. Não consegui medir o tempo de abertura de ponta a ponta (sem acesso ao painel nem aos registros da Vercel)
5. Os 3 segundos ainda não têm evidência a favor nem contra; o critério de aprovação proposto abaixo exige zero diferença nos dados e tempo medido com repetição

## Avaliação cega

### 1. Fontes e método

- Código no commit 38c2ab0 (main): api/panel/boot.js, panel-attend-page.js, api/panel/today.js, panel-server.js, panel-read-model.js, panel-buscas.js, panel-search-stage.js, panel-client-context.js, panel-groups.js, panel-ready.js, vercel.json, painel/painel.js (só os pontos de medição)
- Histórico: `git show ba4efa4` (#286) e `git show 38c2ab0` (#287), comparados linha a linha
- Banco de produção (project wwmakfaqahlbjzqvzgbr), somente SELECT e EXPLAIN (ANALYZE) de SELECT, consultas de contagem e de impressão digital (hash), sem copiar dados pessoais
- Testes locais executados: `node --test tests/abertura-rapida.test.js tests/print-data-original.test.js tests/boot-leitura-unica.test.js tests/panel-speed-invalidation.test.js`, resultado 19 de 19 aprovados
- Sem acesso: registros da Vercel ([boot-timing], [today-timing]), login do painel de produção, chave de serviço do banco. Tudo que depende disso está marcado como NÃO MEDIDO

### 2. Fatos medidos

| Fato | Valor | Como foi medido |
|---|---|---|
| Fichas (journeys) em produção | 781 | `count(*) from journeys where environment='production'` |
| Contatos | 781 | idem em contacts |
| Telefones | 774 | idem em contact_phones |
| Mensagens | 3.451 (0 desfeitas, todas ligadas a uma ficha, nenhuma ligada a duas) | contagens em messages e message_journeys |
| Mensagens automáticas | 280 | `is_automatic` |
| Simulações da calculadora (calc_runs, sem filtro de ambiente) | 4.585 (13 de teste) | `count(*) from calc_runs` |
| Vínculos calculadora e ficha | 1 | calculator_request_links |
| Decisões do painel ativas (dispositions) | 34 de 35 | `cleared_at is null` |
| Mensagens novas, últimas 24 h | 74 (45 do cliente) | `coalesce(occurred_at_utc, created_at) > now()-24h`, medido 05:21 UTC |
| Mensagens, últimos 7 dias | 586 | idem |
| Pedidos de carro (vehicle_requests) | 604 | contagem |
| Pedidos cuja versão mais recente tem campo faltando e não está em revisão | 305 | última versão por pedido, `missing_fields` não vazio e `needs_review` falso. ATENÇÃO: é uma aproximação; o estado PRECISA_DETALHE do painel é calculado em JavaScript (vehicle-requests.js e pesquisas.js) e pode diferir |
| Pedidos cuja versão mais recente pede revisão | 83 | idem com `needs_review` |
| Prints de SMS sem data original (regra "data original desconhecida") | 7 de 200 prints de SMS; todos do cliente, canal SMS, não automáticos, não desfeitos | `source_kind='SMS_PRINT' and occurred_at_utc is null and original_datetime_text='data original desconhecida'` |
| Fichas afetadas por esses 7 prints | 7; em todas as 7 o print seria a mensagem mais recente se a data de criação fosse usada | junção message_journeys, comparando `created_at` do print com a maior data das outras mensagens da ficha |
| Fichas com `updated_at` empatado com outra ficha | 8 | agrupamento por updated_at; o desempate da ordem depende do id |
| Simulações com `created_at` empatado | 2 | idem em calc_runs |
| Ambiente preview no mesmo banco | 2 fichas, 6 mensagens, 0 prints sem data | contagem por environment |
| Função panel_boot_read_bundle no banco | não existe mais (revertida) | `pg_proc` |
| Migrações aplicadas da tentativa | 20261008042715 (criação) e 20261008044618 (reversão) | supabase_migrations.schema_migrations |
| Fuso do banco | UTC | `current_setting('TimeZone')` |
| Limite de tempo do papel authenticator | statement_timeout 8s | `pg_roles.rolconfig` |
| Tempo da função de pontuação usada no HOJE (panel_manheim_score_mmr, 60 dias) | 1.488,6 ms, 361 linhas, 17.557 blocos todos em memória (banco já aquecido) | `explain (analyze, buffers) select count(*) from panel_manheim_score_mmr('production', now()-'60 days')` |
| Mesma função, histórico acumulado desde 19/09 | 7.209 chamadas, média 1.258 ms, pico 7.583 ms | pg_stat_statements (inclui chamadas de outras telas, não só da abertura) |
| Leitura de 1.000 mensagens com todas as colunas do HOJE | 1,9 ms no banco | EXPLAIN ANALYZE, índice messages_pkey |
| Leitura de 1.000 simulações | 2,0 ms no banco | EXPLAIN ANALYZE, índice calc_runs_pkey |
| Leituras de tabela pela API do banco, histórico | calc_runs média 31 ms (119.271 chamadas), messages média 22 ms (150.523), journeys média 20 ms | pg_stat_statements agrupado por tabela |

Impressão digital dos dados de entrada em 2026-10-08 ~05:30 UTC (md5 da linha inteira, ordenado por id; serve para provar que duas execuções leram exatamente os mesmos dados):

| Tabela | Linhas | Hash |
|---|---|---|
| journeys | 781 | 2cfb3c574c100d3a65947042975de072 |
| contacts | 781 | 665d5a609f5b88376aa4c921f80d3b32 |
| contact_phones | 774 | 540009dd78411026e222353053be9ad0 |
| messages | 3.451 | e33abf895e7900b4504dd7d867b8dace |
| message_journeys | 3.451 | e30b70f714d633a25bce2e375f925bbe |
| calc_runs | 4.585 | ecf55218ba0ace654a28cf28632cadad |
| panel_item_dispositions | 35 | 22c2e1f7f0896014329c8cb2dc2b0d38 |
| journey_refs | 399 | 513476b1ed114783b4a263bb08ac9760 |
| vehicle_request_versions | 670 | e9ced4cd2598a2850363a24fd092601c |

Consulta usada: `select count(*), md5(string_agg(md5(row(t.*)::text), '' order by t.id)) from public.<tabela> t where environment='production'` (calc_runs sem filtro de ambiente).

NÃO MEDIDO: o resultado completo da fila de hoje (ordem das linhas, grupos, contagens por aba, refCounts, stats). Ele só existe depois das regras em JavaScript e exige rodar /api/panel/boot com a chave do banco ou com login no painel. Abaixo está como produzir essa linha de base.

### 3. Por que os testes locais do #286 passaram e os totais mudaram em produção

FATO (código): em panel-server.js, toda leitura de `messages` passa por `rows()`, que chama `messageDateParams` e `maskUnknownDates`. Essa regra (desde o PR #180) apaga `created_at` e marca `date_unknown: true` nos prints de SMS sem data original, para que eles nunca sejam a mensagem mais recente, nunca entrem como "recente" no HOJE e nunca virem "há X min". O transporte do #286 (`readBundle` em panel-boot-reads.js) chamava a função do banco com `rpc()` direto e devolvia as linhas cruas: os prints sem data voltavam com `created_at` preenchido e sem `date_unknown`. As duas leituras de mensagens trocadas pelo pacote (bundle `operational`, usado pelo HOJE, e bundle `buscas`) incluem `created_at`.

FATO (código): `api/panel/today.js` linha 244 e `panel-groups.js` linha 91 filtram `!message.date_unknown` para escolher a última mensagem, a última do cliente e o resumo do grupo. Sem a marca, o print entra nessa escolha usando `created_at`.

FATO (dados): existem 7 desses prints em produção, todos do cliente, em 7 fichas diferentes, e em todas as 7 o print seria a mensagem mais recente pela data de criação (01/10/2026).

HIPÓTESE (forte, não comprovada): esses 7 casos passaram a aparecer como cliente esperando resposta, mudaram de grupo (atendido para não atendido) e de posição, e por isso os totais mudaram. Não há registro de quais totais a Leo viu mudar, então não é possível provar que foi só isso. Outras diferenças possíveis que o teste também não cobria:
- O teste `tests/boot-read-bundle.test.js` normalizava os dois lados antes de comparar (convertia `lance` em número e qualquer texto com cara de data em ISO). Diferenças de formato que o JavaScript do painel trata como texto ficariam escondidas
- O pacote lia todas as tabelas numa única fotografia do banco; a leitura antiga lê em várias páginas e momentos. Em produção, com mensagens chegando, os dois lados podem divergir sem erro de regra (com 74 mensagens em 24 h, uma chegada durante a abertura é plausível, mas não medi a frequência por minuto)
- `boot.js` ainda usa `buildContexts(..., {listOnly:true})`, que entrou no #286 e NÃO foi revertido no #287. Ele tem teste de identidade igual à ficha completa só nos dados de demonstração. Não há evidência de que tenha mudado totais, mas ele continua em produção sem ter sido comparado com dados reais

FATO (por que o teste não pegou):
- O seed de demonstração (`tests/fixtures/caso-demonstracao.js`) tem 0 ocorrências de SMS_PRINT; o teste que exercita a regra (`tests/print-data-original.test.js`) testa só o caminho `allRows`, nunca o pacote
- O teste "boot real" do #286 comparava o novo transporte com o antigo sobre esse mesmo seed; qualquer regra que só age em dados ausentes do seed passa
- O ambiente preview no banco real tem 2 fichas, 6 mensagens e nenhum print sem data, então conferir em preview também não pegaria
- Volume: o teste inseria 1.105 contatos fictícios; produção tem 4.585 simulações e 3.451 mensagens, com 280 automáticas, 7 com hora incerta, 8 fichas com data de atualização empatada

O que precisa existir para não se repetir (RECOMENDAÇÃO):
1. Comparação contra dados reais e volume real, versão atual e versão nova sobre a MESMA fotografia dos dados (ver seção 4), comparando a lista inteira e não só as primeiras 30 linhas
2. Regra de arquitetura verificável por teste: toda leitura de `messages` nova (função do banco, view, pacote) precisa aplicar a mesma regra de data desconhecida, ou passar por `rows()`. Um teste de contrato deve falhar se uma leitura de mensagens chegar ao HOJE sem passar pela máscara
3. Seed de teste com os formatos raros que existem em produção, com contagem real anotada: 7 prints sem data, 7 mensagens com hora incerta, 280 automáticas, empates de ordenação (8 fichas, 2 simulações), pedidos incompletos e em revisão
4. Proibir normalização nos testes de equivalência: comparar o JSON exatamente como sai do boot (só ignorar `generatedAt`, `dataUpdatedAt` e `waitedMs`)
5. Versão da migração: o arquivo do repositório (20261008042413) não tem o mesmo número da migração aplicada (20261008042715); o mesmo vale para a reversão (044457 contra 044618). Conferir esse alinhamento antes de qualquer nova migração

### 4. Linha de base que qualquer mudança terá de reproduzir

Definição do resultado de referência (a "fotografia de hoje"), produzido pelo código do commit 38c2ab0:
- Chamada: POST /api/panel/boot com `{part:'main', includeCounters:true, sort, page:{ref, stat, query, limit:10000}}`, para cada combinação de ordenação (ready, recent, oldest, ref_recent, value_desc, value_asc, location, vehicle), filtro de Ref (all, with, recover, without) e atalho (nenhum, late24, hot, sent), mais 4 buscas de texto e número de telefone
- Guardar, por combinação: a lista completa `order` (chave de cada caso na ordem), `group`, `area` e `subject` de cada linha, `counts`, `refCounts`, `stats`, `windows`, `shownCount`, `total`, `allKeys`, `identities`, `v1Today`, além das partes entry, triage, whatsapp, pesquisas (requestCount e itens PRECISA_DETALHE) e manheim (peopleWithOptions)
- Guardar, junto, os hashes de entrada da seção 2 tirados imediatamente antes e depois. Se os hashes mudarem no meio, a fotografia é descartada e refeita
- Guardar só chaves, hashes e contagens nos arquivos de evidência; nomes, telefones e textos ficam fora

Como executar com segurança (RECOMENDAÇÃO, não executado por falta de credencial):
- Opção A, "sanduíche" em produção somente leitura: rodar no mesmo processo antigo, novo, antigo, com `readCache` desligado entre eles. Se antigo 1 = antigo 2 e novo difere, a diferença é da mudança. Se antigo 1 diferente de antigo 2, os dados mudaram no meio e a rodada é refeita. Custo: três aberturas completas, o mesmo que a Leo recarregar três vezes
- Opção B, cópia fiel: restaurar uma cópia do banco de produção num ambiente isolado e comparar ali com os dados parados. Exige aprovação de privacidade (cópia de dados pessoais) e é o único jeito de testar com tempo à vontade
- Opção C, modo sombra: a versão nova roda em paralelo à atual e grava só o hash do resultado e o número de diferenças. Tem custo de banco dobrado durante o período; só vale depois de A ou B aprovadas

Contagens de hoje que a linha de base precisa reproduzir (o que já está medido): ver seção 2. Mensagens novas: 74 nas últimas 24 h. Pedidos incompletos: 305 pela aproximação do banco; o número exato do painel (PRECISA_DETALHE) NÃO foi medido.

### 5. Testes que existem e o que falta

Existem (conferidos no repositório; os quatro primeiros executados agora, 19 de 19 aprovados):
- `tests/abertura-rapida.test.js`: boot igual às listas separadas; mediu 69 leituras no boot contra 112 separadas no banco simulado; página de 30 com contagens iguais ao modelo completo
- `tests/print-data-original.test.js`: regra da data desconhecida no caminho `allRows`
- `tests/boot-leitura-unica.test.js` e `tests/panel-speed-invalidation.test.js`: leitura compartilhada e invalidação
- `tests/panel-speed-equivalence.spec.js` (Playwright, não executado agora): compara a tela paginada com a tela antiga para 8 ordenações, 4 filtros de Ref, 4 buscas e 3 atalhos, mas com dados inventados no navegador (83 casos e 9 incompletos), sem banco e sem regra de servidor
- `tests/contexto-cliente.test.js`: identidade leve igual à completa, só com seed de demonstração

Falta:
1. Comparação com dados reais e volume real (seção 4); nenhum teste atual usa produção ou uma cópia dela
2. Seed com os casos raros reais (seção 3, item 3), com o número de vezes que cada um acontece
3. Teste de contrato da regra de data desconhecida para qualquer leitura nova de mensagens
4. Teste de "mensagem nova chega durante a abertura": a lista final precisa ser igual à da leitura seguinte, sem caso perdido nem duplicado
5. Teste da lista inteira e não só das 30 primeiras linhas, incluindo a posição dos pedidos incompletos inseridos por `MCSCompleting.insert`
6. Teste de empate de ordenação com os mesmos empates de produção (8 fichas e 2 simulações)
7. Teste do caminho comum mostrando que a abertura continua com uma chamada e sem passo novo (regra da Leo)

### 6. Como medir a abertura sem cache

Definições:
- Sem cache no navegador: IndexedDB `mcs-painel` vazio (sem fotografia guardada), sem `have` na chamada, aba anônima. O painel já registra `[panel-performance] list-ready sinceNavigationMs` quando não há fotografia guardada
- Primeira execução no servidor (fria): primeira chamada depois da publicação ou depois de um período parado. O servidor já registra `[boot-timing]` (ms total e número de leituras) e `[today-timing]` (cada fase do HOJE)
- Recarga (quente): segunda chamada em seguida, ainda sem fotografia no navegador

Protocolo (RECOMENDAÇÃO):
1. 10 aberturas frias (uma por publicação ou após 20 minutos parado) e 20 quentes, no mesmo computador e rede, horário registrado
2. Para cada uma: `sinceNavigationMs` no navegador, `[boot-timing].ms` e `[today-timing]` nos registros da Vercel, e `pg_stat_statements` antes e depois para o tempo de banco
3. Relatar mediana e o pior de 10 (p90), separando frio e quente, nunca uma medida só
4. As medidas de referência da Leo (8,4 s antes, 6,9 s nas recargas, 10,5 s na primeira abertura após publicar) devem ser repetidas por esse protocolo antes de qualquer mudança, para ter a mesma régua no antes e no depois

NÃO MEDIDO nesta etapa: nenhum dos três tempos da Leo foi repetido aqui (sem login e sem registros da Vercel).

Medido que ajuda a dimensionar: dentro do banco, ler 1.000 linhas leva cerca de 2 ms; a função de pontuação do HOJE levou 1,49 s com o banco aquecido e tem média histórica de 1,26 s. Ela roda em paralelo com as outras leituras do HOJE, então é um piso provável de cerca de 1,3 a 1,5 s para a parte HOJE enquanto existir como está (HIPÓTESE, falta confirmar no `[today-timing]`). As leituras de tabela custam pouco no banco; o tempo restante deve estar em idas e voltas pela rede (a paginação de 1.000 em 1.000 é sequencial: 5 páginas para calc_runs, 4 para messages), no JavaScript e no início frio do servidor. Isso é HIPÓTESE até os registros da Vercel serem lidos.

### 7. Critério objetivo de aprovado ou reprovado

Aprovado somente se TODOS forem verdadeiros:
1. Equivalência: zero diferenças, campo a campo, em todas as combinações da seção 4, entre versão atual e nova, sobre a mesma fotografia (hashes de entrada iguais antes e depois). Uma diferença em qualquer linha, posição, grupo, área, assunto ou contagem reprova
2. Casos raros reais presentes na comparação: os 7 prints sem data, as 7 mensagens com hora incerta, os empates de ordenação e todos os pedidos incompletos aparecem iguais
3. Mensagem nova durante a abertura: a abertura seguinte mostra a mensagem, sem caso perdido nem duplicado
4. Falha parcial: se uma fonte falhar, a página volta à lista completa anterior, nunca a uma página mais curta que pareça completa (regra já escrita em boot.js)
5. Tempo: mediana quente e mediana fria medidas pelo protocolo da seção 6, com o antes e o depois na mesma régua. Atingir 3 s é a meta da Leo; o relatório diz o número medido, sem arredondar a favor
6. Caminho comum: a abertura continua com uma chamada, sem passo, aviso ou confirmação novos
7. Testes existentes continuam passando, e os testes da seção 5 que faltam existem

Reprovado se qualquer item falhar ou não puder ser medido; item não medido vira pendência, nunca aprovação.

### 8. Alternativas, do ponto de vista de risco para a comparação

- Montar a página no banco (alternativa a validar): maior risco de equivalência. A fila depende de regras em JavaScript (painel/atendimento.js, panel-groups.js, completar-pedido.js, regra de data desconhecida, triagem, assunto, Ref em três estados). Reescrever em SQL duplica essas regras; foi exatamente uma regra fora do caminho comum que quebrou o #286. Só é aceitável com a comparação da seção 4 e um teste de contrato por regra
- Reduzir idas e voltas mantendo as regras no servidor (por exemplo páginas paralelas por id, ou leitura conjunta que passe pelo mesmo `rows()`): risco menor, porque o JavaScript continua igual, mas ainda exige a comparação completa
- Acelerar a função de pontuação (1,49 s medido): não muda ordem nem grupos se o resultado for igual linha a linha; comparação simples do resultado da função antes e depois (361 linhas hoje)
- Índices: pela medição, as leituras de tabela já usam a chave primária e levam cerca de 2 ms dentro do banco; não há evidência de que índice novo mude o tempo da abertura. Índice não muda resultado, mas exige migração (privacidade e qa)
- Início frio do servidor: não muda dados; exige medir antes e depois com o protocolo da seção 6

### 9. Casos raros e a regra "Exceção continua exceção"

- Prints de SMS sem data: 7 de 3.451 mensagens (0,2%). Não justificam passo novo no caminho comum; justificam um teste de contrato e a presença no seed
- Mensagens com hora incerta: 7. Mesma recomendação
- Empates de ordenação: 8 fichas e 2 simulações. O desempate por id já existe; qualquer leitura nova tem de manter
- Pedidos com campo faltando: 305 de 604 pela aproximação (cerca de metade). Isso NÃO é caso raro, é caminho comum e precisa estar na comparação principal
- Mensagens novas: 74 por dia. Também caminho comum

### 10. Checklist do setor qa

- [x] Critérios de aceitação conferidos contra o pedido original e os ajustes da Leo (seção 7)
- [x] Caminhos principais, limites e casos de falha verificados no código e contados nos dados (seções 2, 3 e 9)
- [x] Testes automatizados relevantes conferidos; executados só os que estão declarados como executados (19 de 19); Playwright não executado
- [ ] Uso diário no ambiente autorizado: bloqueado, sem login do painel de produção nem registros da Vercel
- [ ] Correção e efeitos nas funções relacionadas: não se aplica nesta fase (nada implementado)

### 11. Pendências

1. Gerar a linha de base completa da seção 4 (precisa da chave do banco num ambiente autorizado ou de login no painel)
2. Repetir os três tempos da Leo pelo protocolo da seção 6 (precisa dos registros da Vercel)
3. Confirmar com a Leo, se ela lembrar, quais totais mudaram no #286, para fechar a hipótese da seção 3
4. Medir o número exato de pedidos PRECISA_DETALHE pelo painel, não pela aproximação do banco
