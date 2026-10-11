# PERF-002: auditoria atual da abertura de TODOS

Data: 2026-10-11 UTC
Base conferida: main 7e0dae12e5e0638290ef1ca0fd05a49f43554976
Responsável: Codex, auditoria técnica direta e implementação
Natureza: atualização com evidências atuais, não relatório final de aprovador dos setores

## Pedido e limites

Auditar a pasta de desempenho, explicar o tempo atual de TODOS e retirar leituras repetidas e esperas desnecessárias. Autorização do usuário para corrigir e publicar, preservando dados, layout, regras, grupos, ordem, contagens, preços e manuseio. Não enviar mensagens nem executar seleções de carros em produção para testar.

## O que mudou desde PERF-001

Foram conferidos pedido, executores e revisores de backend, QA e SRE. PERF-001 não possui os três relatórios finais de aprovador nesta pasta. Seus números e pendências são históricos de 08/10 e não representam automaticamente o estado atual.

| Tema histórico | Estado conferido agora |
|---|---|
| São Francisco como causa principal | Premissa já refutada no revisor de SRE. O campo sfo1 nos logs não demonstra a região de execução. Não repetir a troca de região como solução principal |
| Extrair JSON e agrupar Manheim do zero | As funções de produção já usam `panel_internal.manheim_grouped_prepared` e `panel_internal.manheim_score_mmr_candidates`. Recriar o preparo seria duplicar trabalho já publicado |
| Paginação serial de mensagens e simulações | O boot atual usa `panel_boot_table_rows` para quatro históricos completos. Manter histórico completo é necessário para as regras, não ler somente os 30 cartões antes de classificar |
| Repetir a abertura e desenhar a lista duas vezes | Já existe compartilhamento de chamadas em andamento e renderização única na abertura |
| Dicionário consultado por cada parte | PRs #349/#350 já compartilham uma leitura por boot, mantendo nova leitura na próxima abertura |
| Cálculo em cada ficha usando todo o acervo | O código atual usa índices por ficha e compartilha fontes. O trecho compute de today nos registros atuais foi 448 a 547 ms |
| Totais errados no #286 | A regra dos prints de SMS sem data continua preservada e foi incluída na comparação completa |
| Percentual de prévias abertas e primeira abertura em dobro | Evidência histórica. Não foi reproduzida nesta auditoria e não é apresentada como causa atual medida |

## Desperdício encontrado e corrigido

1. A triagem fazia leituras próprias de conversas, contatos e citações depois que o boot já tinha carregado as mesmas fontes completas. Suas buscas por até 100 IDs agora passam pelo compartilhamento de projeções existente.
2. A leitura dos candidatos Fora da MCS era iniciada no fim da triagem, embora não dependesse das etapas anteriores. Agora inicia junto com as classificações e o assunto.
3. As citações aguardavam primeiro as conversas e depois os nomes. Agora começam junto com as conversas; nomes continuam esperando somente os IDs de contato.
4. Os filtros conhecidos de conversas, direção das mensagens, mensagens não desfeitas, links `/v/` e fichas não encerradas impediam reaproveitar fontes completas da abertura. Esses filtros exatos agora são aplicados sobre a fonte já solicitada, inclusive quando ela ainda está sendo preparada.
5. Na verificação publicada do #351, as mensagens complementares caíram de 6 para 1 consulta, mas nomes de contatos ainda eram relidos 3 vezes no main. Uma dessas chamadas levou 2.337 ms. Os nomes das sugestões e revisões agora começam antes da prova das mensagens e reaproveitam a fonte completa de contatos do boot. Leituras fora do boot e listas maiores que o limite anterior mantêm a consulta original. Se nomes falharem, a resposta continua erro e a regra de recusa de Ref executa no mesmo ponto de antes.

O compartilhamento dura somente a mesma abertura. Nenhuma consulta nova é feita para criar cache. Ambiente e demais filtros continuam iguais. Filtros de data, JSON, padrões não reconhecidos e colunas ausentes continuam no banco. Falha da fonte compartilhada mantém a leitura própria do filtro e o comportamento de erro anterior.

Não houve alteração de HTML, CSS, JavaScript da interface, banco, permissões, envio de mensagens, preço, seleção ou regra de negócio.

## Validação e tempos

- 42 testes relevantes passaram, sem falhas: 8 de projeções, 2 de início independente da triagem, 18 de triagem, 13 de leituras independentes e 1 de comparação completa A/B/A.
- Os 2 testes de espera falharam na base antiga e passaram no código corrigido.
- O teste de início dos nomes também falhou na base antiga e passou na correção. A resposta inteira e as gravações da rota WhatsApp foram comparadas em 9 cenários, incluindo boot compartilhado, mensagens ausentes, falha da prova de Ref e falha dos nomes. Relógio e gerador de ID de erro foram fixados no teste; nenhuma informação de resposta foi removida para fazer a comparação passar.
- Comparação A/B/A: mesmos corpos, hashes, ordem, grupos e contagens com relógio fixo, 1.104 mensagens, simulações paginadas, print de SMS sem data, pedido incompleto, triagem pendente, candidato Fora da MCS e V1 enviada e não enviada. O contador de V1 continua contando somente o envio comprovado.
- Conferência dos filtros contra PostgreSQL local: dados e campos iguais, isolamento entre chamadas, NULL, ambiente diferente, fonte pendente e falha com leitura própria preservados.
- Antes desta correção, 5 boots reais de produção levaram 3.657, 3.914, 3.841, 5.672 e 5.597 ms no servidor, de 04:17 a 04:25 UTC. Não confundir essa medida com a abertura completa no navegador nem com média controlada.
- No navegador autenticado, o último tempo registrado antes da publicação foi 4.672 ms: 4.527 ms de leitura e 145 ms de renderização, com 30 linhas e 726 casos. É uma observação, não uma garantia de máximo.
- A medição depois da publicação será acrescentada à descrição do PR, com identificação da publicação e limite da comparação. A meta de no máximo 4 segundos permanece dependente de medição real, incluindo primeira abertura.
- Primeira etapa publicada no #351, `dpl_G9oLpRBETo9Tvu8fyZTwgsTVgsJZ`: consultas complementares de mensagens de 6 para 1; conversas de 4 para 1; fichas de 3 para 1. Os 4 históricos completos por RPC continuam. No navegador foram 5.949 e 5.929 ms, com os mesmos 726 casos. Portanto essa etapa reduziu trabalho, mas não demonstrou redução do tempo total contra os 4.672 ms observados antes. Isso levou à correção adicional dos nomes, em vez de declarar a meta cumprida.

## O que ainda tem função e permanece

O cálculo da nota Manheim é feito uma vez no main e ainda participa da ordem de TODOS. Não é removível sem alterar a regra. Os contadores usam uma consulta diferente, com outra finalidade. Autenticação, classificação, fontes de pedidos incompletos, histórico e mensagens novas também continuam necessários. Consultas de estado com filtros e limites diferentes não são automaticamente duplicadas só porque usam a mesma tabela.

Em produção, `panel_manheim_score_mmr` ainda levou cerca de 1,7 s em uma abertura observada. Esse tempo inclui a chamada ao banco e não prova uso de CPU de 1,7 s. Não foi criada outra migração nem um cache entre aberturas para esconder esse custo ou arriscar dado antigo.

Nenhuma conclusão de aprovação formal de setor foi inventada. Os relatórios antigos foram preservados como registro histórico, e esta auditoria identifica separadamente o que foi verificado e corrigido agora.
