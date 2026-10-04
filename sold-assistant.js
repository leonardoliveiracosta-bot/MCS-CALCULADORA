/* Sold: o assistente da página. É o martelo de madeira do leiloeiro em forma de gente.
   Responde as dúvidas com o que o site já diz (FAQ, How it works, política, taxas, depósito, exemplos reais) e,
   quando faz sentido, mostra a calculadora ou o WhatsApp. Não usa IA nem servidor: nunca inventa preço, prazo ou
   promessa. Os textos da página (data-i18n) são lidos dela mesma, então seguem o idioma escolhido. */
(function () {
  'use strict';
  if (window.__mcsSold) return;
  window.__mcsSold = true;

  var CALC = '#calculadora-widget';
  var WHATSAPP = 'https://wa.me/13055400742';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var TEXT = {
    en: {
      tagline: 'Your auction guide',
      open: 'Talk to Sold',
      close: 'Close',
      hello: "Hi, I'm Sold. I help you buy where dealers buy, at wholesale dealer auctions.",
      first: 'Ask me anything: fees, deposit, financing, title, delivery, timing. When you want to see your numbers, the calculator is right here.',
      teaser: 'Want to see your numbers before a dealer sets your price?',
      how: 'How it works',
      howIntro: 'Six steps, and you approve every one:',
      whatsapp: 'Message us on WhatsApp',
      page: 'See it on the page',
      fallback: "I don't have a ready answer for that one. Try asking about fees, the deposit, financing, title, delivery or timing, or ask a specialist on WhatsApp: a real person answers in English, Spanish or Portuguese.",
      feeIs: 'For a winning bid of {bid}, our service fee is {fee}.',
      feeTier: 'Tier: {from} to {to}.',
      feeAbove: 'Above $20,000: $900 base + $50 for each additional $2,500 or portion ({n} × $50).',
      feeEnd: 'The fee is set only by what the car actually sells for. If we don\'t buy a vehicle for you, you don\'t pay a service fee.',
      ask: 'Type your question',
      send: 'Send',
      more: 'Other questions',
      sold: 'SOLD!'
    },
    es: {
      tagline: 'Tu guía de subastas',
      open: 'Habla con Sold',
      close: 'Cerrar',
      hello: 'Hola, soy Sold. Te ayudo a comprar donde compran los dealers, en subastas mayoristas.',
      first: 'Pregúntame lo que quieras: tarifas, depósito, financiamiento, título, entrega, plazos. Cuando quieras ver tus números, la calculadora está aquí.',
      teaser: '¿Quieres ver tus números antes de que un dealer fije tu precio?',
      how: 'Cómo funciona',
      howIntro: 'Seis pasos, y tú apruebas cada uno:',
      whatsapp: 'Escríbenos por WhatsApp',
      page: 'Verlo en la página',
      fallback: 'No tengo una respuesta lista para eso. Pregúntame sobre tarifas, depósito, financiamiento, título, entrega o plazos, o escribe a un especialista por WhatsApp: una persona real responde en inglés, español o portugués.',
      feeIs: 'Para una oferta ganadora de {bid}, nuestra tarifa de servicio es {fee}.',
      feeTier: 'Rango: {from} a {to}.',
      feeAbove: 'Arriba de $20,000: $900 de base + $50 por cada $2,500 adicionales o fracción ({n} × $50).',
      feeEnd: 'La tarifa depende solo de por cuánto se vende realmente el auto. Si no compramos un vehículo para ti, no pagas tarifa de servicio.',
      ask: 'Escribe tu pregunta',
      send: 'Enviar',
      more: 'Otras preguntas',
      sold: '¡VENDIDO!'
    },
    pt: {
      tagline: 'Seu guia de leilão',
      open: 'Fale com o Sold',
      close: 'Fechar',
      hello: 'Oi, eu sou o Sold. Ajudo você a comprar onde os dealers compram, nos leilões de atacado.',
      first: 'Pode perguntar: taxas, depósito, financiamento, título, entrega, prazos. Quando quiser ver seus números, a calculadora está aqui.',
      teaser: 'Quer ver seus números antes que um dealer defina o seu preço?',
      how: 'Como funciona',
      howIntro: 'Seis passos, e você aprova cada um:',
      whatsapp: 'Fale no WhatsApp',
      page: 'Ver na página',
      fallback: 'Não tenho uma resposta pronta para isso. Pergunte sobre taxas, depósito, financiamento, título, entrega ou prazos, ou fale com um especialista no WhatsApp: uma pessoa de verdade responde em inglês, espanhol ou português.',
      feeIs: 'Para um lance vencedor de {bid}, a nossa taxa de serviço é {fee}.',
      feeTier: 'Faixa: {from} a {to}.',
      feeAbove: 'Acima de $20.000: $900 de base + $50 a cada $2.500 adicionais ou fração ({n} × $50).',
      feeEnd: 'A taxa é definida só por quanto o carro realmente sai. Se a gente não comprar um veículo para você, você não paga taxa de serviço.',
      ask: 'Digite sua pergunta',
      send: 'Enviar',
      more: 'Outras perguntas',
      sold: 'VENDIDO!'
    }
  };

  /* Os passos do How it works: em inglês vêm da página; em espanhol e português, a mesma coisa traduzida. */
  var STEPS = {
    es: [['DINOS LO QUE QUIERES', ''], ['BUSCAMOS EN LAS SUBASTAS', 'Inventario mayorista nuevo cada día'], ['TÚ REVISAS PRIMERO', 'Fotos e información del estado antes de cualquier oferta. CARFAX a medida que avanza el negocio'],
      ['HACES UN DEPÓSITO', 'Reembolsable. Fija tu máximo antes de que ofertemos por ti'], ['OFERTAMOS EN VIVO', 'Nunca por encima de tu máximo. Nunca sin tu autorización'], ['PAGAS EL RESTO, ES TUYO', 'Lo recoges, o te ayudamos a enviarlo con nuestros socios de transporte']],
    pt: [['DIGA O QUE VOCÊ QUER', ''], ['VARREMOS OS LEILÕES', 'Estoque de atacado novo todo dia'], ['VOCÊ ANALISA PRIMEIRO', 'Fotos e informações da condição antes de qualquer lance. CARFAX conforme o negócio avança'],
      ['VOCÊ FAZ UM DEPÓSITO', 'Reembolsável. Trava o seu máximo antes do nosso lance'], ['DAMOS O LANCE AO VIVO', 'Nunca acima do seu máximo. Nunca sem a sua autorização'], ['PAGUE O RESTANTE, É SEU', 'Você retira, ou ajudamos a enviar com nossos parceiros de transporte']]
  };

  /* ---------- o que o Sold sabe responder ----------
     Tudo sai do que a página já diz. {chave} é o texto da própria página naquele idioma (data-i18n: FAQ, política,
     depósito), então a resposta acompanha o site. k: palavras da pergunta nos três idiomas, sem acento (palavra de até
     4 letras vale só inteira; as maiores valem também como começo de palavra). pair: precisa de uma palavra de cada
     lista. w: peso (as genéricas pesam menos). go: calc (botão da calculadora), wa (WhatsApp) ou os dois. sec: seção. */
  var EXAMPLES_EN = '2018 BMW 530i: $7,875 · 2018 Audi Q7: $8,800 · 2019 Alfa Romeo Giulia: $9,250 · 2021 Mercedes GLA 250: $10,050 · 2018 Porsche Macan S: $10,450';
  var EXAMPLES_PT = '2018 BMW 530i: $7.875 · 2018 Audi Q7: $8.800 · 2019 Alfa Romeo Giulia: $9.250 · 2021 Mercedes GLA 250: $10.050 · 2018 Porsche Macan S: $10.450';
  var KB = [
    { id: 'how', special: 'how', go: 'calc', sec: 'como-funciona',
      k: 'how it works|how does it work|how does this work|how do you work|how this works|process|steps|step by step|como funciona|proceso|processo|passo a passo|paso a paso|pasos|etapas|funciona',
      chip: { en: 'How it works', es: 'Cómo funciona', pt: 'Como funciona' } },
    { id: 'fees', sec: 'taxas', chip: { en: 'Service fees', es: 'Tarifas de servicio', pt: 'Taxas de serviço' },
      k: 'fee|fees|service fee|your fee|commission|charge|charges|how much do you charge|what do you charge|tarifa|tarifas|comision|cuanto cobran|que cobran|cobran|cobra|comissao|taxa|taxas|quanto cobram|quanto voces cobram|cobram',
      en: 'Our service fee is based only on the winning bid:\n• Up to $3,000: $300\n• $3,001 – $5,000: $400\n• $5,001 – $7,500: $550\n• $7,501 – $10,000: $650\n• $10,001 – $15,000: $750\n• $15,001 – $20,000: $900\n• Above $20,000: $900 + $50 for each additional $2,500 (or portion)\nIf we don\'t buy a vehicle for you, you don\'t pay a service fee. Tell me an amount, like "fee for $12,000", and I\'ll show you the fee.',
      es: 'Nuestra tarifa de servicio depende solo de la oferta ganadora:\n• Hasta $3,000: $300\n• $3,001 – $5,000: $400\n• $5,001 – $7,500: $550\n• $7,501 – $10,000: $650\n• $10,001 – $15,000: $750\n• $15,001 – $20,000: $900\n• Arriba de $20,000: $900 + $50 por cada $2,500 adicionales (o fracción)\nSi no compramos un vehículo para ti, no pagas tarifa de servicio. Dime un monto, por ejemplo "tarifa para $12,000", y te muestro la tarifa.',
      pt: 'A nossa taxa de serviço é baseada só no lance vencedor:\n• Até $3.000: $300\n• $3.001 – $5.000: $400\n• $5.001 – $7.500: $550\n• $7.501 – $10.000: $650\n• $10.001 – $15.000: $750\n• $15.001 – $20.000: $900\n• Acima de $20.000: $900 + $50 a cada $2.500 adicionais (ou fração)\nSe a gente não comprar um veículo para você, você não paga taxa de serviço. Me diga um valor, por exemplo "taxa para $12.000", e eu mostro a taxa.' },
    { id: 'shipcost', go: 'calc', w: 1.5,
      pair: ['ship|shipping|transport|transportation|delivery|deliver|envio|enviar|transporte|entrega|frete|traer|trazer', 'how much|cost|costs|price|cuanto|cuesta|costo|precio|valor|quanto|custa|custo|preco'],
      en: 'We help ship the car through our transport partners, or you can pick it up. Transport cost varies with the vehicle\'s location and your destination, so it\'s part of the estimate: run your numbers and a specialist reviews them with you.',
      es: 'Te ayudamos a enviar el auto con nuestros socios de transporte, o puedes recogerlo. El costo del transporte varía según dónde está el vehículo y tu destino, por eso entra en el estimado: calcula tus números y un especialista los revisa contigo.',
      pt: 'A gente ajuda a enviar o carro com nossos parceiros de transporte, ou você pode retirar. O custo do transporte varia conforme onde o veículo está e o seu destino, por isso entra na estimativa: faça a sua conta e um especialista revisa com você.' },
    { id: 'depositAmount', go: 'wa', w: 1.5, sec: 'taxas',
      pair: ['deposit|deposito', 'how much|amount|cuanto|monto|quanto|valor'],
      en: 'The deposit is refundable and locks your max before we bid for you. The page doesn\'t list a fixed amount: a specialist confirms it for your search on WhatsApp.',
      es: 'El depósito es reembolsable y fija tu máximo antes de que ofertemos por ti. La página no indica un monto fijo: un especialista lo confirma para tu búsqueda por WhatsApp.',
      pt: 'O depósito é reembolsável e trava o seu máximo antes do lance. A página não traz um valor fixo: um especialista confirma o valor para a sua busca no WhatsApp.' },
    { id: 'refund', sec: 'taxas', w: 1.2,
      k: 'refund|refunds|money back|get my money|reembolso|devolucion|devuelven|devolver|dinheiro de volta|devolvem|devolucao|devolver',
      en: '{dep_2}\n{dep_1}\n{dep_3}', es: '{dep_2}\n{dep_1}\n{dep_3}', pt: '{dep_2}\n{dep_1}\n{dep_3}' },
    { id: 'backout', sec: 'taxas', w: 1.2,
      k: 'back out|change my mind|cancel|regret|walk away|dont want it|not complete|give up|arrepent|desist|cancelar|ya no quiero|no lo quiero|cambiar de opinion|nao quero mais|mudar de ideia|desistir|me arrepend',
      en: '{dep_3}', es: '{dep_3}', pt: '{dep_3}' },
    { id: 'deposit', sec: 'taxas', chip: { en: 'Deposit', es: 'Depósito', pt: 'Depósito' },
      k: 'deposit|deposits|deposito|depositos|refundable|reembolsable|reembolsavel|lock my|locks',
      en: 'The deposit is refundable and locks your max before we bid for you.\n{dep_1}\n{dep_2}\n{dep_3}',
      es: 'El depósito es reembolsable y fija tu máximo antes de que ofertemos por ti.\n{dep_1}\n{dep_2}\n{dep_3}',
      pt: 'O depósito é reembolsável e trava o seu máximo antes do lance.\n{dep_1}\n{dep_2}\n{dep_3}' },
    { id: 'lose', faq: 4, sec: 'faq',
      k: 'dont win|do not win|not win|dont get the car|lose|lost|outbid|dont buy|dont purchase|if you dont|no ganan|no ganamos|no gana|no ganar|perder|pierdo|no compran|no consiguen|nao ganh|nao arremat|nao conseguir|nao conseguem|nao compr|se voces nao' },
    { id: 'decide', faq: 3, sec: 'faq',
      k: 'who decides|decide|max bid|maximum bid|my max|my maximum|limit|go over|above my|over my|quien decide|oferta maxima|mi maximo|limite|pasar de|lance maximo|meu maximo|quem decide|acima do|passar do' },
    { id: 'license', faq: 1, sec: 'faq', chip: 'q1',
      k: 'license|licence|licensed|dealer license|dealer account|auction account|licencia|cuenta|licenca|conta no leilao' },
    { id: 'choose', faq: 2, sec: 'faq',
      k: 'choose|pick the car|pick my|which car|any car|specific car|car i want|find me|can you find|looking for|brand|model|tesla|truck|suv|elegir|escoger|cualquier|el auto que|el carro que|marca|modelo|camioneta|escolher|qualquer carro|o carro que|encontrar|procuro|caminhonete|busco' },
    { id: 'after', faq: 5, sec: 'faq',
      k: 'after purchase|after buying|after i buy|after we win|after you win|after winning|what happens after|once purchased|once you buy|bought|despues de comprar|despues de la compra|despues de ganar|depois da compra|depois de comprar|depois que compr|depois de arrematar|apos a compra' },
    { id: 'testdrive', faq: 6, sec: 'faq',
      k: 'test drive|testdrive|drive it|see the car|see it|in person|look at the car|ver el auto|ver el carro|verlo|prueba de manejo|manejar|en persona|ver o carro|ver pessoalmente|pessoalmente|dirigir' },
    { id: 'inspection', sec: 'politica',
      k: 'inspect|inspection|mechanic|mechanical|condition|problem|problems|defect|issues|as is|inspeccion|mecanic|condicion|problema|problemas|defecto|fallas|inspecao|vistoria|condicao|defeito|estado do carro',
      en: '{pol_3}\n{pol_4}', es: '{pol_3}\n{pol_4}', pt: '{pol_3}\n{pol_4}' },
    { id: 'receive', faq: 8, sec: 'faq', chip: { en: 'Delivery', es: 'Entrega', pt: 'Entrega' },
      k: 'receive|get my car|delivery|deliver|delivered|pickup|pick up|pick it up|bring|ship|shipping|transport|entrega|recib|recoger|retirar|traer|envio|enviar|receb|retirada|levar|trazer|transporte|frete|buscar o carro' },
    { id: 'finance', faq: 7, sec: 'financiamento', go: 'wa', chip: { en: 'Financing', es: 'Financiamiento', pt: 'Financiamento' },
      k: 'financ|loan|lender|credit|bad credit|monthly|down payment|credito|prestamo|mensual|cuota|enganche|pago inicial|emprestimo|parcel|mensal|entrada',
      en: '{a7}\nYou don\'t need to pay cash: finance the wholesale price, not the dealer markup. In the Financing section, tell us your down payment and the monthly payment you want (your wish, not a promise).',
      es: '{a7}\nNo necesitas pagar en efectivo: financia el precio mayorista, no el margen del dealer. En la sección de Financiamiento, dinos tu pago inicial y la mensualidad que quieres (tu deseo, no una promesa).',
      pt: '{a7}\nVocê não precisa pagar à vista: financie o preço de atacado, não a margem do dealer. Na seção de Financiamento, diga a sua entrada e a parcela que você quer (seu desejo, não uma promessa).' },
    { id: 'pay', go: 'wa',
      k: 'pay|payment|payments|cash|wire|zelle|card|credit card|how do i pay|pagar|pago|efectivo|tarjeta|transferencia|pagamento|dinheiro|a vista|cartao|pix',
      en: 'Before we bid, you put down a refundable deposit that locks your max. When the purchase is completed, the deposit is applied to the amount due and you pay the rest. You don\'t need to pay cash: financing may be available through third-party lenders, subject to their approval. A specialist confirms the payment details for your purchase.',
      es: 'Antes de ofertar, haces un depósito reembolsable que fija tu máximo. Cuando se completa la compra, el depósito se aplica al monto a pagar y pagas el resto. No necesitas pagar en efectivo: el financiamiento puede estar disponible con prestamistas externos, sujeto a su aprobación. Un especialista confirma los detalles del pago de tu compra.',
      pt: 'Antes do lance, você faz um depósito reembolsável que trava o seu máximo. Quando a compra é concluída, o depósito é abatido do valor devido e você paga o restante. Você não precisa pagar à vista: o financiamento pode estar disponível com credores terceiros, sujeito à aprovação deles. Um especialista confirma os detalhes do pagamento da sua compra.' },
    { id: 'bid',
      k: 'bid live|live|bidding|who bids|how do you bid|bid for me|place the bid|puja|pujan|en vivo|ofertan|ao vivo|dar lance|lance por mim|quem da o lance',
      en: 'We bid live for you: never above your max, never without your go-ahead. Before that, you review photos and condition info, and you put down a refundable deposit that locks your max.',
      es: 'Ofertamos en vivo por ti: nunca por encima de tu máximo, nunca sin tu autorización. Antes, revisas fotos e información del estado, y haces un depósito reembolsable que fija tu máximo.',
      pt: 'A gente dá o lance ao vivo por você: nunca acima do seu máximo, nunca sem a sua autorização. Antes, você analisa fotos e informações da condição, e faz um depósito reembolsável que trava o seu máximo.' },
    { id: 'save', go: 'calc', sec: 'real-purchase',
      k: 'save|savings|cheaper|discount|how much less|worth it|good deal|below retail|ahorr|barato|mas barato|descuento|vale la pena|economi|mais barato|desconto|vale a pena|compensa',
      en: 'A documented My Car Scout case: a 2021 BMW X3 with 57,347 miles cost $20,094 all in, against $25,800 in the Black Book XClean retail reference. That\'s $5,706 less, 22.12% below the reference. Every car is different: run your numbers to see yours.',
      es: 'Un caso documentado de My Car Scout: un BMW X3 2021 con 57,347 millas costó $20,094 en total, frente a $25,800 de la referencia minorista Black Book XClean. Son $5,706 menos, 22.12% por debajo de la referencia. Cada auto es distinto: calcula tus números para ver los tuyos.',
      pt: 'Um caso documentado da My Car Scout: um BMW X3 2021 com 57.347 milhas custou $20.094 no total, contra $25.800 da referência de varejo Black Book XClean. São $5.706 a menos, 22,12% abaixo da referência. Cada carro é diferente: faça a sua conta para ver a sua.' },
    { id: 'markup',
      k: 'markup|mark up|dealer price|dealership|why not a dealer|doc fee|instead of a dealer|margen|concesionari|agencia|en lugar de un dealer|concessionaria|revenda|loja|margem|lucro do dealer',
      en: 'Cars don\'t get better when dealers mark them up. At the auction you get the same cars dealers buy, without the dealer markup, and our whole fee costs less than a dealer\'s doc fee. You pick the car and set your max; we never go over.',
      es: 'Los autos no mejoran cuando los dealers les suben el precio. En la subasta tienes los mismos autos que compran los dealers, sin su margen, y nuestra tarifa completa cuesta menos que el doc fee de un dealer. Tú eliges el auto y fijas tu máximo; nunca lo pasamos.',
      pt: 'Carro não fica melhor quando o dealer aumenta o preço. No leilão você tem os mesmos carros que os dealers compram, sem a margem deles, e a nossa taxa inteira custa menos que o doc fee de um dealer. Você escolhe o carro e define o seu máximo; a gente nunca passa dele.' },
    { id: 'total', go: 'calc', sec: 'real-purchase', w: 1.2,
      k: 'total cost|all in|out the door|what costs|other costs|hidden|extra cost|extra fees|additional fees|auction fee|breakdown|costo total|costos|cargos|oculto|escondid|custo total|custos|cobrancas extras|taxa do leilao|tarifa de la subasta',
      en: 'You pay the winning bid plus the auction fee, purchase & title, and our service fee. Transport, taxes and registration vary by vehicle, location and state. Real example, 2021 BMW X3: auction purchase $17,900 + auction fee $650 + purchase & title $644 + service fee $900 = $20,094 all in. The calculator estimates this for your car.',
      es: 'Pagas la oferta ganadora más la tarifa de la subasta, compra y título, y nuestra tarifa de servicio. Transporte, impuestos y registro varían según el vehículo, el lugar y el estado. Ejemplo real, BMW X3 2021: compra en subasta $17,900 + tarifa de subasta $650 + compra y título $644 + tarifa de servicio $900 = $20,094 en total. La calculadora estima esto para tu auto.',
      pt: 'Você paga o lance vencedor mais a taxa do leilão, compra e título, e a nossa taxa de serviço. Transporte, impostos e emplacamento variam por veículo, localização e estado. Exemplo real, BMW X3 2021: compra no leilão $17.900 + taxa do leilão $650 + compra e título $644 + taxa de serviço $900 = $20.094 no total. A calculadora estima isso para o seu carro.' },
    { id: 'calc', go: 'calc',
      k: 'calculator|calculate|estimate|estimation|quote|simulat|run my numbers|my numbers|calculadora|calcular|estimado|cotiza|presupuesto|numeros|estimativa|cotacao|orcamento|simula',
      en: 'The calculator is a reference tool: you see an estimate of the total for your car, with the fees. The values are estimates, not an official quote, and create no purchase obligation. When you send it, a specialist follows up with you personally.',
      es: 'La calculadora es una herramienta de referencia: ves un estimado del total para tu auto, con las tarifas. Los valores son estimados, no una cotización oficial, y no crean obligación de compra. Cuando la envías, un especialista te atiende personalmente.',
      pt: 'A calculadora é uma ferramenta de referência: você vê uma estimativa do total para o seu carro, com as taxas. Os valores são estimativas, não um orçamento oficial, e não criam obrigação de compra. Quando você envia, um especialista te atende pessoalmente.' },
    { id: 'reference', sec: 'exemplos',
      k: 'reference|price guide|guide price|black book|book value|kbb|kelley|mmr|referencia|guia de precio|guia de preco|tabela',
      en: 'On the real examples, "reference" is the auction\'s own price guide for a car in that condition. It\'s not a price: the winning bid can come in above or below it. In the BMW X3 case we compare with the Black Book XClean retail reference ($25,800); the car cost $20,094 all in.',
      es: 'En los ejemplos reales, "referencia" es la guía de precios de la propia subasta para un auto en esa condición. No es un precio: la oferta ganadora puede quedar por encima o por debajo. En el caso del BMW X3 comparamos con la referencia minorista Black Book XClean ($25,800); el auto costó $20,094 en total.',
      pt: 'Nos exemplos reais, "referência" é o guia de preços do próprio leilão para um carro naquela condição. Não é um preço: o lance vencedor pode ficar acima ou abaixo. No caso do BMW X3 a gente compara com a referência de varejo Black Book XClean ($25.800); o carro custou $20.094 no total.' },
    { id: 'examples', go: 'calc', sec: 'exemplos',
      k: 'example|examples|real cars|what cars|which cars|cars do you have|inventory|stock|available|ejemplo|ejemplos|inventario|disponible|que autos|exemplo|exemplos|estoque|disponivel|que carros',
      en: 'New wholesale inventory comes in every day. Real examples that crossed our desk (auction reference, not a price):\n' + EXAMPLES_EN + '\nTell us the car you want and your max, and we scan the auctions for you.',
      es: 'Cada día entra inventario mayorista nuevo. Ejemplos reales que pasaron por nuestras manos (referencia de la subasta, no un precio):\n' + EXAMPLES_EN + '\nDinos el auto que quieres y tu máximo, y buscamos en las subastas por ti.',
      pt: 'Todo dia entra estoque novo de atacado. Exemplos reais que passaram pela nossa mesa (referência do leilão, não um preço):\n' + EXAMPLES_PT + '\nDiga o carro que você quer e o seu máximo, e a gente varre os leilões por você.' },
    { id: 'title', sec: 'politica', chip: { en: 'Clean title', es: 'Título limpio', pt: 'Título limpo' },
      k: 'salvage|rebuilt|clean title|title|tmu|flood|odometer|branded|titulo limpio|titulo|salvamento|reconstruido|odometro|inundad|titulo limpo|batido|recuperado',
      en: '{pol_2}', es: '{pol_2}', pt: '{pol_2}' },
    { id: 'carfax', sec: 'politica',
      k: 'carfax|autocheck|history|report|reports|accident|accidents|photos|pictures|vin|information|historial|informe|fotos|accidente|historico|laudo|acidente|informacoes|informacion',
      en: '{pol_1}\nYou review photos and condition info before we bid anything, and CARFAX as the deal advances.',
      es: '{pol_1}\nRevisas fotos e información del estado antes de cualquier oferta, y el CARFAX a medida que avanza el negocio.',
      pt: '{pol_1}\nVocê analisa fotos e informações da condição antes de qualquer lance, e o CARFAX conforme o negócio avança.' },
    { id: 'warranty', sec: 'politica',
      k: 'warranty|guarantee|guaranteed|service contract|protection|coverage|extended|garantia|cobertura|contrato de servicio|contrato de servico|protecao|proteccion',
      en: 'Auction vehicles are bought as-is, under the conditions disclosed by the auction.\n{pol_6}',
      es: 'Los vehículos de subasta se compran en el estado en que están, en las condiciones informadas por la subasta.\n{pol_6}',
      pt: 'Veículos de leilão são comprados no estado em que se encontram, nas condições informadas pelo leilão.\n{pol_6}' },
    { id: 'time', go: 'wa', chip: { en: 'How long?', es: '¿Cuánto tarda?', pt: 'Quanto tempo?' },
      k: 'how long|how many days|how many weeks|when will|time|timing|fast|quick|wait|soon|cuanto tiempo|cuantos dias|tiempo|demora|tarda|rapido|quanto tempo|quantos dias|prazo|prazos|demorar|leva quanto',
      en: 'New wholesale inventory comes in every day, so the search depends on the car and the max you set. After a purchase, timing varies with the auction, title release, location and destination, and title release and DMV processing can take time.',
      es: 'Cada día entra inventario mayorista nuevo, así que la búsqueda depende del auto y del máximo que fijes. Después de la compra, los plazos varían según la subasta, la liberación del título, el lugar y el destino, y la liberación del título y el trámite en el DMV pueden tomar tiempo.',
      pt: 'Todo dia entra estoque novo de atacado, então a busca depende do carro e do máximo que você definir. Depois da compra, os prazos variam conforme o leilão, a liberação do título, a localização e o destino, e a liberação do título e o processo no DMV podem levar tempo.' },
    { id: 'taxes', go: 'wa', sec: 'politica',
      k: 'tax|taxes|sales tax|registration|register|plates|plate|tag|tags|dmv|impuesto|impuestos|registro|placa|placas|imposto|impostos|emplacamento|licenciamento|emplacar',
      en: '{pol_5}', es: '{pol_5}', pt: '{pol_5}' },
    { id: 'where',
      k: 'where are you|located|location|florida|miami|nationwide|which states|my state|other state|another state|where|donde|ubicad|otro estado|estados|onde|localiza|outro estado|estados unidos',
      en: 'We\'re based in Florida and buy nationwide. Our real examples come from auctions in Central Florida, New Jersey, Milwaukee and the San Francisco Bay area. Pickup or delivery is coordinated based on the vehicle\'s location and your destination.',
      es: 'Estamos en Florida y compramos en todo el país. Nuestros ejemplos reales vienen de subastas en el centro de Florida, Nueva Jersey, Milwaukee y el área de la Bahía de San Francisco. La recogida o la entrega se coordina según dónde está el vehículo y tu destino.',
      pt: 'A gente fica na Flórida e compra em todo o país. Nossos exemplos reais vêm de leilões no centro da Flórida, em Nova Jersey, Milwaukee e na área da Baía de São Francisco. A retirada ou a entrega é coordenada conforme onde o veículo está e o seu destino.' },
    { id: 'language', go: 'wa',
      k: 'spanish|portuguese|english|language|languages|espanol|portugues|ingles|idioma|idiomas|lingua|habla|hablan|fala|falam|speak',
      en: '{lang_full}', es: '{lang_full}', pt: '{lang_full}' },
    { id: 'contact', go: 'wa', chip: { en: 'Talk to a person', es: 'Hablar con una persona', pt: 'Falar com uma pessoa' },
      k: 'whatsapp|phone|call|text|sms|contact|instagram|email|talk to|speak to|speak with|human|person|agent|specialist|someone|telefono|llamar|contacto|hablar con|persona|agente|especialista|alguien|telefone|ligar|contato|falar com|atendente|pessoa|alguem',
      en: 'WhatsApp: +1 305 540 0742\nText message: (305) 540-0742\nInstagram: @mycarscout\nA real person replies in English, Spanish or Portuguese.',
      es: 'WhatsApp: +1 305 540 0742\nMensaje de texto: (305) 540-0742\nInstagram: @mycarscout\nUna persona real responde en inglés, español o portugués.',
      pt: 'WhatsApp: +1 305 540 0742\nMensagem de texto: (305) 540-0742\nInstagram: @mycarscout\nUma pessoa de verdade responde em inglês, espanhol ou português.' },
    { id: 'trust', go: 'wa',
      k: 'legit|scam|trust|safe|reliable|fraud|is this real|estafa|fraude|confiable|es real|golpe|confiavel|confiar|e real|e seguro|es seguro',
      en: 'You stay in control at every step: you approve the specific car and authorize your max before any bid, and we never go over it. If we don\'t buy a car for you, you don\'t pay a service fee, and the deposit rules are written on the page. You can see a documented purchase (2021 BMW X3) and talk to a real person on WhatsApp.',
      es: 'Tú tienes el control en cada paso: apruebas el auto específico y autorizas tu máximo antes de cualquier oferta, y nunca lo pasamos. Si no compramos un auto para ti, no pagas tarifa de servicio, y las reglas del depósito están escritas en la página. Puedes ver una compra documentada (BMW X3 2021) y hablar con una persona real por WhatsApp.',
      pt: 'Você tem o controle em cada passo: aprova o carro específico e autoriza o seu máximo antes de qualquer lance, e a gente nunca passa dele. Se a gente não comprar um carro para você, você não paga taxa de serviço, e as regras do depósito estão escritas na página. Você pode ver uma compra documentada (BMW X3 2021) e falar com uma pessoa de verdade no WhatsApp.' },
    { id: 'mileage',
      k: 'mileage|miles|high mileage|low mileage|millaje|millas|kilometraje|quilometragem|milhas|kilometragem',
      en: 'You set the mileage you accept, together with the car, the budget and what matters to you. We only bid on vehicles with a documented actual odometer. Example: the 2021 BMW X3 from our documented case had 57,347 miles.',
      es: 'Tú defines el millaje que aceptas, junto con el auto, el presupuesto y lo que te importa. Solo ofertamos por vehículos con odómetro real documentado. Ejemplo: el BMW X3 2021 de nuestro caso documentado tenía 57,347 millas.',
      pt: 'Você define a quilometragem que aceita, junto com o carro, o orçamento e o que importa para você. A gente só dá lance em veículos com odômetro real documentado. Exemplo: o BMW X3 2021 do nosso caso documentado tinha 57.347 milhas.' },
    { id: 'auction', w: 0.6,
      k: 'auction|auctions|wholesale|dealer auction|manheim|adesa|closed to the public|public|subasta|subastas|mayorista|publico|leilao|leiloes|atacado|atacadista',
      en: 'Wholesale dealer auctions are closed to the public: 80K+ dealers bidding, 8M+ vehicles a year. My Car Scout opens them to you: the same cars dealers buy, without the dealer markup, purchased through a licensed dealer operation on your behalf.',
      es: 'Las subastas mayoristas de dealers están cerradas al público: más de 80 mil concesionarios ofertando, más de 8 millones de vehículos al año. My Car Scout te las abre: los mismos autos que compran los dealers, sin su margen, comprados a través de una operación con licencia de dealer en tu nombre.',
      pt: 'Os leilões de atacado de dealers são fechados ao público: mais de 80 mil concessionárias dando lance, mais de 8 milhões de veículos por ano. A My Car Scout abre esses leilões para você: os mesmos carros que os dealers compram, sem a margem deles, comprados através de uma operação com licença de dealer em seu nome.' },
    { id: 'about',
      k: 'who are you|what is my car scout|what is this|what do you do|about you|your company|quienes son|que es my car scout|que hacen|que es esto|quem sao|o que e a my car scout|o que voces fazem|o que e isso',
      en: 'My Car Scout searches wholesale dealer auctions and buys through a licensed dealer operation on your behalf. You pick the car and set your max; we never go over. Based in Florida, buying nationwide.',
      es: 'My Car Scout busca en subastas mayoristas de dealers y compra a través de una operación con licencia de dealer en tu nombre. Tú eliges el auto y fijas tu máximo; nunca lo pasamos. Estamos en Florida y compramos en todo el país.',
      pt: 'A My Car Scout busca em leilões de atacado de dealers e compra através de uma operação com licença de dealer em seu nome. Você escolhe o carro e define o seu máximo; a gente nunca passa dele. Sediada na Flórida, comprando em todo o país.' },
    { id: 'price', go: 'calc', sec: 'exemplos', w: 0.5,
      k: 'price|prices|how much|cost|costs|expensive|precio|precios|cuanto|cuesta|caro|preco|precos|quanto|custa|valor',
      en: 'It depends on the car, its condition and the auction. Auction references from real examples (not prices, the winning bid can come in above or below):\n' + EXAMPLES_EN + '\nFor your car, the calculator estimates the total with the fees.',
      es: 'Depende del auto, su condición y la subasta. Referencias de subasta de ejemplos reales (no son precios, la oferta ganadora puede quedar arriba o abajo):\n' + EXAMPLES_EN + '\nPara tu auto, la calculadora estima el total con las tarifas.',
      pt: 'Depende do carro, da condição e do leilão. Referências de leilão de exemplos reais (não são preços, o lance vencedor pode ficar acima ou abaixo):\n' + EXAMPLES_PT + '\nPara o seu carro, a calculadora estima o total com as taxas.' },
    { id: 'start', go: 'both',
      k: 'start|begin|get started|sign up|first step|next step|how do i buy|i want to buy|want a car|buy a car|interested|empezar|comenzar|iniciar|quiero comprar|primer paso|interesad|comecar|primeiro passo|quero comprar|interessad',
      en: 'Tell us the car and your max, and we handle the rest. The fastest first step is the calculator: you see your numbers and a specialist follows up personally. You can also write to us on WhatsApp.',
      es: 'Dinos el auto y tu máximo, y nosotros nos encargamos del resto. El primer paso más rápido es la calculadora: ves tus números y un especialista te atiende personalmente. También puedes escribirnos por WhatsApp.',
      pt: 'Diga o carro e o seu máximo, e a gente cuida do resto. O primeiro passo mais rápido é a calculadora: você vê seus números e um especialista te atende pessoalmente. Você também pode falar com a gente no WhatsApp.' },
    { id: 'hello', w: 0.4,
      k: 'hi|hello|hey|good morning|good afternoon|good evening|hola|buenos dias|buenas|oi|ola|bom dia|boa tarde|boa noite',
      en: 'Hi! Ask me anything about buying at the dealer auctions: fees, deposit, financing, title, delivery, timing.',
      es: '¡Hola! Pregúntame lo que quieras sobre comprar en las subastas de dealers: tarifas, depósito, financiamiento, título, entrega, plazos.',
      pt: 'Oi! Pode perguntar o que quiser sobre comprar nos leilões de dealers: taxas, depósito, financiamento, título, entrega, prazos.' },
    { id: 'thanks', w: 0.4,
      k: 'thank|thanks|thx|gracias|obrigad|valeu|perfect|great|okay|perfecto|perfeito|otimo',
      en: 'You\'re welcome! Anything else, just ask.', es: '¡Con gusto! Si tienes otra pregunta, aquí estoy.', pt: 'Imagina! Se tiver outra dúvida, é só perguntar.' }
  ];
  KB.forEach(function (entry) {
    entry.keys = entry.k ? entry.k.split('|') : [];
    if (entry.pair) entry.pair = entry.pair.map(function (list) { return list.split('|'); });
  });

  function lang() { var value = String(document.documentElement.lang || 'en').slice(0, 2); return TEXT[value] ? value : 'en'; }
  function t(key) { return TEXT[lang()][key] || TEXT.en[key]; }
  function fold(text) { return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function pageText(key) { var node = document.querySelector('[data-i18n="' + key + '"]'); return node ? node.textContent.replace(/\s+/g, ' ').trim() : ''; }
  // "DO I NEED A DEALER LICENSE?" -> "Do I need a dealer license?" (the page writes the questions in capitals)
  function sentence(text) {
    var lower = text.toLocaleLowerCase(lang());
    if (lang() === 'en') lower = lower.replace(/\bi\b/g, 'I');
    return lower.charAt(0).toLocaleUpperCase(lang()) + lower.slice(1);
  }
  function ctaText() { return pageText('cta_est') || 'RUN MY NUMBERS'; }
  function steps() {
    if (STEPS[lang()]) return STEPS[lang()];
    return Array.prototype.map.call(document.querySelectorAll('#como-funciona .step'), function (step) {
      var title = step.querySelector('.step-text p'), desc = step.querySelector('.step-desc');
      return [title ? title.textContent.trim() : '', desc ? desc.innerText.replace(/\s*\n\s*/g, '. ').trim() : ''];
    });
  }

  /* ---------- o personagem ---------- */
  function character(size, headOnly) {
    var id = 'sold' + Math.random().toString(36).slice(2, 8);
    var head =
      '<g class="sold-head">' +
        '<rect x="10" y="12" width="100" height="60" rx="24" fill="url(#' + id + 'w)"/>' +
        '<rect x="6" y="10" width="17" height="64" rx="8.5" fill="url(#' + id + 'c)"/>' +
        '<rect x="97" y="10" width="17" height="64" rx="8.5" fill="url(#' + id + 'c)"/>' +
        '<rect x="23" y="11" width="4.5" height="62" rx="2" fill="#c9a34e"/>' +
        '<rect x="92.5" y="11" width="4.5" height="62" rx="2" fill="#c9a34e"/>' +
        '<path d="M32 26 Q60 21 88 26 M30 62 Q60 67 90 62 M34 34 Q46 32 52 34" stroke="rgba(92,50,18,.28)" stroke-width="1.4" fill="none" stroke-linecap="round"/>' +
        '<rect x="32" y="16" width="56" height="7" rx="3.5" fill="rgba(255,255,255,.22)"/>' +
        '<path d="M40 31 Q47 27 54 30 M66 30 Q73 27 80 31" stroke="#3a1f0c" stroke-width="2.6" fill="none" stroke-linecap="round"/>' +
        '<g class="sold-eyes">' +
          '<ellipse cx="47" cy="41" rx="6" ry="7" fill="#fff"/><ellipse cx="73" cy="41" rx="6" ry="7" fill="#fff"/>' +
          '<circle cx="48" cy="42" r="3.4" fill="#1a1d21"/><circle cx="74" cy="42" r="3.4" fill="#1a1d21"/>' +
          '<circle cx="49.3" cy="40.4" r="1.2" fill="#fff"/><circle cx="75.3" cy="40.4" r="1.2" fill="#fff"/>' +
        '</g>' +
        '<ellipse cx="37" cy="53" rx="5.5" ry="3.2" fill="#e8835f" opacity=".42"/><ellipse cx="83" cy="53" rx="5.5" ry="3.2" fill="#e8835f" opacity=".42"/>' +
        '<path d="M49 52 Q60 63 71 52 Q60 57 49 52 Z" fill="#3a1f0c"/>' +
        '<path d="M53 56.5 Q60 60 67 56.5" stroke="#d9655a" stroke-width="2" fill="none" stroke-linecap="round"/>' +
      '</g>';
    var body =
      '<ellipse cx="60" cy="149" rx="26" ry="3.6" fill="rgba(0,0,0,.22)"/>' +
      '<g class="sold-body">' +
        '<rect x="50" y="74" width="9" height="64" rx="4.5" fill="#8a5226"/><rect x="61" y="74" width="9" height="64" rx="4.5" fill="#8a5226"/>' +
        '<rect x="48" y="70" width="24" height="52" rx="12" fill="url(#' + id + 'h)"/>' +
        '<ellipse cx="52" cy="142" rx="9.5" ry="5" fill="#4f2b12"/><ellipse cx="68" cy="142" rx="9.5" ry="5" fill="#4f2b12"/>' +
        '<g class="sold-arm-wave"><path d="M50 84 Q38 78 31 64" stroke="#9a5f2e" stroke-width="6.5" fill="none" stroke-linecap="round"/><circle cx="30" cy="61" r="6" fill="#c98a4f"/></g>' +
        '<path d="M70 86 Q80 94 85 104" stroke="#9a5f2e" stroke-width="6.5" fill="none" stroke-linecap="round"/><circle cx="86" cy="107" r="6" fill="#c98a4f"/>' +
        '<path d="M60 77 L47 70 L47 84 Z M60 77 L73 70 L73 84 Z" fill="#c9a34e" stroke="#7d612f" stroke-width="1.4" stroke-linejoin="round"/>' +
        '<circle cx="60" cy="77" r="3.6" fill="#a8873f" stroke="#7d612f" stroke-width="1.2"/>' +
      '</g>';
    var defs =
      '<defs>' +
        '<linearGradient id="' + id + 'w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfa86c"/><stop offset=".55" stop-color="#bd7d43"/><stop offset="1" stop-color="#8d5527"/></linearGradient>' +
        '<linearGradient id="' + id + 'c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7a4520"/><stop offset="1" stop-color="#4a2810"/></linearGradient>' +
        '<linearGradient id="' + id + 'h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#94592a"/><stop offset=".5" stop-color="#cc8f53"/><stop offset="1" stop-color="#8a5226"/></linearGradient>' +
      '</defs>';
    var viewBox = headOnly ? '4 6 112 72' : '0 4 120 150';
    return '<svg class="sold-figure" viewBox="' + viewBox + '" width="' + size + '" aria-hidden="true" focusable="false">' + defs + (headOnly ? '' : body) + head + '</svg>';
  }

  /* ---------- estilo ---------- */
  var css = [
    '.sold-launcher{position:fixed;right:10px;bottom:calc(158px + env(safe-area-inset-bottom,0px));z-index:71;width:66px;height:84px;padding:0;border:0;background:none;cursor:pointer;filter:drop-shadow(0 8px 12px rgba(0,0,0,.38));-webkit-tap-highlight-color:transparent}',
    '.sold-launcher .sold-figure{display:block;width:66px;height:auto;animation:sold-bob 3.4s ease-in-out infinite}',
    '.sold-launcher:hover .sold-arm-wave,.sold-launcher:focus-visible .sold-arm-wave{animation:sold-wave .9s ease-in-out 2}',
    '.sold-launcher:focus-visible{outline:2px solid #c9a34e;outline-offset:4px;border-radius:12px}',
    '.sold-launcher.hidden{display:none}',
    '.sold-arm-wave{transform-box:view-box;transform-origin:50px 84px}',
    '.sold-eyes{transform-box:view-box;transform-origin:60px 41px;animation:sold-blink 5s infinite}',
    '.sold-head{transform-box:view-box;transform-origin:60px 72px}',
    '.sold-tap .sold-head{animation:sold-tap .5s ease-out}',
    '@keyframes sold-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}',
    '@keyframes sold-wave{0%,100%{transform:rotate(0)}30%{transform:rotate(-16deg)}70%{transform:rotate(12deg)}}',
    '@keyframes sold-blink{0%,94%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}',
    '@keyframes sold-tap{0%{transform:rotate(0)}35%{transform:rotate(-18deg)}60%{transform:rotate(6deg)}100%{transform:rotate(0)}}',
    '.sold-teaser{position:fixed;right:82px;bottom:calc(196px + env(safe-area-inset-bottom,0px));z-index:71;max-width:230px;background:#fff;color:#0b0d10;border:1px solid rgba(201,163,78,.55);border-radius:14px 14px 4px 14px;padding:11px 30px 11px 13px;font:600 14px/1.35 "Barlow",system-ui,sans-serif;box-shadow:0 10px 26px rgba(0,0,0,.28);cursor:pointer;animation:sold-pop .35s ease-out}',
    '.sold-teaser button{position:absolute;top:4px;right:4px;width:24px;height:24px;border:0;background:none;color:#5a5f66;font-size:16px;line-height:1;cursor:pointer}',
    '@keyframes sold-pop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}',
    '.sold-panel{position:fixed;right:14px;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:150;width:min(380px,calc(100vw - 28px));max-height:min(620px,calc(100vh - 40px));display:flex;flex-direction:column;background:#f6f3ec;border:1px solid rgba(201,163,78,.45);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.42);overflow:hidden;font-family:"Barlow",system-ui,sans-serif;animation:sold-pop .25s ease-out}',
    '.sold-panel[hidden]{display:none}',
    '.sold-top{display:flex;align-items:center;gap:10px;padding:10px 12px;background:linear-gradient(176deg,#1d2025 0%,#0b0c0e 100%);color:#f2efe9;border-bottom:1px solid rgba(201,163,78,.4)}',
    '.sold-top .sold-figure{width:46px;height:auto;flex:0 0 auto}',
    '.sold-top strong{display:block;font-size:17px;letter-spacing:.06em;color:#c9a34e}',
    '.sold-top span{display:block;font-size:12.5px;color:rgba(242,239,233,.75)}',
    '.sold-x{margin-left:auto;width:34px;height:34px;border-radius:50%;border:1px solid rgba(242,239,233,.25);background:none;color:#f2efe9;font-size:18px;cursor:pointer}',
    '.sold-log{flex:1 1 auto;overflow-y:auto;padding:14px 12px 6px;display:flex;flex-direction:column;gap:8px}',
    '.sold-msg{max-width:88%;padding:10px 12px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-line;overflow-wrap:anywhere}',
    '.sold-msg.bot{align-self:flex-start;background:#fff;color:#1a1d21;border:1px solid #e4dccb;border-bottom-left-radius:4px}',
    '.sold-msg.me{align-self:flex-end;background:#1a1d21;color:#f2efe9;border-bottom-right-radius:4px}',
    '.sold-steps{margin:6px 0 0;padding-left:18px}.sold-steps li{margin:4px 0}.sold-steps b{font-weight:700}.sold-steps small{display:block;color:#5a5f66;font-size:13px}',
    '.sold-cta{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;margin:2px 0 4px;padding:11px 16px;border:0;border-radius:10px;background:linear-gradient(180deg,#d8b65f 0%,#c9a34e 55%,#a8873f 100%);color:#111;font:800 14.5px/1 "Barlow",system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 0 #7d612f,0 8px 16px rgba(0,0,0,.2)}',
    '.sold-cta:active{transform:translateY(3px);box-shadow:0 1px 0 #7d612f}',
    '.sold-link{align-self:flex-start;font-size:14px;font-weight:700;color:#1a7f4b;text-decoration:none;padding:4px 2px}',
    '.sold-page{color:#7d612f;padding-top:0}',
    '.sold-chips{flex:0 0 auto;display:flex;flex-wrap:nowrap;gap:6px;padding:6px 12px 10px;overflow-x:auto;scrollbar-width:thin;-webkit-overflow-scrolling:touch;border-top:1px solid #e4dccb;mask-image:linear-gradient(90deg,#000 88%,transparent)}',
    '.sold-chip{flex:0 0 auto;white-space:nowrap;border:1px solid #d9cfb9;background:#fff;color:#1a1d21;border-radius:999px;padding:7px 11px;font:600 13px/1.2 "Barlow",system-ui,sans-serif;cursor:pointer}',
    '.sold-chip:hover{border-color:#c9a34e}',
    '.sold-form{flex:0 0 auto;display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e4dccb;background:#fbf9f4}',
    '.sold-form input{flex:1 1 auto;min-width:0;border:1px solid #d9cfb9;border-radius:10px;padding:10px 11px;font:500 15px "Barlow",system-ui,sans-serif;background:#fff;color:#1a1d21}',
    '.sold-form button{border:0;border-radius:10px;padding:0 14px;background:#1a1d21;color:#f2efe9;font:700 14px "Barlow",system-ui,sans-serif;cursor:pointer}',
    '.sold-stamp{position:fixed;left:50%;top:42%;z-index:160;transform:translate(-50%,-50%) rotate(-12deg);padding:10px 26px;border:5px solid #9b1b23;border-radius:12px;color:#9b1b23;font:900 44px/1 "Barlow",system-ui,sans-serif;letter-spacing:.08em;background:rgba(255,255,255,.85);pointer-events:none;animation:sold-stamp .9s ease-out forwards}',
    '@keyframes sold-stamp{0%{opacity:0;transform:translate(-50%,-50%) rotate(-12deg) scale(2.2)}25%{opacity:1;transform:translate(-50%,-50%) rotate(-12deg) scale(.95)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) rotate(-12deg) scale(1)}}',
    '@media (max-width:820px){.sold-panel{right:0;left:0;bottom:0;width:100%;max-height:82vh;border-radius:18px 18px 0 0}}',
    /* computador: o WhatsApp fica no canto (22px); o Sold fica logo acima dele, centrado no mesmo eixo */
    '@media (min-width:821px){.sold-launcher{right:11px;bottom:74px}.sold-teaser{bottom:112px}}',
    '@media (prefers-reduced-motion:reduce){.sold-launcher .sold-figure,.sold-eyes,.sold-arm-wave,.sold-panel,.sold-teaser{animation:none!important}}'
  ].join('\n');

  /* ---------- montagem ---------- */
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'sold-launcher';
  launcher.innerHTML = character(66, false);

  var panel = document.createElement('section');
  panel.className = 'sold-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.innerHTML =
    '<header class="sold-top">' + character(46, true) + '<div><strong>SOLD</strong><span class="sold-tag"></span></div>' +
    '<button type="button" class="sold-x" aria-label="">×</button></header>' +
    '<div class="sold-log" aria-live="polite"></div>' +
    '<div class="sold-chips"></div>' +
    '<form class="sold-form"><input type="text" maxlength="200" autocomplete="off"><button type="submit"></button></form>';

  var log = panel.querySelector('.sold-log'), chips = panel.querySelector('.sold-chips'), form = panel.querySelector('.sold-form'), input = form.querySelector('input');

  function labels() {
    launcher.setAttribute('aria-label', t('open'));
    panel.setAttribute('aria-label', 'Sold · ' + t('tagline'));
    panel.querySelector('.sold-tag').textContent = t('tagline');
    panel.querySelector('.sold-x').setAttribute('aria-label', t('close'));
    input.placeholder = t('ask');
    input.setAttribute('aria-label', t('ask'));
    form.querySelector('button').textContent = t('send');
  }

  function scrollDown() { log.scrollTop = log.scrollHeight; }
  function say(text, who) {
    var node = document.createElement('div');
    node.className = 'sold-msg ' + (who || 'bot');
    node.textContent = text;
    log.appendChild(node);
    scrollDown();
    return node;
  }
  function cta() {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'sold-cta';
    button.textContent = ctaText();
    button.addEventListener('click', goCalculator);
    log.appendChild(button);
    scrollDown();
  }
  function whatsappLink() {
    var link = document.createElement('a');
    link.className = 'sold-link';
    link.href = WHATSAPP;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = t('whatsapp') + ' →';
    log.appendChild(link);
    scrollDown();
  }

  function answerHow() {
    var node = say(t('howIntro'));
    var list = document.createElement('ol');
    list.className = 'sold-steps';
    steps().forEach(function (step) {
      var item = document.createElement('li'), title = document.createElement('b');
      title.textContent = sentence(step[0]);
      item.appendChild(title);
      if (step[1]) { var small = document.createElement('small'); small.textContent = step[1]; item.appendChild(small); }
      list.appendChild(item);
    });
    node.appendChild(list);
    scrollDown();
  }

  /* A taxa de serviço da tabela da página, para um lance vencedor. */
  var TIERS = [[3000, 300, 0], [5000, 400, 3001], [7500, 550, 5001], [10000, 650, 7501], [15000, 750, 10001], [20000, 900, 15001]];
  function money(value) { return '$' + Math.round(value).toLocaleString(lang() === 'pt' ? 'pt-BR' : 'en-US'); }
  function fill(text, values) { return text.replace(/\{(\w+)\}/g, function (all, key) { return key in values ? values[key] : all; }); }
  function feeFor(bid) {
    for (var i = 0; i < TIERS.length; i++) if (bid <= TIERS[i][0]) return { fee: TIERS[i][1], from: TIERS[i][2], to: TIERS[i][0] };
    var extra = Math.ceil((bid - 20000) / 2500);
    return { fee: 900 + 50 * extra, extra: extra };
  }
  function answerFee(bid) {
    var tier = feeFor(bid), lines = [fill(t('feeIs'), { bid: money(bid), fee: money(tier.fee) })];
    if (tier.extra) lines.push(fill(t('feeAbove'), { n: tier.extra }));
    else lines.push(fill(t('feeTier'), { from: tier.from ? money(tier.from) : '$0', to: money(tier.to) }));
    lines.push(t('feeEnd'));
    say(lines.join('\n'));
  }
  // "$12,000", "12.000", "12000", "12k", "12 mil" -> 12000 (anos como 2019 não contam)
  function amountIn(text) {
    var match = String(text).match(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k\b|mil\b)?/i);
    if (!match) return null;
    var raw = match[1], value;
    if (/^\d{1,3}([.,]\d{3})+$/.test(raw)) value = Number(raw.replace(/[.,]/g, ''));
    else value = Number(raw.replace(',', '.'));
    if (match[2]) value *= 1000;
    if (!isFinite(value) || value < 100 || value > 1000000) return null;
    if (!match[2] && /^(19|20)\d\d$/.test(raw) && !/\$/.test(text)) return null;
    return value;
  }

  function dot(text) { text = String(text || '').trim(); return text && !/[.!?:)]$/.test(text) ? text + '.' : text; }
  // {pol_2}, {a7}...: o texto da própria página, no idioma escolhido.
  function compose(text) {
    return text.split('\n').map(function (line) {
      return line.replace(/\{(\w+)\}/g, function (all, key) { return dot(pageText(key)); });
    }).filter(Boolean).join('\n');
  }
  function sectionLink(id) {
    var link = document.createElement('a');
    link.className = 'sold-link sold-page';
    link.href = '#' + id;
    link.textContent = t('page') + ' →';
    link.addEventListener('click', function (event) {
      var target = document.getElementById(id);
      if (!target) return;
      event.preventDefault();
      if (window.matchMedia('(max-width:820px)').matches) close();
      target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    });
    log.appendChild(link);
    scrollDown();
  }

  var lastId = null;
  function answer(result) {
    var entry = result && result.entry;
    if (result && result.fee) { answerFee(result.fee); sectionLink('taxas'); lastId = 'fees'; return; }
    if (!entry) { say(t('fallback')); whatsappLink(); lastId = null; return; }
    lastId = entry.id;
    if (entry.special === 'how') answerHow();
    else if (entry[lang()]) say(compose(entry[lang()]));
    else if (entry.faq) say(dot(pageText('a' + entry.faq)) || t('fallback'));
    if (entry.go === 'calc' || entry.go === 'both') cta();
    if (entry.go === 'wa' || entry.go === 'both') whatsappLink();
    if (entry.sec) sectionLink(entry.sec);
  }

  /* A pergunta digitada: cada assunto soma pontos pelas palavras que aparecem (expressões de várias palavras valem
     mais); ganha o de mais pontos, e no empate o que vem antes na lista (o mais específico). */
  function has(value, word) {
    var at = value.indexOf(' ' + word);
    if (at === -1) return false;
    return word.length > 4 || value.charAt(at + word.length + 1) === ' ';
  }
  function classify(text) {
    var value = ' ' + fold(text).replace(/['’`]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
    var bid = amountIn(text);
    var feeWord = /\b(fee|fees|charge|commission|tarifa|comision|cobr\w*|taxa|comissao)\b/.test(value);
    // depois da tabela de taxas, um valor sozinho ("12k", "e 25000?") já é a pergunta da taxa
    var justAmount = value.replace(/\b(\d+k?|k|mil|for|para|de|e|y|and|what|about|o|a|um|una|uno|bid|lance|oferta)\b/g, ' ').trim() === '';
    if (bid && (feeWord || (lastId === 'fees' && justAmount))) return { id: 'fee', fee: bid };
    var best = null, top = 0;
    KB.forEach(function (entry) {
      var score = 0;
      entry.keys.forEach(function (word) { if (has(value, word)) score += word.split(' ').length; });
      if (entry.pair && entry.pair.every(function (list) { return list.some(function (word) { return has(value, word); }); })) score += 3;
      score *= entry.w || 1;
      if (score > top) { top = score; best = entry; }
    });
    return best ? { id: best.id, entry: best } : null;
  }

  function renderChips() {
    chips.innerHTML = '';
    KB.filter(function (entry) { return entry.chip; }).forEach(function (entry) {
      var label = typeof entry.chip === 'string' ? sentence(pageText(entry.chip)) : (entry.chip[lang()] || entry.chip.en);
      if (!label) return;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sold-chip';
      chip.textContent = label;
      chip.addEventListener('click', function () { say(label, 'me'); answer({ id: entry.id, entry: entry }); });
      chips.appendChild(chip);
    });
  }

  var greeted = false;
  function greet() {
    if (greeted) return;
    greeted = true;
    say(t('hello'));
    say(t('first'));
    cta();
  }

  var lastFocus = null;
  function open() {
    hideTeaser(true);
    labels();
    renderChips();
    lastFocus = document.activeElement;
    panel.hidden = false;
    launcher.classList.add('hidden');
    greet();
    setTimeout(function () { input.focus({ preventScroll: true }); }, 60);
  }
  function close() {
    panel.hidden = true;
    launcher.classList.remove('hidden');
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); else launcher.focus({ preventScroll: true });
  }

  /* "RUN MY NUMBERS": o martelo bate, carimba SOLD e a página desce até a calculadora. */
  function goCalculator() {
    close();
    var target = document.querySelector(CALC);
    if (!reduced) {
      launcher.classList.add('sold-tap');
      setTimeout(function () { launcher.classList.remove('sold-tap'); }, 600);
      var stamp = document.createElement('div');
      stamp.className = 'sold-stamp';
      stamp.textContent = t('sold');
      document.body.appendChild(stamp);
      setTimeout(function () { stamp.remove(); }, 950);
    }
    if (target) target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    try { if (history.replaceState) history.replaceState(null, '', CALC); } catch (_) {}
  }

  /* ---------- o recado inicial ---------- */
  var teaser = null;
  function calculatorInView() {
    var target = document.querySelector(CALC);
    if (!target) return false;
    var box = target.getBoundingClientRect();
    return box.top < window.innerHeight * 0.7 && box.bottom > window.innerHeight * 0.3;
  }
  function showTeaser() {
    var seen = false;
    try { seen = sessionStorage.getItem('mcs_sold_teaser') === '1'; } catch (_) {}
    if (seen || !panel.hidden || calculatorInView() || document.querySelector('.sheet.open, .sheet[style*="block"]')) return;
    teaser = document.createElement('div');
    teaser.className = 'sold-teaser';
    teaser.setAttribute('role', 'status');
    teaser.textContent = t('teaser');
    var dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', t('close'));
    dismiss.textContent = '×';
    dismiss.addEventListener('click', function (event) { event.stopPropagation(); hideTeaser(true); });
    teaser.appendChild(dismiss);
    teaser.addEventListener('click', open);
    document.body.appendChild(teaser);
    try { sessionStorage.setItem('mcs_sold_teaser', '1'); } catch (_) {}
    setTimeout(function () { hideTeaser(false); }, 12000);
  }
  function hideTeaser() { if (teaser) { teaser.remove(); teaser = null; } }

  /* ---------- eventos ---------- */
  launcher.addEventListener('click', open);
  panel.querySelector('.sold-x').addEventListener('click', close);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !panel.hidden) close(); });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    say(text, 'me');
    answer(classify(text));
  });
  // The visitor changed the language: the next texts follow (what was already said stays).
  new MutationObserver(function () { labels(); if (!panel.hidden) renderChips(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  function mount() {
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    labels();
    setTimeout(showTeaser, 9000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  window.MCSSold = { classify: classify, open: open, close: close };
})();
