# PERF-001 Nível 2 Revisor independente

Data: 2026-10-08
Pedido: PERF-001 (setor responsável eng-backend-infra; qa entra pela comparação completa dos dados)
Agente: Nível 2 Revisor independente do setor qa
Ordem das etapas: 1) avaliação cega abaixo, gravada sem abrir nenhum PERF-001-executor.md nem a pasta perf-qa-exec; 2) a comparação com o rascunho do executor fica para depois, em seção própria, quando for pedida
Limites seguidos: somente leitura no repositório (a única escrita é este arquivo), banco de produção só com SELECT (nenhuma consulta passou de meio segundo), nada publicado, nenhum comentário em PR, nenhum crédito de IA gasto

## Fontes

- Código no commit atual b7ea66e (ramo claude/mcs-system-connection-tsq6ex): api/panel/boot.js, api/panel/today.js, panel-server.js (rows, readRows, allRows, orderComparator, memoRead, maskUnknownDates), panel-attend-page.js, panel-client-context.js, panel-read-model.js, panel-buscas.js, painel/painel.js (bootLoadNow, applyAttend, marcas [panel-performance])
- Histórico: git show ba4efa4 (PR 286), git show 38c2ab0 (PR 287), git show b7ea66e (região cle1, ainda não publicada), git log -S maskUnknownDates
- Registros da Vercel em produção, 2026-10-08 entre 03:59 e 05:22 UTC: [boot-timing], [today-timing], [buscas-timing], [pesquisas-timing]; busca por "fallback" no mesmo período sem resultado
- Banco de produção (SELECT agregados, sem nomes, telefones nem textos): messages, message_journeys, journeys, panel_item_dispositions, journey_toggle_states, panel_conversation_class, whatsapp_user_ids, journey_refs, calc_runs, pg_stat_statements
- Testes locais: npm test na cópia do commit atual (scratchpad); reprodução própria da PR 286 em perf-qa-rev/repro-286.test.js sobre a árvore de ba4efa4 extraída com git archive, banco simulado PGlite com todas as migrações e dados fictícios

## Avaliação cega

### 2. Por que a PR 286 passou nos testes locais e mudou totais em produção (começo por aqui porque orienta os itens 1 e 4)

Fatos
- A leitura conjunta da PR 286 (panel_boot_read_bundle, via panel-boot-reads.js) chama a função do banco direto pelo rpc e entrega as linhas às regras. Ela pula panel-server.rows, que para a tabela messages faz uma correção desde 2026-10-04 (commit 63f6178): um print de SMS sem data original (source_kind SMS_PRINT, sem occurred_at_utc, original_datetime_text "data original desconhecida") recebe created_at vazio e date_unknown, para nunca parecer recente. Pela leitura conjunta essas mensagens chegam com created_at preenchido
- Em produção existem 7 mensagens nessa condição, de 3451 mensagens (0,2 por cento), todas de 2026-10-01, ligadas a 7 fichas ativas. Em 6 dessas fichas o print é a única mensagem; na sétima ele passaria a ser a mensagem mais recente
- Reproduzido localmente na árvore de ba4efa4 (perf-qa-rev/repro-286.test.js, 3 testes):
  - Controle: banco de demonstração sem esse tipo de mensagem, abertura antiga e nova idênticas (o mesmo resultado que fez a PR passar)
  - Ficha existente com um print sem data mais novo: 14 campos mudam no item de HOJE (última mensagem, canal SMS em vez de WhatsApp, "sem resposta" passa de 3 h para 1 min, contactAt, lastCustomerAt)
  - Ficha nova cuja única mensagem é um print sem data: a ficha entra em HOJE; counts.todos 1 para 2, counts.depende 1 para 2, refCounts.all 1 para 2, refCounts.without 0 para 1, total da página 1 para 2, windows.NONE 0 para 1
- Registros de produção na mesma meia hora, intercalando a publicação da PR 286 (dpl_6FWd, 04:36 a 04:38 UTC) com a publicação anterior (dpl_58C1) e a posterior à reversão (dpl_Qxfp), com o mesmo número de fichas (774) e mensagens (3451) em todas:
  - HOJE (today-timing items): 665 antes, 670 na PR 286, 665 depois (diferença de 5)
  - ENVIAR OPÇÕES (buscas-timing): items 744 para 749 e demands 461 para 464
  - PESQUISAS (pesquisas-timing items): 1072 para 1075
  - Nenhuma linha [boot-bundle-fallback]: a leitura conjunta foi usada de fato
- O que os testes da PR 286 deixaram de comparar:
  - Os dados de teste não tinham nenhuma das classes raras que as leituras antigas tratam no meio do caminho (o print sem data é uma delas). O teste comparou "função nova contra consulta antiga" só onde a correção não muda nada
  - O teste existente da regra (tests/print-data-original.test.js) cobre só o caminho antigo; nenhum teste dizia que toda leitura de messages tem de passar pela mesma correção
  - A função normalize do teste trocava datas e números por uma forma comum antes de comparar; isso não causou esta diferença, mas pode esconder outras (formato de data em texto é usado em comparações)
  - O teste da abertura real rodou com 5 fichas no ambiente preview; nada parecido com as 774 fichas, 3451 mensagens e 4585 simulações de produção
  - Não houve conferência depois de publicar: as contagens dos registros já mostravam 665 contra 670 nos primeiros minutos
- A PR 287 não é uma reversão completa: tirou a leitura conjunta, mas manteve em produção a identidade leve da página (buildContexts com listOnly em api/panel/boot.js) e as leituras paralelas de mensagens em panel-client-context.js. Depois dela HOJE voltou a 665, o que indica que a diferença de contagem veio da leitura conjunta

Suposições
- A diferença de 5 em HOJE vem dessas fichas; hoje são 6 candidatas sem descarte, sem desligamento e com assunto PEDIDO_CARRO. A diferença de uma ficha entre 6 e 5 não foi explicada (outra regra de lista ou dado que mudou desde então). Pendência: rodar a leitura conjunta contra uma cópia dos dados de produção para fechar a conta
- Não encontrei outra diferença de transformação entre a leitura conjunta e allRows: ordem por id e desempate são refeitos pelo mesmo orderComparator, colunas iguais, ambiente filtrado igual. Isso foi lido no código, não testado com dados de produção

Riscos
- Qualquer nova "leitura juntada no banco" ou "página montada no banco" que não passe pelas correções de panel-server.rows e allRows repete o mesmo erro com outra classe rara
- A identidade leve (listOnly) segue em produção, comparada só no banco de demonstração; deve entrar na comparação completa do item 1

### 1. Método de comparação completa antes e depois e critério de aprovação

Método (comparação diferencial, versão antiga contra versão nova, sobre os mesmos dados no mesmo instante)
1. Base de dados congelada: os dois códigos leem a mesma fotografia dos dados. Os dados de produção mudam o tempo todo (774 fichas às 04:36 UTC, 781 às 05:20), então comparar aberturas feitas em momentos diferentes não prova nada. Duas bases:
   - Base de casos raros, local e fictícia (PGlite com todas as migrações), com pelo menos um exemplo de cada classe medida em produção: print sem data (7 mensagens), hora incerta (7), marcadores de edição e exclusão (2), empates de updated_at entre fichas (3 grupos), mais de 1000 linhas por tabela (calc_runs 4585, messages 3451, paginação), ficha só com print, Ref em duas fichas, contato com duas fichas, ficha desligada, item descartado, pedido incompleto (PRECISA_DETALHE), mensagem nova recente, mensagem desfeita, outro ambiente. Classes que hoje têm zero em produção (vínculos desfeitos, Ref em duas fichas, contato com vários usuários do WhatsApp) entram mesmo assim, porque a regra existe
   - Cópia completa dos dados de produção, num lugar autorizado pela Leo e pela privacidade (o pedido proíbe criar isso nesta fase; fica como pendência). Sem ela, a alternativa é uma "comparação sombra" em produção, que exige mudança de código e aprovação: a mesma chamada calcula antigo e novo e registra apenas o hash de cada parte e as contagens
2. Relógio congelado: Date.now fixo e igual nas duas execuções, porque "há 3 h", late24, janelas de compra e "sem resposta" dependem da hora
3. Matriz de entradas de POST /api/panel/boot:
   - part main com page: sort ready e recent; ref all, with, recover, without; stat nenhum, late24, hot, sent; query vazia, um trecho de nome fictício, três dígitos de telefone; limit 30 e 10000
   - part main sem page e com includeCounters; part counters com e sem summary
   - have vazio (primeira abertura) e have completo (o painel já tem tudo), para cobrir o caminho das partes "same" e dos itens já conhecidos
   - As rotas sozinhas, fora da abertura (api/panel/today, pesquisas, records?view=manheim), porque as abas usam esse caminho sem readCache
4. Cenários de mudança no meio: inserir uma mensagem nova fictícia de cliente e um pedido incompleto novo e repetir a matriz; os dois códigos têm de colocar a mensagem e o pedido no mesmo lugar (HOJE, ENTRADA, grupo COMPLETAR, contadores)
5. Comparação campo a campo do JSON inteiro: listas e ordem (page.rows, order, allKeys), grupos e áreas, contagens (counts, refCounts, stats, windows, total, shownCount), identities, todos os campos de cada item, mensagens de aviso (degraded, erros por parte), o hash de cada parte. Só três campos podem ser ignorados: generatedAt, dataUpdatedAt e waitedMs. Nada de normalizar datas ou números; se algum formato mudar, a mudança tem de ser provada sem efeito antes
6. Depois de publicar: comparar as contagens dos registros ([today-timing] items, [buscas-timing] items e demands, [pesquisas-timing] items) entre a versão nova e a anterior em aberturas do mesmo intervalo. É conferência necessária, mas não suficiente, porque só mostra contagens

Critério de aprovação
- Zero diferença em todas as combinações da matriz, nas duas bases, com o relógio congelado. Uma diferença reprova, sem tolerância
- Cada classe rara aparece de fato na base usada (o teste falha se a classe estiver ausente), para não repetir o teste que passa por falta de caso
- Contagens dos registros iguais entre versões nas primeiras aberturas depois de publicar; diferença gera reversão
- npm test inteiro verde e o teste do caminho comum do item 4

### 3. Como medir a abertura sem cache e o que só a Leo mede

Fatos
- Não existe cache entre pedidos no servidor: api/panel/boot.js cria um readCache novo a cada chamada; as respostas saem com Cache-Control no-store
- Os caches que existem: (a) no navegador, a cópia da última abertura no IndexedDB "mcs-painel" (o painel desenha a lista na hora com "Mostrando os dados de ... atualizando…" e manda os hashes, e o servidor responde "same" sem mandar o corpo); (b) o cache comum de arquivos do navegador (painel.js, css); (c) a função da Vercel aquecida ou fria; (d) o cache interno do banco (memória do Postgres), que não dá para limpar
- Registros de hoje, 05:07 a 05:22 UTC, publicação atual em sfo1: abertura com página (main, 139 leituras) entre 4671 e 5745 ms no servidor em 8 de 8 medições; counters entre 3941 e 5786 ms. Há uma chamada da abertura a cada cerca de 2 minutos, o que mantém a função aquecida; a medição "fria" só acontece depois de publicar ou de um tempo parado
- pg_stat_statements mostra funções chamadas pela API com média entre 1 e 5 segundos por chamada; o tempo no banco pesa tanto quanto a distância entre a função e o banco. A separação por função fica com eng-backend-infra e confiabilidade-sre

Como medir no servidor (dá para fazer daqui)
- Sempre pelas marcas [boot-timing] e [today-timing], separando main com página, main sem página e counters (o número de leituras distingue: 139, 97, 63)
- Pelo menos 20 aberturas por versão, mediana e o pior caso, e à parte a primeira abertura depois de publicar (fria)
- Comparar versões no mesmo intervalo do dia, porque a carga e os dados mudam

O que só a Leo mede (roteiro)
1. No Chrome do uso diário, abrir as Ferramentas do desenvolvedor, aba Rede, marcar "Desativar cache"
2. Em Aplicativo, IndexedDB, apagar o banco "mcs-painel" (a cópia da última abertura); a sessão continua no aparelho
3. Recarregar e anotar no Console as linhas [panel-performance]: kind boot (ms de cada parte) e list-ready (sinceNavigationMs, o tempo desde a navegação até a lista pronta). A linha list-ready só aparece quando a lista não veio da cópia guardada
4. Repetir 5 vezes sem cache (passos 2 e 3), 5 vezes com cache (só recarregar), e uma vez como primeira abertura logo depois de publicar
5. Anotar também a rede usada (casa, celular) e o aparelho
- Isso repete o protocolo das medições de referência (8,4 s antes, 6,9 s nas recargas, 10,5 s na primeira abertura depois de publicar), que até agora não têm roteiro registrado; sem o mesmo roteiro, os números novos não são comparáveis com os antigos

### 4. Teste do caminho comum por tipo de mudança (regra do CLAUDE.md)

O caminho comum aqui: a Leo abre o painel e vê TODOS com as mesmas listas, contagens e ordem, sem passo, aviso, confirmação ou campo novo, e com o mesmo número de chamadas do navegador na abertura (uma por parte)

- Índice novo no banco: comparação diferencial do item 1 (resultado idêntico); EXPLAIN antes e depois das consultas reais da API; medir também o tempo de gravação das tabelas que recebem o índice (mensagens novas chegam a toda hora); teste de que a abertura continua com o mesmo número de chamadas
- Função nova no banco ou página montada no banco: comparação diferencial completa nas duas bases; teste de contrato dizendo que toda correção de panel-server.rows e allRows (print sem data, colunas de ordem, desempate por id, paginação acima de 1000) vale também pela função, com a classe rara presente; teste do caminho de volta quando a função falha (mesmo resultado, sem aviso novo para a Leo); teste da abertura comum mostrando uma chamada e a mesma tela
- Região das funções (PR 288, vercel.json cle1): os dados não mudam por definição, então o teste é de configuração (tests/regiao-funcoes.test.js já existe) mais a medição do item 3 antes e depois; conferir que agendamentos e rotas de terceiros continuam iguais; contagens dos registros iguais depois de publicar
- Paralelismo ou reaproveitamento de leitura no servidor (readCache, memoRead, inChunks em paralelo): cada consumidor recebe sua cópia, ordem preservada, e fora da abertura nada muda (testes de boot-leitura-unica já fazem parte disso); somar a comparação diferencial
- Identidade leve da página (listOnly, hoje em produção): identityOf igual entre leve e completo para todas as fichas da página, na base de casos raros e na cópia dos dados
- Mudança no navegador (painel.js): teste de tela que abre com e sem a cópia guardada e mostra a mesma lista e as mesmas contagens, sem etapa de carregamento nova e sem clique a mais; contar as chamadas da abertura

## Resultado dos testes locais

- npm test na cópia do commit atual: 1033 de 1034 passaram; a falha (tests/panel-five-tabs.test.js, imagem do login) vem da minha cópia, que deixou de fora os arquivos .jpg, e não do código
- Testes da PR 286 na árvore de ba4efa4: 6 de 6 passam, como na época
- Reprodução própria: 1 controle passa e 2 cenários com print sem data falham, mostrando a mudança de totais

## Pendências

- Fechar a conta de 6 fichas candidatas contra 5 itens a mais em HOJE (precisa da cópia dos dados ou da comparação sombra)
- Comparar a identidade leve (listOnly) com a completa em dados de produção
- Medição no navegador pela Leo, com o roteiro acima
- Decisão da Leo e da privacidade sobre onde rodar a comparação com dados de produção

## Comparação com o rascunho do executor

Feita depois da avaliação cega acima, que não foi alterada. Rascunho lido: setores/qa/entregas/PERF-001-executor.md. Os números que divergiam foram conferidos de novo, de forma independente, com scripts próprios (perf-qa-rev/verifica-etapa2.test.js e perf-qa-rev/verifica-hash.test.js, sobre árvores extraídas por mim de ba4efa4, 55ccf70, 38c2ab0 e do commit atual), registros da Vercel e SELECT agregados. Não usei os scripts do executor para chegar aos números.

### Pontos em que concordamos

- Causa mecânica: a leitura conjunta da PR 286 pulava a correção de panel-server.rows para o print de SMS sem data original, nas partes operational e buscas. A correção existe desde 63f6178, antes da PR 286
- Frequência: 7 prints sem data, em 7 fichas ativas, de 3451 mensagens (0,2 por cento). Conferido de novo: 7 fichas, 7 ativas
- O banco de demonstração não tinha nenhum caso assim, então os testes da PR 286 passaram; a função normalize do teste podia esconder diferenças de formato
- A PR 287 não foi reversão completa: a identidade leve (listOnly) e as páginas paralelas de mensagens continuam em produção
- Em produção a página foi atendida pela PR 286 entre 04:36 e 04:38 UTC, depois pela publicação anterior (dpl_58C1) de 04:40 a 04:48, e pela PR 287 a partir de 04:50; nenhum [boot-bundle-fallback]
- Método: comparar o JSON inteiro de POST /api/panel/boot entre antigo e novo, sobre os mesmos dados, com relógio congelado, numa matriz de ordenações, filtros, limites, have vazio e completo, com mensagem nova e pedido incompleto; ignorar só generatedAt, dataUpdatedAt e waitedMs; nenhuma conversão de tipo; uma diferença reprova
- Comparação com dados reais: daqui não há como; a opção é uma comparação sombra que registra só hashes e caminhos, que exige mudança de código e aprovação da Leo
- Medição: os caches que contam são a cópia no IndexedDB "mcs-painel", o cache de arquivos do navegador e a função fria ou quente; o banco não se limpa; a marca list-ready com sinceNavigationMs é a medida principal no navegador; as referências 8,4, 6,9 e 10,5 s precisam do mesmo roteiro
- Teste do caminho comum por tipo de mudança: as duas listas cobrem os mesmos tipos (índice, função no banco, página montada no banco, região, paralelismo, navegador) com o mesmo princípio

### Divergências, com a evidência de cada lado

1. Quais totais mudaram em produção
   - Executor: diz que falta a Leo confirmar quais totais mudaram e mantém a causa como provável
   - Revisor: os registros da Vercel já mostram os totais, com o mesmo número de fichas (774) e mensagens (3451) nas três publicações. Conferido de novo, filtrando por publicação: HOJE 665 na publicação anterior, 670 nas 3 aberturas da PR 286 (04:36:28, 04:37:38, 04:38:09 UTC), 665 depois; ENVIAR OPÇÕES items 744 para 749 e demands 461 para 464; PESQUISAS items 1072 para 1075
   - Avaliação: a mudança de totais é fato medido; a Leo não precisa lembrar quais números viu para isso ficar provado. O que continua aberto é ligar cada unidade da diferença a uma ficha
2. Quantas mudanças no contador e por qual caminho
   - Executor: no cenário com a última mensagem real de cliente com 30 h, stats.late24 cai de 1 para 0 (uma mudança). Conferido de forma independente: reproduzi late24 de 1 para 0, e só isso muda nos contadores desse cenário (18 caminhos diferentes contando o hash)
   - Revisor: no cenário de uma ficha cuja única mensagem é um print sem data, a ficha entra em HOJE e mudam counts.todos e counts.depende (1 para 2), refCounts.all (1 para 2), refCounts.without (0 para 1), total e windows.NONE
   - Avaliação: os dois cenários são verdadeiros e se somam. O do executor explica uma mudança em atrasadas 24 h (1 ficha em produção com a última mensagem real de cliente com mais de 24 h, conferido de novo). O do revisor é o que explica itens a mais em HOJE, ENVIAR OPÇÕES e PESQUISAS, porque 6 das 7 fichas têm o print como única mensagem (conferido de novo: 7 fichas, 6 só com o print). O executor não mediu esse cenário, então o rascunho dele não explica o aumento de 665 para 670
3. 6 ou 7 fichas
   - Não é divergência de número: são 7 fichas com print sem data; em 6 o print é a única mensagem e em 1 ele passaria a última mensagem. A frase do executor "nas 7 o print viraria a última mensagem" está correta, mas esconde que em 6 delas não havia mensagem nenhuma com data, que é o que faz a ficha entrar na lista
   - Continua aberto: 6 fichas candidatas contra 5 itens a mais em HOJE
4. 14 ou 15 caminhos diferentes no cenário da ficha de demonstração
   - Executor: 15. Revisor: 14 itens de HOJE. A diferença é o hash da parte today, que o executor contou e eu não. Sem divergência de fato
5. Rótulo das chamadas de 97 leituras
   - Executor: chama as chamadas de 97 a 99 leituras de "main sem página" e tira daí que o caminho mais rápido leva de 3,3 a 4 s
   - Revisor: em painel/painel.js (commit atual, 55ccf70 e 38c2ab0) toda chamada main do navegador leva page (loadMainBoot nas linhas 2008 e 2097); includeCounters só vai quando os contadores têm mais de 60 s. Localmente, no banco de demonstração: main com página e contadores 85 leituras, main com página sem contadores 80, main sem página 67, counters 21. Então as de 97 leituras são, com toda probabilidade, main com página sem a parte manheim, não "sem página"
   - Avaliação: os tempos do executor estão certos (batem com os meus, 4671 a 5745 ms para 139 leituras entre 05:07 e 05:22 UTC); o rótulo não. Isso importa para a meta: a primeira abertura do dia vai com contadores (counterCacheAt começa em zero), então passa pelo caminho de 139 leituras, de 4,5 a 5,7 s só no servidor, e não pelo de 3,3 a 4 s
6. A chamada a cada 2 minutos
   - Executor: supõe uma aba esquecida aberta no endereço do deploy
   - Revisor: painel/painel.js tem atualização automática a cada 120000 ms pela aba visível que lidera (REFRESH_MS). Como 120 s é mais que os 60 s dos contadores, cada atualização vai com contadores, o que explica as chamadas de 139 leituras a cada cerca de 2 min. O padrão continuou em www depois das 05:00 UTC (05:07 a 05:22), não só no endereço do deploy
   - Avaliação: é o comportamento normal de uma aba visível do painel. Se a aba no endereço do deploy era esquecida ou não, só a Leo sabe. Para medir, basta filtrar por domínio e lembrar que a atualização automática mantém a função quente
7. Testes rodados
   - Executor: rodou 4 arquivos (29 de 29) e não rodou o npm test inteiro
   - Revisor: rodou o npm test inteiro na cópia do commit atual, 1033 de 1034; a única falha vem da minha cópia sem as imagens .jpg

### Afirmações do executor que confirmei

- 7 prints sem data, 7 fichas ativas, 3451 mensagens; 1 ficha com a última mensagem real de cliente com mais de 24 h (SELECT agregado, repetido)
- pg_stat_statements: panel_boot_read_bundle chamada 8 vezes pelo PostgREST, média 1306 ms, máximo 1672 ms; 2 execuções diretas, média 2128 ms (SELECT repetido)
- late24 de 1 para 0 na PR 286 com a última mensagem real de cliente com 30 h (reprodução própria)
- 55ccf70 contra 38c2ab0 no mesmo banco com print sem data: 0 diferença nos corpos. Conferido nas ordenações ready e recent, limites 30 e 10000, filtro late24 e counters, nos dois cenários (print numa ficha existente e ficha só com print). Achado meu nessa conferência: o hash de today muda entre duas execuções da mesma versão com os mesmos dados, porque dataUpdatedAt fica dentro do hash (não está entre os campos que o boot ignora). Então comparar hashes, como os dois rascunhos propõem, só vale com o relógio congelado; e a parte today nunca volta como "same" para o navegador. O segundo ponto é desempenho, não dado, e fica para eng-backend-infra avaliar
- Linha de base do servidor em sfo1 e as faixas de tempo (com a ressalva do rótulo no item 5)
- Controle A, B, A proposto pelo executor: concordo e adoto; ele pega exatamente o problema do hash acima

### Afirmações do executor que não consegui sustentar

- "Ainda falta você confirmar quais totais viu mudar. Sem isso a causa fica como provável": os totais estão nos registros (divergência 1)
- "main sem página (97 a 99 leituras)": o código do navegador sempre manda page (divergência 5)
- "Parece uma aba esquecida": a atualização automática de 2 min explica o padrão sem precisar de aba esquecida (divergência 6)
- "Mesmo o caminho do servidor mais rápido leva cerca de 3,3 a 4 segundos": o número está certo para as chamadas sem contadores, mas a primeira abertura passa pelo caminho de 139 leituras, mais lento

### O que fica pendente

- Fechar a conta de 6 fichas candidatas contra 5 itens a mais em HOJE, e ligar os +5 de ENVIAR OPÇÕES e os +3 de PESQUISAS às mesmas fichas (precisa da comparação sombra ou de uma cópia dos dados autorizada pela Leo e pela privacidade)
- Comparar a identidade leve (listOnly, em produção) com a completa em dados reais; localmente os dois rascunhos encontraram zero diferença
- Medição no navegador pela Leo, com o roteiro (os dois rascunhos trazem roteiros compatíveis; o do executor separa melhor os cenários de recarga e aba nova)
- Decidir se dataUpdatedAt deve sair do hash de today (efeito no desempenho, não nos dados), com o teste do caminho comum
- Confirmar com a Leo se a aba no endereço do deploy era intencional
