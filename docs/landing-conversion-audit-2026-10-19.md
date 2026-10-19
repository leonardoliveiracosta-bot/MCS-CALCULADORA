# Auditoria dos caminhos de conversão da página principal

Data: 19/10/2026. Base revisada: `b632572` da `main`, posterior aos PRs #379 e #380. O #379 estava incorporado e não havia PR aberto retornado pela consulta ao repositório no início da tarefa. A inspeção ao vivo confirmou o CTA final e o financiamento ainda em inglês quando o idioma escolhido era português.

## Conclusão e decisão

O destino de “START MY SEARCH” era uma conversa vazia no WhatsApp, enquanto a abertura e a barra de compra já levavam à calculadora. Isso comprova uma diferença entre intenção e destino, sem demonstrar perda de leads. A correção utiliza a área já existente da calculadora, que oferece orçamento, veículo ou financiamento. Não acrescenta modal, confirmação, formulário ou tela intermediária.

Se a calculadora já estiver aberta em um caminho, o link retorna a esse caminho sem recarregar o iframe nem apagar o preenchimento. Em uma visita nova, mostra a seleção dos três caminhos. Reiniciar sempre na seleção exigiria abandonar ou esconder um trabalho já iniciado; por isso o CTA só navega até a calculadora existente.

O contato humano continua independente, inclusive na seção final, com uma ação explícita de WhatsApp. Preencher critérios não é condição para tirar dúvidas, conversar sobre financiamento ou pedir retorno.

## Mapeamento de intenção e próximo passo

| Entrada | Intenção e benefício | Destino após a correção | Decisão |
| --- | --- | --- | --- |
| RUN MY NUMBERS na abertura | Ver os custos antes de avançar | `#calculadora-widget` | Preservado |
| Barra de início da compra | Continuar a compra e entender os números | `#calculadora-widget` | Preservada |
| Menu: calculadora de custos | Acessar o cálculo | `#calculadora-widget` | Preservado |
| Menu: iniciar minha busca | Informar o carro desejado | `#calculadora-widget` | Retirado o desvio até a seção final, que exigia outro clique |
| START MY SEARCH no final | Informar preferências para orientar a busca | `#calculadora-widget` | Corrigido o destino; benefício explicado em EN/ES/PT |
| Conversar no WhatsApp no final | Tirar dúvidas com uma pessoa | WhatsApp direto | Ação secundária explícita em EN/ES/PT |
| Ícone de contato, WhatsApp flutuante e telefone do rodapé | Falar diretamente com a empresa | WhatsApp ou SMS existentes | Preservados |
| Prefiro que me chamem | Receber contato no canal escolhido | Formulário existente de nome, telefone e canal | Preservado; não é uma busca qualificada por si só |
| Financiamento na página | Conversar sobre entrada e parcela | WhatsApp com os valores informados | Preservado o contato direto; traduções e retenção de respostas parciais corrigidas |
| Usar anúncio como referência | Explicar o tipo de carro pretendido | Fluxo existente de referência na calculadora | Preservado |
| Salvar contato nos três caminhos | Reconhecer o contato da MCS | vCard existente | Preservado; não equivale a um lead recebido |

## Problemas adicionais comprovados

- O bloco de financiamento e sua mensagem de WhatsApp ficavam em inglês mesmo após trocar o idioma. Agora os textos, rótulos, CTA e mensagem acompanham EN/ES/PT. A troca de idioma conserva os valores digitados. O conteúdo inglês aprovado e os campos originais foram mantidos.
- A mensagem de financiamento só incluía os valores se os dois campos estivessem preenchidos. Agora conserva cada valor disponível, inclusive quando só há entrada ou só há parcela; campos vazios não viram números inventados.
- A seleção dos caminhos na calculadora tinha subtítulos em inglês em ES/PT. Foram traduzidos. A orientação “comece pelo orçamento” também não descrevia todos os três caminhos; agora convida a começar pelo que a pessoa já sabe. Nenhum campo ou comportamento de envio da calculadora foi alterado.

## Limites da evidência e da medição

Esta auditoria demonstra destinos, conteúdo, validação e funcionamento das interfaces. Não contém um estudo causal de conversão, nem confirma mensagens efetivamente recebidas ou vendas. Não houve envio de mensagens ou criação de leads de teste em produção.

Os eventos existentes separam `ContactInitiated` (intenção de contato) do processamento de mensagens realmente recebidas. Um clique em `wa.me`, um formulário completo, uma linha de simulação e uma mensagem recebida são eventos diferentes. A alteração não adiciona eventos `Lead` aos links de WhatsApp nem redefine sucesso da solicitação de contato como recebimento de uma mensagem.

Para medir o efeito após a publicação, comparar etapas e origem em períodos equivalentes: critérios completos, contato iniciado, mensagem recebida correlacionada à Ref e avanço real do atendimento. Tratar contatos diretos e pedidos de retorno como caminhos próprios. Sem identificação correlacionável, não atribuir uma mensagem ou venda ao CTA final por suposição.

## Verificação

Os testes de navegador usam o servidor local e bloqueiam serviços externos. Os testes de retorno de contato usam API e banco local. A abertura direta de WhatsApp é interceptada no teste, sem envio real. A conferência de layout inclui 320, 390, 430 e 1440 px nos três idiomas, alvos de toque, largura do texto, retorno ao preenchimento, seleção e volta dos três caminhos, mensagem de financiamento, anúncio de referência, vCard, taxas e erros/repetição do pedido de contato.

Resultados finais e comandos são registrados no PR desta correção.

### Resultados desta execução

- 45 cenários de navegador aprovados: 42 na execução combinada e os 3 cenários de desktop reexecutados com sucesso após corrigir o cálculo das coordenadas de teste sob o zoom CSS já existente. O teste usa clique real do mouse, sem `force` ou disparo artificial de evento. A seleção e volta também funcionaram na checagem do site publicado antes da mudança. Não foi alterado o zoom da página.
- 29 testes específicos de Node aprovados: `finance-path`, `calc-meta-events`, `calc-handoff`, `calc-attribution`, `site-contact` e `meta-received-leads`.
- O controle de integridade confirma os caminhos originais da calculadora e o conteúdo inglês aprovado do bloco de financiamento; o controle desconsidera somente os novos atributos de tradução.
- A tentativa de suíte geral não foi concluída: a revisão automática de segurança bloqueou sua continuação por um teste que tenta HTTPS para `db.invalid`, sem comprovação do conteúdo transmitido. Não houve nova tentativa de executar essa chamada. Antes disso foram observadas três falhas, reproduzidas independentemente em uma cópia de `b632572` sem as alterações desta tarefa: `aud001-textos-whatsapp` (texto do painel), `buscas-split` (regex de payload desatualizada) e `find-one` (hash antigo do markup). Nenhuma delas foi tratada como regressão desta alteração, nem a suíte geral foi declarada aprovada.
- Navegador automatizado: Chromium 140, incluindo contexto com toque e tamanhos responsivos. O WebKit foi baixado, mas não pôde ser executado por falta de bibliotecas do sistema. Não se afirma validação em Safari/iPhone físico.

Comandos dos testes relevantes:

```sh
PANEL_VISUAL_LOCAL=1 npx playwright test tests/landing-conversion.spec.js tests/trust.spec.js tests/finance-path.spec.js tests/find-one.spec.js tests/service-fee.spec.js tests/site-contact.spec.js --workers=2 --reporter=line
PANEL_VISUAL_LOCAL=1 npx playwright test tests/landing-conversion.spec.js --grep '1440' --workers=1 --reporter=line
node --test tests/finance-path.test.js tests/calc-meta-events.test.js tests/calc-handoff.test.js tests/calc-attribution.test.js tests/site-contact.test.js tests/meta-received-leads.test.js
```
