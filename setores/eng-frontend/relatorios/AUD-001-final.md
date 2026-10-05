# AUD-001 · Relatório final do Aprovador · eng-frontend

- Pedido: AUD-001
- Setor: eng-frontend
- Papel: Nível 3 Aprovador (agente distinto do executor e do revisor)
- Base conferida: main com HEAD 7a25ef1 (código do painel igual ao de 77c9352)
- Ordem das etapas: executor (entregas/AUD-001-executor.md), revisor cego com comparação posterior (entregas/AUD-001-revisor.md), aprovador (este arquivo)
- Método do aprovador: li os dois documentos e reabri no código cada linha citada (painel/painel.js, painel/wa-link.js, painel/whatsapp-envio.js, painel/sugestoes.js, painel/grupos.js, painel/action.js, api/panel/manheim-options.js, migração 20261022010000). Não refiz consultas no Supabase; números do banco citados pelo executor e pelo revisor ficam registrados como deles, não como confirmação minha

## 1. O que foi pedido

Auditoria do painel, somente achados, sem mudar código, sem commit e sem publicação, nos domínios CLIQUES, TELA, DADOS e VENDAS. Cada achado com domínio, gravidade, esforço, evidência concreta e correção sugerida. Marcar para corrigir agora o que bloqueia venda, quebra clique ou mostra informação errada ou duplicada, com esforço pequeno ou médio. O comando da Leo inclui também, como itens fechados para corrigir agora, leituras duplicadas do banco e o guard do makeCardClickable em todos os lugares

## 2. O que foi entregue

Executor: 8 achados (F1 a F8) e medições sem achado (funções do Manheim entre 0,8 s e 1,5 s, longe do limite de 8 s)
Revisor: avaliação cega com 7 achados (A1 a A7), depois a comparação, que sustentou todos os achados do executor e refutou uma afirmação da própria avaliação cega (nenhuma religação no mesmo nó, derrubada por F8)

Conferência do aprovador, achado por achado

- F1 = A1, linha de carro dentro do cartão de pedido abre o pedido duas vezes. Confirmado: painel.js:3716 liga makeCardClickable na linha e painel.js:3724 no cartão que a contém; o guard (painel.js:1732 a 1755) não para a propagação e não reconhece um .clickable-card interno. Aprovado, corrigir agora
- F2 = A3, ação no cartão de CLIENTES volta a lista para a página 1. Confirmado: refresh: () => loadClients() em painel.js:1505, 1520, 1521, 1522 e 1523 (as linhas do executor estavam deslocadas, o revisor corrigiu); loadClients (painel.js:1597) busca só page 1 e renderClients faz replaceChildren (painel.js:1588). restoreClientsPosition existe e não é usado aqui. Aprovado, corrigir agora
- F3, link "Abrir no WhatsApp Web" do bloco V1 escapa do wa-link. Confirmado: o link fallback (painel.js:3382) é um wa.me (painel.js:3400) dentro do nó v1-send, que faz stopPropagation em todo clique (painel.js:3484); wa-link.js:87 escuta no document em bolha, então nunca recebe; MCSWaHandoff.attach (whatsapp-envio.js:55) só troca o texto e cria "No celular". Mesmo padrão em sugestoes.js:47 e 274 e grupos.js:103, onde fica o link do MCSSuggest. Aprovado como VENDAS, corrigir agora
- F4 = A5, mesma API da aba chamada duas vezes. Confirmado: switchPanel já chama loadCurrent (painel.js:642) e os atalhos ainda fazem .then(loadCurrent) (painel.js:2237 e 3766). Aprovado, corrigir agora pelo item 3 do comando (leitura duplicada)
- A6, cada redesenho de ENVIAR OPÇÕES faz um POST prepare por cartão com V1. Confirmado: painel.js:3629 chama restore, que chama setVitrine(item.token, true) (painel.js:3496), que faz POST /api/panel/v1-send action prepare (painel.js:3428). Repete a cada atualização automática. Aprovado, corrigir agora pelo item 3 do comando, com cuidado para não quebrar o envio da V1
- F7, paginação do grupo sem descartar carro repetido. Confirmado no código: painel.js:3295 faz loadedIds.add e desenha sem checar; a API pagina por offset (manheim-options.js:123 e 135 a 137; migração 20261022010000 linhas 169 e 220). Repetição não observada na tela, é risco real e barato de fechar. Aprovado, corrigir agora pelo item 2 do comando (mesmo VIN duas vezes), com spec que simula páginas sobrepostas
- F5 + A2, atualização automática de 2 min e ações "Retomar busca" e "Apresentei ao cliente" redesenham ENVIAR OPÇÕES inteira. Confirmado: REFRESH_MS 120000 (painel.js:5490), run chama loadCurrent (painel.js:5516 a 5518), refresh: loadCurrent em painel.js:3564 e 3593. Aprovado para backlog com prioridade alta (ver decisão)
- F6, marcar trim durante a carga é desfeito sem aviso. Confirmado: painel.js:3326. Aprovado para backlog
- F8, ouvinte toggle acumulado na triagem. Confirmado: painel.js:1058 e 1077 ligam com once:true dentro do desenho, em elementos fixos. Aprovado para backlog
- A4, seleção de "Excluir selecionados" em ATENDIMENTO some a cada redesenho. Confirmado: a marcação vive só no DOM (painel.js:2578 a 2583) e renderToday faz replaceChildren (painel.js:2665). Aprovado para backlog
- A7, guard não conhece role=button, contenteditable nem um cartão clicável interno. Confirmado na lista de painel.js:1738. A parte do cartão interno entra na correção de F1 (item 1 do comando); o restante vai para backlog como prevenção, porque hoje não há controle desses dentro de cartão
- Os 9 usos de makeCardClickable (painel.js:1424, 1529, 2615, 2770, 2857, 3664, 3716, 3724, 4905) foram reconferidos; botões internos usam MCSAction.bind, que para a propagação (action.js:84), ou são cobertos pelo guard. O único caso quebrado é o aninhamento de F1

## 3. Divergências encontradas

- F5 x A2, alcance: o executor citou só as duas ações; o revisor incluiu o agendador de 2 min. Evidência a favor do revisor (painel.js:5516 a 5518). Decisão: vale o alcance do revisor
- F5 x A2, gravidade: executor OUTRO, revisor BLOQUEIA_VENDA "atrapalha, não impede". A seleção fica salva no servidor e a venda continua possível, só o contexto visual se perde. Decisão: OUTRO no critério da regra, mas no topo do backlog por impacto em venda. Esforço G, porque preservar grupos abertos, páginas carregadas, filtro de trim e a caixa da V1 mexe em vários estados
- F6, gravidade: executor QUEBRA_CLIQUE, revisor OUTRO. A janela é curta e o checkbox volta à vista. Decisão: OUTRO, backlog
- F7: o revisor tinha concluído na avaliação cega que a ordem é determinística e não via repetição; na comparação aceitou o risco. Decisão: o código confirma a ausência de checagem e a paginação por offset; aprovado como risco, corrigir agora por ser P e cair no item 2 do comando. O spec precisa simular páginas sobrepostas para falhar antes
- F3, domínio: executor CLIQUES implícito, revisor propôs VENDAS. Decisão: VENDAS, porque é o envio da V1
- A4, gravidade: revisor INFO_ERRADA_OU_DUPLICADA. A barra volta a zero junto com as caixas, então não mostra número errado, só perde a seleção. Decisão: OUTRO, backlog
- Afirmação cega do revisor "nenhuma religação no mesmo nó": refutada por F8, como o próprio revisor registrou
- Números do banco (55.454 linhas para 47.758 pares no lote ativo, 9 vitrines em 7 fichas em 30 dias) não foram refeitos pelo aprovador; não sustentam decisão sozinhos

## 4. Decisão do aprovador

Corrigir agora (regra do comando e esforço P ou M), cada um com spec Playwright que falha antes e passa depois

1. F1, guard do cartão: incluir .clickable-card na lista do guard (ou ignorar quando event.target.closest('.clickable-card') !== card), resolvendo o aninhamento em painel.js:3716 e 3724. Esforço P
2. F3, link do WhatsApp no bloco V1 e nos cartões de sugestão: tirar o stopPropagation genérico de painel.js:3484, sugestoes.js:47 e 274 e grupos.js:103, ou abrir pelo MCSWaLink no clique do link. Esforço P
3. F2, CLIENTES: após ação no cartão, recarregar as páginas já carregadas e chamar restoreClientsPosition. Esforço M
4. F4, remover o .then(loadCurrent) de painel.js:2237 e 3766. Esforço P
5. F7, pular opção cujo id ou VIN já está em loadedIds (painel.js:3295). Esforço P
6. A6, guardar a resposta do prepare por token na sessão, para que o redesenho não repita o POST. Esforço M

Backlog priorizado por impacto x esforço, nada descartado

1. F5 + A2, preservar o trabalho de venda em ENVIAR OPÇÕES na atualização automática e após "Retomar busca" e "Apresentei ao cliente" (ou não redesenhar enquanto houver grupo aberto). VENDAS, esforço G
2. A3 parte automática, CLIENTES volta à página 1 também na atualização de 2 min. CLIQUES, esforço M (sai junto se a correção de F2 for reaproveitada no agendador)
3. A4, manter a seleção de ATENDIMENTO num conjunto e remarcar ao redesenhar. TELA, esforço P
4. F6, desabilitar os trims com aviso enquanto carrega, ou aplicar depois. CLIQUES, esforço P
5. F8, ligar os ouvintes toggle uma vez só. CLIQUES, esforço P
6. A7 restante, incluir [role=button] e [contenteditable] no guard e abrir o cartão também com Espaço. CLIQUES, esforço P

Rejeitados: nenhum achado. Decisão sujeita à aprovação da Leo
