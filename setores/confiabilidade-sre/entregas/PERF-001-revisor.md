# PERF-001 Nível 2 Revisor independente

Setor: confiabilidade-sre (apoio, porque a proposta em avaliação envolve infraestrutura)
Data: 2026-10-08
Etapa: avaliação cega, registrada antes de qualquer contato com o rascunho do executor
Anti-ancoragem: nenhum arquivo PERF-001-executor.md foi aberto ou lido nesta etapa
Limites respeitados: somente leitura; nenhum código, migração, publicação, configuração na Vercel ou no Supabase ou comentário em PR foi alterado ou criado; no banco, apenas SELECT em tabelas de estatística e de sistema e contagens agregadas; nenhuma consulta acima de meio segundo foi repetida

## Fontes

- Pedido: setores/eng-backend-infra/entregas/PERF-001-pedido.md
- Código lido: api/panel/boot.js, panel-server.js (rows, readRows, allRows, memoRead, readRpc, requirePanel), api/panel/today.js (fases e leituras), panel-ready.js (loadScoreIndex), panel-buscas-view.js (batchOverview), panel-identity.js, painel/painel.js (bootLoadNow, abertura, sessão, atualização automática a cada 120 s), painel/index.html, painel/sw.js, vercel.json
- Histórico: git show b7ea66e (commit do PR 288), git log de vercel.json; ramo remoto perf-panel-loading lido com git fetch (commits 06572c7 e ea958a1, tentativa anterior de cle1 por função e sua reversão)
- Vercel (somente leitura): get_project, list_deployments, get_deployment de dpl_QxfpvBjJTmvK7qEFDnyEBWS1psej (produção atual), dpl_79RPAPHHAXHj2dF9EsaNW5wC24cM (prévia do PR 288), dpl_ER1wDraxnnJqBBJzizshH2tGMecc e dpl_ApNuETP5auKMZ2TchpUaFWH8yVkU (prévias com abas abertas); registros [boot-timing], [today-timing], [pesquisas-timing], [buscas-timing] entre 2026-10-07 12:00 e 2026-10-08 05:25 UTC; documentação de regiões
- Supabase (somente leitura): get_project; pg_settings; pg_stat_statements (acumulado desde 2026-09-19); pg_stat_activity agregado; pg_stat_user_tables; pg_proc (provolatile e texto de panel_manheim_score_mmr); contagens por ambiente; registros de borda da API (edge_logs: origem de cada chamada, tempo no servidor, horário) e do Postgres

## Avaliação cega

### Resumo em linguagem simples

O painel demora principalmente porque o banco fica congestionado no momento da abertura, e não por causa da distância entre a Vercel e o banco. A cada abertura o servidor dispara cerca de 60 leituras ao mesmo tempo, mais duas contas pesadas sobre os carros da Manheim que são refeitas toda vez, embora os dados delas mudem raramente. Mudar a região (PR 288) partiu de uma premissa errada: as funções já rodam em Washington (iad1), não em São Francisco. O ganho esperado da mudança é pequeno, perto de um décimo de segundo.

### 1. Regiões, custo de cada ida e volta e leituras em cadeia

Fatos medidos

- Banco Supabase: região us-east-2 (Ohio), Postgres 17, estado saudável
- Funções em produção: a Vercel registra regions ["iad1"] (Washington, us-east-1) para a produção atual e para as prévias sem configuração de região
- Confirmação pelo lado do banco: nas últimas 17 horas, todas as chamadas do servidor da produção chegaram ao Supabase vindas de Ashburn, Virgínia (ponto IAD, rede da Amazon Virgínia do Norte), cerca de 230 mil chamadas
- O campo "region" dos registros da Vercel mostra sfo1 na maioria das aberturas e iad1 em algumas, dentro da mesma publicação. Como a função de uma publicação roda numa região só, esse campo não indica onde a função rodou; ele não serve de evidência de que as funções estão em sfo1
- A mensagem do commit do PR 288 afirma que as funções rodavam em sfo1 e que cada leitura cruzava o país. Isso está refutado pelas duas medidas acima
- Custo de uma ida e volta: na produção, a resposta de autenticação levou 32 ms no servidor do banco e a chamada seguinte saiu 48 ms depois do início da primeira; sobram no máximo 16 ms para rede e processamento da função. Numa função em cle1 (prévia ER1w, ver abaixo), a mesma conta deu 16 ms. Com a resolução dos registros, a diferença de rede entre iad1 e cle1 não aparece
- Cadeia de leituras de uma abertura real (parte main com página, 139 leituras, 4,72 s, 2026-10-08 05:17:42 UTC), reconstruída pelos registros do banco:
  - 2 chamadas em sequência para conferir a sessão (cerca de 0,14 s)
  - uma onda de cerca de 60 leituras simultâneas; leituras simples que levam 18 a 120 ms sozinhas levaram 350 a 530 ms dentro da onda
  - panel_manheim_score_mmr começou junto e levou 2,80 s no banco
  - panel_manheim_batch_overview começou 0,6 s depois e levou 3,20 s no banco
  - leituras dependentes do overview só começaram depois dele (cerca de 0,8 s até o fim)
  - páginas sequenciais de tabelas grandes (calc_runs, messages): entre o fim de uma página e o pedido da seguinte passaram 90 a 180 ms além do tempo no banco, o que é processamento na própria função (a função estava ocupada calculando outras listas), não rede
  - no total, cerca de 10 a 15 passos dependentes em sequência
- Tempo de cada parte em produção (publicação atual, após 04:53 UTC, sem sobreposição com outra aba):
  - main com página (139 leituras): 4,5 a 5,7 s, mediana perto de 4,9 s
  - main sem página (97 a 99 leituras): 3,6 a 4,4 s, mediana perto de 3,9 s
  - counters (63 leituras): 4,1 a 4,7 s, mediana perto de 4,3 s
  - dentro de main, today gasta cerca de 1,0 s só calculando na função (compute 947 a 1.110 ms) e espera 2,4 a 3,4 s pelas leituras; pesquisas gasta 3,3 a 5,3 s em leituras e até 1,2 s calculando
- O navegador chama counters só depois que main termina (sequência observada: main termina, counters começa cerca de 1,3 s depois)

Suposições

- Ida e volta típica entre Virgínia e Ohio na rede da Amazon de 10 a 15 ms, e de 1 a 3 ms dentro de Ohio (valores públicos conhecidos, não medidos aqui)

### 2. A proposta do PR 288 (regions cle1)

Fatos medidos

- Aceitação: a Vercel aceitou a configuração; a prévia dpl_79RPAPHHAXHj2dF9EsaNW5wC24cM ficou pronta (READY) com regions ["cle1"]
- A prévia do PR 288 não recebeu nenhuma chamada desde que foi criada; o efeito não foi medido nela
- Uma prévia não serve para medir o efeito: prévias usam o ambiente preview, que tem 2 fichas e 6 mensagens, contra 781 fichas e 3.451 mensagens em produção
- Já houve uma tentativa anterior: o commit 06572c7 (ramo perf-panel-loading) pôs boot, config, session e client-context em cle1, e o commit ea958a1 desfez isso com a mensagem "keep existing regions after runtime verification". O motivo da reversão não está registrado
- Essa prévia antiga (dpl_ER1wDraxnnJqBBJzizshH2tGMecc) continua com uma aba aberta e atualiza sozinha a cada 2 minutos; o banco recebe essas leituras vindas de Columbus, Ohio (ponto CMH), cerca de 800 por quarto de hora. Isso confirma que funções em cle1 funcionam nesta conta e chegam ao banco por Ohio
- Crons: os quatro agendamentos (ai-cron, subject-cron, openai-cron, media-cron) não mudam de horário nem de prazo com a mudança; o teste do PR confere isso
- Webhook do WhatsApp: nenhuma chamada registrada nas últimas 24 h. SMS de entrada: 8 registros de aviso nas últimas 24 h, todos atendidos em iad1
- Desfazer: a produção anterior (iad1) segue marcada como candidata a reversão na Vercel; a região fica gravada em cada publicação, então voltar à publicação anterior volta para iad1 sem mexer em banco ou variáveis. Pelo código, desfazer exige remover a linha regions e o teste tests/regiao-funcoes.test.js, que trava o valor cle1

Avaliação

- Efeito esperado (suposição apoiada nas medidas): economia de cerca de 10 ms por passo em sequência, vezes 10 a 15 passos, ou seja 0,1 a 0,2 s numa abertura de 4,5 a 5 s no servidor, perto de 2 a 4 por cento. Não leva a abertura a 3 s
- Para o navegador, a diferença depende de onde a Leo está; para quem está no leste dos Estados Unidos, Virgínia e Ohio estão a distâncias parecidas, efeito perto de zero (suposição)
- Crons e webhooks: efeito perto de zero; as chamadas ao banco ficam um pouco mais rápidas, as chamadas a serviços externos (Meta, OpenAI, Anthropic) mudam pouco (suposição)
- Conclusão: a hipótese do PR 288 como solução da lentidão está refutada pela premissa (as funções não estão em sfo1) e pelo tamanho do ganho possível. A mudança em si parece inofensiva e fácil de desfazer, mas é ajuste fino de baixo retorno, não causa principal

### 3. Primeira abertura depois de publicar (referência 10,5 s)

Fatos medidos

- Primeira abertura na publicação atual (pronta às 04:50:26 UTC): main levou 7,08 s e a seguinte 7,39 s, contra 3,6 a 4,9 s nas aberturas normais; counters levou 5,2 s contra 4,1 a 4,7 s
- Parte do excesso é função fria: na primeira counters, o cálculo de fichas levou 801 ms e o de conversas 355 a 392 ms, contra cerca de 55 e 35 ms nas aberturas seguintes; o cálculo de today não mudou (1,06 a 1,11 s)
- Na mesma hora havia três aberturas simultâneas: duas na produção nova e uma numa aba ainda aberta na publicação anterior (endereço vercel.app da dpl_58C1, que levou 10,1 s). A leitura de today ficou em 5,7 s contra 2,4 a 3,4 s nas normais, efeito da disputa no banco
- No navegador, a abertura faz em sequência: página e arquivos, config, sessão, main e depois counters. Config, sessão e boot são funções separadas; logo após publicar, cada uma pode começar fria
- A página carrega cerca de 1,32 MB de JavaScript e CSS (cerca de 0,40 MB comprimidos), todos com Cache-Control no-store pelo vercel.json, mesmo tendo versão no endereço; o service worker não guarda arquivos

O que reduz (hipóteses para o executor e o aprovador validarem)

- Evitar aberturas sobrepostas logo após publicar: fechar abas de publicações antigas e de prévias
- Aquecer automaticamente as funções de config, sessão e boot logo depois de cada publicação, sem passo novo para a Leo e sem créditos de IA
- Reduzir o trabalho pesado do item 4, que também pesa na primeira abertura
- Permitir guardar no navegador os arquivos com versão no endereço; não muda a medida sem cache pedida pela Leo, mas muda o uso real

Pendência: o tempo no navegador não pode ser medido daqui. Roteiro para a Leo: abrir o painel numa janela anônima com as ferramentas do desenvolvedor abertas, aba Rede, marcar "Desativar cache", recarregar e anotar o tempo até a lista aparecer; repetir 3 vezes logo após uma publicação e 3 vezes 10 minutos depois, com as outras abas do painel fechadas

### 4. Carga do banco durante a abertura

Fatos medidos

- Instância: max_connections 120, shared_buffers 1 GB, effective_cache_size 3 GB, 6 processos de trabalho, 2 paralelos; banco com 976 MB; acerto em memória de 100 por cento nas consultas mais pesadas, então o gargalo é processamento, não disco
- Conexões: no momento da consulta havia 39 conexões ociosas do PostgREST (a camada que recebe as leituras da função). Uma onda de cerca de 60 leituras simultâneas passa desse número e fica em fila (a quantidade máxima de conexões do PostgREST não foi lida diretamente)
- Efeito da simultaneidade, medido em 16.334 leituras do servidor na última hora:
  - segundos com 1 a 4 leituras: mediana 27 ms por leitura, 90 por cento abaixo de 66 ms
  - 5 a 19: mediana 44 ms, 90 por cento abaixo de 85 ms
  - 20 a 49: mediana 61 ms, 90 por cento abaixo de 165 ms
  - 50 ou mais: mediana 208 ms, 90 por cento abaixo de 484 ms; 46 por cento das leituras caíram nessa faixa
- Funções do banco mais caras desde 2026-09-19 (tempo total acumulado):
  - panel_identity_evidence (subject-cron, a cada 5 min): 4.088 chamadas, média 2,8 s, mínimo 2,1 s, cerca de 3,2 h no total
  - panel_manheim_score_mmr (today, records, buscas): 7.198 chamadas, média 1,26 s, até 7,6 s, cerca de 2,5 h
  - panel_manheim_batch_overview (pesquisas): 1.143 chamadas, média 3,6 s, cerca de 1,1 h
  - panel_manheim_batch_summary_v2, offer_summary, batch_people, batch_cars: médias de 1 a 5 s
- Na janela de 04:55 a 05:20 UTC: 44 chamadas de score_mmr (média 1,38 s, até 4,1 s), 13 de batch_overview (média 3,5 s, até 4,8 s), 10 de identity_evidence (média 3,3 s)
- Repetição: score_mmr é chamada pelo caminho comum rpc, sem a memória compartilhada da abertura (readRpc); today, records e buscas pedem a mesma conta em separado
- Os dados dessas contas mudam raramente: há 1 lote Manheim ativo nos últimos 60 dias e o último envio foi em 2026-10-06; ainda assim a conta é refeita várias vezes a cada 2 minutos. Ainda falta confirmar quais outras tabelas alimentam a conta (por exemplo pedidos e fichas)
- score_mmr levou 2,80 s numa abertura de produção carregada e 0,54 s numa prévia, o que mostra o quanto a disputa infla o custo
- Atualização automática: cada aba líder visível refaz main e counters a cada 120 s. Na última hora houve 158 aberturas no banco, de 5 publicações: 58 da prévia ApNu (fix-panel-sms-navigation), 29 da prévia ER1w (cle1), 37 da produção anterior dpl_58C1 (incluindo uma aba no endereço vercel.app até 04:53), 29 da produção atual e 5 de outra publicação antiga. Cerca de 55 por cento das aberturas da hora vieram de abas esquecidas em prévias, todas no mesmo banco da produção
- Leituras do servidor por hora: cerca de 10 mil à tarde e 17 a 19 mil à noite de 2026-10-07, acompanhando o número de abas abertas
- Registros do Postgres nas últimas 24 h: sem erro de conexão e sem tempo esgotado; 6 rejeições de regra de validação em conversation_pending_insights (fora do escopo, registrado para o setor responsável)

Suposições

- Pelo par max_connections 120 e shared_buffers 1 GB, a instância parece ser do tamanho Medium do Supabase (4 GB de memória, 2 núcleos compartilhados). Confirmar no painel do Supabase
- Aumentar a instância daria mais núcleos para as contas pesadas, mas tem custo mensal e não resolve a repetição; fica como alternativa a medir, não como primeira escolha

### 5. Riscos de disponibilidade e recuperação de cada alternativa

| Alternativa | Ganho esperado | Risco de disponibilidade | Recuperação |
|---|---|---|---|
| Região cle1 (PR 288) | 0,1 a 0,2 s (suposição) | Baixo; região menor que iad1; banco e funções na mesma região da Amazon passam a cair juntos, mas sem banco o painel já não funciona | Voltar à publicação anterior na Vercel ou reverter o commit e o teste |
| Fechar abas esquecidas em prévias e publicações antigas | Menos disputa; cerca de 55 por cento menos aberturas por hora no banco na amostra | Nenhum | Não se aplica |
| Não refazer as contas da Manheim a cada abertura (guardar o resultado e refazer só quando um lote muda) | Tira 2,8 a 3,2 s do caminho mais longo da abertura medida (suposição até ser testado) | Médio: resultado guardado pode ficar velho se a regra de quando refazer estiver errada; exige migração ou memória no servidor e comparação completa antes e depois, como pede a Leo | Voltar a calcular na hora, mantendo o caminho antigo como reserva |
| Limitar quantas leituras saem ao mesmo tempo ou reduzir o número de leituras | Leituras passam de cerca de 208 ms para 44 a 61 ms na mediana (faixa medida) | Médio: a tentativa anterior de juntar leituras (PR 286) mudou totais em produção sem causa identificada | Reversão por publicação anterior; exige comparação completa |
| Mais processador para a função de abertura | Reduz parte do cerca de 1 s de cálculo de today e do cálculo de pesquisas (suposição) | Baixo; custo maior por execução | Voltar a configuração anterior |
| Aquecer funções após publicar | Remove a penalidade de função fria (cerca de 1 s observado nos cálculos) | Baixo; chamada automática a mais por publicação | Desligar o aquecimento |
| Aumentar a instância do banco | Incerto; mais folga para as contas pesadas | Baixo a médio; troca de tamanho causa reinício curto do banco | Voltar ao tamanho anterior, com novo reinício |

Riscos observados agora, independentes da escolha

- Abas de prévias e de publicações antigas atualizando sozinhas contra o mesmo banco: aumentam a disputa e contaminam qualquer medida de antes e depois. Medidas da PERF-001 devem ser feitas com essas abas fechadas e registrando quantas aberturas houve no banco no mesmo período
- Prévias não representam a produção (2 fichas contra 781), então nenhuma prévia confirma ou refuta ganho de velocidade
- Um subject-cron falhou por erro de sintaxe no arquivo publicado em 2026-10-07 entre 05:38 e 05:48 UTC (3 registros em duas publicações já substituídas); não reapareceu na janela lida, fica registrado para o setor responsável

### Separação final

Fatos medidos: funções em iad1 e banco em us-east-2; premissa sfo1 do PR 288 refutada; cle1 aceita pela Vercel; ida e volta de no máximo cerca de 16 ms; caminho mais longo da abertura dominado por duas contas da Manheim de 2,8 e 3,2 s; leituras quatro a oito vezes mais lentas quando saem 50 ou mais por segundo; cerca de 55 por cento das aberturas da última hora vieram de abas em prévias; primeira abertura após publicar em 7,1 a 7,4 s no servidor, com sinais de função fria e de aberturas sobrepostas

Suposições: ganho de 0,1 a 0,2 s com cle1; tamanho Medium da instância; efeitos estimados de guardar as contas da Manheim, limitar a simultaneidade e aquecer funções; distâncias de rede públicas

Riscos: reverter ou repetir a abordagem do PR 286 sem explicar a diferença de totais; resultado guardado ficar velho; medidas contaminadas por abas esquecidas; nenhuma das mudanças medida ainda em produção

## Comparação com o rascunho do executor

Etapa: comparação, feita depois de registrada a avaliação cega acima (que não foi alterada)
Rascunho lido: setores/confiabilidade-sre/entregas/PERF-001-executor.md
Novas verificações feitas nesta etapa (somente leitura): edge_logs do Supabase (tempo no portão e no PostgREST por origem, trabalho por ambiente e por minuto, horários das leituras vindas de Ohio), postgres_logs (tempo esgotado), pg_roles (limite por consulta), registros [boot-timing] da prévia dpl_ER1wDraxnnJqBBJzizshH2tGMecc

### Pontos em que concordamos

- Funções em produção em iad1 (Virgínia) e banco em us-east-2 (Ohio); a premissa sfo1 do PR 288 está refutada; o campo region=sfo1 dos registros da Vercel não indica onde a função rodou
- A Vercel aceita cle1 (prévia dpl_79RPAPHHAXHj2dF9EsaNW5wC24cM pronta com regions ["cle1"]); a prévia do PR 288 não recebeu chamadas, então o efeito não foi medido
- Prévias usam os dados de prévia (muito menores) e não medem produção
- cle1 sozinho não leva a abertura a 3 s; agendas, webhook e SMS não mudam de endereço nem de horário; desfazer é voltar à publicação anterior na Vercel, que mantém iad1
- Tempos da abertura no servidor: main com página perto de 4,7 a 5 s, sem página 3,6 a 4,4 s, counters 4,1 a 4,4 s (uma de 5,2 s); today gasta cerca de 1 s calculando na função
- O peso principal está nas funções pesadas do banco (score_mmr, batch_overview, batch_people e identity_evidence), refeitas a cada atualização automática, e na disputa por processamento nos picos
- Primeira abertura após publicar: main 7,08 e 7,39 s, counters 5,2 s; sinais de função fria (cálculo de fichas 10 a 20 vezes mais lento na primeira execução); aquecimento automático após publicar como hipótese, sem passo novo para a Leo
- Porte do banco: os dois inferem o tamanho Medium pelo par max_connections 120 e shared_buffers 1 GB; os dois pedem confirmação no painel do Supabase
- Arquivos do painel com no-store; abas de prévia e de publicações antigas competindo com a produção no mesmo banco; a função panel_boot_read_bundle não existe mais no banco

### Divergências, com a evidência de cada lado e nova verificação

1. Custo por ida e volta (executor: 36 ms saindo de Virgínia contra 15 ms saindo de Ohio; revisor na avaliação cega: no máximo 16 ms e diferença não visível)
   - Nova verificação: nas leituras GET do servidor entre 03:30 e 05:20, o tempo entre o portão do Supabase e o PostgREST (tempo de origem menos tempo do PostgREST) foi de 18 ms (10% mais rápidas) e 37 ms (mediana) para 23.384 leituras vindas de Virgínia, contra 5 ms e 14 ms para 3.910 leituras vindas de Ohio
   - Conclusão: o executor está certo e a minha conta da avaliação cega estava errada. Eu tratei o tempo de origem como tempo só do servidor, mas ele já inclui o trecho de Virgínia até Ohio; o que sobrou na minha conta foi processamento da função, não rede. Correção: cada ida e volta saindo de Virgínia custa de 13 ms (10% mais rápidas, mais próximo da distância pura) a 23 ms (mediana, que inclui fila no portão) a mais do que saindo de Ohio
2. Ganho de cle1 (executor: 0,15 a 0,4 s; revisor: 0,1 a 0,2 s)
   - Com a correção do item 1, refaço a conta: 8 a 16 idas e voltas no caminho mais longo vezes 13 a 23 ms dão de 0,1 a 0,37 s, de 2% a 8% de uma abertura de cerca de 4,7 s no servidor
   - Faixa sustentada pelos dois lados: abaixo de 0,4 s e abaixo de 10%. O valor exato depende da contagem da cadeia (item 3) e só uma medida com o mesmo código e os mesmos dados confirma
3. Leituras em cadeia (executor: 12 a 20, estimadas pelo código; revisor: 10 a 15, pela reconstrução de uma abertura)
   - Reexame da abertura de 05:17:42: o caminho que define o fim da abertura passa por autenticação (2), primeira onda (1), panel_manheim_batch_overview (1), manheim_demand_syncs e vehicle_request_checks (2) e montagem das identidades da página (2 a 3), cerca de 8 a 9 idas e voltas; a cadeia de páginas de calc_runs e messages tem de 5 a 6 passos, mas corre em paralelo e termina antes
   - Conclusão: a cadeia que conta para a distância tem cerca de 8 a 16 passos; o número exato segue pendente, como o executor também registrou
4. Peso das prévias abertas (executor: 26%; revisor: 55%)
   - Não há contradição: são medidas diferentes. Nova verificação entre 04:20 e 05:20: as leituras GET de prévia somaram 622 s de cerca de 2.395 s de trabalho do PostgREST, 26% (confirma o executor); elas foram 6.088 de cerca de 16.900 chamadas do servidor (36%); e pelas marcas [boot-timing] houve 158 aberturas entre 04:25 e 05:25, 87 delas em prévias (55%, a minha medida)
   - Leitura correta: as prévias fazem mais da metade das aberturas e cerca de um terço das chamadas, mas pesam cerca de um quarto do trabalho do banco, porque têm poucos dados. As chamadas de funções do banco (POST) não foram separadas por ambiente, então o peso das prévias no trabalho total pode ser um pouco maior que 26%
5. Origem das leituras vindas de Ohio (executor: cliente de prévia não identificado; as duas prévias da tentativa anterior ficaram em iad1)
   - Nova verificação: as rajadas vindas de Ohio terminam alguns milissegundos antes de cada registro [boot-timing] da prévia dpl_ER1wDraxnnJqBBJzizshH2tGMecc (05:11:09, 05:13:13, 05:15:16, 05:17:20, 05:19:24, 05:21:27, 05:23:30), com 110 a 122 chamadas cada, compatíveis com as 113 leituras dessa prévia mais a autenticação
   - Conclusão: o cliente vindo de Ohio é essa prévia. A Vercel mostra iad1 para a publicação inteira, mas o commit 06572c7 pôs boot.js, config.js, session.js e client-context.js em cle1 função por função, e essas funções rodam em Ohio. A afirmação do executor de que as duas prévias ficaram em iad1 vale só para o nível da publicação
6. Tentativas anteriores de cle1 (commits 06572c7 e ea958a1)
   - O executor não conseguiu ver o conteúdo; eu li com git fetch do ramo perf-panel-loading: 06572c7 acrescentou regions ["cle1"] a 4 funções; ea958a1 retirou as 4 com a mensagem "keep existing regions after runtime verification". O motivo da reversão não está escrito em lugar nenhum que eu tenha lido
   - Consequência: a aba aberta nessa prévia é hoje a única medida real de funções em cle1, mas com dados de prévia e código diferente do atual, então não serve para comparar velocidade com a produção
7. Disputa de conexões (executor: não há disputa, 39 de 120 livres e nenhum erro 429; revisor: a onda de cerca de 60 leituras passa das 39 conexões do PostgREST e espera em fila)
   - Concordamos que não houve recusa nem erro de conexão. Não se sustenta, porém, que não haja espera: a minha medida mostra a mediana por leitura subindo de 27 ms (1 a 4 leituras por segundo) para 208 ms (50 ou mais por segundo). Se a espera acontece no grupo de conexões do PostgREST ou no processador do banco não foi separado por nenhum dos dois; o tamanho do grupo de conexões do PostgREST não foi lido
8. Tempo esgotado no banco (executor: limite de 8 s, 4 estouros em 24 h, um às 04:48:42; revisor na avaliação cega: sem tempo esgotado)
   - Nova verificação: pg_roles mostra statement_timeout de 8 s para authenticator e authenticated; os registros do Postgres mostram 4 cancelamentos por tempo esgotado em 24 h (2026-10-07 06:03:55, 06:03:56 e 13:08:42; 2026-10-08 04:48:42). O executor está certo; a minha afirmação estava errada, porque agrupei só as mensagens mais frequentes e essas ficaram de fora
9. Quem chama as funções pesadas (executor: score_mmr em cada main e batch_overview em counters; revisor: score_mmr chamada em separado por today, records e buscas, e batch_overview também em main quando a página é pedida)
   - As duas descrições são parciais e compatíveis: pelo código e pela abertura de 05:17:42, batch_overview roda dentro de pesquisas, que entra em main com página e em counters; score_mmr não usa a memória compartilhada da abertura (chama rpc direto), então pode rodar mais de uma vez por ciclo de main mais counters

### Afirmações do executor que confirmei

- Regiões, premissa sfo1 refutada e significado do campo region (confirmadas por get_deployment e pela origem das chamadas no banco)
- Custo por ida e volta de 36 ms contra 15 ms na mediana (confirmado: 37 contra 14 ms)
- Pico de trabalho do banco em 04:48 (121,6 s em 60 s) e 04:50 (94,2 s), coincidindo com a primeira abertura após a publicação das 04:50 (confirmado)
- 26% do trabalho GET vindo de prévias (confirmado: 622 s de cerca de 2.395 s)
- Limite de 8 s e 4 estouros em 24 h (confirmado)
- Médias e totais de pg_stat_statements das quatro funções pesadas e todas STABLE (confirmado para as que consultei)

### Afirmações do executor que não consegui sustentar ou que corrijo

- "Nenhuma leitura de servidor veio de pontos da Califórnia" e "origem de Ohio não identificada": a primeira eu também vi; a segunda está resolvida, a origem é a prévia ER1w com funções em cle1 (item 5)
- "As duas prévias ficaram em iad1": vale só para o nível da publicação (item 5)
- "Não há disputa de conexões": não há recusa, mas há espera crescente com a simultaneidade (item 7)
- "10 publicações de produção entre 02:00 e 04:50": não conferi a janela inteira; a listagem que li mostra ao menos 7 publicações de produção entre 02:36 e 04:50
- A falha da subject-cron às 04:48:42 e os limites internos do webhook (25 s e 40 s) não foram conferidos por mim
- "Cada ciclo de uma aba custa uma score_mmr": pelo código pode ser mais de uma por ciclo de main mais counters (item 9)

### Correções à minha avaliação cega (registradas aqui, sem alterar a seção original)

- Ida e volta: o valor de "no máximo 16 ms" e a frase "a diferença de rede entre iad1 e cle1 não aparece" estão errados; o correto é de 13 a 23 ms a mais por ida e volta saindo de Virgínia (item 1)
- Ganho de cle1: passa de 0,1 a 0,2 s para 0,1 a 0,37 s (item 2); a conclusão não muda
- Tempo esgotado: houve 4 em 24 h, e não nenhum (item 8)

### Pendências

- Medir a cadeia real de idas e voltas de uma abertura de produção com contagem automática, para fechar a faixa de 8 a 16
- Medir cle1 com o mesmo código e os mesmos dados: o roteiro do executor (prévia dpl_AjaNz449zXf5ed6PDGuphTw1p8QY em iad1 contra dpl_79RPAPHHAXHj2dF9EsaNW5wC24cM em cle1) mede só a distância, com dados de prévia; serve para confirmar os 13 a 23 ms por ida e volta, não o ganho em produção
- Descobrir o motivo da reversão ea958a1 com quem fez a verificação
- Separar por ambiente o trabalho das funções do banco (POST) para fechar o peso real das prévias
- Separar se a espera nas ondas de leituras acontece no grupo de conexões do PostgREST ou no processador do banco
- Confirmar o porte da instância e o uso de processador nos minutos de pico no painel do Supabase
- Fechar as abas das prévias ApNu e ER1w antes de qualquer medida de antes e depois
- Tempo no navegador sem cache continua com a Leo, pelos roteiros dos dois arquivos
