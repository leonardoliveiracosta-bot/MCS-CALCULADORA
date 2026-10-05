# AUD-001 · Executor · privacidade

- Pedido: AUD-001, auditoria do painel My Car Scout, somente achados, sem alterar código
- Papel: Nível 1 Executor
- Agente: executor do setor privacidade (subagente do fluxo AUD-001)
- Foco: exposição de dados pessoais em telas, links, logs ou URLs no fluxo de venda
- Base: main atual em /home/user/MCS-CALCULADORA; produção consultada só com SELECT de contagem, sem ler conteúdo de clientes

## Conferido e sem achado

- Logs do servidor (api/panel, panel-*.js, whatsapp-*.js): registram só códigos, ids e contagens; panel-server.js:43-50 descarta o corpo da resposta do banco e guarda só o código de negócio
- Endereço do painel: o hash usa só Ref ou id da ficha (painel/painel.js:2207-2209), nunca nome ou telefone
- Vitrine pública /v/: só primeiro nome, sem telefone (vitrine-domain.js:46-60); V1 sem limite nem nota; cabeçalhos no-referrer, noindex, no-store (vercel.json)
- Envio da V1 (api/panel/v1-send.js): erros e registros sem telefone nem texto
- "Enviar para meu celular": aviso com corpo genérico; o link com número e texto vai no conteúdo cifrado do Web Push (api/panel/push-handoff.js:17)
- QR code gerado no próprio navegador (painel/vendor/qrcode.js), sem serviço externo

## Achados

### P1. Aviso no celular mostra o nome completo ou o telefone inteiro do cliente
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: panel-push.js:16-17 monta o título com `clean(name) || clean(phone)`; vitrine-webhook.js:21 faz o mesmo com `person?.display_name||item.phone`. O título aparece na tela bloqueada (painel/sw.js:23-24). Contagem em produção: 456 de 729 contatos sem nome ou com nome que é só número, ou seja, para a maioria o aviso mostra o telefone inteiro
- Correção sugerida: no título usar só o primeiro nome (mesma regra de publicFirstName) e, sem nome, telefone mascarado (exemplo fictício: final 4321) ou só a Ref

### P2. Sair do painel não desliga os avisos do aparelho
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: M
- Evidência: painel/painel.js:5667 (logout) só chama clearSession (5432-5439); não há pushManager unsubscribe em painel/*.js nem rota DELETE em api/panel/push-subscriptions.js (aceita só POST). Aparelho deslogado ou emprestado continua recebendo nome ou telefone de cliente (ver P1)
- Correção sugerida: no logout, `registration.pushManager.getSubscription()` e `unsubscribe()`, mais rota DELETE que apaga a linha em panel_push_subscriptions pelo endpoint

### P3. Busca global manda nome ou telefone do cliente na URL
- Domínio: DADOS · Gravidade: OUTRO · Esforço: P
- Evidência: painel/painel.js:5353 `request('/api/panel/search?q=' + encodeURIComponent(q) ...)`; api/panel/search.js:11 aceita só GET e lê `req.query.q`. O texto buscado (exemplo fictício: +1 555 010 0000 ou Maria Exemplo) fica nos registros de acesso da Vercel
- Correção sugerida: aceitar POST com `{ q, sort }` no corpo e o painel passar a usar POST
- Observação para o setor de dados: a mesma rota lê tabelas inteiras a cada busca (contacts, contact_phones, journeys, calc_runs, messages etc., search.js:17-28), candidata a lentidão perto do limite de 8 s

### P4. Rascunho de nota da ficha fica no navegador depois de Sair
- Domínio: VENDAS · Gravidade: OUTRO · Esforço: P
- Evidência: painel/lead.js:226-227 guarda o rascunho em sessionStorage com chave `mcs_lead_draft_<ref ou id>`; clearSession (painel.js:5432-5439) apaga só a sessão. Quem abrir o painel na mesma aba depois do logout vê o rascunho ao entrar de novo em outra conta
- Correção sugerida: no logout, apagar as chaves `mcs_lead_draft_*` (e os ids de aviso) do sessionStorage

### P5. CEP do cliente enviado a serviço externo
- Domínio: TELA · Gravidade: OUTRO · Esforço: P
- Evidência: painel/painel.js:213 busca `https://api.zippopotam.us/us/<CEP>` a cada CEP sem cidade no cartão e guarda em localStorage `mcs_zip_<CEP>`. O CEP sozinho identifica pouco, mas sai do domínio da MCS
- Correção sugerida: resolver o CEP no servidor (tabela local ou cache em banco) ou aceitar o risco e registrar a decisão

## Fora do escopo de correção imediata

Nenhum achado deste setor bloqueia venda, quebra clique ou mostra informação errada ou duplicada; todos vão para o backlog, com P1 e P3 como mais baratos e de maior impacto.
