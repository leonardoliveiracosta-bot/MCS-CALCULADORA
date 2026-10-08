# PERF-001 fase 1: diagnóstico da primeira execução após publicar

- Pedido: PERF-001, fase 1 (diagnóstico independente e comparação completa, nada implementado)
- Setor: confiabilidade-sre
- Papel: Nível 1 Executor (rascunho; ainda não revisado pelo Nível 2 nem julgado pelo Nível 3)
- Foco deste papel: item 3 do comando, por que a primeira abertura após publicar levou 10,5 s contra 6,9 s nas recargas
- Data da coleta: 2026-10-08, entre 05:10 e 05:30 UTC, sobre o main no commit 38c2ab0
- Ordem das etapas: este rascunho foi feito sem ver nenhum outro rascunho de PERF-001

## Resumo para a Leo

1. O banco não "esfria" ao publicar: ele está ligado desde 29/09 e 99,999% das leituras já vêm da memória; a lentidão da primeira abertura não vem de disco frio.
2. No momento da primeira abertura medido nos registros do banco, o painel pediu os mesmos dados duas vezes ao mesmo tempo (235 leituras contra cerca de 150 nas recargas); o banco ficou congestionado e a consulta mais pesada passou de cerca de 3 s para 4,3 s.
3. Nessa mesma abertura a sessão de login tinha vencido, o que custou uma ida e volta a mais (cerca de 0,3 s); isso acontece em 0,7% das chamadas.
4. A parte que é "frio" de verdade (ligar a função na Vercel) não deu para medir: a ferramenta da Vercel não está conectada; deixo o passo a passo para medir.
5. Mesmo zerando todo o efeito de primeira abertura, a abertura comum continua perto de 6,9 s; o efeito "frio" explica no máximo os 3,6 s de diferença, não o caminho até 3 s.
6. Recomendo primeiro descobrir de onde veio a leitura dobrada, antes de qualquer mudança de configuração.

## 1. O que foi e o que não foi medido

| Item | Situação |
|---|---|
| Registros do banco (Supabase, edge_logs e postgrest_logs, últimas 24 h) | Medido |
| Estado do banco (memória, conexões, configuração) | Medido com SELECT |
| Plano e tempo da consulta mais pesada da abertura | Medido com EXPLAIN (ANALYZE, BUFFERS) de um SELECT |
| Tempo de carregamento dos módulos do servidor | Medido localmente (Node 22), não na Vercel |
| Início a frio das funções na Vercel (tempo de inicialização, instância nova ou reaproveitada) | NÃO medido: ferramenta da Vercel não conectada |
| Linha `[boot-timing]` que o servidor já grava a cada abertura | NÃO lida: fica nos logs da Vercel |
| Tempo no navegador (download, montagem da tela) | NÃO medido: sem login do painel de produção |
| Os números 8,4 s, 6,9 s e 10,5 s | NÃO repetidos por mim; são referência do PR #287, a repetir conforme a seção 5 |

Nenhum número abaixo foi estimado sem medição, salvo quando marcado como estimativa.

## 2. Fatos medidos

### F1. Onde rodam as funções e onde está o banco

- Banco: Supabase, região us-east-2 (Ohio). Fonte: `get_project` do projeto.
- Chamadas do servidor ao banco (agente `node`) nas últimas 24 h, pelo ponto de entrada da Cloudflare (`request.cf.colo` em edge_logs): 228.971 por IAD (Ashburn, Virgínia) e 3.802 por CMH (Columbus, Ohio), estas só a partir de 03:40 UTC de hoje.
  - Consulta: `select log_attributes['request.cf.colo'], count() from logs where source='edge_logs' and user_agent='node' group by colo`
- Leitura: as funções de produção rodam perto de Washington (iad1, inferido pelo ponto de entrada), a poucos milissegundos de Ohio. O PR #280 registrou sfo1 nos logs do preview; em produção a evidência do banco aponta IAD.
- As chamadas por CMH seguem um ritmo fixo de cerca de 2 min (04:46:24, 04:48:28, 04:50:31, 04:52:34...). Origem não identificada; hipótese: uma implantação de preview com a região experimental do PR #280 ainda aberta em alguma aba. Verificar na Vercel.

### F2. O banco não esfria ao publicar

- Postgres ligado desde 2026-09-29 23:45 UTC (`pg_postmaster_start_time()`); publicar na Vercel não reinicia o banco.
- Tamanho do banco 976 MB; memória de páginas (`shared_buffers`) 1 GB; acerto na memória 99,999% (2.290.914.775 acertos contra 26.692 leituras de disco desde o início). Consulta em `pg_stat_database`.
- Consulta mais pesada da abertura, isolada: `explain (analyze, buffers) select * from panel_manheim_score_mmr('production', now() - interval '60 days')` levou 1.462 ms, planejamento 0,128 ms, `shared hit=17571`, nenhuma leitura de disco.
- Conclusão medida: não há "plano frio" nem "disco frio" relevante no banco depois de publicar.

### F3. Conexões entre a API do banco e o Postgres são recicladas o tempo todo

- O PostgREST (a camada que recebe as leituras do servidor) tem no máximo 40 conexões (postgrest_logs: "Connection Pool initialized with a maximum size of 40 connections").
- Cada migração recarrega o esquema e reinicia esse conjunto de conexões: 04:27:15 (migração do #286) e 04:46:18 UTC (migração de reversão do #287). A publicação do #287 veio cerca de 4 min depois.
- Às 05:14 UTC, 38 das 39 conexões do PostgREST tinham sido abertas em 05:13:11 e 05:13:12 (`pg_stat_activity`, agrupado por `backend_start`). Ou seja, conexões novas surgem a cada rajada depois de um intervalo, não só após publicar.
- Conclusão: conexão nova no banco é o caso comum, não um efeito exclusivo da primeira abertura. O custo dela não foi isolado; pelo planejamento medido (0,128 ms) e pelo acerto de memória, deve ser pequeno.

### F4. O banco fica lento quando recebe muitas leituras ao mesmo tempo

Leituras simples (sem funções) do servidor, 03:15 a 05:20 UTC, agrupadas pela quantidade de leituras no mesmo segundo:

| Leituras no segundo | Segundos | Leituras | Tempo médio de resposta |
|---|---|---|---|
| menos de 10 | 614 | 2.606 | 47,7 ms |
| 10 a 39 | 603 | 13.480 | 63,7 ms |
| 40 a 79 | 238 | 13.518 | 250,9 ms |
| 80 ou mais | 36 | 3.334 | 172,8 ms |

A mesma leitura fica de 4 a 5 vezes mais lenta em rajadas acima de 40 por segundo, que é o tamanho da rajada de uma abertura do painel.

### F5. As duas funções pesadas dominam o tempo de banco da abertura (24 h)

| Função | Chamadas de 1 s ou mais | Mediana dessas | 95% abaixo de | Máximo | Chamadas abaixo de 1 s |
|---|---|---|---|---|---|
| panel_manheim_score_mmr (lista HOJE) | 1.843 | 2.630 ms | 4.304 ms | 7.098 ms | 741 |
| panel_manheim_batch_overview (contadores) | 960 | 3.387 ms | 5.286 ms | 8.331 ms | 0 |

- Isolada, score_mmr leva 1,46 s (F2); dentro das aberturas leva 2,6 s na mediana. A diferença é congestionamento.
- O cron `openai-cron` (a cada 5 min, minutos 2, 7, 12...) carrega `pesquisas` e `panel-buscas-view`, as mesmas leituras pesadas, e pode coincidir com uma abertura. Não medi quanto disso coincidiu.
- Este ponto pertence ao item 1 (consultas lentas) e é tratado pelos outros setores; aqui ele importa porque é o que mais cresce sob carga.

### F6. A janela da primeira abertura mostra leituras dobradas

O PR #287 informa publicação após 04:49:56 UTC e três recargas seguidas. Sem a Vercel não sei o minuto exato em que a nova versão entrou no ar. A janela mais provável da primeira abertura, pelos registros do banco, é 04:52:57 a 04:53:04 UTC (há também uma janela muito movimentada em 04:50:45 a 04:51:01, com várias aberturas sobrepostas, função pesada a 6,8 s; não consigo dizer qual das duas é a medida dos 10,5 s).

Comparação da janela 04:52:57 com duas rajadas seguintes que se parecem com recargas:

| Medida | Janela 04:52:57 | Rajada 04:53:57 | Rajada 04:54:30 |
|---|---|---|---|
| Leituras do servidor na rajada | 235 | 157 | 146 |
| Leituras de mensagens | 37 | 27 | 26 |
| Leituras de eventos do WhatsApp | 16 | 8 | 8 |
| Leituras de contatos | 15 | 9 | 9 |
| Leituras de cálculos da calculadora | 10 | 6 | 6 |
| Chamadas de score_mmr | 2 | 1 | 1 |
| Tempo médio de resposta no 1º segundo | 412 ms | 320 ms | 316 ms |
| Função mais lenta da rajada | 4.351 ms | 3.310 ms | 2.751 ms |
| Do 1º pedido ao último fim de leitura | cerca de 6,0 s | cerca de 5,3 s | cerca de 5,6 s |

- Consulta: contagem por `request.path` em edge_logs, agente `node`, colo IAD, nas três janelas de 6,5 s.
- Leitura: na primeira abertura o servidor executou praticamente o conjunto inteiro de leituras duas vezes, quase ao mesmo tempo (duas verificações de login aceitas, 04:52:57.922 e 04:52:58.402). Cada abertura já tem seu próprio reaproveitamento de leituras; duas aberturas paralelas não compartilham nada.
- Nas recargas há uma só chamada de score_mmr por abertura; corrijo aqui uma suspeita inicial minha de que cada abertura fazia duas.
- Quem fez a segunda execução não é visível no banco. Candidatos, sem prova ainda: outra aba ou outro navegador abrindo o painel no mesmo instante; o caminho de nova tentativa depois do login vencido; o caminho de reserva do painel (`viaBoot.catch` em painel/painel.js, que lê as listas uma a uma quando a abertura rápida falha).

### F7. Sessão vencida na primeira abertura

- 04:52:57.628: verificação de login do servidor recusada (403). 04:52:57.831: o navegador renovou a sessão. 04:52:57.922: verificação aceita. Custo visível de cerca de 0,3 s.
- O mesmo padrão aparece em 05:03:33 e 05:11:23.
- Frequência em 24 h: 43 recusas em 6.274 verificações do servidor por IAD (0,7%) e 1 em 36 por CMH. É exceção, não o caminho comum.
- Cada renovação aparece duas vezes seguidas no registro (por exemplo 04:52:57.831 e 04:52:57.926). Não investiguei a causa; registro como observação.

### F8. O que o código faz a frio (leitura do código, main em 38c2ab0)

- `api/panel/boot.js` carrega today, entry, triage, whatsapp, pesquisas, records e vitrine-funnel só quando a primeira abertura chega (o `require` está dentro de `PARTS`). Medição local, 5 execuções em processo novo: 74 a 95 ms para carregar os 65 módulos. Na Vercel o número pode ser outro; não medido.
- `panel-manheim-state.js` guarda na memória da instância se as colunas `undone_at` e `activated_at` existem. Numa instância nova, a primeira abertura faz uma leitura extra antes de score_mmr e das leituras de lotes ativos. Pela mediana de `manheim_uploads` (83 ms), custa por volta de 0,1 s; estimativa, não medida.
- `requirePanel` faz duas idas sequenciais ao banco antes de qualquer lista (verificação do login e `panel_users`), cerca de 25 a 40 ms cada pelos registros. Isso vale para toda abertura, fria ou não.
- `vercel.json` não lista `api/panel/boot.js`: memória, duração máxima e região são os padrões do projeto na Vercel. Não há chave `regions`. Os padrões efetivos dependem do plano e da configuração do projeto, que não consegui ler.
- Há cerca de 60 arquivos em `api/panel/`; cada um é uma função separada na Vercel. Depois de publicar, todas começam frias, inclusive as que a tela chama junto com a abertura.
- O navegador guarda a última lista (IndexedDB, `BOOT_STORE_VERSION = 3`) e manda o que já tem; o #287 não mudou arquivos do navegador, então a versão guardada continua valendo após publicar.

### F9. Frequência de publicações

- PRs incorporados ao main por dia: 34 (03/10), 24 (04/10), 21 (05/10), 24 (06/10), 26 (07/10). Comando: `git log --first-parent --since=2026-10-01` filtrando `(#N)`.
- Quantos viraram publicação em produção não sei sem a Vercel. Se a maioria vira publicação, a "primeira abertura após publicar" acontece dezenas de vezes por dia nesta fase do projeto. É preciso medir antes de tratar como caso comum ou como exceção.

## 3. Hipóteses para os 3,6 s a mais (10,5 s contra 6,9 s)

Ordem pela força da evidência. Nenhuma está provada; as somas são aproximadas e as partes podem se sobrepor.

| # | Hipótese | Evidência | Peso provável | Como confirmar |
|---|---|---|---|---|
| H1 | Duas execuções completas da abertura ao mesmo tempo congestionaram o banco | F4, F6: leituras em dobro, função mais pesada 1 a 1,6 s mais lenta | Alto, cerca de 1 s ou mais no servidor | Logs da Vercel: contar linhas `[boot-timing]` e invocações de `/api/panel/boot` no minuto da medida; ou o registro de rede do navegador |
| H2 | Sessão vencida: recusa, renovação e nova tentativa | F7: 0,3 s visíveis nos registros | Baixo a médio, só quando a sessão venceu (0,7%) | Mesmo registro de rede do navegador |
| H3 | Início a frio das funções na Vercel (inicialização, carregamento de módulos, código ainda não otimizado pelo Node, conexões novas) | F8: módulos 74 a 95 ms locais; o resto não medido | Desconhecido; provavelmente centenas de ms, não segundos | Logs da Vercel (tempo de inicialização e marcação de instância nova) e a linha `[boot-timing]` |
| H4 | Coincidência com crons (openai-cron nos minutos 2, 7, 12...; subject-cron nos minutos 3, 8, 13...; media-cron a cada minuto) | 04:52 é minuto de openai-cron e 04:53 de subject-cron; F5 mostra que as mesmas funções pesadas rodam no cron | Médio, variável | Cruzar horário das execuções dos crons (Vercel) com as rajadas do banco |
| H5 | Conexões novas no banco após a migração de reversão | F3: conjunto reiniciado 04:46:18; mas conexões novas são frequentes de qualquer jeito | Baixo | Repetir a medida a frio numa publicação sem migração |
| H6 | Navegador: arquivos novos para baixar | #287 não mudou arquivos do navegador | Baixo para esta publicação | Registro de rede do navegador |

O que já dá para afirmar com evidência: a diferença entre primeira abertura e recarga não é causada pelo banco "frio" (F2). O que os registros mostram é mais trabalho ao mesmo tempo (F6) e congestionamento (F4).

## 4. O que é alcançável e o que não é, olhando só a primeira execução

- Fato: as recargas medidas ficaram em 6,3 a 7,4 s (PR #287) e o banco sozinho, numa rajada de recarga, levou cerca de 5,3 a 5,6 s do primeiro pedido ao último fim de leitura (F6).
- Portanto, eliminar todo o efeito de primeira abertura traria a primeira abertura para perto das recargas (cerca de 7 s), não para 3 s. Os 3 s dependem dos itens 1 e 2 (consultas pesadas e montagem da fila), que estão fora deste papel.
- Não tenho evidência para garantir quanto dos 3,6 s se recupera; H1 sozinha parece explicar a maior parte do tempo de banco, mas o tempo do navegador e da Vercel não foi medido.

## 5. Como repetir as medições (8,4 s, 6,9 s, 10,5 s)

### Sem a Vercel (dá para fazer já, só leitura)

1. Registros do banco: para uma abertura com horário anotado, contar leituras por tabela, tempo médio e a função mais lenta numa janela de 7 s (consultas da seção 2, F6). Mostra se houve leitura dobrada e congestionamento.
2. Navegador (exige alguém logado no painel de produção): abrir as ferramentas do navegador, aba Rede e Console, sem cache. O painel já grava `[panel-performance]` com `kind:'boot'` (tempo da chamada) e `kind:'list-ready'` (tempo desde a navegação). Repetir 3 vezes em cada cenário:
   - primeira abertura logo após publicar, uma única aba aberta, sessão recém-renovada;
   - mesma situação com a sessão vencida;
   - recarga com dados frescos;
   - abertura sem nada guardado no navegador (janela anônima), que é a "abertura sem cache" pedida no comando.
   Anotar o horário de cada abertura para cruzar com o banco.
3. Conferir quantas chamadas a `/api/panel/boot` saem do navegador na primeira abertura. Se for uma só, a segunda execução de F6 veio de outro lugar.

### Com a Vercel (exige conectar a ferramenta ou acesso ao painel da Vercel)

1. Hora exata em que a implantação entrou no ar e região efetiva das funções.
2. Logs de `/api/panel/boot`: linha `[boot-timing]` (ms no servidor, quantidade de leituras, ms de hash) e marcação de instância nova com tempo de inicialização.
3. Memória e duração máxima efetivas da função de abertura e se o modo de instâncias compartilhadas da Vercel está ligado.
4. Execuções de openai-cron, subject-cron, ai-cron e media-cron no mesmo minuto da abertura.
5. Lista de publicações em produção por dia (para medir a frequência do caso "primeira abertura após publicar").

## 6. Alternativas para reduzir a primeira execução

Avaliadas pelo efeito esperado e pelo risco à disponibilidade e à recuperação. Nada disso foi implementado.

| # | Alternativa | Ganho esperado | Risco para disponibilidade e recuperação | Muda o caminho comum? |
|---|---|---|---|---|
| A1 | Descobrir e eliminar a execução dobrada da abertura (H1), depois de confirmar a origem | Possivelmente o maior; reduz congestionamento para todos | Baixo, se a correção não remover o caminho de reserva que lê lista por lista quando a abertura rápida falha | Não; tira trabalho repetido |
| A2 | Renovar a sessão antes de chamar a abertura quando ela está para vencer | Cerca de 0,3 s, só em 0,7% das chamadas | Baixo; a renovação já existe, só muda o momento | Não; o caso comum (sessão válida) segue igual |
| A3 | Carregar os módulos da abertura no início da função, não dentro do primeiro pedido | Até cerca de 0,1 a 0,3 s, só em instância nova (estimativa) | Baixo; mas aumenta o tempo de inicialização de toda instância, inclusive as que não abrem a lista | Não visível para a Leo |
| A4 | Fixar como conhecidas as colunas de lotes que a migração já criou (F8) | Uma leitura a menos em instância nova, cerca de 0,1 s | Baixo hoje; perde a proteção para ambiente sem a migração | Não |
| A5 | Aquecer a função depois de publicar com uma chamada automática | Incerto: aquece uma instância, não o congestionamento do banco | Médio: exige uma credencial automática do painel (segurança e privacidade revisam) e pode somar carga no momento da publicação | Não |
| A6 | Limitar quantas leituras a abertura dispara ao mesmo tempo (por exemplo 10 a 16) | Pode reduzir o congestionamento de F4; precisa de medição antes e depois | Médio: se mal ajustado, deixa a abertura mais lenta | Não visível, mas mexe no caminho comum; testar com dados reais |
| A7 | Afastar o openai-cron dos horários de abertura ou deixá-lo mais leve | Reduz coincidências (H4) | Baixo, desde que os prazos do cron continuem cumpridos e sem execuções simultâneas | Não |
| A8 | Mudar a região das funções para perto de Ohio | Poucos ms por ida e volta; desprezível perto de 3,6 s | Médio: mudança de infraestrutura, e o #280 já descartou ganho | Não recomendado agora |
| A9 | Mais memória ou processador para a função de abertura | Só ajuda a parte de cálculo no servidor, que não foi medida | Baixo, com custo | Decidir só depois de ver `[boot-timing]` |
| A10 | Evitar migração imediatamente antes de publicar | Pequeno (H5) | Nenhum | Não |

Recomendação desta fase: medir antes de escolher. A ordem sugerida é A1 (confirmar a origem da leitura dobrada), depois os logs da Vercel para H3, e só então decidir entre A2, A3, A6 e A9. Pela regra "Exceção continua exceção", A2 e A5 tratam casos que hoje são exceção (0,7% e frequência de publicação ainda não medida) e não podem acrescentar passo ou espera à abertura comum.

## 7. Relação com a tentativa revertida (#286)

- Fato: o #286 criou `panel_boot_read_bundle`; em produção os totais mudaram (669 contra 673, segundo o próprio PR) e a Leo reverteu no #287 com uma migração que só apaga a função.
- Do ponto de vista de confiabilidade, a reversão funcionou: a migração recarregou o esquema às 04:46:18 sem erro registrado e a função não existe mais (o esquema passou de 145 para 144 funções nos registros do PostgREST).
- Não investiguei a causa da diferença de totais; fica para o setor responsável pelo item 2. Qualquer nova função de leitura no banco precisa ser comparada em produção, com o mesmo horário e os mesmos dados, antes de publicar.
- Observação de risco: às 04:48:42 UTC uma chamada a `panel_identity_evidence` foi cancelada por tempo esgotado (erro 57014, limite de 120 s). É um caso isolado neste intervalo; não medi a frequência em 24 h.

## 8. Checklist do setor confiabilidade-sre

- [x] Disponibilidade e sinais de falha com evidência do ambiente autorizado: banco saudável, sem reinício desde 29/09; 1 tempo esgotado em `panel_identity_evidence` (04:48:42); 0,7% de verificações de login recusadas por sessão vencida. Sem acesso aos erros da Vercel.
- [ ] Agendamento, execução e atraso das tarefas recorrentes: horários dos crons lidos no `vercel.json`; atrasos e duração reais exigem a Vercel. Pendente.
- [ ] Limites de tentativas e prevenção de execuções simultâneas indevidas: a execução dobrada da abertura (F6) é exatamente um caso de execução simultânea a esclarecer. Pendente de confirmação da origem.
- [x] Saída segura para estados travados e falhas parciais: a abertura tem caminho de reserva (listas uma a uma) quando falha; qualquer alternativa da seção 6 deve preservá-lo. `boot.js` não tem duração máxima própria no `vercel.json`; se o padrão do projeto for curto, uma abertura congestionada pode esgotar o tempo e cair no caminho de reserva, que é mais lento. Verificar o padrão na Vercel.
- [ ] Alertas úteis e instruções de recuperação: o servidor já grava `[boot-timing]`, mas não há alerta configurado no repositório para abertura lenta. Recomendo, depois desta fase, um alerta simples sobre esse registro. Pendente.

## 9. Pendências para o Revisor e o Aprovador

1. Confirmar se a janela 04:52:57 UTC é mesmo a primeira abertura medida em 10,5 s (precisa da hora de entrada da implantação na Vercel).
2. Identificar a origem da segunda execução da abertura em F6.
3. Ler `[boot-timing]` e a marcação de instância nova nos logs da Vercel.
4. Identificar a origem das chamadas por CMH (F1).
5. Repetir as medições 8,4 s, 6,9 s e 10,5 s pelo protocolo da seção 5 antes de qualquer decisão.
