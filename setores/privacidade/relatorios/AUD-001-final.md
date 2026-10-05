# AUD-001 · privacidade · Relatório final do Nível 3 Aprovador

Agente: aprovador do setor privacidade, distinto do executor e do revisor
Base conferida: main atual (commit 7a25ef1) em /home/user/MCS-CALCULADORA
Fontes julgadas: entregas/AUD-001-executor.md e entregas/AUD-001-revisor.md, com cada evidência reaberta no código pelo aprovador

## 1. O que foi pedido

Auditoria do painel My Car Scout, somente achados, sem alterar código, sem commit e sem publicação. No recorte do setor privacidade: exposição de dados pessoais em telas, links, logs ou endereços no fluxo de venda, classificando cada achado por domínio (CLIQUES, TELA, DADOS, VENDAS), gravidade, esforço, evidência e correção sugerida, e marcando para correção imediata só o que bloqueia venda, quebra clique ou mostra informação errada ou duplicada com esforço pequeno ou médio

## 2. O que foi entregue

Executor: 5 achados (P1 a P5) e lista de conferências sem achado. Revisor: avaliação cega com 4 achados registrada antes da leitura do rascunho, depois comparação que sustentou todos os achados do executor e acrescentou um próprio (cópia local no navegador após Sair)

Aprovados pelo aprovador, todos conferidos no código:

| Nº | Achado | Domínio | Gravidade | Esforço | Evidência conferida | Corrigir agora |
|---|---|---|---|---|---|---|
| A1 | Aviso no celular mostra nome completo ou telefone inteiro do cliente na tela bloqueada | TELA | OUTRO | P | panel-push.js:17 `clean(name) \|\| clean(phone) \|\| 'Cliente'`; vitrine-webhook.js:21 `person?.display_name\|\|item.phone`; painel/sw.js:24 exibe o título quando não há aba do painel visível | Não |
| A2 | Busca global manda nome ou telefone buscado no endereço da requisição, que fica nos registros de acesso da hospedagem | DADOS | OUTRO | P | painel/painel.js:5353 `request('/api/panel/search?q=' + encodeURIComponent(q) ...)`; api/panel/search.js:11 aceita só GET e :14 lê `req.query.q` | Não |
| A3 | Sair do painel não cancela a inscrição de avisos do aparelho | VENDAS | OUTRO | M | painel/painel.js:5667 o botão Sair chama só `stopAutoRefresh` e `clearSession` (5432 a 5439); nenhum `unsubscribe` em painel/*.js; api/panel/push-subscriptions.js:17 aceita só POST | Não |
| A4 | Sair deixa dados de clientes no navegador: cópia do boot no IndexedDB "mcs-painel" e rascunhos de nota em sessionStorage | DADOS | OUTRO | P | painel/painel.js:2497 a 2504 guarda o boot na loja "snap" e nenhum `deleteDatabase` existe em painel/*.js; painel/lead.js:226 e 227 grava `mcs_lead_draft_<ref ou id>`; `clearSession` não toca nessas chaves | Não |
| A5 | CEP do cliente enviado a serviço externo direto do navegador e guardado sem prazo | DADOS | OUTRO | P | painel/painel.js:213 `fetch('https://api.zippopotam.us/us/' + zip)` e grava `localStorage['mcs_zip_' + zip]` sem expiração | Não |

Correções sugeridas, em ordem de impacto por esforço para o backlog:
1. A1: título do aviso só com primeiro nome (mesma regra de publicFirstName) e Ref; sem nome, só Ref, nunca telefone; aplicar em panel-push.js e vitrine-webhook.js
2. A2: rota de busca aceitar POST com `q` e `sort` no corpo e o painel passar a usar POST
3. A3 e A4 juntos, "Sair limpa o aparelho": no Sair, cancelar a inscrição de aviso (`getSubscription` e `unsubscribe`) com rota DELETE que apaga a linha pelo endpoint, apagar a base "mcs-painel", zerar a cópia em memória, apagar `mcs_lead_draft_*` e `mcs_zip_*`. Esforço do conjunto: M
4. A5: resolver CEP no servidor ou registrar aceite do risco; no mínimo mandar sem referência de origem e apagar o cache no Sair

## 3. Divergências encontradas

- Domínio de A1: executor marcou VENDAS, revisor marcou TELA. Decisão: TELA, porque o problema é o que aparece na tela bloqueada e não interrompe a venda
- Domínio de A5: executor marcou TELA, revisor marcou DADOS. Decisão: DADOS, porque o problema é o envio do CEP para fora e o armazenamento local
- Cópia IndexedDB após Sair: só o revisor achou; o executor não registrou. Decisão: sustentado, unido ao rascunho de nota (P4 do executor) no achado A4. O desenho a partir da cópia só ocorre com sessão válida (painel.js:1923 exige `current()`), então o risco é dado guardado no aparelho e não exibição sem login
- Inscrição de aviso após Sair (P3 aqui A3) e rascunho de nota: só o executor achou; o revisor confirmou na comparação. Decisão: sustentados
- Contagem de produção do executor (456 de 729 contatos sem nome útil): não reconferida pelo revisor nem pelo aprovador. Não entra como fato; A1 se sustenta pelo código sem ela
- Observação do executor sobre a rota de busca ler tabelas inteiras a cada busca (api/panel/search.js:17 a 28, incluindo contacts, contact_phones, journeys, calc_runs sem filtro de ambiente e messages): confirmada no código pelo aprovador, mas o tempo real não foi medido. Fica fora da lista deste setor e é encaminhada ao setor de dados ou eng-backend-infra para medir contra o limite de 8 s; não some do registro
- Nenhum achado de nenhum lado foi refutado

## 4. Decisão do aprovador

Aprovados A1 a A5, todos com evidência conferida pelo aprovador no código atual. Nenhum bloqueia venda, quebra clique ou mostra informação errada ou duplicada; todos têm gravidade OUTRO e por isso nenhum entra na correção imediata. Todos vão para o backlog na ordem da seção 2, com A1 e A2 como os mais baratos e de maior impacto. Rejeitados como conclusão: a contagem de produção sem reconferência. Pendência encaminhada: medição da rota de busca pelo setor de dados. Decisão sujeita à aprovação da Leo
