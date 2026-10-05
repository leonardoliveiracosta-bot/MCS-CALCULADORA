# AUD-001 · ia-ml · relatório final do aprovador

- Setor: ia-ml
- Papel: Nível 3 Aprovador, agente distinto do executor e do revisor
- Ordem das etapas: rascunho do executor (entregas/AUD-001-executor.md), revisão cega e depois comparação (entregas/AUD-001-revisor.md), este julgamento
- Base conferida: main atual (7a25ef1), código lido por mim e SELECT agregado em produção (chaves de demanda só pelos 6 primeiros caracteres do md5, sem dados pessoais)

## 1. O que foi pedido

Auditoria do painel no domínio do setor ia-ml (conferência por IA dos carros do Manheim e o que ela segura na venda), somente achados, sem mudar código, sem commit e sem publicação. Caçar em cliques, tela, dados e vendas, com evidência concreta, gravidade, esforço e correção sugerida. Marcar para corrigir agora o que bloqueia venda, quebra clique ou mostra informação errada ou duplicada, com esforço pequeno ou médio. O comando da Leo inclui na lista fechada de correção imediata as leituras duplicadas do banco e as consultas lentas (item 3), e isso prevalece sobre a regra geral de gravidade.

## 2. O que foi entregue

Executor: 6 achados. Revisor: 5 achados na avaliação cega, comparação com o rascunho e verificações sem achado. Depois de juntar os iguais ficam 9 achados. Conferi cada um no código e, quando havia dado de produção, com SELECT.

Aprovados para corrigir agora

| Id | Achado | Domínio | Gravidade | Esforço | Evidência que conferi |
|---|---|---|---|---|---|
| IA-1 | Mudar a seleção depois de "Conferido" trava a V1 | VENDAS | BLOQUEIA_VENDA | P | painel/painel.js:3513 chama `state.listeners`, que nunca recebe listener; 2941 `AUDIT_CHECK_FIRST` só tem CONFERINDO e SEM_SELECAO; 3643 relança o erro MANHEIM_AUDIT_PENDING quando a tela ainda diz CONFERIDO; 3658 e 3659 só reabilitam o botão em `audit-changed` |
| IA-2 | Resposta de "Conferir de novo" ou "Aprovar com motivo" não chega ao cartão quando o bloco foi trocado | TELA | INFO_ERRADA_OU_DUPLICADA | P | painel/painel.js:2964 dispara `audit-changed` no `box`; 3560 e 3692 trocam o bloco a cada `options-loaded` (`replaceWith`); 3030 e 3304 disparam `options-loaded` ao carregar opções; o botão V1 escuta só no cartão (3659). Evento num bloco já fora da tela não sobe ao cartão, que segue mostrando pendente |
| IA-3 | Um clique em "Gerar link V1" lê a base inteira três vezes | DADOS | OUTRO (leitura duplicada do banco, item 3 do comando) | M | api/panel/vitrines.js:34 e 35 (`auditGate`), api/panel/manheim-audit.js:29 e 32 (`manheimView` e `withEntry` com `viewState` de novo), painel/painel.js:3643 a 3650 (create, check, create); panel-buscas-view.js:138 a 145 `auditInputFor` chama `loadBuscasBase`; `auditGate` roda antes de `stampGate` e `selectedFor` (vitrines.js:119 a 122); na BUSCAS a conferência roda depois do `Promise.all` principal (panel-buscas-view.js:213 a 217) |
| IA-4 | Falha ao ler a seleção cai na leitura do lote inteiro | DADOS | OUTRO com risco de BLOQUEIA_VENDA (consulta lenta, item 3 do comando) | P | panel-buscas-view.js:113 `catch (_)` sem olhar o erro chama `liveOptions(..., 1001)`; 93 chama `panel_manheim_batch_top_options`, que na última definição (supabase/migrations/20261022010000_manheim_v34_group_vin.sql:90 a 100) usa `panel_manheim_grouped_options(p_environment,p_upload_id,null)`, o lote inteiro. O tempo de 8,98 s é medição do executor, não refeita por mim nem pelo revisor |

Aprovados para backlog (não cabem na regra de correção imediata)

| Id | Achado | Domínio | Gravidade | Esforço | Impacto | Evidência que conferi |
|---|---|---|---|---|---|---|
| IA-5 | A conferência paga de novo os mesmos carros com frequência | DADOS | OUTRO (custo e atraso) | M | médio | Produção, lote ativo: demanda `1b4ff5` com 4 leituras pagas (00:10, 00:32, 00:52, 00:57 de 05/10); `4b5a12` paga com 7 carros às 21:47 e às 23:07. `carHash` (panel-manheim-audit.js:155 a 159) inclui `match.id`, `row_fingerprint` e a opção com `lote`; representante do grupo depende do horário (manheim-offer.js:85). Causa exata ainda é hipótese |
| IA-6 | Motivo digitado em "Aprovar com motivo" some quando as opções carregam | CLIQUES | OUTRO | P | baixo | painel/painel.js:2981 cria o campo no bloco; 3560 e 3692 recriam o bloco. Fica resolvido junto se a correção de IA-2 deixar de recriar o bloco sem mudança |
| IA-7 | Troca da versão da regra derruba aprovação à mão e cobra o lote de novo | VENDAS | OUTRO | M | médio | `RULE_VERSION` em `contentHash` e `carHash` (panel-manheim-audit.js:151 e 158); produção: `68d950` APROVADO_MANUAL na v3.3 às 20:19 de 04/10 e nova leitura paga na v3.5 às 21:47 |
| IA-8 | Leitura de regra antiga pode aparecer como "Última conferência" | TELA | OUTRO (risco, hoje aparece certo) | P | baixo | panel-manheim-audit.js:450 e 451 pegam a última linha da demanda sem filtrar `rule_version`; painel/painel.js:2976; produção: `4b5a12` tem linha v3.3 PENDENTE de 625 carros |
| IA-9 | "Destravar esta venda" chama dois provedores de IA por clique | VENDAS | OUTRO (decisão de produto) | M | baixo | api/panel/unlock-sale.js:63 a 76, OpenAI e Anthropic em `Promise.allSettled`; regra fixa "Um provedor por solução" |

Ordem do backlog por impacto x esforço: IA-5, IA-7, IA-8, IA-6, IA-9.

## 3. Divergências encontradas

- Executor A1 (IA-5), "o reaproveitamento por carro nunca acontece": o revisor refutou e eu confirmei. As linhas de `4b5a12` das 23:32 (6 carros) e 23:37 (2 carros) não têm custo nem resultado novo por carro, ou seja, foram montadas só com carros já lidos. Decisão: retirado o "nunca"; o achado vale como reaproveitamento que falha com frequência
- Executor A1 (IA-5), gravidade BLOQUEIA_VENDA contra OUTRO do revisor: hash novo vira CONFERINDO, que está em `AUDIT_CHECK_FIRST`, então o clique em V1 pede a conferência na hora (painel.js:3643). É atraso e custo, não bloqueio. Decisão: OUTRO, como o revisor
- Executor A4 (IA-4), gravidade BLOQUEIA_VENDA contra OUTRO com risco do revisor: o caminho só ocorre quando a leitura da seleção falha. Decisão: OUTRO com risco de bloqueio; entra para corrigir agora por ser consulta lenta do lote inteiro, item 3 do comando, com esforço P
- Executor A5 (IA-8), INFO_ERRADA_OU_DUPLICADA contra OUTRO do revisor: o próprio executor registra que hoje aparece certo. Decisão: OUTRO, backlog
- Executor A3 = Revisor A4 (IA-3): os dois classificaram OUTRO. Pela regra geral iria para o backlog, mas o comando da Leo lista "leituras duplicadas do banco" para corrigir agora. Decisão: corrigir agora, esforço M
- Achados só do revisor (IA-2, IA-6, IA-9): o executor não os registrou; conferi os três no código e mantenho
- Pendência: o tempo de 8,98 s de `panel_manheim_grouped_options` com chave nula foi medido só pelo executor. Não muda a decisão de IA-4, porque o código prova que o caminho lê o lote inteiro

## 4. Decisão do aprovador

Aprovo IA-1, IA-2, IA-3 e IA-4 para correção imediata, cada uma com spec Playwright que falhe antes e passe depois:
- IA-1: ao receber MANHEIM_AUDIT_PENDING, pedir sempre a conferência (`check`); ao mudar a seleção, marcar a demanda como CONFERINDO e disparar `audit-changed` no cartão. Spec: demanda conferida, selecionar outro carro, clicar em "Gerar link V1", o painel confere e gera o link
- IA-2: disparar `audit-changed` no cartão (guardar o cartão na criação do bloco), não no bloco. Spec: abrir opções durante "Conferir de novo" e conferir que o cartão e o botão V1 atualizam
- IA-3: no `check`, reaproveitar a leitura já feita em vez de reler as linhas; deixar o `auditGate` depois de `selectedFor` e `stampGate`; na BUSCAS, iniciar a leitura das opções da conferência junto do `Promise.all` principal
- IA-4: só cair no caminho antigo quando a tabela de seleção não existir (404 ou 400, como `selectedFor` já faz) e repassar os outros erros

IA-5 a IA-9 ficam no backlog com o esforço registrado acima. IA-5 precisa primeiro de log dos insumos do hash, sem dados pessoais, para confirmar a causa. IA-9 depende de decisão da Leo.

Nada foi alterado em código, banco ou publicação nesta etapa. Esta decisão não substitui a aprovação da Leo.
