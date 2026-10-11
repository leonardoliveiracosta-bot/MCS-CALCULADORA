# Catálogo gratuito de versões para o site

## Escopo e cobertura

Todos os 53 fabricantes e 563 modelos de `vehicle-catalog.js` são elegíveis, sem ranking por demanda. As sugestões são filtradas por marca, modelo e intervalo de anos. São preferências, sem estoque ou promessa de disponibilidade. O campo existente continua opcional e aceita texto livre; “Não tenho certeza” mantém a regra existente.

Esta revisão tem sugestões para **250 modelos, em 2.139 combinações modelo/ano**, distribuídas pelas **53 marcas**, com 7.155 nomes agregados. Os outros 313 modelos continuam disponíveis para escolha e preenchimento manual. Mesmo um modelo coberto pode ter anos e versões sem informação. A cobertura exata e todas as lacunas estão em `vehicle-trims-coverage.json`; nunca apresentar essa base como completa.

A base combina rótulos já importados na MCS com nomes revisados em documentos das próprias fabricantes, encontrados pelo Exa. `vehicle-trims-evidence.json` registra cada complemento com fonte, mercado, ano exato e data da conferência. Brochuras históricas podem estar hospedadas em arquivos públicos; conferir autoria e mercado. Datas de lançamento ou publicação não provam ano-modelo. Uma lacuna não significa “versão inexistente”.

## Custo e funcionamento

Sem nova assinatura, API paga, conta nova ou credencial. Os dados são arquivos do próprio site. Exa foi usado para pesquisa editorial nesta revisão e não é chamado durante o preenchimento. Não há custo recorrente adicional de fornecedor de catálogo. Manter o catálogo atualizado exige revisão e nova publicação; não existe sincronização automática nem garantia de cobertura total.

- `vehicle-trims.json`: nomes por marca/modelo/ano, fonte e data. Sem VIN, clientes, telefone, preço, MMR, lote, localização, leilão ou contagem de carros.
- `vehicle-trims.js`: datalist no campo existente. Carrega o catálogo somente após marca, modelo e anos válidos estarem preenchidos; reutiliza o arquivo na página. Não exige escolher uma versão.
- Falha de carregamento permite escrever ou marcar “Não tenho certeza”. Mudanças de contexto limpam imediatamente as sugestões antigas; respostas atrasadas não repõem opções do carro anterior.
- A lista de um intervalo é a união dos nomes comprovados em pelo menos um dos anos selecionados. Não inventa continuidade entre anos sem registros.
- Não muda cálculo, preços, orçamento, milhas, mensagens, importação, buscas, GPT, Claude, painel nem pedidos de contato.

## Atualização sem assinatura

1. Pesquisar lacunas de todas as marcas e modelos, sem filtro de popularidade. Preferir documentos oficiais dos EUA com ano-modelo explícito.
2. Acrescentar a `docs/vehicle-trims-evidence.json` somente nomes conferidos. Registrar fonte, ano, mercado e data. Não copiar VINs nem transformar pacotes opcionais em garantias de equipamentos. Deixar de fora o que não puder ser confirmado.
3. Executar o compilador local:

```bash
node scripts/update-reviewed-vehicle-trims.js
```

O compilador valida todo o lote antes de escrever e acrescenta nomes, preservando os anteriores. Não remove versões porque um veículo saiu do lote; não pesquisa a web nem acessa o banco. Corrigir nome ou ano equivocado exige remover explicitamente a entrada antiga do catálogo, corrigir a evidência e republicar.

Rótulos adicionais dos dados já importados podem ser agregados por separado, com entrada contendo apenas `year`, `make`, `model`, `trim`:

```bash
node scripts/build-vehicle-trims.js LABELS.json vehicle-trims.json mcs-import-labels
node scripts/update-reviewed-vehicle-trims.js
```

O importador da MCS permanece intacto. Só aceita modelos do catálogo do site ou aliases explícitos revisados, sem aproximação por prefixo. F-250/F-350 só são tratados como Super Duty a partir de MY1999. Mercedes M-Class é mapeado para o nome ML-Class existente no site.

Após atualizar, revisar a cobertura, incrementar `?v=` do JSON em `vehicle-trims.js`, rodar testes do catálogo e formulário e publicar pelo GitHub/Vercel. Novas marcas/modelos incluídas no catálogo do site ficam elegíveis sem alterar esta funcionalidade; sugestões exigem dados revisados para seus anos.

## Validação

Testes cobrem filtro por ano/modelo, ausência de extrapolação, privacidade, todas as marcas/modelos elegíveis, evidência inválida, preservação de rascunho, escolha manual, “Não tenho certeza”, troca de idioma, erro de rede e resposta atrasada. Verifica-se também envio da preferência, anúncio de referência e taxa de serviço, sem enviar mensagens reais.
