# Opções automáticas após a mensagem da calculadora

O receptor ao vivo mantém a saudação atual. Depois dela, envia uma mensagem com o link `/o/<código>` e outra com a explicação dos valores. Se a saudação for dispensada por já existir conversa recente, uma nova solicitação válida ainda pode receber opções.

O envio exige uma única Ref explícita em uma mensagem da calculadora, registro real e não de teste em `calc_runs`, modo CARRO/VALOR correspondente, contato e conversa resolvidos, pedido ativo e opções disponíveis no lote ativo. Refs de outra pessoa, telefones conflitantes, pedidos desligados, mensagens antigas, históricos importados, opt-out e eventos repetidos não disparam o recurso. Usa o mesmo `panel_manheim_offer_page` e o mesmo código de `linkFor` do botão manual; não altera critérios, preços, GPT ou Claude.

O link é precedido por `Current options:`, `Opções atuais:` ou `Opciones actuales:` conforme o idioma da calculadora. A explicação tem tradução fixa, sem chamada a uma IA. Seu texto apresenta uma referência baseada no mercado de atacado, que pode incluir ajustes e revisão de preço da equipe; comprar abaixo dela é um objetivo.

`whatsapp_auto_options` registra uma reserva única por ambiente, Ref e modo. O link precisa de confirmação do provedor antes de enviar a explicação. Os IDs do WhatsApp são guardados antes da gravação no chat. O novo gatilho marca essas mensagens como automáticas, inclusive quando um eco chega durante o envio antes da confirmação HTTP. O corpo exato, contato e janela de envio limitam essa identificação; a URL copiada pelo botão manual continua contando como mensagem humana. As funções existentes de mensagens e etapas não são substituídas.

Não há repetição automática após falha ou resposta incerta do provedor. `stage`, `link_wamid`, `explanation_wamid` e `error_code` permitem conferir a entrega antes de uma ação manual. `PANEL_RECORD_FAILED` indica confirmação de envio com falha na gravação do chat. Nenhum processo reaproveita mensagens históricas para enviar ofertas.

## Ativação e interrupção

Aplicar `20261011022911_whatsapp_calculator_options.sql` e `20261011024329_whatsapp_auto_options_bsuid_identity.sql` antes de publicar o código. A segunda migração exige vínculo anterior quando um contato já identificado aparece com um BSUID ou telefone novo, impedindo que uma Ref encaminhada introduza outro destinatário. Em produção, `AUTO_REPLY_ENABLED=true` ativa o fluxo; `AUTO_OPTIONS_ENABLED=false` desativa apenas as opções automáticas após nova publicação. `AUTO_OPTIONS_ENABLED` ausente equivale a habilitado. Preview e desenvolvimento da Vercel nunca enviam opções reais. O transporte usa a integração e cobrança atuais do 360dialog.

Para interromper apenas esta inclusão, definir `AUTO_OPTIONS_ENABLED=false` em produção e publicar novamente. Manter a tabela e seus registros preserva a proteção contra duplicidades caso o recurso volte a ser ativado.

## Validação

`node --test tests/whatsapp-auto-options.test.js tests/whatsapp-auto-reply.test.js` verifica sequência, idiomas, envio por telefone/BSUID, regras de bloqueio, orçamento de tempo e falhas. `npm run test:sql` verifica a migração, identidade, Ref real, modos, isolamento dos ambientes, pedido desligado, exclusividade da reserva e distinção entre envio automático e humano. Os testes usam transportes simulados e banco local; não enviam mensagens a clientes.
