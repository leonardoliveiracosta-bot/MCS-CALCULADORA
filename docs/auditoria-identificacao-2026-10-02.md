# Auditoria de identificação e organização · estado antes dos reparos (02/10/2026)

Registro dos casos afetados e das evidências lidas no banco de produção **antes** de qualquer reparo persistido.
Tudo abaixo foi consulta de leitura. Os reparos são feitos pelo próprio sistema (rotinas retomáveis e idempotentes),
nunca por SQL avulso em dados de cliente.

## Prints de SMS (`sms_print_reads`, 178 registros)

| Estado | Qtde | Observação |
|---|---|---|
| CONFIRMED | 153 | 150 com Ref e telefone, 3 sem Ref |
| READY (pendente) | 22 | detalhado abaixo |
| DISCARDED | 3 | 2 `DUPLICATE_CONFIRMED`, 1 `NAME_MATCH_REVIEW` |

Os 22 READY:

* **2 sem telefone, com Ref de ficha já identificada** (os casos do comando)
  * `IMG_9241.jpeg` · Ref `CG8LN` · cliente A · mensagem cortada, sem a linha "Ref" e com o nome lido só com o primeiro nome.
    Já confirmados: `IMG_9240.jpeg` e `IMG_9243.png` (mesma Ref, telefone `+1718•••••••`, ficha `dbcf30a7…`, contato do cliente A).
  * `IMG_9236.jpeg` · Ref `RNEVL` · cliente B · texto idêntico (mesmo hash) ao de `IMG_9244.png`, confirmado depois
    (telefone `+1225•••••••`, ficha `dcb30ec9…`). Quando o 9236 foi lido, o 9244 ainda não existia.
  * Causa: o servidor exige telefone para guardar a mensagem e a função `panel_sms_print_confirm` também; a comparação de
    mensagem repetida era por texto normalizado idêntico (o nome lido diferente e a linha "Ref" cortada quebravam a igualdade).
* **4 lidos, com Ref e telefone, ainda não guardados**: `AGGRE`, `L3PD9`, `NTHQS`, `RDM3H`.
* **16 com `AI_DAILY_LIMIT`** (erro antigo da cota compartilhada, sem leitura): nenhuma rotina os retomava.
* Dono do print (`created_by`) presente em todos: a retomada age em nome de quem enviou.

## Identidade por Ref

* 292 pares ficha × Ref escrita pelo cliente na mensagem da calculadora: **292 já ligados à ficha, 0 a ligar, 0 conflitos**.
* Caso do cliente C: ficha `4bc06bb9…` com `WSR3X` escrita na mensagem, em `journey_refs` e como código da ficha; `FMLNA` não é da ficha.
* 361 fichas com mensagem do modelo da calculadora do cliente: 287 com "Ref:" no texto, **74 sem Ref no texto**.
  * dos 74: 74 têm um código interno na ficha, **1** desses códigos existe em `calc_runs`, **0** têm qualquer código de 5 letras
    de simulação conhecida escrito em alguma mensagem da conversa.
  * `calc_runs` não guarda telefone (0 de 3414), então não existe ligação por telefone entre simulação e cliente.
  * Esses casos ficam como "Calculadora, referência a recuperar": a origem está comprovada pela mensagem, a Ref não.
  * (O número 48 do comando usa um recorte mais estreito; aqui o recorte é "tem o modelo e não tem Ref escrita".)

## Lista × ficha (R7T8Q)

* Ficha `febbf669…`: `vehicle_text` e `budget_cents` vazios; simulações `R7T8Q` = Dodge Charger, lance US$ 5.000.
* A ficha mostra Dodge Charger e US$ 5.000 (critério efetivo); a lista de Clientes e os cartões de ficha sem pedido liam
  `vehicle_text`/`budget_cents` crus e ficavam em branco.

## Buscar carros (cliente D, `9BN8J`)

* Ficha `77c63c19…`, tipo CARRO. Lote ativo `84b9bf0e…`: **92** carros na demanda oficial `journey:77c63c19…:CARRO`.
* O **100** vem de pedidos lidos da conversa (`vehicle_request_checks.request_key` = `conversa:…`, 100 opções), que têm outro
  critério e outro hash; o botão "Ver as N opções" abria a demanda oficial da ficha, com outro critério.
* `2ZF6D`, `CMYH6`, `REYUM`: código na ficha, sem simulação (`calc_runs`), sem critério/lance na ficha. Resultados "candidato"
  (`HAS_CANDIDATES`) não são opção válida.

## Rotinas existentes antes da mudança

* `ai-cron` (10 min), `openai-cron` (5 min), `media-cron` (1 min). Nenhuma lia prints, assunto ou identidade.
