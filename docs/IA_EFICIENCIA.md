# Eficiência das IAs

Claude e OpenAI continuam nas funções existentes. Em **Destravar esta venda**, as duas
recebem os mesmos pedidos reais e regras: POR_CARRO não pede lance/orçamento;
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
