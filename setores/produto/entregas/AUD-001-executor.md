# AUD-001 · executor · produto

- Pedido: AUD-001, auditoria do painel, somente achados (sem mudar código, sem commit, sem publicar)
- Papel: Nível 1 Executor
- Agente: executor do setor produto (subagente da rodada AUD-001)
- Foco: fluxo de vender (seleção para cliente, V1, envio no WhatsApp, conferência, regra por carro x por valor)
- Base: main atual (painel/painel.js com o guard do commit 77c9352)
- Banco de produção: só SELECT e EXPLAIN ANALYZE em funções de leitura; nenhum dado pessoal transcrito

## Achados

### 1. Conferência fica velha no navegador depois de mudar a seleção e trava o "Gerar link V1"
- Domínio: VENDAS · Gravidade: BLOQUEIA_VENDA · Esforço: P
- Evidência: a conferência do servidor é por conjunto de carros selecionados (hash do grupo, migração 20261023010000_conferencia_so_selecionados.sql); mudar a seleção cria um hash novo. No navegador, `state.setSelected` (painel/painel.js:3513) só mexe no Set e no contador; `state.listeners` nunca recebe ninguém (nenhum `listeners.push` no código) e nada dispara `audit-changed`. O botão segue `auditCanTry(demand)` (painel.js:2942), que lê o estado antigo.
  - Caso A: estado REVISAR por causa de um carro; o operador remove esse carro e seleciona outro. O botão "Gerar link V1" continua desligado (REVISAR não está em AUDIT_OK nem em AUDIT_CHECK_FIRST) e "Conferir de novo" não aparece (canRetry só para PENDENTE, panel-manheim-audit.js:444). Só recarregando a página.
  - Caso B: estado CONFERIDO; o operador acrescenta um carro. O servidor responde MANHEIM_AUDIT_PENDING, mas o navegador ainda acha CONFERIDO, então não roda a conferência automática (painel.js:3642, só roda para CONFERINDO ou SEM_SELECAO) e mostra "A conferência desta demanda ainda não liberou a V1" sem botão para sair.
  - O bloco de conferência do cartão também continua dizendo "Conferido" e "Conferência sobre N carros selecionados" com o N antigo.
- Correção sugerida: em `setSelected`, marcar a entrada da demanda como CONFERINDO (ou SEM_SELECAO quando zerar) e disparar `audit-changed` no cartão; spec Playwright: REVISAR, remover o carro, botão volta a ligar.

### 2. Valor em dólar digitado e clique direto em "Selecionar" pode gravar outro preço
- Domínio: VENDAS · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: o valor só é salvo no `change` do campo (painel.js:3200 a 3208, ação `price` com finalCents). Ao clicar em "Selecionar" logo depois de digitar, o `change` sai no mesmo gesto e o `select` sai em paralelo com `priceBody()` (painel.js:3164), que ainda vê `info.manualFinal` falso e manda `pct` (calculado pelo listener de input, painel.js:3148, arredondado a duas casas). No banco (panel_manheim_offer_select_v2, migração 20261022010000), um pct gera `final = round(mmr * (100 + pct) / 100)`. Se o `select` for processado por último, o preço final deixa de ser o valor digitado (exemplo fictício: MMR US$ 49.843, digitado US$ 59.000, pct 18,37, final US$ 58.999,16) e esse preço vai para a V1.
- Correção sugerida: `priceBody()` mandar `finalCents` sempre que o campo de valor tiver um valor válido diferente de `info.finalCents`, ou esperar o salvamento pendente antes do `select`.

### 3. ENVIAR OPÇÕES redesenha a visão inteira sozinha e apaga o trabalho em andamento
- Domínio: VENDAS (tela) · Gravidade: QUEBRA_CLIQUE · Esforço: M
- Evidência: ao abrir a aba, `scheduleOptionsSync(500)` (painel.js:1946); todo POST para /api/panel/actions, lead, whatsapp, entry, pesquisas também agenda (painel.js:316 e 319). Se a sincronização mudou alguma demanda, `loadCurrent()` (painel.js:339) chama `renderManheim`, que faz `replaceChildren` nas colunas. Some o que o operador tinha aberto: grupos abertos, carros carregados, percentual ou valor digitado ainda não salvo, texto editado da mensagem da V1 e a caixa "Confirmar envio" aberta. O mesmo acontece com "Apresentei ao cliente", "Religar busca" e "Comparar de novo", que chamam `loadCurrent()`.
- Correção sugerida: não redesenhar enquanto houver grupo aberto, campo com foco ou caixa de confirmação; mostrar aviso "Opções atualizadas · Recarregar" em vez de redesenhar.

### 4. Seleção guardada em dois lugares (Set do navegador e banco) sem reconciliar
- Domínio: VENDAS (dados) · Gravidade: INFO_ERRADA_OU_DUPLICADA · Esforço: P
- Evidência: `setSelected(id, on, total)` ignora `total` (selectedCount do servidor) e usa `option.id` da linha (painel.js:3171 a 3176, 3513). A função do banco troca `p_match_id` pelo membro do mesmo VIN que já tem linha de seleção (migração 20261022010000, trecho `select coalesce((select ss.match_id ... v_members ...` ) e devolve esse `matchId`; o resumo devolve em `selected_ids` o id do membro selecionado (`first_selected`, 20261024020000_manheim_resumo_rapido.sql), não o id que a página mostra. Quando os dois ids diferem: "Remover" tira do Set um id que não estava lá, o contador fica errado, a V1 manda o id antigo (servidor responde MANHEIM_OPTION_NOT_SELECTED) e o PDF procura o id em todas as páginas sem achar. Medição em produção (SELECT no lote ativo): 7 seleções, 0 hoje com id divergente; o defeito é latente (aparece quando o carro representante do VIN muda, por exemplo fim da venda Buy Now).
- Correção sugerida: usar `result.matchId` e `selectedCount` da resposta; reconciliar pelo `memberMatchIds` da linha.

### 5. "Ver opções" vindo de BUSCAR CARROS carrega ENVIAR OPÇÕES duas vezes
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: `openOptionsCard` (painel.js:1849 a 1851) chama `switchPanel('searches')`, que já faz `loadCurrent` (GET /api/panel/records?view=manheim e render completo), e em seguida chama `loadCurrent('searches', ...)` de novo. Resultado: duas leituras pesadas iguais, dois renders e dois GET /api/panel/v1-send (latestV1For por render, painel.js:3629). A aba também ignora o valor que o boot de contadores já trouxe (primeBoot da mesma rota, painel.js:1928) porque usa `request` e não `sharedGet` (painel.js:1942).
- Correção sugerida: tirar o segundo `loadCurrent` em `openOptionsCard`; usar `sharedGet` com validade curta na aba.

### 6. Trocar "Ordenar" de uma coluna redesenha as duas e repete a leitura das V1
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: o `change` de options-sort-valor ou options-sort-carro chama `renderManheim(manheimData)` inteiro (painel.js:3750), que recria todos os cartões de VALOR e CARRO, refaz `latestV1For` (um GET /api/panel/v1-send por render) e fecha grupos e seleções carregadas na outra coluna.
- Correção sugerida: redesenhar só a coluna do modo alterado e reaproveitar o resultado de v1-send.

### 7. Erros do fluxo de venda sem texto próprio, com mensagem "tente de novo" que nunca resolve
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: `OFFER_ERRORS` (painel.js:3057 a 3067) não tem MANHEIM_SALE_ENDED (lançado pelo banco quando o carro saiu da venda) e cai em "Não consegui salvar, tente de novo". `v1Error` (painel.js:3631) não tem VITRINE_VIN_DUPLICATE (vitrines.js:112), VITRINE_CONTACT_BLOCKED nem VITRINE_SOURCE_* e mostra "Não consegui gerar o link". `setVitrine` (painel.js:3428 a 3431) recebe 409 VITRINE_VIN_DUPLICATE do prepare (v1-send.js:79) e mostra "Não consegui preparar o envio · Tente de novo".
- Correção sugerida: acrescentar os códigos com o motivo e a saída (recarregar opções, contato bloqueado etc).

### 8. Selecionar um carro lê a mesma função pesada três vezes no banco
- Domínio: DADOS · Gravidade: OUTRO · Esforço: M
- Evidência: panel_manheim_offer_select_v2 (migração 20261022010000) chama `panel_manheim_grouped_options` para achar o carro, para contar o limite de 10 e para contar o total final. Medição (EXPLAIN ANALYZE em produção, demanda com mais linhas do lote ativo, cerca de 3.100 linhas): `panel_manheim_offer_page` que usa a mesma função levou 811 ms; `panel_manheim_offer_trims` 698 ms; `panel_manheim_offer_summary` 1.410 ms. Estimativa do clique em Selecionar nessa demanda: perto de 2,4 s só de banco. Longe dos 8 s, mas o clique demora.
- Correção sugerida: materializar o grupo uma vez dentro da função e reutilizar nas três etapas.

### 9. PDF com carro selecionado fora da tela lê grupos inteiros em série
- Domínio: DADOS · Gravidade: OUTRO · Esforço: M
- Evidência: `selectedOptions` (painel.js:2883 a 2896) percorre LANE, OFFLANE e INCOMPLETE de 50 em 50, em série, até achar os ids; cada página custa perto de 0,8 s na maior demanda (medição do item 8). Combinado com o item 4, um id divergente faz ler tudo e ainda falhar.
- Correção sugerida: endpoint que lê as seleções por id.

### 10. Linha clicável dentro de cartão clicável abre o pedido duas vezes
- Domínio: CLIQUES · Gravidade: OUTRO · Esforço: P
- Evidência: em `renderManheimOrderGroup`, cada linha recebe `makeCardClickable(row, ...)` (painel.js:3716) e o cartão também (painel.js:3724). `makeCardClickable` não para a propagação, então um clique em texto da linha chama `openDetail('order', ref)` na linha e de novo no cartão. Só aparece quando a seleção para cliente está indisponível (lista antiga).
- Correção sugerida: no guard, ignorar o clique quando `event.target.closest('.clickable-card') !== card`.

### 11. Observação interna do carro não é salva sozinha
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: o campo `offer-note` (painel.js:3156) não tem listener de change; a nota só vai junto com price, select, remove ou exclude. Digitar a observação e sair perde o texto ao recarregar.
- Correção sugerida: salvar no change com a ação price.

## Conferido sem defeito (para o revisor confrontar)
- Mesmo VIN duas vezes em ENVIAR OPÇÕES: o lote ativo tem 7.694 pares demanda x VIN repetidos em manheim_matches (334 demandas), mas as páginas, contagens e a seleção usam `panel_manheim_grouped_options` (um VIN por demanda), então a tela não repete o carro. Seleções com VIN repetido no lote ativo: 0.
- Cliques dentro dos grupos de carros (inputs, botões, filtro de trim) não abrem a ficha: o grupo é um `details`, que o guard trata como controle; o bloco da V1 para a propagação.
- Botão desligado (ex.: "Gerar link V1" travado) não gera clique no cartão (teste em Chromium headless: nenhum evento).
- "No celular" some junto com o link do WhatsApp (CSS identidade.css:984).
