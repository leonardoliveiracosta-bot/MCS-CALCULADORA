# eng-backend-infra

## Missão

Manter APIs e banco dentro dos limites de tempo
Preparar processamento para lote de 66 mil carros
Garantir conclusão e retomada sem duplicar trabalho ou registros

## Checklist fixo

- [ ] Conferir limites de tempo e tamanho de cada operação
- [ ] Verificar processamento de lote de 66 mil carros em cenário autorizado
- [ ] Conferir divisão em partes, paginação e consultas limitadas
- [ ] Verificar retomada e repetição segura após falhas
- [ ] Conferir concorrência e consistência sem alterações de banco fora do pedido

## Papéis e funcionamento

Toda função passa por dois agentes diferentes, nunca por um único: Nível 1 Executor e Nível 2 Revisor independente

- Nível 1 Executor: produz a partir do pedido e registra o rascunho em entregas/
- Nível 2 Revisor independente: recebe o MESMO pedido, verifica de forma cega e registra sua avaliação antes de ver o rascunho; depois confronta o rascunho com a avaliação registrada e salva a verificação em entregas/
- Nível 3 Aprovador: um terceiro agente, superior aos níveis anteriores, julga o trabalho do nível 2, decide o que vale com base nas evidências e grava somente o relatório final em relatorios/
- Acima dos três níveis está a Leo, que aprova ou reprova o relatório final

Só entra no relatório o que os níveis 2 e 3 sustentarem com evidência; alegações sem sustentação não entram como conclusões
Divergência entre executor e revisor aparece no relatório, nunca escondida; o aprovador registra os dois entendimentos, a evidência e sua decisão
Se os níveis 2 e 3 não sustentarem uma conclusão, registrar a pendência e devolver para verificação, sem apresentar a alegação como fato

## Regra anti-ancoragem

Executor e revisor recebem cópias idênticas do pedido, com o mesmo identificador e as mesmas fontes necessárias
O revisor não recebe rascunho, resumo, sugestão, decisão ou mensagem do executor antes de registrar sua avaliação independente
Registrar agentes responsáveis e ordem das etapas; preservar a avaliação cega original e acrescentar a comparação somente depois
Se houver acesso antecipado ao rascunho, refazer a revisão cega com outro agente que não tenha visto o material
O aprovador não acumula os papéis de executor ou revisor; sua decisão não substitui a aprovação da Leo

## Arquivos e relatório

- entregas/: rascunho do executor e verificação do revisor, identificados pelo mesmo pedido
- relatorios/: somente o relatório final do aprovador por pedido
- Arquivos vazios .gitkeep.md apenas preservam pastas ainda sem entrega no Git e não são relatórios

O relatório final usa exatamente estes quatro itens

1. O que foi pedido
2. O que foi entregue
3. Divergências encontradas
4. Decisão do aprovador

Aplicar as regras fixas de [setores/README.md](../README.md) em toda entrega
