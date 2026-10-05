# AUD-001 · produto · relatório final do Nível 3 Aprovador

- Papel: Nível 3 Aprovador (agente distinto do executor e do revisor)
- Base conferida: main atual na branch de trabalho (commit 7a25ef1)
- Ordem registrada: executor salvou AUD-001-executor.md; revisor registrou a avaliação cega sem abrir o rascunho e só depois comparou (AUD-001-revisor.md); o aprovador leu os dois e conferiu cada evidência no código
- Banco de produção: o aprovador não rodou nenhuma consulta; as medições de tempo vêm do executor e do revisor, feitas de forma independente e com valores próximos (0,7 a 0,9 s por página, 1,4 a 1,7 s no resumo)
- Registro de transparência do revisor aceito: uma tabela temporária vazia de sessão criada por engano, sem tocar dado nenhum

## 1. O que foi pedido

Auditoria do painel no domínio do setor produto, foco no fluxo de vender: seleção de carros para o cliente, V1, envio no WhatsApp, conferência e regra por carro x por valor, cobrindo cliques, tela, dados e vendas. Somente achados com evidência, sem mudar código, sem commit, sem publicar. Para cada achado: domínio, gravidade, esforço, evidência e correção sugerida. Marcar para corrigir agora o que bloqueia venda, quebra clique ou mostra informação errada ou duplicada com esforço pequeno ou médio; o resto vira backlog.

## 2. O que foi entregue

O executor registrou 11 achados e 4 pontos conferidos sem defeito. O revisor registrou 10 achados às cegas, retirou 1 (R8) depois da comparação e sustentou os 11 do executor. O aprovador conferiu no código cada evidência citada. Resultado: 15 achados aprovados (alguns juntam executor e revisor), 1 rejeitado.

### Aprovados para corrigir agora

| Nº | Achado | Domínio | Gravidade | Esforço | Origem | Evidência conferida pelo aprovador |
|---|---|---|---|---|---|---|
| A1 | Conferência fica velha no navegador ao mudar a seleção e trava "Gerar link V1" | VENDAS | BLOQUEIA_VENDA | P | E1 | painel/painel.js:3513 `setSelected` não mexe em `manheimData.audit.byDemand` nem dispara `audit-changed`; `state.listeners` nasce vazio em 3508 e ninguém acrescenta; o botão usa `auditCanTry` (2942); REVISAR fora de `AUDIT_OK` (2935) e de `AUDIT_CHECK_FIRST` (2941); `canRetry` só para PENDENTE (panel-manheim-audit.js:444); a conferência automática antes da V1 só roda para CONFERINDO ou SEM_SELECAO (painel.js:3643) |
| A2 | Seleção volta ao retrato antigo quando a coluna é reordenada | VENDAS | BLOQUEIA_VENDA | P | R1 + E6 | `setSelected` (3513) só muda o Set local; `offerSection` (3508) recria o Set a partir de `demand.offer.selectedIds` do retrato `manheimData`; o "Ordenar" da coluna (3750) e o "Ordenar" de manheim (5682) chamam `renderManheim(manheimData)` sem ler o servidor; a V1 usa `card.offerState.selectedIds` (3634). Também redesenha as duas colunas e repete o GET de v1-send (3629) |
| A3 | Seleção gravada no id de outro membro do mesmo VIN diverge do id mostrado (latente) | VENDAS | BLOQUEIA_VENDA | M | E4 + R5 | migração 20261022010000, função select_v2: `select coalesce((select ss.match_id ... v_members ? ss.match_id::text ...), v_match.id) into p_match_id` e devolve `'matchId', p_match_id`; o resumo (20261024020000, `first_selected`) devolve o id do membro; o painel compara por `option.id` (3176, 3613) e ignora `result.matchId` e `selectedCount` (3171 a 3176). Hoje 0 casos (medição dos dois níveis) |
| A4 | Sincronização e atualização automática redesenham ENVIAR OPÇÕES e apagam o trabalho aberto | VENDAS (tela) | QUEBRA_CLIQUE | M | E3 + R2 | `runOptionsSync` chama `loadCurrent()` sem olhar se o operador está ocupado (painel.js:339); a aba agenda a sincronização ao abrir (1946) e todo POST de ficha também (316, 319); o agendador de 120 s só espera quem está digitando (`operatorIsTyping`, 5482); `renderManheim` faz `replaceChildren` (3779) e nada reabre `details.offer-group` (único uso em 3221) |
| A5 | Linha clicável dentro de cartão clicável abre o pedido duas vezes | CLIQUES | QUEBRA_CLIQUE | P | E10 + R7 | painel.js:3716 (linha) e 3724 (cartão) usam `makeCardClickable`; o guard (1732 a 1754) não para a propagação e não ignora clique que já passou por um `.clickable-card` mais interno; resultado: dois `openDetail('order')` e dois registros no histórico. Só na lista antiga (sem seleção disponível) |
| A6 | Valor em dólar digitado seguido de clique em "Selecionar" pode gravar outro preço | VENDAS | INFO_ERRADA_OU_DUPLICADA | P | E2 | o valor só é salvo no `change` (3207); `priceBody` (3164) manda `pct` enquanto `info.manualFinal` é falso; o `pct` do campo vem arredondado a duas casas (3148); no banco `v_final := round(v_mmr * (100 + pct) / 100)` (migração v34, trecho de v_final). Depende de qual pedido termina por último |
| A7 | "Ver opções" vindo de outra aba lê a mesma visão duas vezes e deixa o grupo fechado | DADOS + TELA | INFO_ERRADA_OU_DUPLICADA | P | E5 + R3 | `openOptionsCard` (1849 a 1851): `switchPanel('searches')` já chama `loadCurrent` (643) e logo depois vem outro `loadCurrent('searches')`; a aba usa `request` e não `sharedGet` (1942); o botão clicado (1860 e 1861) é o `.manheim-options-toggle` dentro do `details.offer-group` fechado (3221 e 3227) |
| A8 | Contador da aba e lista de ENVIAR OPÇÕES não batem | TELA | INFO_ERRADA_OU_DUPLICADA | P | R9 | `optionsPeopleOf` (3730) conta toda demanda com `matchCount > 0`; a lista pula ficha ausente, pedido não achado e reativação com `bateCount` 0 (3783 a 3795), e essa reativação também não entra em "Sem carros" (3804 filtra `!(matchCount > 0)`), então some da tela mas segue no número da aba |
| A9 | Selecionar um carro roda a função pesada de grupos três vezes no banco | DADOS | OUTRO | M | E8 | migração 20261022010000, select_v2: `panel_manheim_grouped_options` aparece para achar o carro, para contar o limite de 10 e para contar o total final. Tempos medidos pelos dois níveis: cerca de 0,7 a 0,9 s por leitura na maior demanda, longe dos 8 s |
| A10 | Cada página de carros relê a base inteira e a tabela inteira de vitrines; PDF lê grupos em série | DADOS | OUTRO | M | R4 + E9 | api/panel/manheim-options.js:142 chama `contextFor` depois da página, em série; `alsoFitsFor` (58) lê `allRows('vitrines')` sem filtro a cada página; `selectedOptions` (painel.js:2883 a 2896) pagina de 50 em 50, grupo por grupo |

Observação sobre A9 e A10: pela regra do pedido do setor a gravidade é OUTRO, mas o comando da Leo coloca "leituras duplicadas do banco e consultas lentas" entre os itens fechados para corrigir agora, e o comando prevalece. Por isso ficam marcados para corrigir agora, com esforço M.

### Aprovados para o backlog (por impacto x esforço)

| Ordem | Achado | Domínio | Gravidade | Esforço | Origem | Evidência conferida |
|---|---|---|---|---|---|---|
| B1 | Erros do fluxo de venda sem texto próprio, com "tente de novo" que nunca resolve | VENDAS | OUTRO | P | E7 | `OFFER_ERRORS` (3057 a 3067) sem MANHEIM_SALE_ENDED, que o banco lança (v34 linha 263) e vitrines.js devolve (114, 158); `v1Error` (3631) sem VITRINE_VIN_DUPLICATE (vitrines.js:112, v1-send.js:79 e 130) |
| B2 | Observação interna do carro não é salva sozinha | VENDAS | OUTRO | P | E11 | o campo `offer-note` (3159) não tem listener; a nota só vai junto com price, select, remove ou exclude |
| B3 | Cartão de reativação: lista antiga só BATE, seleção mostra todos os grupos | VENDAS | OUTRO | P (depois da decisão) | R10 | 3793 troca só `matchCount` por `bateCount`; `offerSection` usa `demand.offer` inteiro (3507 a 3516). Precisa de decisão da Leo sobre a regra por carro x por valor na reativação |
| B4 | Cartão de pedido sem ficha deixa selecionar, mas não tem V1, PDF nem WhatsApp | VENDAS | OUTRO | M | R6 | `renderManheimOrderGroup` monta `offerSection` e só o botão "Abrir pedido" (3719 a 3723); vitrines.js:97 exige ficha. Hoje 0 demandas desse tipo no lote ativo |

## 3. Divergências encontradas

- Gravidade de A3 (membro x representante): executor marcou INFO_ERRADA_OU_DUPLICADA; revisor marcou BLOQUEIA_VENDA latente. Evidência: a V1 manda o id que o painel guarda e o servidor recusa com MANHEIM_OPTION_NOT_SELECTED quando os ids diferem. Decisão: BLOQUEIA_VENDA, latente (0 casos hoje).
- Esforço de A3: executor P, revisor M. A correção mexe na função de resumo do banco ou na comparação por `memberMatchIds` no painel e no PDF. Decisão: M.
- Gravidade de A7: executor OUTRO, revisor INFO_ERRADA_OU_DUPLICADA. Evidência: leitura dupla da mesma rota e o grupo prometido como aberto fica fechado. Decisão: INFO_ERRADA_OU_DUPLICADA.
- A2: o executor viu só o custo de redesenhar as duas colunas (E6); o revisor viu o efeito na seleção (R1). Decisão: juntar num achado só, com a gravidade maior (BLOQUEIA_VENDA), porque o contador e a V1 passam a usar a seleção antiga.
- A5: executor marcou OUTRO, revisor QUEBRA_CLIQUE leve. Evidência: duas navegações por um clique e o Voltar precisa de dois toques. Decisão: QUEBRA_CLIQUE, e entra no item 1 do comando (guard do makeCardClickable).
- A9 e A10: os dois níveis marcaram OUTRO. O aprovador mantém OUTRO como gravidade, mas marca para corrigir agora pelo item 3 do comando da Leo (leituras duplicadas do banco e consultas lentas).
- A4: executor citou perda de valor digitado; o aprovador confirmou que o agendador de 120 s não roda enquanto há campo com foco ou digitação recente, mas a recarga da sincronização (339) não tem essa trava. A perda de grupos abertos e de páginas carregadas vale nos dois caminhos.
- R8 (área de seleção dentro do cartão navega para a ficha): o revisor retirou depois da comparação. O aprovador confirmou que as linhas, preços e botões ficam dentro de `details.offer-group` (3221) e que o guard trata `details` como controle (1739). Toque no contador ou no espaço entre grupos é navegação legítima do cartão.
- Pendência registrada: as medições de tempo no banco não foram refeitas pelo aprovador; ficam aceitas por virem de dois níveis independentes com valores próximos. A correção de A9 deve medir de novo antes e depois.

## 4. Decisão do aprovador

- Aprovados para corrigir agora: A1, A2, A3, A4, A5, A6, A7, A8, A9, A10
- Aprovados para o backlog, nesta ordem: B1, B2, B3 (depende de decisão da Leo), B4
- Rejeitado: R8, retirado pelo revisor e refutado no código
- Cada correção precisa de spec Playwright que falhe antes e passe depois; para A1 e A2, cobrir também seleção, tap no celular, abrir e fechar de `details` e a navegação legítima do cartão
- A decisão não substitui a aprovação da Leo
