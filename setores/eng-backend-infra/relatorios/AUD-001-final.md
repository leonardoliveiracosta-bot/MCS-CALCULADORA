# AUD-001, eng-backend-infra, relatório final do Aprovador

- Pedido: AUD-001
- Setor: eng-backend-infra
- Papel: Nível 3 Aprovador (agente distinto do executor e do revisor)
- Ordem das etapas: executor (entregas/AUD-001-executor.md), revisor com avaliação cega e comparação (entregas/AUD-001-revisor.md), aprovador (este arquivo)
- Base conferida: main atual na branch de trabalho, commit 7a25ef1
- Banco de produção: somente SELECT (pg_stat_statements e contagem de v1_sends por status). Nenhum dado pessoal transcrito, lote ativo do Manheim não tocado

## 1. O que foi pedido

Auditoria do painel no domínio de API e banco, somente achados, sem alterar código, sem commit e sem publicar. Caçar leituras duplicadas (mesma API ou mesma função do banco chamada duas vezes para a mesma visão), consultas perto do limite de 8 s, informação errada ou duplicada vinda do servidor e tudo que quebre o fluxo de vender (seleção, V1, WhatsApp). Cada achado com domínio, gravidade, esforço, evidência e correção sugerida. Pela regra do comando da Leo, corrigir agora o que bloqueia venda, quebra clique ou mostra informação errada ou duplicada com esforço P ou M; o item 3 da lista fechada da Leo (leituras duplicadas do banco e consultas lentas) também entra na correção imediata.

## 2. O que foi entregue

Conferi no código cada evidência citada e repeti a leitura de pg_stat_statements. Aprovados 11 achados (detalhe na seção 4). Números conferidos agora: a função mais pesada do painel (panel_identity_evidence, chamada pela reconciliação de identidade) tem 2.135 chamadas, média 2,6 s e máximo 6,9 s, a mais próxima do corte de 8 s; as funções do resumo do lote têm máximos entre 5,5 s e 6,7 s. Em v1_sends há 1 envio, SENT, nenhum preso.

Evidências confirmadas por mim:
- api/panel/pesquisas.js:47 usa `.catch(() => [])` no resumo do lote e as linhas 76 a 78 transformam falta de linha em NO_OPTIONS
- api/panel/boot.js:20 a 24 roda pesquisas, records e records?view=manheim juntos; panel-server.js:89 a 92 só guarda leituras de tabela, e rpc (linha 200) não tem cache; panel_manheim_batch_summary roda em pesquisas.js:47 e panel-buscas-view.js:184; panel_manheim_score_mmr roda por loadScoreIndex (panel-ready.js:31, com p_since calculado em milissegundos) em records.js:80, panel-buscas-view.js:158 e today.js:61
- painel/painel.js:1942, 1957 e 1975 usam request direto para records?view=manheim, ignorando o que o boot guardou em 1928; 4589 a 4592 e 4344 a 4345 fazem loadCurrent e depois refreshCounters (sharedGet em 2010) com o cache vazio
- painel/painel.js:1072 faz loadWhatsApp (request direto, 1085) e depois refreshCounters (sharedGet de 10 s, 2009)
- api/panel/searches.js:30 a 46 relê journeys, messages, calc_runs e outras e chama panel_manheim_batch_people; pesquisas.js:43, manheim-searches.js:22 e panel-buscas-view.js:151 chamam loadBuscasBase
- api/panel/manheim-options.js:162 chama contextFor (loadBuscasBase inteira) depois da RPC da página, a cada "Ver mais"
- api/panel/manheim-options.js:179 chama optionStamp.gate, que em panel-option-stamp.js:40 a 41 relê a base inteira antes de cada seleção
- painel/painel.js:2883 a 2895 percorre LANE, OFFLANE e INCOMPLETE de 50 em 50 em série para o PDF
- api/panel/v1-send.js:139 e 162 com o índice único v1_sends_one_in_flight_idx (migração 20261007010000 linha 32); nenhum outro código troca SENDING antigo; v1-send.js não tem maxDuration em vercel.json
- api/panel/subject-cron.js:33 roda reconcileIdentity com max 120 a cada 5 min (vercel.json:24); panel-identity.js:146 faz um PATCH por ficha sem mudança, em série

## 3. Divergências encontradas

- Gravidade das leituras duplicadas (executor A2 e A3 como OUTRO, revisor como INFO_ERRADA_OU_DUPLICADA). Decisão: gravidade OUTRO, porque a leitura duplicada não aparece duplicada na tela; mesmo assim entram em corrigir agora porque o item 3 da lista fechada da Leo manda corrigir leituras duplicadas do banco e consultas lentas
- Alcance do executor A5 (WhatsApp lido duas vezes). O revisor acertou: só vale em painel/painel.js:1072; nas linhas 1110 e 1151 o refresh não chama contadores. Além disso, a segunda leitura só vai ao servidor se o cache de 10 s do sharedGet já tiver vencido. Aprovado com esse alcance reduzido
- Executor A4 dizia quatro leituras da base em BUSCAR CARROS. O revisor acertou: records?view=manheim em 1971 sai do cache de 60 s; são três leituras da base no servidor
- Revisor A5 falava em leitura dos carros um por um (N+1) ao selecionar. Refutado nessa parte: o único chamador de gate (manheim-options.js:179) passa um id só. O que se sustenta é a releitura da base inteira a cada clique em Selecionar
- Revisor A6: legendas "243 mil linhas no lote ativo" e "lote de 66 mil carros" retiradas pelo próprio revisor; o lote ativo tem cerca de 55 mil linhas ativas. Os tempos continuam válidos
- Executor A7 (V1 preso em SENDING): os dois aceitam BLOQUEIA_VENDA condicional, só quando a função cai entre gravar SENDING e finalizar. Mantido, porque se acontecer a vitrine fica sem envio para sempre
- Executor A8 (carros repetidos no armazenamento): revisor contou 47.759 trios, executor 47.758; diferença de 1 sem efeito, a tela segue protegida pelo agrupamento por VIN

## 4. Decisão do aprovador

Corrigir agora (bloqueia venda, informação errada, ou item 3 da Leo, com esforço P ou M):

1. BUSCAR CARROS mostra "sem opção" falso quando o resumo do lote falha. DADOS, INFO_ERRADA_OU_DUPLICADA, P. Tratar falha como resumo indisponível, nunca NO_OPTIONS; teste com a RPC rejeitando
2. V1 pode ficar preso em SENDING e travar o envio daquela vitrine. VENDAS, BLOQUEIA_VENDA condicional, P. SENDING com mais de 2 minutos vira UNCONFIRMED na leitura e por atualização condicional; maxDuration explícito para v1-send
3. Abertura (boot counters) roda batch_summary e score_mmr duas vezes. DADOS, OUTRO, P. Cache de rpc de leitura dentro de ctx.readCache e p_since de score_mmr arredondado
4. OPÇÕES, IMPORTAÇÕES e MANHEIM buscam de novo records?view=manheim que o boot trouxe, e importar ou desfazer lote busca duas vezes. DADOS, OUTRO, P. Passar essas visões pelo pool (sharedGet com prazo curto, ou primar o pool com a resposta do loadCurrent)
5. Cada página de opções relê a base inteira de BUSCAS, em série depois da RPC. DADOS e VENDAS, OUTRO, M. Rodar em paralelo e montar só o contexto da demanda pedida
6. Selecionar carro para o cliente relê a base inteira a cada clique. VENDAS, OUTRO, M. Montar só o contexto da demanda da chave
7. BUSCAR CARROS faz três leituras da mesma base no servidor. DADOS, OUTRO, M. Juntar numa chamada com readCache
8. Reconciliação de identidade relê 120 fichas a cada 5 min mesmo sem mudança, consulta mais lenta do painel (máximo 6,9 s). DADOS, OUTRO, M. Só reavaliar fichas com novidade e trocar os PATCH unitários por um só
9. WhatsApp lido duas vezes no refresh da triagem (painel.js:1072). DADOS, OUTRO, P. loadWhatsApp passar por fresh

Backlog, por impacto e esforço:

10. Baixar PDF com carro selecionado fora da página carregada percorre até dezenas de páginas em série. VENDAS, OUTRO, M. Não provado quebrado; fica muito mais leve depois do item 5. Endpoint que devolva os selecionados por id
11. Funções do resumo do lote entre 1,3 e 1,6 s cada, picos de 5,5 a 6,7 s. DADOS, OUTRO, G. Guardar o resumo por lote no fim da importação e da seleção
12. 7.693 carros repetidos por pedido no armazenamento, sem duplicação na tela. TELA, OUTRO, P. Só monitorar, com teste que obrigue toda leitura de opções a passar pelo agrupamento por VIN

Rejeitados como conclusão: a contagem de quatro leituras em BUSCAR CARROS (são três), a leitura dupla do WhatsApp nas linhas 1110 e 1151, a leitura um por um dos carros ao selecionar e as legendas de 243 mil e 66 mil linhas. Esta decisão não substitui a aprovação da Leo.
