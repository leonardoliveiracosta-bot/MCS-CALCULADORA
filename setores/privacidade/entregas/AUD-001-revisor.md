# AUD-001 · privacidade · Nível 2 Revisor independente

Agente: revisor independente do setor privacidade (subagente do fluxo AUD-001)
Ordem: avaliação cega registrada antes de qualquer leitura do rascunho do executor (AUD-001-executor.md não foi aberto)
Escopo: exposição de dados pessoais em telas, links, logs ou URLs no fluxo de venda. Somente achados, sem mudança de código
Banco de produção: apenas SELECT em catálogo (pg_class, pg_policies), sem ler conteúdo de clientes

## Avaliação cega

### Achados

1. Busca global manda nome ou telefone do cliente na URL (vai para os logs da Vercel)
   - Domínio: DADOS · Gravidade: OUTRO · Esforço: P
   - Evidência: painel/painel.js:5353 `request('/api/panel/search?q=' + encodeURIComponent(q) ...)`; api/panel/search.js:11 aceita só GET e lê `req.query.q`. O operador busca por nome ou telefone, e a linha de requisição com a query fica no log de requisições da hospedagem
   - Correção sugerida: trocar para POST com `q` no corpo (manter GET por algumas versões só para compatibilidade, sem registrar o valor)

2. Cópia local do painel (IndexedDB "mcs-painel") sobrevive ao Sair
   - Domínio: DADOS · Gravidade: OUTRO · Esforço: P
   - Evidência: painel/painel.js:2497 a 2504 guarda a resposta do boot (nomes, telefones, resumos dos casos) na loja "snap"; painel/painel.js:5667 (botão Sair) chama só `clearSession()`, e `clearSession` (5432 a 5439) limpa apenas o token. Nada apaga a base. Em aparelho compartilhado, os dados ficam no navegador e são desenhados de novo no próximo login (painel/painel.js:1923)
   - Correção sugerida: no Sair, `indexedDB.deleteDatabase('mcs-painel')` e zerar `bootStore`; também limpar `mcs_zip_*` (achado 3)

3. CEP do cliente enviado a serviço de terceiros e guardado sem prazo
   - Domínio: DADOS · Gravidade: OUTRO · Esforço: P
   - Evidência: painel/painel.js:211 a 213 faz `fetch('https://api.zippopotam.us/us/' + zip)` direto do navegador e grava `localStorage['mcs_zip_' + zip]` sem expiração. O painel não define Referrer-Policy (vercel.json só define para /t/ e /v/), então o terceiro recebe o CEP junto com a origem do painel
   - Correção sugerida: resolver CEP no servidor (tabela própria ou função) ou ao menos mandar `referrerPolicy: 'no-referrer'` no fetch e incluir Referrer-Policy no cabeçalho de /painel; apagar o cache no Sair

4. Aviso de nova mensagem mostra nome completo ou telefone na tela bloqueada
   - Domínio: TELA · Gravidade: OUTRO · Esforço: P
   - Evidência: panel-push.js:16 a 23 `notificationTitle` usa `clean(name) || clean(phone)` e acrescenta Ref e veículo; painel/sw.js:24 exibe esse título. Em celular bloqueado, qualquer pessoa perto vê nome ou telefone do cliente
   - Correção sugerida: título neutro ("Nova mensagem de cliente · Ref XXXXX") com primeiro nome no máximo, sem telefone

### Conferências que não viraram achado (com evidência)

- Página pública da V1/V2: api/vitrine.js e vitrine-domain.js:46 a 70 mostram só o primeiro nome (`publicFirstName` recusa dígitos e "+"), sem telefone, sem VIN (`publicVehicle` não inclui VIN) e, na V1, sem limite do cliente nem nota. vercel.json aplica `Referrer-Policy: no-referrer`, `noindex` e `no-store` em /v/ e /t/
- V1 só junta carros da própria ficha: api/panel/vitrines.js:108 filtra `manheim_matches` por `journey_id` da ficha, então um cliente não recebe carro selecionado para outro
- Texto sugerido da V1 usa só o primeiro nome (api/panel/v1-send.js:39 a 51); a demonstração usa dados fictícios (v1-send.js:193)
- Logs de erro do servidor no fluxo de venda gravam só código ou id (v1-send.js:116, panel-server.js:45 usa mensagem genérica `SUPABASE_REQUEST_FAILED`); api/panel/lead.js:210 registra Ref e id da jornada, não telefone
- Banco: contacts, contact_phones, messages e journeys têm RLS ligado e política de SELECT só para `authenticated` com `private.panel_authorized`; vitrines, vitrine_cars e v1_sends sem privilégio para anon. calc_runs tem INSERT anon com política RESTRICTIVE de limites, sem SELECT anon
- Link wa.me e WhatsApp Web levam telefone e texto na URL por natureza do WhatsApp; a aba é aberta pelo operador e não há registro desses links no servidor além do envio de push "Enviar para meu celular" (api/panel/push-handoff.js), que vai cifrado pelo Web Push

### Nenhum achado de gravidade BLOQUEIA_VENDA, QUEBRA_CLIQUE ou INFO_ERRADA_OU_DUPLICADA no recorte de privacidade

## Comparação com o rascunho do executor

Pendente: será acrescentada somente depois, sem alterar a avaliação cega acima.

## Comparação com o rascunho

Rascunho lido depois da avaliação cega. Cada achado foi conferido de novo no código (tentativa de refutar).

### Concordâncias (os dois lados acharam)

- Aviso com nome ou telefone na tela bloqueada (revisor 4, executor P1): SUSTENTADO. panel-push.js:16 `clean(name) || clean(phone) || 'Cliente'`; painel/sw.js:24 mostra o título quando não há aba visível. O executor achou também vitrine-webhook.js:21 (`person?.display_name||item.phone`), que eu não tinha visto: acréscimo válido. A contagem de produção (456 de 729) não foi reconferida por mim; o achado se sustenta sem ela. Divergência só de domínio: executor pôs VENDAS, eu pus TELA; fico com TELA, porque não interrompe a venda
- Busca global com nome ou telefone na URL (revisor 1, executor P3): SUSTENTADO. painel/painel.js:5353 e api/panel/search.js:11 e 15. A observação do executor sobre leitura de tabelas inteiras (search.js:17 a 28, inclusive calc_runs e messages completas) também se sustenta e deve ir ao setor de dados
- CEP enviado a serviço externo (revisor 3, executor P5): SUSTENTADO. painel/painel.js:211 a 213, `mcs_zip_<CEP>` sem prazo em localStorage. Minha menção a Referrer-Policy é secundária: o CEP já vai no caminho da URL, e o padrão do navegador manda só a origem; vercel.json de fato não define Referrer-Policy para /painel (linhas 29 a 36). Divergência de domínio (TELA no executor, DADOS no meu); fico com DADOS

### Só no rascunho do executor

- P2 Sair não desliga os avisos do aparelho: SUSTENTADO. Logout em painel/painel.js:5667 chama só clearSession (5432 a 5439); `unsubscribe` não aparece em painel/*.js (só getSubscription e subscribe em notifications.js:101 a 102); api/panel/push-subscriptions.js:17 aceita só POST. Eu não tinha visto. Esforço M concordo
- P4 Rascunho de nota fica em sessionStorage após Sair: SUSTENTADO. painel/lead.js:226 e 227 grava `mcs_lead_draft_<ref ou id>`; só é apagado no Confirmar (lead.js:252); clearSession não toca nessas chaves. Impacto baixo (mesma aba, mesma base de clientes para qualquer operador autorizado), mas real

### Só na minha avaliação cega

- Revisor 2 Cópia IndexedDB "mcs-painel" sobrevive ao Sair: SUSTENTADO na reconferência. painel/painel.js:2497 a 2504 guarda o boot na loja "snap"; nenhum `deleteDatabase` em painel/*.js; o desenho a partir da cópia (painel.js:1923) só acontece com sessão válida (`current()`), então o risco é dado em repouso no aparelho, não exibição sem login. O executor não registrou; deve entrar junto de P2 e P4 numa única correção de "Sair limpa o aparelho"

### Refutados

- Nenhum achado de nenhum lado foi refutado. Os itens "conferido e sem achado" do executor (hash só com Ref ou id, logs sem telefone, vitrine só primeiro nome, QR local) batem com as minhas conferências

### Conclusão da comparação

Lista final do setor: aviso com nome ou telefone (P, incluir vitrine-webhook.js), busca na URL (P), Sair limpa o aparelho: IndexedDB, rascunhos, cache de CEP e inscrição de aviso (M no conjunto), CEP para terceiro (P). Nenhum é BLOQUEIA_VENDA, QUEBRA_CLIQUE ou INFO_ERRADA_OU_DUPLICADA; todos vão para o backlog, como o executor concluiu.
