# Eficiência das IAs

Claude e OpenAI continuam nas funções existentes. Em **Destravar esta venda**, as duas
recebem os mesmos pedidos reais. As instruções do Claude continuam exatamente iguais.
O GPT usa `destravar-gpt-v3`: responde primeiro ao ponto atual, propõe uma ação,
escreve uma mensagem de até 80 palavras e faz no máximo uma pergunta útil. Não
imagina respostas futuras do cliente nem reinicia uma qualificação completa.
Cada provedor registra sua própria versão para comparação. Regras: POR_CARRO não pede lance/orçamento;
POR_VALOR não pede ano/milhas; teto total e lance são separados; apenas Lane/Run
ativo do lote atual entra como opção. Nenhum envio automático novo foi criado.

As sugestões registram somente provedor, versão do texto de instruções, duração,
comprimento e hash da mensagem. Os botões existentes registram escolha, edição,
envio confirmado pelo painel ou abertura de WhatsApp/SMS. Cliques repetidos não
duplicam as contagens. Abrir um aplicativo não prova envio, nem escolha prova venda.

No assistente existente, perguntar **“Qual IA estou aproveitando mais nos últimos
30 dias?”** usa `eficiencia_ia`: escolhas, edições, tempo médio e envios confirmados.
Não trocar provedor por uma amostra pequena ou só pela velocidade.

## Custos

V2 usa a tabela central de preços por milhão de tokens. Seu custo fica no registro
durável antes de liberar a reserva; falha ao gravar mantém o valor reservado contando.
O total inclui Destravar, V2 e Assistente. A migração preserva o valor original dos
registros antigos afetados pelo erro de unidade e recupera custos V2 já pagos.
Esses valores são estimativas internas, não confirmação de fatura do provedor.

## Piloto Langfuse

Preparado e desativado por padrão. Para ativar, criar/conectar um projeto na conta
Langfuse e configurar **somente no servidor Vercel**, em produção:

- `LANGFUSE_PUBLIC_KEY` e `LANGFUSE_SECRET_KEY`: chaves do projeto.
- `LANGFUSE_BASE_URL`: região do projeto, por exemplo `https://cloud.langfuse.com`
  (EU) ou `https://us.cloud.langfuse.com` (US).
- `LANGFUSE_ENABLED=true`: habilitação explícita; redeploy após configurar.

Usar o plano gratuito para o piloto; nenhum plano pago foi contratado. A integração
envia apenas função, provedor, modelo, duração, tokens disponíveis e custo estimado
das chamadas que passam pela reserva central. Não envia conversas, prompts,
respostas, nomes, telefones, referências ou IDs de clientes. Falhas são marcadas
sem enviar o texto do erro; custo incerto por timeout é identificado como reserva.
O envio acontece em segundo plano com limite de 3 segundos e não altera a resposta.
Desativar `LANGFUSE_ENABLED` encerra o envio externo; medição interna continua.

Referência do transporte: https://langfuse.com/docs/opentelemetry

## Teste das orientações do GPT

`node scripts/evaluate-gpt-sale.js` é um teste manual no servidor Vercel, não um
cron, uma rota pública ou o comando normal de build. Usa oito casos inteiramente
fictícios e compara a orientação anterior com a nova no mesmo modelo GPT. Não
chama Claude e não cria clientes, conversas, pedidos nem envios.

Antes de chamar a IA, verifica que o custo máximo de todas as chamadas cabe em
US$0,05. Cada chamada passa pela reserva central e grava seu custo no audit log,
identificado como `GPT_PROMPT_EVAL`, com `synthetic=true`. As chaves ficam na Vercel.

Envia ao Langfuse apenas versão, identificador do cenário fictício, tempo, modelo,
tokens, custo e uma nota de verificações determinísticas. Os registros ficam no
ambiente `test`; textos das respostas não são enviados ao Langfuse. A nova versão
precisa passar todos os cenários para esse build terminar. As verificações não
certificam qualidade comercial geral nem provam aumento de vendas; o uso real
continua sendo acompanhado pelas escolhas e edições existentes no painel.
