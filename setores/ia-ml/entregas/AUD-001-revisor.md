# AUD-001 · ia-ml · Nível 2 Revisor independente

Pedido: AUD-001, auditoria do painel, somente achados, sem mudar código
Ordem das etapas: avaliação cega registrada abaixo antes de qualquer leitura do rascunho do executor
Fontes lidas: setores/ia-ml/EQUIPE.md, painel/painel.js, painel/lead.js, api/panel/manheim-audit.js, api/panel/vitrines.js, api/panel/openai-cron.js, api/panel/unlock-sale.js, panel-manheim-audit.js, panel-buscas-view.js, panel-buscas.js, vercel.json, tests/manheim-conferencia.spec.js
Banco de produção: somente SELECT agregado (contagens, status e códigos de divergência), sem dados pessoais

## Avaliação cega

### A1 · Seleção alterada depois de "Conferido" trava a V1 até recarregar a página

- Domínio: VENDAS
- Gravidade: BLOQUEIA_VENDA
- Esforço: P
- Evidência:
  - painel/painel.js:3174 e 3513: selecionar ou remover um carro (setSelected) só atualiza o contador; o estado da conferência na tela (manheimData.audit.byDemand) não muda e nenhum evento audit-changed é disparado
  - panel-manheim-audit.js, carHash e contentHash: o hash da demanda inclui os carros selecionados, então no servidor a demanda volta a CONFERINDO (sem linha para o hash novo)
  - painel/painel.js:3643: no clique em "Gerar link V1", o servidor responde MANHEIM_AUDIT_PENDING, mas o painel só pede a conferência (action check) quando o status guardado na tela está em AUDIT_CHECK_FIRST (CONFERINDO ou SEM_SELECAO). Com o status antigo "Conferido" o erro é relançado e aparece "A conferência desta demanda ainda não liberou a V1", sem botão "Conferir de novo" (canRetry falso em CONFERIDO)
  - O mesmo vale ao contrário: demanda em REVISAR ou PENDENTE da qual o operador remove o carro problemático continua com o botão V1 desabilitado (auditCanTry falso) até recarregar ou o cron rodar (a cada 5 min, vercel.json)
  - tests/manheim-conferencia.spec.js não cobre selecionar carro novo numa demanda já conferida
- Correção sugerida: em MANHEIM_AUDIT_PENDING sempre pedir action check (o servidor decide) e, ao mudar a seleção, marcar a entrada local como CONFERINDO e disparar audit-changed. Spec Playwright: demanda CONFERIDO, selecionar mais um carro, V1 responde pendente na primeira vez, painel deve chamar check e gerar o link

### A2 · "Conferir de novo" ou "Aprovar com motivo" não atualizam o cartão se as opções carregarem durante a leitura

- Domínio: TELA (efeito em VENDAS)
- Gravidade: INFO_ERRADA_OU_DUPLICADA
- Esforço: P
- Evidência:
  - painel/painel.js:2978 e 2964: o redraw do bloco chama applyAuditEntry(demand,result,box) e dispara audit-changed a partir do próprio bloco (box)
  - painel/painel.js:3560 e 3692: todo evento options-loaded troca o bloco por um novo (audited.replaceWith(next))
  - painel/painel.js:3030 e 3304: options-loaded é disparado a cada página de opções carregada ("Ver mais", abrir grupo)
  - A leitura de "Conferir de novo" pode levar até 55 s (api/panel/manheim-audit.js, deadlineAt). Se o operador abrir opções nesse meio tempo, o box antigo sai do documento; o evento disparado num elemento solto não sobe até o cartão. Resultado: o cartão continua mostrando "Conferência pendente" e o botão V1 desabilitado mesmo com a demanda já conferida no servidor
- Correção sugerida: disparar audit-changed no cartão (passar o cartão para auditBlock ou guardar box.closest('.item-card') na criação) em vez do box

### A3 · Motivo digitado para "Aprovar com motivo" some quando as opções carregam

- Domínio: CLIQUES
- Gravidade: OUTRO
- Esforço: P
- Evidência: painel/painel.js:2981 cria o campo audit-reason dentro do bloco; painel/painel.js:3560 e 3692 recriam o bloco inteiro a cada options-loaded, então o texto digitado é perdido sem aviso
- Correção sugerida: só recriar o bloco quando a entrada ou a lista de carros conhecidos mudar, ou copiar o valor do campo para o bloco novo

### A4 · Um clique em "Gerar link V1" de demanda não conferida lê a base inteira três vezes

- Domínio: DADOS
- Gravidade: OUTRO (custo e tempo, não bloqueia)
- Esforço: M
- Evidência:
  - api/panel/vitrines.js:34-35 (auditGate): manheimView(ctx,{auditInput:true}) mais viewState a cada criação de V1
  - panel-buscas-view.js:138-145 (auditInputFor) chama loadBuscasBase, que em panel-buscas.js:20-31 lê journeys, contacts, contact_phones, calc_runs, messages e outras tabelas inteiras do ambiente (produção hoje: 3219 mensagens, 731 fichas, 4164 calc_runs)
  - Caminho do painel (painel/painel.js:3638-3648): create, check, create. São três auditInputFor (gate, manheim-audit check, gate de novo) e quatro leituras de manheim_match_audits (gate, runAudit, withEntry em api/panel/manheim-audit.js:32, gate)
  - Além disso o auditGate roda antes de stampGate e selectedFor (api/panel/vitrines.js:119-122), então uma V1 que seria recusada por seleção ou carimbo paga a leitura completa primeiro
- Correção sugerida: no check, devolver ao painel a decisão do gate na mesma resposta ou deixar o servidor de vitrines fazer o check inline; mover o auditGate para depois de selectedFor e stampGate; reaproveitar a mesma leitura de base dentro de uma requisição

### A5 · "Destravar esta venda" usa dois provedores de IA por clique

- Domínio: VENDAS (regra do setor)
- Gravidade: OUTRO
- Esforço: M (decisão de produto)
- Evidência: api/panel/unlock-sale.js:6, 11, 66-76 chama OpenAI e Anthropic em paralelo a cada clique (painel/lead.js:258-260), contra a regra do setor ia-ml "Usar um único provedor por solução" (setores/ia-ml/EQUIPE.md). Custo controlado por orçamento, mas duas chamadas pagas por clique
- Correção sugerida: levar à Leo a decisão de manter os dois especialistas ou ficar com um provedor; não é correção imediata

### Verificações sem achado (registradas para não sumir)

- Guard do makeCardClickable (painel/painel.js:1740) cobre o campo audit-reason e os botões do bloco de conferência; botão removido pelo próprio clique também é barrado (linha 1746)
- Conferência não cobra duas vezes o mesmo conteúdo: hash único, reserva atômica (aiClaim e panel_manheim_audit_budget_hold) e carros já lidos reaproveitados (car_results)
- Produção: 34 linhas de conferência, custo total US$ 0,0417; a linha mais cara (US$ 0,011) é uma leitura cortada três vezes por AUDIT_DEADLINE na versão de regra antiga conferencia-v3.3, já fora do hash atual (conferencia-v3.5), sem efeito na tela
- Cartões de pedido da calculadora (renderManheimOrderGroup) não têm botão V1, então a regra do demandKey só aceitar journey em api/panel/vitrines.js:118 não bloqueia venda hoje

## Comparação com o rascunho

Feita depois da avaliação cega acima, que não foi alterada. Cada achado foi conferido de novo no código do main e, quando citava dados, com SELECT agregado em produção (chaves de demanda só pelos 6 primeiros caracteres do md5, sem dados pessoais).

### Concordâncias

- Executor A2 = Revisor A1 (seleção mudada depois de "Conferido" trava a V1). Sustentado. Confirmado: `state.listeners` só aparece em painel/painel.js:3508 e 3513, nunca recebe listener; `AUDIT_CHECK_FIRST` (2941) não inclui CONFERIDO; o caminho de 3643 relança o erro. Mesma gravidade (BLOQUEIA_VENDA) e esforço (P).
- Executor A3 = Revisor A4 (três leituras da base por clique em V1). Sustentado. api/panel/vitrines.js:30 a 35, api/panel/manheim-audit.js:29 e 32, painel/painel.js:3645 e 3649. O executor acrescenta que na BUSCAS a conferência roda depois do `Promise.all` principal (panel-buscas-view.js:230 e 231): confirmado, é sequencial. Eu acrescento que o `auditGate` roda antes de `stampGate` e `selectedFor` (vitrines.js:119 a 122). Mesma gravidade (OUTRO) e esforço (M).

### Achados só do executor

- Executor A1 (conferência paga de novo os mesmos carros): sustentado em parte, divergente na gravidade e na redação.
  - Sustentado: nas 10 linhas da regra conferencia-v3.5 do lote ativo há 32 chaves em `car_results`, todas distintas; `1b4ff5` foi paga 4 vezes e `4b5a12` foi paga com 7 carros às 21:47 e de novo às 23:07. `carHash` (panel-manheim-audit.js:155) inclui `match.id`, `row_fingerprint` e a opção inteira (com `lote`), e o representante do grupo depende do horário (`groupVehicles(rows, now)`, manheim-offer.js:85), então a hipótese é plausível, mas segue sem prova.
  - Refutado o "nunca acontece": as linhas de `4b5a12` das 23:32 (6 carros) e 23:37 (2 carros) têm `cost_usd` nulo e `car_results` vazio, ou seja, foram montadas só com carros já lidos, sem chamada paga. O reaproveitamento funciona às vezes.
  - Divergente na gravidade: o efeito na venda é atraso, não bloqueio. Hash novo vira CONFERINDO, que está em `AUDIT_CHECK_FIRST`, então o clique em V1 pede `check` e lê na hora (painel.js:3643). Custo por releitura em produção: US$ 0,00012 a 0,00023. Proponho OUTRO (custo e atraso), esforço M mantido, com a etapa de log antes da correção.
- Executor A4 (falha ao ler a seleção cai no lote inteiro): sustentado no código, divergente na gravidade. `catch (_)` sem olhar o erro em panel-buscas-view.js:112 confirmado, e `selectedFor` em vitrines.js já trata só 404 e 400. Não refiz o EXPLAIN ANALYZE de 8,98 s (não repeti a medição pesada em produção); o número fica como medição do executor. Só bloqueia a venda quando a leitura de `manheim_option_selections` falha, o que é raro; proponho OUTRO com risco de BLOQUEIA_VENDA, esforço P mantido. Correção sugerida concorda.
- Executor A5 (leitura antiga conta como "última leitura"): sustentado no código (panel-manheim-audit.js:450 e 451 pegam a última linha da demanda sem filtrar `rule_version`; painel.js:2976 mostra "Última conferência"), divergente na gravidade. O próprio executor diz que hoje aparece certo; não há informação errada na tela agora. Proponho OUTRO (risco), esforço P.
- Executor A6 (troca de versão derruba aprovação à mão e cobra de novo): sustentado. `RULE_VERSION` entra nos dois hashes (151 e 158); produção: `68d950` tem APROVADO_MANUAL em v3.3 às 20:19 de 04/10 e nova leitura paga em v3.5 às 21:47. Gravidade OUTRO e esforço M concordam. Observação: o atraso na V1 foi de no máximo um ciclo, porque o clique em V1 pede `check` para CONFERINDO.

### Achados só do revisor (não estão no rascunho)

- Revisor A2 (audit-changed disparado num bloco já trocado não chega ao cartão): mantido. painel/painel.js:2964 dispara no `box`; 3560 e 3692 trocam o bloco a cada `options-loaded`; o botão V1 só escuta no cartão (painel.js:3654). Sem refutação.
- Revisor A3 (motivo digitado some quando as opções carregam): mantido, mesma causa (recriação do bloco).
- Revisor A5 (dois provedores de IA por clique em "Destravar esta venda"): mantido como decisão de produto, fora da correção imediata.

### Resumo por achado

| Achado | Situação | Gravidade final proposta |
|---|---|---|
| Exec A1 / hash muda e paga de novo | sustentado em parte ("nunca" refutado), divergente na gravidade | OUTRO, M |
| Exec A2 = Rev A1 / seleção nova trava V1 | sustentado, concordância | BLOQUEIA_VENDA, P |
| Exec A3 = Rev A4 / três leituras da base | sustentado, concordância | OUTRO, M |
| Exec A4 / catch cai no lote inteiro | sustentado, divergente na gravidade | OUTRO (risco de bloqueio), P |
| Exec A5 / última leitura de regra antiga | sustentado no código, divergente na gravidade | OUTRO, P |
| Exec A6 / troca de regra derruba aprovação | sustentado | OUTRO, M |
| Rev A2 / audit-changed em bloco solto | sustentado | INFO_ERRADA_OU_DUPLICADA, P |
| Rev A3 / motivo digitado some | sustentado | OUTRO, P |
| Rev A5 / dois provedores por clique | sustentado (decisão de produto) | OUTRO, M |
