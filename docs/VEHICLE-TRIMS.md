# Catálogo de versões para o site

## Escopo

Todos os 53 fabricantes e 563 modelos de `vehicle-catalog.js` são elegíveis, sem ranking por demanda. As sugestões são filtradas por marca, modelo e intervalo de anos. São nomes de versões, não estoque, ofertas ou promessa de disponibilidade. O campo continua opcional e aceita texto livre; “Não tenho certeza” mantém a regra existente.

O catálogo inicial é uma amostra de nomes nos dados já importados na MCS. A cobertura real está em `vehicle-trims-coverage.json`. Não é um catálogo completo do mercado. Uma linha ausente significa “sem informação nesta fonte”, não “versão inexistente”. Não publicar como cobertura abrangente antes de completar/revisar a fonte de dados.

## Arquitetura

- `vehicle-trims.json`: nomes agregados por marca/modelo/ano, fonte e data da revisão. Sem VIN, clientes, telefone, preço, MMR, lote, localização, leilão ou contagem de carros.
- `vehicle-trims.js`: sugere opções no campo existente via datalist nativo. O catálogo só é carregado quando marca, modelo e anos válidos estiverem preenchidos. Nunca pesquisa na web durante o preenchimento.
- `scripts/build-vehicle-trims.js`: atualização offline, somente por nomes correspondentes ao catálogo do site. Não conecta ao banco, não altera importador, buscas, IA nem regras da calculadora.
- As sugestões não selecionam uma versão automaticamente, não alteram orçamento, milhas, anos ou rascunho. O cliente escolhe ou escreve.
- A lista do intervalo de anos é a união dos nomes comprovados em pelo menos um dos anos selecionados. Não inventa continuidade entre anos sem registros.

## Atualizar

O arquivo de entrada contém somente `year`, `make`, `model`, `trim`; `observations` é ignorado e não publicado. Pode vir de fonte comercial licenciada ou de revisão de documentação oficial localizada com Exa. Registrar fonte, mercado EUA e ano exato antes de importar. Não incluir equipamento opcional como garantia de presença em um veículo.

```json
[{"year":2025,"make":"Toyota","model":"Camry","trim":"XLE"}]
```

```bash
node scripts/build-vehicle-trims.js LABELS.json vehicle-trims.json SOURCE
```

O compilador acrescenta nomes e preserva os anteriores. Não remove versões porque um carro saiu do lote. Corrigir uma entrada equivocada exige revisão explícita do arquivo. Modelos desconhecidos e rótulos inválidos ficam no relatório de cobertura, sem aproximação por prefixo que possa confundir modelos.

Após atualizar, revisar os nomes e a cobertura, incrementar `?v=` do JSON em `vehicle-trims.js`, rodar os testes do catálogo e formulário, publicar a revisão pelo GitHub/Vercel. É uma atualização por publicação, não uma sincronização automática com a importação.

## Cobertura ampla: fonte pendente de contratação

Pesquisa com Exa em 11/10/2026:

- CarAPI Premium: US$299 por ano, 6.000 chamadas/dia, endpoint de versões com cobertura anunciada de 1990–2027. A tabela oficial inclui Trim APIs apenas no Premium, apesar dos resumos dos planos básicos serem ambíguos. https://carapi.app/pricing/
- CarAPI Data Feed: US$599 por ano para arquivos CSV/Excel. https://carapi.app/pricing/data-feed/
- A amostra pública CarAPI cobre 2015–2020, não o catálogo completo. https://carapi.app/docs/api/trims/
- CarQuery não serve como dependência neste momento: leitura da documentação retornou “Account Suspended” e o endpoint consultado falhou.
- Bases gratuitas encontradas de modelos/estilos não comprovam níveis de acabamento por ano; não foram tratadas como versões.

Nenhum serviço contratado, conta criada, segredo copiado ou chamada paga feita. Antes de escolher fornecedor, confirmar licença para uso no site/cache, acesso autenticado e correspondência dos nomes dos modelos ao catálogo MCS. Mesmo um fornecedor amplo pode ter lacunas, preservadas com preenchimento manual. Exa auxilia a conferir/complementar casos, não garante completude.
