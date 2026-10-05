# AUD-001 · rascunho do executor

- Pedido: AUD-001, auditoria do painel My Car Scout, somente achados (sem alterar código, sem commit, sem publicar)
- Setor: ia-ml
- Papel: Nível 1 Executor
- Agente: subagente executor ia-ml (Claude Code), sessão do fluxo AUD-001
- Foco: conferência por IA (MANHEIM_MATCH_AUDIT), chamadas repetidas ou desnecessárias à IA, custo, bloqueios de V1 por conferência
- Fontes: código do main atual (panel-manheim-audit.js, api/panel/manheim-audit.js, api/panel/vitrines.js, api/panel/openai-cron.js, panel-buscas-view.js, manheim-offer.js, painel/painel.js, migrações 20261022010000 e 20261023010000) e Supabase de produção só com SELECT e EXPLAIN (sem dados pessoais; chaves de demanda mostradas só como os 6 primeiros caracteres do md5)

## Achados

### A1. A conferência paga de novo os mesmos carros: o reaproveitamento por carro nunca acontece
- Domínio: DADOS (com efeito em VENDAS)
- Gravidade: BLOQUEIA_VENDA
- Esforço: M
- Evidência: no lote ativo de produção, os 32 resultados por carro guardados em `manheim_match_audits.car_results` têm 32 chaves distintas, nenhuma repetida entre leituras. A demanda `1b4ff5` foi lida e paga 4 vezes (00:10, 00:32, 00:52 e 00:57 de 05/10, sempre "Conferido pela IA", 2, 2, 3 e 3 carros, custo em cada uma). A seleção dessa demanda não mudou entre 00:50:51 e o fim (última linha de `manheim_option_selections` e do `audit_log`), e mesmo assim 00:52 e 00:57 geraram hashes diferentes para os mesmos 3 carros. O mesmo vale para 00:10 e 00:32 (seleção parada de 00:10 a 00:49). A demanda `4b5a12` foi paga com 7 carros às 21:47 e de novo com 7 carros às 23:07. Não houve complemento de venda no lote (`manheim_complement_runs` vazio para o lote ativo). `carHash` (panel-manheim-audit.js:155) usa `match.id`, `row_fingerprint` e `lote` do representante do grupo de VIN; o representante é escolhido por venda ativa no momento (`panel_manheim_grouped_options`, `row_number() ... order by active desc, priority, id` com `panel_manheim_sale_active`, e `groupVehicles(rows, now = Date.now())` em manheim-offer.js:85). Hipótese ainda não confirmada: a troca do representante ou de outro campo dependente do horário muda o hash. Efeito na venda: cada hash novo não tem linha gravada, então `viewState` devolve "Conferindo" (panel-manheim-audit.js:440) e `heldFor` segura a V1 (linha 491) até o cron ou o botão ler de novo.
- Correção sugerida: primeiro gravar no log os insumos do hash (sem dados pessoais) para confirmar o campo que muda; depois montar `carHash` só com dados estáveis do carro (VIN, ano, marca, modelo, milhagem, MMR, tipo do match) mais critérios e versão da regra, sem o id do representante nem o lote. Teste: mesmo carro com representante trocado tem o mesmo hash.

### A2. Depois de mudar a seleção, o botão "Gerar link V1" usa o estado antigo da conferência
- Domínio: VENDAS
- Gravidade: BLOQUEIA_VENDA
- Esforço: P
- Evidência: `state.setSelected` chama `state.listeners` (painel/painel.js:3513), mas nenhum código adiciona listener nessa lista (única ocorrência de `state.listeners` no arquivo), e nada atualiza `manheimData.audit.byDemand` quando a seleção muda. Caso 1: demanda CONFERIDA, operador troca um carro; o servidor passa a responder MANHEIM_AUDIT_PENDING (hash novo sem linha); no cliente a demanda segue CONFERIDO, que não está em `AUDIT_CHECK_FIRST` (painel.js:2941 e 3643), então a conferência imediata não roda e aparece só "A conferência desta demanda ainda não liberou a V1", sem botão de saída. Caso 2: demanda em REVISAR, operador tira o carro com divergência; `auditCanTry` continua falso e o botão fica desabilitado (painel.js:3658) até a atualização automática (a cada 2 min, `REFRESH_MS`, e só se o operador não estiver digitando) depois do cron (a cada 5 min).
- Correção sugerida: ao receber MANHEIM_AUDIT_PENDING, sempre pedir `check` (o servidor já decide e nunca aprova sozinho), e ao mudar a seleção marcar a entrada da demanda como "Conferindo" e reabilitar o botão disparando `audit-changed`. Spec Playwright: selecionar outro carro numa demanda conferida e clicar em "Gerar link V1".

### A3. Um clique em "Gerar link V1" com conferência pendente lê a base inteira três vezes
- Domínio: DADOS
- Gravidade: OUTRO
- Esforço: M
- Evidência: o clique faz POST /api/panel/vitrines, que em `auditGate` chama `manheimView(ctx,{auditInput:true})` e `viewState` (api/panel/vitrines.js:30 a 35); ao receber MANHEIM_AUDIT_PENDING o cliente faz POST /api/panel/manheim-audit `check` (painel.js:3645), que chama de novo `manheimView` (api/panel/manheim-audit.js:29), `runAudit` (lê `auditRows`) e `withEntry`, que roda `viewState` de novo (linha 32, lê `auditRows` e `runRow` outra vez); depois o cliente repete o POST /vitrines (painel.js:3649), com a terceira leitura completa. Cada `auditInputFor` roda `loadBuscasBase`, que lê dez tabelas inteiras (panel-buscas.js:20 a 31). Em produção hoje: 3.221 mensagens, 3.219 vínculos de mensagem, 4.164 cálculos e 729 fichas, cerca de 20 páginas de 1.000 linhas por leitura. O mesmo vale para a tela BUSCAS, que já calcula a conferência dentro de `manheimView` (panel-buscas-view.js:213 a 217), depois das outras leituras e não junto delas.
- Correção sugerida: fazer o `check` dentro do próprio POST /vitrines quando a demanda ainda não tem leitura (uma só leitura da base), e no `withEntry` montar a entrada a partir do resultado de `runAudit` sem reler as linhas. Na BUSCAS, iniciar `auditOptions` junto do `Promise.all` principal.

### A4. Qualquer falha ao ler a seleção faz a conferência cair na leitura do lote inteiro (9 s, acima do limite)
- Domínio: DADOS
- Gravidade: BLOQUEIA_VENDA
- Esforço: P
- Evidência: `auditOptions` (panel-buscas-view.js:111 a 113) tem `catch (_)` sem olhar o erro: um tempo esgotado ou erro de rede na leitura de `manheim_option_selections` leva a `liveOptions(..., AUDIT_OPTIONS=1001)`, que chama `panel_manheim_batch_top_options`, função que usa `panel_manheim_grouped_options(p_environment,p_upload_id,null)` (lote inteiro). EXPLAIN ANALYZE em produção de `panel_manheim_grouped_options` do lote ativo com chave nula: 39.352 linhas, 8.981 ms, acima dos 8 s do PostgREST. A leitura certa (`panel_manheim_audit_selected_options` com as demandas selecionadas) levou 122 ms. Resultado: no caminho da V1 (`auditGate`, sem catch) o erro vira "Não consegui gerar o link"; se o lote fosse menor, `scope: null` mandaria até 1.000 carros por demanda para a OpenAI (foi assim que a leitura v3.3 de 625 carros ficou PENDENTE com 3 tentativas pagas, US$ 0,011).
- Correção sugerida: só cair no caminho antigo quando o erro for de tabela ausente (404 ou 400, como já faz `selectedFor` em vitrines.js), e repassar os demais erros.

### A5. Leituras paradas antigas continuam no lote e contam como "última leitura"
- Domínio: TELA
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência: no lote ativo a demanda `4b5a12` tem uma linha v3.3 PENDENTE (625 carros, 3 tentativas, "Tempo esgotado") e hoje 0 carros selecionados. Para demanda sem seleção, `viewState` pega a última linha da demanda em `stored` (panel-manheim-audit.js:450 a 451, ordenada por `created_at`), e o cartão mostra "Última conferência: Tempo esgotado..." quando `lastStatus` é PENDENTE (painel.js:2976). Como a linha mais nova de `4b5a12` é CONFERIDO, hoje aparece certo; mas a regra mistura versões de regra diferentes e uma leitura antiga de regra superada pode aparecer como motivo atual sempre que for a mais nova da demanda.
- Correção sugerida: considerar só linhas da `RULE_VERSION` atual ao montar `lastStatus`.

### A6. Troca da versão da regra derruba aprovações à mão e cobra o lote de novo
- Domínio: VENDAS
- Gravidade: OUTRO
- Esforço: M
- Evidência: `RULE_VERSION` entra em `contentHash` e `carHash` (panel-manheim-audit.js:151 e 158). No lote ativo, a demanda `68d950` tinha APROVADO_MANUAL em v3.3 (20:25 de 04/10) e, após o deploy da v3.5, ficou sem linha para o hash novo até ser lida e paga de novo às 21:47. Entre o deploy e a nova leitura a V1 dessa demanda ficou segura, e a aprovação com motivo do operador deixou de valer sem aviso.
- Correção sugerida: registrar no cartão quando uma aprovação à mão perdeu efeito por mudança de regra, e na troca de versão disparar a leitura do lote ativo logo após o deploy (em vez de esperar o cron ou o clique).

## Fora do meu domínio, anotado para o setor certo
- `panel_manheim_batch_top_options` e `panel_manheim_batch_demand_options` ainda chamam `panel_manheim_grouped_options` com chave nula (lote inteiro, 8,98 s medidos). Vale o setor dados conferir se alguma tela ainda chama essas duas funções.

## Separação entre verificado e hipótese
- Verificado: A1 (falta de reaproveitamento e leituras pagas repetidas, por consulta), A2 (código), A3 (código e contagens), A4 (código e tempos medidos), A5 (dados e código), A6 (dados e código).
- Hipótese: a causa exata da mudança do hash em A1 (representante do grupo de VIN escolhido pelo horário). Precisa de confirmação por log antes da correção.
