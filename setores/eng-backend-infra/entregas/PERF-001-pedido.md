# PERF-001 Pedido

Identificador: PERF-001
Data: 2026-10-08
Setor responsável: eng-backend-infra
Setores que entram: qa (comparação completa dos dados), confiabilidade-sre (a proposta em avaliação envolve infraestrutura)
Privacidade entra quando houver proposta de migração, inclusive para criar índices; esta fase é só diagnóstico

## Comando da Leo

Encontrar a solução para o painel abrir em até 3 segundos
Sem mudar o layout e sem gastar créditos de IA
Começar pelo diagnóstico independente e pela comparação completa dos dados, antes de decidir quais índices ou funções criar
A comparação de resultados antes e depois deve ser completa, incluindo mensagens novas e pedidos incompletos, e a abertura deve ser medida sem cache

## Fatos já conhecidos

1. Já tentamos reunir leituras numa função do banco (PR 286, commit ba4efa4, função panel_boot_read_bundle e arquivo panel-boot-reads.js). Os testes locais passaram, mas os totais mudaram em produção, e a Leo reverteu (PR 287, commit 38c2ab0). A causa da diferença não foi identificada. Repetir essa abordagem sem investigar a diferença é arriscado
2. Medições anteriores da abertura vistas pela Leo: 8,4 segundos antes, 6,9 nas recargas após a otimização e 10,5 na primeira abertura após publicar. São referência e devem ser repetidas na nova avaliação
3. Montar a página no banco é uma alternativa a validar, não uma solução comprovada ou obrigatória
4. Existe uma proposta aberta e não publicada: PR 288, que muda a região das funções na Vercel (vercel.json, regions cle1). Deve ser avaliada como hipótese, confirmada ou refutada com evidência

## Fontes

- Código: api/panel/boot.js (abertura rápida, partes main e counters), api/panel/today.js, api/panel/pesquisas.js, api/panel/records.js, panel-server.js (rows, allRows, readCache), panel-read-model.js, panel-buscas-view.js, panel-client-context.js, panel-ready.js, panel-attend-page.js, painel/painel.js (chamada da abertura no navegador)
- Histórico: git show ba4efa4, git show 38c2ab0, git log
- Registros de produção na Vercel (projeto prj_rvTTgtaQ8o682GtphtYQ9TTEt80e, equipe team_H3H5lnPK5SjLdU3Xm2A0QNnW): marcas [boot-timing], [today-timing], [buscas-timing], [boot-page-fallback]
- Banco Supabase (projeto wwmakfaqahlbjzqvzgbr): pg_stat_statements, definições de funções, planos de consulta
- Testes locais: npm test; banco simulado em tests/fixtures/banco-simulado.js (PGlite com todas as migrações)

## Limites desta fase

- Somente leitura: não alterar código, não criar ou aplicar migração, não publicar, não comentar em PR, não enviar mensagens
- No banco de produção: somente SELECT e EXPLAIN; EXPLAIN ANALYZE só para consulta que chama função marcada STABLE ou IMMUTABLE (conferir em pg_proc.provolatile antes)
- O banco de produção atende a Leo enquanto isso: no máximo 3 execuções de qualquer consulta que leve mais de meio segundo; preferir pg_stat_statements e os registros da Vercel
- Sem dados pessoais nas entregas: nada de nomes, telefones, textos de mensagens ou Refs reais; números agregados e exemplos fictícios
- Sem segredos; sem travessão nos textos
- Não é possível entrar no painel de produção a partir deste ambiente; a medição no navegador fica como pendência para a Leo, com o roteiro de como medir
