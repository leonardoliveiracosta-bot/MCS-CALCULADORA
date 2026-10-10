# Setores do painel My Car Scout

Estrutura documental do repositório MCS-CALCULADORA, sem agentes permanentes ou automações ativadas

## Fluxo em 5 linhas

1. Pedido: registrar o comando da Leo e entregar o mesmo pedido aos agentes dos setores necessários
2. Executor: o Nível 1 produz e salva o rascunho em entregas/
3. Revisor cego: o Nível 2 registra sua avaliação independente sem ver o rascunho antes e só depois faz a comparação
4. Aprovador: o Nível 3 julga a revisão, decide com evidências e salva o relatório final em relatorios/
5. Relatório para a Leo: apresentar os quatro itens, incluindo divergências, para ela aprovar ou reprovar

## Roteamento

Acionar somente os setores necessários ao pedido e justificar os apoios adicionais, nunca todos sem motivo
Cada setor acionado aplica seus três papéis; o responsável principal consolida sem apagar divergências sustentadas

| Tipo de tarefa | Setor responsável | Setores que entram | Apoio somente quando necessário |
|---|---|---|---|
| Mudança visual | design-ux-ui | eng-frontend, qa | ux-writing se mudar texto; ux-research se houver dificuldade de uso; produto se mudar prioridade ou fluxo |
| Regra de match, compatibilidade entre pedido e veículo | produto | ia-ml, qa | eng-backend-infra se mudar processamento; dados se medir qualidade; privacidade se envolver exposição de dados |
| Bug, falha do painel | eng-frontend para tela ou eng-backend-infra para API e banco | qa | confiabilidade-sre se houver indisponibilidade ou travamento; produto se afetar regra; privacidade se houver exposição de dados |
| Texto do painel | ux-writing | design-ux-ui | produto se mudar significado comercial; eng-frontend e qa se implementar; ux-research se testar compreensão |
| Migração de banco | eng-backend-infra | qa, privacidade | confiabilidade-sre se afetar disponibilidade ou recuperação; dados se afetar indicadores; produto se mudar regra |
| Vídeo ou post do Instagram | instagram | nenhum | produto se mudar a oferta ou o caminho até a calculadora; privacidade se aparecer rosto, placa, VIN ou dado de cliente; dados se medir resultado |

## Regras fixas

- Os comandos da Leo são a especificação do trabalho e prevalecem sobre preferências dos setores
- Sem jargão no que a Leo lê; explicar termos técnicos em linguagem comum quando indispensáveis
- Sem travessão nos textos e nas entregas
- Textos de interface, incluindo botões e avisos, sem ponto final
- Um provedor por solução; não combinar provedores para a mesma solução
- Nunca expor segredos; não registrar senhas, chaves ou tokens no repositório, rascunhos, verificações ou relatórios
- Usar exemplos fictícios e evidências sem dados pessoais
- Exceção continua exceção: o caso raro é tratado à parte e nunca vira regra que atrapalha o caso comum; medir a frequência nos dados antes de criar regra e perguntar à Leo se a proteção mudar o caminho comum (detalhes em CLAUDE.md)
- Esta estrutura não autoriza alterar código, migrar banco, publicar o painel ou enviar mensagens a clientes

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

Aplicar as regras fixas de deste README em toda entrega
