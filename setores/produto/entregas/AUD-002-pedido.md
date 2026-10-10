# AUD-002 Pedido

Identificador: AUD-002
Data: 2026-10-09
Setor responsável: produto
Setor que entra: qa (confere se cada correção tem o teste que a AUD-001 exigiu)

## Comando da Leo

Acompanhamento da auditoria AUD-001 do setor produto: dizer quais dos achados marcados para corrigir agora já foram resolvidos pelas publicações recentes e quais seguem abertos, conferido no código atual

## Escopo

- Os 10 achados aprovados para corrigir agora (A1 a A10) e os 4 do backlog (B1 a B4) do relatório setores/produto/relatorios/AUD-001-final.md
- Para cada achado, um destes estados, com evidência no código atual (arquivo e linha) e o commit ou PR que resolveu, quando houver:
  - RESOLVIDO: o defeito descrito não acontece mais no código atual
  - PARCIAL: parte do defeito foi corrigida e parte continua
  - ABERTO: o defeito continua como descrito
  - MUDOU: o código mudou tanto que o achado precisa ser refeito; dizer por quê
- Quando a AUD-001 citou contagem em produção (por exemplo 0 casos em A3 e B4), dizer se a contagem continua valendo, medindo de novo só com SELECT
- A AUD-001 decidiu que cada correção precisa de teste Playwright que falhe antes e passe depois; registrar se esse teste existe para cada achado resolvido
- Não propor regra comercial nova; B3 continua dependendo de decisão da Leo

## Fontes

- setores/produto/relatorios/AUD-001-final.md, setores/produto/entregas/AUD-001-executor.md, setores/produto/entregas/AUD-001-revisor.md
- Código atual do repositório (branch main, já presente no diretório de trabalho), git log e git show desde o commit 7a25ef1 (base da AUD-001)
- Testes em tests/ (node --test e specs Playwright)
- Banco Supabase de produção (projeto wwmakfaqahlbjzqvzgbr), somente para recontar casos citados na AUD-001

## Limites

- Somente leitura: não alterar código, não criar migração, não publicar, não comentar em PR, não enviar mensagens
- No banco de produção: somente SELECT; no máximo 3 execuções de qualquer consulta que leve mais de meio segundo
- Sem dados pessoais: nada de nomes, telefones, textos de mensagens, VINs ou Refs reais; só contagens e exemplos fictícios
- Sem segredos; sem travessão
- Exceção continua exceção (CLAUDE.md): ao relatar casos raros, dizer quantas vezes acontecem
