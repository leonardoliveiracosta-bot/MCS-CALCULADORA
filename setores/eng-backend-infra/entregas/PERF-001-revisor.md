# PERF-001 Nível 2 Revisor independente

Data: 2026-10-08
Setor: eng-backend-infra
Papel: Nível 2 Revisor independente, etapa cega
Ordem das etapas: pedido lido; avaliação cega registrada abaixo sem abrir nenhum rascunho do executor; a comparação com o rascunho fica para a segunda etapa
Limites respeitados: nenhum código do repositório alterado, nenhuma migração, nenhuma publicação, nenhum comentário em PR. No banco de produção só houve SELECT, EXPLAIN e um único EXPLAIN ANALYZE (função panel_manheim_score_mmr, conferida como STABLE em pg_proc.provolatile, 1,5 s, executada uma vez). Nenhum dado pessoal ou segredo foi copiado para cá: só contagens e tempos

## Fontes

- Código: api/panel/boot.js, api/panel/today.js, api/panel/records.js, panel-server.js (rows, readRows, allRows, memoRead, messageDateParams, maskUnknownDates), panel-read-model.js, panel-ready.js, panel-search-stage.js, panel-client-context.js, painel/painel.js (bootLoadNow, carregamento de ATENDIMENTO e dos contadores), vercel.json
- Histórico: git show ba4efa4 (PR 286), git show 38c2ab0 (PR 287), git show b7ea66e (PR 288, regions cle1), git log
- Vercel: get_project, list_deployments e get_deployment (campo regions de cada publicação); registros de produção das marcas [boot-timing], [today-timing], [buscas-timing], [boot-page-fallback], [boot-bundle-fallback] entre 2026-10-08 03:58 e 05:18 UTC
- Supabase (projeto wwmakfaqahlbjzqvzgbr): get_project (região us-east-2), pg_stat_statements (acumulado desde 2026-09-19 e duas fotos às 05:20:05 e 05:24:38 UTC para o intervalo atual), pg_proc (volatilidade e definição das funções Manheim), pg_settings, registros do gateway da API (edge_logs: cidade e ponto de presença de quem chama, tempo de resposta da origem)
- Reprodução local: cópia do commit ba4efa4 extraída por git archive numa pasta temporária fora do repositório, com o banco simulado (PGlite com todas as migrações) e uma mensagem fictícia

## Avaliação cega

### Resumo em linguagem simples

1. A abertura hoje tem duas chamadas em sequência no servidor: a lista principal (main) leva em torno de 4,1 a 4,9 s e os contadores (counters) mais cerca de 4,3 s. O tempo vai em três lugares: uma conta pesada do Manheim que o banco refaz várias vezes por abertura, muito processamento dentro da função (cerca de 1 s só para montar HOJE) e leituras em fila (páginas de 1000 linhas lidas uma depois da outra)
2. O PR 286 mudou os totais porque a nova leitura no banco pulou uma correção que o servidor aplica nas mensagens: prints de SMS sem data original devem ficar sem data. Em produção existem 7 mensagens assim (7 fichas); no banco simulado dos testes não havia nenhuma, por isso os testes passaram. Reproduzi a diferença localmente
3. O PR 288 parte de uma premissa errada: as funções não rodam em São Francisco, rodam em Washington (iad1), a cerca de 500 km do banco em Ohio. Mudar para cle1 ajuda pouco (estimativa de 0,1 a 0,3 s por chamada), não chega aos 3 s sozinho
4. Chegar a 3 s exige atacar a conta do Manheim e o processamento na função, e encurtar as filas de leitura. Algumas dessas mudanças precisam de migração; nenhuma precisa mudar regra ou total, desde que a comparação completa seja feita

### 1. Onde vai o tempo da abertura hoje

#### Fatos medidos

Tempos do servidor por chamada POST /api/panel/boot, publicação atual (38c2ab0), domínio de produção, 2026-10-08 entre 04:50 e 05:18 UTC:

| Chamada | Leituras por chamada | Amostras | Faixa | Mediana aproximada |
|---|---|---|---|---|
| main com página (sem contadores) | 97 a 99 | 8 | 3,6 a 7,1 s | 4,1 s |
| main com página e contadores juntos | 139 | 10 | 4,5 a 7,4 s | 4,9 s |
| counters | 63 a 65 | 8 | 4,1 a 5,2 s | 4,3 s |

- No navegador (painel/painel.js) a chamada dos contadores só começa depois que a lista principal chega e é desenhada; o tempo do servidor das duas partes se soma quando a abertura inclui os contadores
- Divisão interna da lista HOJE ([today-timing], 18 amostras da publicação atual): phase1 (leituras) 2,4 a 5,7 s; compute (processamento em JavaScript dentro da função) 0,95 a 1,14 s em todas as amostras; operational 1,5 a 2,9 s; stageIndex 2,2 a 3,6 s; o hash final soma até 0,18 s. Volume: 665 casos, 774 fichas, 3.451 mensagens
- Divisão interna de BUSCAS nos contadores ([buscas-timing], 7 amostras): base 2,1 a 2,3 s; batch 3,5 a 4,1 s; cpu_items cerca de 0,52 a 0,57 s. O batch é a função panel_manheim_batch_overview
- Gateway da API do Supabase, chamadas vindas da Vercel entre 04:52 e 05:20 UTC (tempo de resposta da origem):
  - rpc panel_manheim_score_mmr: 51 chamadas, mediana 1,72 s, p90 3,19 s (usada na lista HOJE e de novo nos contadores, por records.js, com outro horário de referência, então não se reaproveita)
  - rpc panel_manheim_batch_overview: 16 chamadas, mediana 3,34 s, p90 4,30 s
  - rpc panel_identity_evidence (tarefa automática subject-cron, a cada 5 min): 12 chamadas, mediana 3,25 s
  - leituras simples de tabela (messages, calc_runs, journeys, contacts e outras): mediana 50 a 180 ms, p90 270 a 600 ms, mesmo com tabelas de poucos milhares de linhas
- pg_stat_statements no intervalo de 05:20:05 a 05:24:38 UTC (4 min 33 s): panel_manheim_score_mmr 11 chamadas e 7,5 s de banco; panel_manheim_batch_overview 2 chamadas e 6,6 s; panel_identity_evidence 2 chamadas e 6,4 s; messages 111 leituras e 2,3 s; calc_runs 76 leituras e 2,2 s. As três funções Manheim e de identidade somam cerca de 74% do tempo de banco no intervalo
- No acumulado desde 2026-09-19, panel_manheim_batch_overview tem tempo mínimo de 2,4 s por chamada e panel_identity_evidence de 2,1 s; não existe execução rápida delas
- EXPLAIN ANALYZE isolado de panel_manheim_score_mmr: 1,5 s, todas as páginas já em memória (17.571 acertos, nenhuma leitura de disco). Ou seja, é custo de processador, não de disco
- As três funções Manheim (score_mmr, batch_overview, batch_people) chamam panel_manheim_grouped_light, que percorre as 75.182 combinações ativas do lote, lê o JSON de cada veículo e compara datas com o horário atual (now()). Essa conta é refeita do zero em cada chamada, pelo menos duas vezes por abertura (score_mmr na lista e score_mmr de novo nos contadores, mais batch_overview)
- Leituras em fila: allRows lê página por página (1000 linhas), cada página esperando a anterior. Hoje messages tem 3.451 linhas (4 páginas em fila) e calc_runs 4.585 linhas (5 páginas em fila). Além disso há pré-leituras em fila (sessão e usuário do painel, verificação de suporte antes do score e das etapas, leitura de buscas salvas depois das demandas)
- Configuração do banco: shared_buffers 1 GB, effective_cache_size 3 GB, no máximo 2 trabalhadores paralelos, statement_timeout 120 s
- Carga simultânea observada: entre 03:58 e 04:53 UTC uma aba aberta no endereço direto da publicação antiga (domínio mcs-calculadora-2bw3bgls2, publicação 55ccf70) chamou o boot a cada cerca de 2 min com 157 leituras e 6,3 a 11,7 s por chamada, ao mesmo tempo que a aba do domínio de produção; e um cliente "node" a partir de Columbus, Ohio, fez cerca de 4.400 leituras entre 03:40 e 05:23 UTC, origem não identificada

#### Suposições (não medidas diretamente)

- O caminho crítico da lista principal é, em ordem de peso: phase1 limitada por panel_manheim_score_mmr (1,7 s típico) e pelas filas de páginas de messages e calc_runs; depois cerca de 1 s de JavaScript em today; depois a página e o hash. A soma bate com os cerca de 4 s medidos, mas não há marca de tempo separada para o score em today, então isso é inferência
- O tempo de 1 s de compute em today é inflado por trabalho repetido por caso: criação de formatadores de data por item (new Intl.DateTimeFormat em today.js, panel-ready.js e panel-lead.js) e filtros que percorrem todas as mensagens, Refs e itens de IA para cada caso. Microteste local: criar e usar 2.660 formatadores levou 0,20 s contra 0,005 s reaproveitando um; um filtro de 665 casos sobre 3.451 mensagens levou 0,075 s. Na função da Vercel, com fração de processador menor, esses números tendem a ser maiores. Precisa de medição com perfil na própria função antes de virar conclusão
- Todas as listas rodam juntas num só processo Node; o processamento de uma atrasa a leitura das respostas das outras. Por isso os tempos de cada fase se contaminam e a soma do processamento em JavaScript (today, BUSCAS, página, hash) pesa mais do que parece em cada marca isolada
- A diferença entre 1,5 s isolado e 1,7 s mediana (3,2 s p90) do score_mmr em produção vem da disputa de processador no banco com as outras funções pesadas e com as leituras paralelas da mesma abertura

#### Riscos de interpretação

- As medições anteriores vistas pela Leo (8,4 s, 6,9 s, 10,5 s) são do navegador e não puderam ser repetidas daqui. Os tempos acima são só do servidor; falta somar rede até o navegador, desenho da tela e, se a Leo considera a abertura completa com contadores, a segunda chamada
- A aba antiga e o cliente de Ohio aumentam a disputa no banco e podem ter piorado algumas amostras; a mediana é mais confiável que os máximos

### 2. Por que o PR 286 mudou os totais em produção

#### Fatos medidos

- Publicação do PR 286 em produção de 04:35:36 a 04:49:59 UTC (dpl_6FWd), substituída pela do PR 287 (dpl_Qxfp)
- [today-timing] durante o PR 286: items 670; antes e depois: items 665; nas duas situações journeys 774 e messages 3.451, ou seja, os dados de base eram os mesmos e só o resultado mudou (+5 casos em HOJE)
- [buscas-timing] durante o PR 286: items 749 e demands 464; antes e depois: items 744 e demands 461 (+5 e +3)
- Nenhum registro [boot-bundle-fallback] nas últimas 24 h: a nova função do banco respondeu e foi usada, não houve volta às leituras antigas
- No código atual, toda leitura da tabela messages passa por rows() em panel-server.js, que acrescenta a coluna original_datetime_text e, para print de SMS sem data original (source_kind SMS_PRINT, occurred_at_utc vazio, texto "data original desconhecida"), apaga created_at e marca date_unknown. A função panel_boot_read_bundle do PR 286 devolvia as linhas direto do banco e o arquivo panel-boot-reads.js nunca chamava rows(); a correção não era aplicada nem no pacote operational nem no pacote buscas
- Em produção existem 7 mensagens nesse caso, em 7 fichas diferentes, todas do cliente, todas criadas em 2026-10-01. Nas 7 fichas o print seria a última mensagem do cliente e não há mensagem real da equipe depois dele. Frequência: 7 de 3.451 mensagens ligadas (0,2%)
- Reprodução local (cópia do ba4efa4 com o banco simulado, uma mensagem fictícia de print sem data ligada a uma ficha fictícia): as leituras antigas devolvem created_at vazio e date_unknown verdadeiro; o pacote novo devolve created_at preenchido e sem date_unknown, nos dois pacotes. O teste de igualdade falha nos dois casos. O teste original do PR 286 passa (6 de 6) no mesmo ambiente, porque o banco simulado de demonstração não tem nenhum print sem data

#### Causa provável

Sem a correção, cada um desses 7 prints volta a ter data (o momento da confirmação) e passa a ser a mensagem mais recente do cliente sem resposta. Isso faz fichas voltarem a HOJE e mudar grupos e demandas em BUSCAS. O efeito esperado tem o mesmo sentido e a mesma ordem de grandeza do observado (+5 em HOJE, +5 itens e +3 demandas em BUSCAS, com 7 fichas afetadas)

#### Pendência

- Falta provar que os 5 casos extras são exatamente fichas dessas 7. Isso exige rodar a lógica de HOJE com os dados de produção ou reproduzir com 7 prints fictícios num cenário com disposições e respostas parecidas. Não fiz para não ler dados pessoais
- Outras diferenças possíveis do PR 286 que conferi e não encontrei efeito: ordem das linhas (o pacote reordena pelo mesmo comparador), formato de datas e números (a função e o PostgREST usam a mesma conversão para JSON), filtros de ambiente (iguais). Não descartadas por teste em produção, só por leitura de código

#### Observação lateral medida

O PR 286 não deixou a abertura mais rápida: durante ele, base de BUSCAS 3,1 a 3,4 s (contra 2,0 a 2,3 s) e main 3,9 a 5,8 s, faixa igual à de antes

#### Lição para qualquer nova tentativa

Toda leitura que sair do caminho rows() e allRows precisa reproduzir as transformações feitas na hora da leitura, que hoje são: correção de data do print de SMS (messageDateParams e maskUnknownDates), colunas extras lidas e removidas, ordem com desempate por id e comparação de texto en-US, e cópia independente para cada lista. O banco simulado precisa ganhar casos reais raros (como os 7 prints) antes de servir de prova. O caso raro não muda o caminho comum: basta a nova leitura aplicar a mesma correção

### 3. A proposta do PR 288 (regions cle1)

#### Fatos medidos

- Banco Supabase em us-east-2 (Ohio)
- A publicação de produção atual e as anteriores (55ccf70, 38c2ab0) declaram regions iad1 (Washington, Virgínia) na Vercel. A publicação de prévia do ramo com o PR 288 declara cle1
- O gateway do Supabase registra de onde vêm as chamadas: das 17:30 UTC de 07/10 às 05:20 UTC de 08/10, todas as chamadas "node" vindas da Amazon que correspondem às funções da Vercel chegam pelo ponto IAD, cidade Ashburn, Virgínia. Nenhuma pelo oeste dos Estados Unidos
- Os registros da Vercel mostram "region=sfo1" em todas as linhas, inclusive de publicações que declaram iad1. Esse campo não é a região onde a função roda (suposição: é a região de entrada da requisição na Vercel). A mensagem do commit do PR 288 ("as funções rodavam em sfo1 e cada leitura cruzava o país") se apoia nesse campo e não se sustenta

#### Ganho esperado (estimativa)

- Distância real: Virgínia até Ohio, cerca de 500 km, não São Francisco até Ohio. Ida e volta típica entre essas regiões fica perto de 10 a 15 ms (suposição baseada em distância, não medida daqui)
- O caminho crítico da lista principal tem cerca de 15 a 25 idas ao banco em fila (sessão, páginas de messages e calc_runs, pré-verificações, score, montagem da página). Ganho estimado: 0,15 a 0,3 s por chamada de boot, menos de 10% dos 4,1 a 4,9 s. Ajuda, mas não chega a 3 s sozinho
- Para confirmar: comparar [boot-timing] e [today-timing] da prévia em cle1 com os de produção, nas mesmas horas e com o mesmo usuário, ou ver no gateway do Supabase o tempo das chamadas vindas de CMH contra IAD. O cliente "node" de Columbus já visto mostra mediana de 63 ms em leituras e 143 ms em gravações, mas sua origem não está identificada, então não serve de prova

#### Riscos

- Todas as funções mudam de região juntas, incluindo as tarefas automáticas e o webhook do WhatsApp; serviços externos (provedores de IA, Manheim) passam a ser chamados de Ohio. Não há mudança de dados ou totais
- Primeira abertura depois de publicar fica mais lenta (funções frias), como já visto pela Leo (10,5 s); medir depois de aquecer e separar a primeira chamada
- Uma eventual restrição de plano para escolher região: a prévia em cle1 publicou sem erro, então não parece bloqueio
- Risco de expectativa: apresentar o PR 288 como solução da lentidão seria errado; é uma melhoria pequena e barata

### 4. Alternativas para chegar a 3 segundos

Meta de referência: lista principal visível no navegador em até 3 s, sem cache. Descontando rede e desenho (estimativa de 0,4 a 0,7 s), o servidor precisa responder a lista principal em cerca de 2,3 s ou menos. Hoje responde em 4,1 a 4,9 s

| Alternativa | Ganho estimado | Risco de mudar dados ou totais | Migração |
|---|---|---|---|
| A. Remover trabalho repetido no processamento de HOJE e BUSCAS (formatadores de data criados uma vez por fuso, índices por ficha em vez de filtros sobre todas as mensagens e Refs para cada caso) | 0,5 a 0,8 s na lista principal (o compute de 1 s mais parte dos 0,5 s de BUSCAS) | Baixo a médio: muda código de regra; exige a comparação completa antes e depois, inclusive prints sem data e pedidos incompletos | Não |
| B1. Colunas calculadas a partir do JSON dos veículos Manheim (vin, fim do leilão, pista, número, data da venda, preço de compra, MMR) usadas por panel_manheim_grouped_light | Estimativa de 30 a 60% do tempo das funções Manheim (score_mmr de 1,7 s, batch_overview de 3,3 s); precisa de EXPLAIN num ambiente de teste | Baixo: os valores derivam da mesma linha e da mesma regra; a parte que depende do horário (now()) continua sendo calculada na leitura | Sim (colunas novas e reescrita de 75 mil linhas; envolve privacidade e qa) |
| B2. Resultado do agrupamento Manheim guardado por lote, refeito quando o lote ou as seleções mudam; a parte que depende do horário aplicada na leitura | score_mmr de 1,7 s para perto de 0,1 s na lista; batch_overview de 3,3 s para perto de 0,3 s nos contadores | Médio: se a atualização atrasar, os números ficam velhos; precisa de prova de igualdade a cada mudança de lote | Sim |
| C. Encurtar filas de páginas: ler as páginas de messages e calc_runs em paralelo por faixas de id já conhecidas, ou aumentar o limite de linhas por resposta só para essas leituras | 0,2 a 0,5 s | Baixo se mantiver a leitura estável por chave; o código atual escolheu cursor por chave para não pular nem repetir linhas, e isso precisa ser preservado | Não (o limite de linhas é configuração do PostgREST; outras partes do código contam com o corte de 1000) |
| D. Região cle1 (PR 288) | 0,15 a 0,3 s por chamada | Nenhum | Não |
| E. Mais processador para a função da abertura (configuração de memória da Vercel) | Incerto, 0,3 a 0,8 s nas partes de processamento; depende do plano atual, que não consegui ler | Nenhum | Não |
| F. Reduzir disputa no banco: fechar a aba antiga aberta no endereço direto da publicação, identificar o cliente de Ohio, afastar o subject-cron (3,2 s a cada 5 min) dos horários de abertura | Reduz os piores casos (p90) mais que a mediana | Nenhum | Não |
| G. Contadores fora da espera: se a Leo conta a abertura até os contadores, buscá-los ao mesmo tempo que a lista em vez de depois | Até cerca de 4 s na percepção da abertura completa | Nenhum nos totais; aumenta o pico de carga no banco | Não |
| H. Montar a página no banco (modelo de leitura pronto) | Maior potencial (lista principal abaixo de 1 s) | Alto: é exatamente o tipo de mudança que falhou no PR 286; exige reproduzir todas as transformações de leitura e todas as regras | Sim |

Combinação que, por estimativa, pode chegar a 3 s na lista principal sem mudar regra: A + B1 ou B2 + C + D. Soma estimada de ganho: 1,5 a 2,5 s, levando o servidor de 4,1 a 4,9 s para cerca de 1,6 a 3,4 s; a meta de 2,3 s fica dentro dessa faixa, sem garantia: depende da medição com perfil na função (A, E) e de testar B num ambiente de teste. Se a abertura considerada pela Leo inclui os contadores, G ou B2 são necessários para os contadores também

Ordem sugerida com menor risco: medir no navegador (pendência abaixo); F e D (sem risco de dados); A com comparação completa; C; por último B, já como pedido de migração com privacidade e qa

### Pendências

1. Medição no navegador sem cache, que não é possível daqui. Roteiro para a Leo: abrir o painel numa janela anônima (sem cache e sem cópia salva do aparelho), com as ferramentas do navegador na aba Rede e "desativar cache" marcado; recarregar; anotar o tempo até a lista de ATENDIMENTO aparecer e o tempo até os números das abas aparecerem; repetir 3 vezes; anotar também a linha [panel-performance] do console, que mostra o tempo de cada chamada boot. Fazer uma vez logo depois de uma publicação (primeira abertura) e outras depois de 2 minutos
2. Confirmar que os 5 casos extras do PR 286 são fichas entre as 7 com print sem data
3. Perfil do processamento de today.js na função para confirmar onde está o 1 s de compute
4. Plano e configuração de memória das funções na Vercel (alternativa E)
5. Origem do cliente "node" de Columbus, Ohio, e se a aba antiga no endereço direto da publicação 55ccf70 ainda está aberta
6. Medição da prévia em cle1 contra produção nas mesmas condições

### Separação de fatos, suposições e riscos

- Fatos medidos: tempos de [boot-timing], [today-timing] e [buscas-timing]; contagens 665 contra 670 e 744 contra 749 durante o PR 286; 7 prints sem data em 7 fichas; reprodução local da diferença; região iad1 declarada e chamadas chegando por Ashburn; tempos das funções Manheim no gateway e em pg_stat_statements; EXPLAIN ANALYZE de 1,5 s só de processador
- Suposições: o campo region=sfo1 dos registros da Vercel é a região de entrada; ida e volta Virgínia e Ohio de 10 a 15 ms; peso do processamento repetido em today; ganhos das alternativas
- Riscos: qualquer leitura nova fora de rows() repete o erro do PR 286; guardar resultados do Manheim pode deixar números velhos; abrir os contadores junto aumenta o pico no banco; os tempos medidos têm carga extra de uma aba antiga e de um cliente não identificado
