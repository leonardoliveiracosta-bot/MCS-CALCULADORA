# PERF-001 confiabilidade-sre: rascunho do Nível 1 Executor

Identificador: PERF-001
Papel: Nível 1 Executor, setor confiabilidade-sre (apoio, porque a proposta em avaliação envolve infraestrutura)
Data: 2026-10-08 (horários em UTC)
Pedido: setores/eng-backend-infra/entregas/PERF-001-pedido.md
Limites respeitados: somente leitura; nenhum código, configuração, migração, publicação ou comentário em PR foi alterado ou feito; no banco só SELECT em tabelas de estatística e catálogo (nenhuma consulta repetida, nenhum EXPLAIN ANALYZE); nenhum dado pessoal, segredo ou texto de mensagem neste arquivo

## Resumo para a Leo

1. As funções do painel não rodam em São Francisco, como diz o PR 288. Rodam em Washington (iad1, Virginia). O banco fica em Ohio. A distância é pequena: cada leitura gasta cerca de 36 ms de caminho, e gastaria cerca de 15 ms se a função estivesse em Ohio
2. Mudar para cle1 (Ohio) é aceito pela Vercel e não quebra agendas, WhatsApp nem SMS, mas o ganho esperado é pequeno: entre 0,15 e 0,4 segundo por abertura, de um total de cerca de 4,7 segundos no servidor. Sozinho, não leva o painel a 3 segundos
3. O que mais pesa é o próprio banco: quatro funções do banco levam de 1,3 a 3,7 segundos cada uma e rodam a cada atualização automática, numa máquina de 2 processadores que também atende testes e prévias abertas
4. A primeira abertura depois de publicar é de 2,5 a 3,4 segundos mais lenta no servidor porque a função começa "fria" e porque a publicação coincidiu com o minuto de maior carga do banco na hora medida
5. Desfazer a mudança de região é simples: voltar a publicação anterior pela Vercel, em segundos, sem nova compilação

## 1. Regiões e custo de cada ida e volta

### Fatos medidos

| Item | Valor | Evidência |
|---|---|---|
| Região das funções em produção | iad1 (Washington, Virginia, AWS us-east-1) | get_deployment dpl_QxfpvBjJTmvK7qEFDnyEBWS1psej (commit 38c2ab0, produção atual): "regions": ["iad1"] |
| Região do banco | us-east-2 (Ohio) | get_project wwmakfaqahlbjzqvzgbr: "region": "us-east-2", Postgres 17.6 |
| De onde partem as leituras feitas pelas funções | Ashburn, Virginia (ponto IAD da Cloudflare, rede da Amazon): 20.390 leituras entre 04:00 e 05:20; nenhuma leitura de servidor veio de pontos da Califórnia | registros de entrada da API do Supabase (edge_logs), campo request.cf.colo, agente "node" |
| Campo "region=sfo1" nos registros da Vercel | indica por onde a chamada entrou, não onde a função rodou | no mesmo deployment dpl_58C1Jouoh7gHB5hpM7UgN83rkJ93, a agenda subject-cron (chamada pela própria Vercel) aparece com region=iad1 às 04:48:42, e chamadas do navegador aparecem com sfo1; um deployment de região única não executa em duas regiões |
| Custo por leitura saindo de Virginia (03:30 a 05:20, 23.925 leituras GET) | mediana 75 ms no total: 33 ms dentro do Supabase (PostgREST e banco) e 36 ms de caminho e portão de entrada (10% mais rápidas: 18 ms) | edge_logs: response.origin_time e x_envoy_upstream_service_time |
| Custo por leitura saindo de Ohio (mesmo período, 3.947 leituras GET) | mediana 62 ms no total: 35 ms dentro do Supabase e 15 ms de caminho (10% mais rápidas: 5 ms) | mesmas colunas, ponto CMH da Cloudflare (Columbus, Ohio) |
| Diferença por ida e volta | cerca de 21 ms na mediana e 13 ms nas 10% mais rápidas | diferença das duas linhas acima |

Observação sobre a origem de Ohio: são 3.807 leituras do ambiente de prévia (environment=preview), a partir de 03:40, de um cliente fora dos deployments listados na Vercel (origem não identificada). Servem como medida natural do caminho Ohio para Ohio, mas a carga e o tipo de leitura não são idênticos aos da produção

### Leituras da abertura (POST /api/panel/boot), registros de produção

| Parte | Leituras distintas | Tempo no servidor | Amostras |
|---|---|---|---|
| main com página (today, entry, triage, whatsapp, pesquisas, v1) | 139 | 4,67 a 5,75 s; típico 4,7 a 5,0 s | 9 chamadas entre 04:54 e 05:19 no deployment atual |
| main sem página | 97 a 99 | 3,6 a 4,4 s | 6 chamadas entre 04:55 e 05:05 |
| counters (pesquisas e manheim) | 63 a 65 | 4,1 a 4,4 s (uma de 5,2 s) | 6 chamadas entre 04:51 e 05:06 |
| main na versão anterior (dpl_58C1, via endereço do deployment) | 156 a 160 | 6,3 a 11,7 s | cerca de 30 chamadas entre 03:52 e 04:53 |

Detalhe da parte main (marca [today-timing], deployment atual, 5 chamadas entre 05:07 e 05:19): fase de leituras 3,0 a 4,2 s; cálculo na função 1,0 a 1,08 s; índice de andamento das buscas 2,2 a 2,9 s; leitura operacional 1,7 a 2,6 s. A lista pesquisas, que roda em paralelo, leva 4,4 a 5,4 s (marca [pesquisas-timing])

### Leituras em cadeia (quantas esperam a anterior)

Fatos do código:
- requirePanel faz 2 chamadas em sequência antes de qualquer lista: conferência da sessão no Supabase Auth e leitura de panel_users (panel-server.js, linhas 300 a 345)
- allRows lê de 1.000 em 1.000 linhas, uma página depois da outra (panel-server.js, linhas 166 a 197). messages tem 3.457 linhas, então 4 páginas em sequência; calc_runs tem 4.585 linhas, então 5 páginas em sequência
- operational (panel-read-model.js) espera todas as suas leituras e só depois chama outOfFunnelIndex
- loadSearchStageIndex (panel-search-stage.js) primeiro consulta undoSupported e só depois dispara as leituras; loadScoreIndex consulta batchSupported e só depois chama panel_manheim_score_mmr
- com página pedida, boot.js só depois de todas as listas monta os contextos (buildContexts), mais uma rodada

Suposição (estimativa por leitura do código, não medida): o caminho mais longo de uma abertura tem de 12 a 20 idas e voltas em sequência. A soma de 139 leituras não importa para a distância; importa só essa cadeia

## 2. Avaliação da proposta do PR 288 (regions cle1)

### Fatos medidos

- A região é aceita: a prévia dpl_79RPAPHHAXHj2dF9EsaNW5wC24cM ficou pronta (READY) com "regions": ["cle1"], compilada em 21 s
- O PR 288 difere da produção atual apenas em vercel.json (uma linha) e no teste tests/regiao-funcoes.test.js (git diff 38c2ab0 b7ea66e)
- A premissa escrita no commit e no teste ("as funções rodavam em sfo1, São Francisco, e cada leitura cruzava o país") está refutada: as funções rodam em iad1, a cerca de 36 ms de caminho por leitura, não em São Francisco
- A prévia do PR 288 não recebeu nenhuma chamada até 05:23 (zero registros), então o efeito ainda não foi medido na prática
- Já existiu uma tentativa de "colocar as funções perto do banco" na ramificação do PR 280 (prévia dpl_ER1wDraxnnJqBBJzizshH2tGMecc, commit "colocate read functions"), seguida de "keep existing regions after runtime verification" (dpl_F45atNe4xvy8TbVZapgoX7D1fuSu). As duas prévias ficaram em iad1. O conteúdo desses commits não está no repositório local, então não foi possível ver o que foi testado

### Efeito esperado na abertura (suposição calculada a partir das medidas)

12 a 20 idas e voltas em cadeia multiplicadas por 13 a 21 ms dão uma economia de 0,15 a 0,4 s por abertura no servidor, de cerca de 4,7 s. Isso é de 3% a 9%. Não muda: o tempo do banco (33 a 35 ms por leitura e 1,3 a 3,7 s nas funções pesadas), o cálculo dentro da função (cerca de 1 s) nem o caminho entre o navegador e a Vercel

### Efeito em agendas, WhatsApp e SMS

| Ponto | Efeito com cle1 | Base |
|---|---|---|
| Agendas (ai-cron a cada 10 min, subject-cron e openai-cron a cada 5 min, media-cron a cada minuto) | mesmos caminhos, horários e limites de duração; passam a rodar em Ohio e cada leitura delas fica cerca de 21 ms mais curta; o peso das funções do banco que elas chamam não muda | vercel.json do PR 288 mantém as 4 agendas; o teste do PR confere que continuam 4 |
| Webhook do WhatsApp (api/whatsapp/webhook.js) | o endereço não muda (domínio de produção); limites internos de 25 s para gravar e 40 s para processar continuam; a gravação no banco fica um pouco mais rápida | código do webhook; vercel.json mantém maxDuration 60 |
| Envio pelo WhatsApp (waba-v2.360dialog.io) | a saída passa de Virginia para Ohio; diferença esperada de poucos milissegundos | suposição: a localização dos servidores do provedor não foi medida |
| SMS recebido (api/sms/inbound.js, automação do iPhone) | endereço igual; sem efeito além das leituras mais curtas | código |
| Chamadas de IA (OpenAI e Anthropic) | sem efeito relevante | suposição: serviços globais |
| Dependência de regiões | hoje o painel depende de duas regiões da AWS (funções em us-east-1 e banco em us-east-2); com cle1 depende de uma só. Como o painel não funciona sem o banco, juntar os dois não cria um novo ponto de falha | inferência a partir das regiões medidas |

### Como desfazer se piorar

1. Na Vercel, voltar a produção para o deployment anterior (dpl_QxfpvBjJTmvK7qEFDnyEBWS1psej, marcado como candidato a retorno). A região fica gravada em cada deployment, então a volta restaura iad1 em segundos, sem compilar
2. Alternativa: reverter o commit do PR 288 em main; a compilação levou de 21 a 25 s nas medições de hoje
3. Conferir depois da volta: registros [boot-timing] voltando ao padrão, agendas registrando execução, e nos registros do Supabase as leituras de produção saindo de novo do ponto IAD
4. Suposição a confirmar no painel da Vercel: depois de uma volta manual, as próximas publicações de main podem não ir sozinhas para produção até a volta ser desfeita

Critério sugerido para "piorou": mediana de 10 atualizações seguidas da parte main acima de 5,0 s (com 139 leituras), qualquer erro 5xx novo no boot, ou agenda sem execução registrada

## 3. Primeira abertura depois de publicar (referência de 10,5 s)

### Fatos medidos

| Publicação | Primeira chamada | Chamadas seguintes |
|---|---|---|
| dpl_QxfpvBjJTmvK7qEFDnyEBWS1psej (pronta às 04:50:26) | main 7,08 s (99 leituras) e 7,39 s (139 leituras); counters 5,20 s | main 3,6 a 4,4 s (97) e 4,7 a 5,0 s (139); counters 4,1 a 4,4 s |
| dpl_6FWdUzW3MHyuz3dRDkwEfYbK3JtQ (PR 286) | counters 5,78 s; pesquisas com cálculo de fichas 723 ms e de conversas 363 ms | cálculo de fichas 38 a 42 ms e de conversas 30 a 33 ms |
| dpl_58C1Jouoh7gHB5hpM7UgN83rkJ93 (PR 280) | main 8,75 s (160 leituras) | 6,4 a 7,4 s (157 leituras) |

- Na primeira execução, o servidor gasta de 2,5 a 3,4 s a mais na parte main e cerca de 0,9 s a mais em counters
- O cálculo dentro da função chega a ser de 10 a 20 vezes mais lento na primeira execução (723 ms contra cerca de 40 ms), sinal de código ainda não otimizado pelo Node
- boot.js carrega today, pesquisas e as demais listas com require dentro da chamada (objeto PARTS), então o tempo de carregar esses arquivos entra no tempo da primeira abertura
- A publicação das 04:50 caiu nos dois minutos de maior carga do banco na hora medida: 04:48 com 121,6 s de trabalho do Supabase em 60 s e 04:50 com 94,2 s. No minuto 04:48 roda a subject-cron, e às 04:48:42 houve um estouro do limite de 8 s de uma consulta (1 de 4 nas últimas 24 h)
- Não existe cache do lado do servidor entre aberturas: o readCache vale só dentro de uma chamada (boot.js linha 63). O cache que fica vazio é o do navegador; e os arquivos do painel são servidos com "no-store" (vercel.json, regra /painel/(.*)), ou seja, nunca ficam guardados no navegador; painel.js tem 561 KB antes da compressão

### Suposições

- A diferença entre 10,5 s vistos pela Leo e cerca de 7,4 s medidos no servidor vem do início da função antes do código rodar (não aparece nas marcas), do download dos arquivos do painel e do caminho do navegador até a função
- Na primeira execução cada leitura em paralelo abre uma conexão segura nova até o Supabase; nas seguintes, as conexões são reaproveitadas. Não medido

### Frequência (regra exceção continua exceção)

A abertura fria acontece uma vez por publicação e por instância nova. Na noite de 2026-10-08 houve 10 publicações de produção entre 02:00 e 04:50, então ela apareceu 10 vezes, contra cerca de 30 atualizações por hora em cada aba aberta. É exceção: não deve ganhar passo novo no caminho comum

### O que reduz, sem mudar o caminho comum

1. Uma chamada automática de aquecimento logo depois de cada publicação, feita pelo processo de publicação, não pela Leo
2. Carregar os arquivos das listas no início do módulo, e não dentro da chamada, para que o custo caia na inicialização
3. Evitar que a publicação coincida com o pico de carga do banco (ver item 4), o que já reduziria a parte do banco desse atraso

## 4. Carga do banco durante a abertura

### Fatos medidos

| Item | Valor | Fonte |
|---|---|---|
| Tamanho da instância | max_connections 120, shared_buffers 1 GB, effective_cache_size 3 GB; isso corresponde ao porte Medium do Supabase (4 GB de memória, 2 processadores ARM compartilhados), a confirmar no painel do Supabase | current_setting |
| Conexões | 52 no total, 39 do PostgREST, 1 ativa no momento da coleta; nenhum erro 429 na hora medida | pg_stat_activity e edge_logs |
| Tamanho dos dados | banco com 976 MB; manheim_matches 276.652 linhas (523 MB); manheim_vehicles 362.439 linhas (351 MB); messages 3.457 linhas; aproveitamento de memória 99,999% | pg_stat_user_tables e pg_stat_database |
| Limite por consulta | 8 s (papel authenticator); maior tempo registrado 7,96 s; 4 estouros em 24 h | pg_roles, pg_stat_statements, postgres_logs |
| Leituras de servidor na hora 04:20 a 05:20 | 18.923; trabalho total do Supabase 2.394 s (média de 0,67 consulta ao mesmo tempo, pico de 2 no minuto 04:48); mediana 32 ms, 90% abaixo de 321 ms, 99% abaixo de 1.487 ms; 216 acima de 1 s (199 delas são funções do banco), 6 acima de 5 s; 1 erro 5xx | edge_logs |

Funções do banco mais caras (pg_stat_statements, acumulado desde 2026-09-19):

| Função | Chamadas | Média | Total | Quem chama |
|---|---|---|---|---|
| panel_identity_evidence | 4.088 | 2,8 s | 11.501 s | subject-cron (panel-identity.js), só nos minutos 3, 8, 13 e assim por diante |
| panel_manheim_score_mmr | 7.203 | 1,26 s | 9.070 s | cada parte main da abertura (panel-ready.js, loadScoreIndex), sem reaproveitamento entre aberturas |
| panel_manheim_batch_overview | 1.144 | 3,6 s | 4.092 s | parte counters, visão de buscas (panel-buscas-view.js) |
| panel_manheim_batch_people | 2.944 | 1,08 s | 3.180 s | records, contexto do cliente, searches |

Na hora 04:20 a 05:20: score_mmr 161 chamadas com média de cerca de 1,5 s; batch_overview 50 com cerca de 3,7 s; batch_people 40 com cerca de 1,8 s; identity_evidence 23, todas nos minutos da subject-cron, com cerca de 3,5 s. Juntas somam cerca de 580 s, perto de 24% de todo o trabalho do Supabase na hora. As quatro são STABLE (provolatile s)

### Atualização automática

- O painel atualiza a cada 120 s, só na aba visível que lidera, com espera crescente até 15 min depois de erro (painel/painel.js, REFRESH_MS; painel/refresh-coordinator.js)
- Cada ciclo de uma aba custa cerca de 200 leituras, uma score_mmr e uma batch_overview: cerca de 5 s de processamento pesado no banco a cada 2 min por aba
- Clientes vistos atualizando de madrugada contra o mesmo banco: a aba de produção; uma aba aberta no endereço de um deployment antigo até 04:53 (157 leituras por ciclo); uma aba da prévia fix-panel-sms-navigation (dpl_ApNuETP5auKMZ2TchpUaFWH8yVkU, criada em 2026-10-07) atualizando a cada 2 min; e o cliente de prévia não identificado em Ohio
- Prévia e produção usam o mesmo banco (coluna environment). Na hora medida, só as leituras GET de prévia somaram cerca de 622 s de 2.394 s (26%)

### Interpretação

- Não há disputa de conexões: sobra capacidade (39 de 120) e não houve recusa
- Há disputa de processamento nos picos: tabelas pequenas deveriam responder em poucos milissegundos, mas 10% das leituras passam de 321 ms, e os picos coincidem com funções pesadas rodando juntas (agenda mais atualizações de várias abas)
- O estouro de 8 s às 04:48:42 e a falha registrada pela subject-cron no mesmo segundo mostram o efeito desses picos

## 5. Riscos de disponibilidade e plano de recuperação por alternativa

| Alternativa | Ganho esperado | Riscos de disponibilidade | Como recuperar |
|---|---|---|---|
| A. Manter iad1 | nenhum | nenhum novo | nada a fazer |
| B. PR 288 (cle1) | 0,15 a 0,4 s por abertura (suposição calculada) | baixo: troca de região numa publicação comum; agendas, webhook e SMS sem mudança de endereço | volta pela Vercel para dpl_QxfpvBjJTmvK7qEFDnyEBWS1psej em segundos, ou reverter o commit |
| C. Reunir leituras numa função do banco (como o PR 286) | não medido por este setor | hoje cada lista falha sozinha (boot.js devolve ok:false só para a parte com erro); uma função única perde esse isolamento; com 4 a 5 s de trabalho no banco e limite de 8 s, um pico pode derrubar a abertura inteira; além disso a diferença de totais do PR 286 segue sem causa conhecida | reverter o código como no PR 287; a função panel_boot_read_bundle não existe mais no banco hoje (conferido em pg_proc) |
| D. Guardar resultado das funções pesadas entre aberturas (ex.: score_mmr e batch_overview com validade curta, ou tabela preparada por agenda) | potencialmente o maior, porque tira de 1,3 a 3,7 s de banco por ciclo; não medido | dado velho se a agenda falhar; uma agenda a mais competindo nos minutos de pico | validade máxima curta e volta automática à leitura direta quando o dado passar da validade; desligar sem publicar se possível |
| E. Instância maior do banco | mais processadores para os picos; não medido | a troca de porte reinicia o banco por alguns minutos | voltar ao porte anterior, com outra reinicialização curta; fazer fora do horário de uso |
| F. Aquecimento depois de publicar | tira parte dos 2,5 a 3,4 s da primeira abertura | baixo; uma chamada a mais por publicação | remover a chamada |
| G. Fechar abas de prévia e de deployments antigos | reduz a carga de prévia (26% do trabalho GET na hora medida) | nenhum para a produção | não se aplica |

## 6. Riscos registrados

1. Medir o PR 288 na prévia dele não mede produção: prévias leem os dados de prévia, que são menores (main de prévia com 75 leituras em 1,5 a 2,5 s)
2. A premissa errada do PR 288 (sfo1) está escrita no commit e no comentário do teste; se for aprovado assim, o histórico fica com uma informação falsa
3. Funções do banco perto do limite de 8 s: 4 estouros em 24 h; qualquer abordagem que junte mais trabalho numa consulta só aumenta esse risco
4. Prévias e testes usam o banco de produção: uma aba esquecida ou um teste automático competem com a Leo
5. Os registros da Vercel com region=sfo1 enganam: indicam o ponto de entrada, não onde a função rodou

## 7. Pendências e roteiro de medição para a Leo

Comparação limpa da região, com os mesmos dados de prévia e o mesmo código:
1. Abrir a prévia dpl_AjaNz449zXf5ed6PDGuphTw1p8QY (commit 38c2ab0, iad1) e, em outra janela, a prévia dpl_79RPAPHHAXHj2dF9EsaNW5wC24cM (o mesmo código com cle1)
2. Em cada uma, entrar no painel e deixar 10 atualizações automáticas acontecerem (cerca de 20 min), ou recarregar 10 vezes com intervalo de 1 min
3. Comparar a mediana do campo ms da marca [boot-timing] de cada prévia nos registros da Vercel. Esperado pela estimativa: cle1 entre 0,15 e 0,4 s mais rápida
4. Fechar as duas janelas no fim, para não deixar carga no banco

Abertura sem cache no navegador (produção):
1. Abrir o painel no computador, abrir as ferramentas do navegador (F12), aba Rede, marcar "Desativar cache"
2. Recarregar e anotar o tempo até a lista aparecer e o tempo da chamada /api/panel/boot
3. Repetir 5 vezes; fazer uma vez logo depois de uma publicação (abertura fria) e anotar separado
4. O setor confere os mesmos horários nas marcas [boot-timing], [today-timing] e [pesquisas-timing]

Outras pendências:
- Confirmar no painel do Supabase o porte da instância e o uso de processador nos minutos de pico
- Identificar o cliente de prévia que lê o banco a partir de Ohio desde 03:40
- Medir a cadeia real de idas e voltas (contagem de esperas em sequência por abertura), para trocar a estimativa de 12 a 20 por um número

## Fontes

- Pedido: setores/eng-backend-infra/entregas/PERF-001-pedido.md; regras: setores/README.md, setores/confiabilidade-sre/EQUIPE.md, CLAUDE.md
- Código lido: api/panel/boot.js, panel-server.js, panel-read-model.js, api/panel/today.js (linhas 1 a 120), panel-search-stage.js (loadSearchStageIndex), panel-ready.js (loadScoreIndex), panel-identity.js (evaluateJourneys), api/whatsapp/webhook.js, api/panel/media-cron.js, api/sms/inbound.js (início), painel/painel.js (atualização automática), painel/index.html, vercel.json, tests/regiao-funcoes.test.js
- Histórico: git log; git show b7ea66e; git diff 38c2ab0 b7ea66e; git show 55ccf70 --stat
- Vercel (somente leitura): get_project prj_rvTTgtaQ8o682GtphtYQ9TTEt80e; get_deployment de dpl_QxfpvBjJTmvK7qEFDnyEBWS1psej, dpl_79RPAPHHAXHj2dF9EsaNW5wC24cM, dpl_AjaNz449zXf5ed6PDGuphTw1p8QY, dpl_ApNuETP5auKMZ2TchpUaFWH8yVkU, dpl_ER1wDraxnnJqBBJzizshH2tGMecc, dpl_F45atNe4xvy8TbVZapgoX7D1fuSu, dpl_2tkhQ32n3fjwAwmjx914J6gu5vUQ; list_deployments; get_runtime_logs com as marcas [boot-timing], [today-timing], [pesquisas-timing], [buscas-timing] e registros de aviso e erro de 2026-10-08 entre 02:00 e 05:25; search_vercel_documentation (regiões, retorno de publicação)
- Supabase (somente leitura): get_project; execute_sql de leitura em pg_stat_user_tables, pg_stat_activity, pg_stat_database, pg_stat_statements, pg_proc, pg_roles e current_setting, cada consulta executada uma vez; query_logs em edge_logs e postgres_logs (janelas de 2026-10-07 05:30 a 2026-10-08 05:25)
- Não usado: EXPLAIN ANALYZE, navegador no painel de produção, qualquer ação de escrita
