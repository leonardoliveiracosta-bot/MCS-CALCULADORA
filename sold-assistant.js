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
  var SMS = 'sms:+13055400742';
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
      sold: 'SOLD!',
      waButton: 'WhatsApp',
      smsButton: 'Text message',
      prefill: "Hi! I came from the My Car Scout site and I want to buy a car at the dealer auctions.",
      prefillQ: 'My question: {q}',
      feeHook: "That's the whole service fee, and you only pay it if we buy your car. See your full total in the calculator."
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
      sold: '¡VENDIDO!',
      waButton: 'WhatsApp',
      smsButton: 'Mensaje de texto',
      prefill: '¡Hola! Vengo del sitio de My Car Scout y quiero comprar un auto en las subastas de dealers.',
      prefillQ: 'Mi pregunta: {q}',
      feeHook: 'Esa es toda la tarifa de servicio, y solo la pagas si compramos tu auto. Mira tu total completo en la calculadora.'
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
      sold: 'VENDIDO!',
      waButton: 'WhatsApp',
      smsButton: 'Mensagem de texto (SMS)',
      prefill: 'Oi! Vim do site da My Car Scout e quero comprar um carro nos leilões de dealers.',
      prefillQ: 'Minha dúvida: {q}',
      feeHook: 'Essa é a taxa de serviço inteira, e você só paga se a gente comprar o seu carro. Veja o seu total completo na calculadora.'
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
    /* Estoque: a gente não tem estoque. A mesma resposta da primeira mensagem do WhatsApp (whatsapp-auto-reply.js):
       serviço de compra em leilão, carros entram e saem todo dia, cada um tem data de leilão, e a gente caça o carro
       específico a partir do carro e do orçamento da pessoa. */
    { id: 'inventory', go: 'both', chip: { en: 'Do you have stock?', es: '¿Tienen inventario?', pt: 'Vocês têm estoque?' },
      k: 'inventory|in stock|stock|do you have|which cars|what cars|cars are available|quais carros|que carros|que autos|what do you have|what cars do you have|cars do you have|cars available|available cars|whats available|show me cars|show me the cars|see the cars|list of cars|catalog|showroom|inventario|tienen autos|tienen carros|que tienen|que autos tienen|autos disponibles|carros disponibles|catalogo|lista de autos|estoque|tem carro|voces tem|vcs tem|o que voces tem|que carros voces tem|carros disponiveis|vitrine|fotos dos carros|lista de carros|ver os carros',
      en: 'We don\'t sell from our own inventory. We offer an auction buying service through dealer wholesale auctions: you choose the car and set your limit, we handle the purchase.\nDifferent cars come in and go out every day, and every car has an auction date: once it sells, it\'s gone. So we start with the car you want and your budget, and we hunt that specific car for you.',
      es: 'No vendemos de un inventario propio. Ofrecemos un servicio de compra en las subastas mayoristas de dealers: tú eliges el auto y fijas tu límite, nosotros hacemos la compra.\nCada día entran y salen autos distintos, y cada auto tiene su fecha de subasta: cuando se vende, ya no está. Por eso empezamos por el auto que quieres y tu presupuesto, y buscamos ese auto específico para ti.',
      pt: 'A gente não vende de um estoque próprio. A gente oferece um serviço de compra nos leilões de atacado de dealers: você escolhe o carro e define o seu limite, a gente cuida da compra.\nCarros diferentes entram e saem todo dia, e cada carro tem a sua data de leilão: depois que vende, acabou. Por isso a gente começa pelo carro que você quer e pelo seu orçamento, e caça esse carro específico para você.' },
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
      k: 'example|examples|real cars|real examples|past purchases|cars you bought|ejemplo|ejemplos|autos reales|exemplo|exemplos|carros reais|ja compraram',
      en: 'Different cars come in and go out every day. Real examples that crossed our desk (auction reference, not a price):\n' + EXAMPLES_EN + '\nTell us the car you want and your max, and we scan the auctions for you.',
      es: 'Cada día entran y salen autos distintos. Ejemplos reales que pasaron por nuestras manos (referencia de la subasta, no un precio):\n' + EXAMPLES_EN + '\nDinos el auto que quieres y tu máximo, y buscamos en las subastas por ti.',
      pt: 'Carros diferentes entram e saem todo dia. Exemplos reais que passaram pela nossa mesa (referência do leilão, não um preço):\n' + EXAMPLES_PT + '\nDiga o carro que você quer e o seu máximo, e a gente varre os leilões por você.' },
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
      en: 'Different cars come in and go out of the auctions every day, so the search depends on the car and the max you set. After a purchase, timing varies with the auction, title release, location and destination, and title release and DMV processing can take time.',
      es: 'Cada día entran y salen autos distintos de las subastas, así que la búsqueda depende del auto y del máximo que fijes. Después de la compra, los plazos varían según la subasta, la liberación del título, el lugar y el destino, y la liberación del título y el trámite en el DMV pueden tomar tiempo.',
      pt: 'Carros diferentes entram e saem dos leilões todo dia, então a busca depende do carro e do máximo que você definir. Depois da compra, os prazos variam conforme o leilão, a liberação do título, a localização e o destino, e a liberação do título e o processo no DMV podem levar tempo.' },
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
    { id: 'contact', go: 'contact', chip: { en: 'Talk to a person', es: 'Hablar con una persona', pt: 'Falar com uma pessoa' },
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
  /* O gancho: depois de esclarecer, uma linha que deixa a pessoa mais perto do carro que ela quer. Só com o que o
     site garante (mesmos carros dos dealers, sem a margem deles, o máximo é dela, sem compra não há taxa, carros
     diferentes todo dia); nunca promete preço, prazo ou aprovação. [en, es, pt] */
  var HOOK = {
    how: ['You\'re one message away from step 1. Tell us the car and your max, and we start scanning the auctions for you.',
      'Estás a un mensaje del paso 1. Dinos el auto y tu máximo, y empezamos a buscar en las subastas por ti.',
      'Você está a uma mensagem do passo 1. Diga o carro e o seu máximo, e a gente começa a varrer os leilões por você.'],
    inventory: ['Your budget sets the target. Which car is it?',
      'Tu presupuesto define el objetivo. ¿Qué auto es?',
      'O seu orçamento define o alvo. Qual é o carro?'],
    fees: ['No car bought, no service fee. Want the exact fee for your budget? Type an amount, like 15000.',
      'Sin compra, no hay tarifa de servicio. ¿Quieres la tarifa exacta para tu presupuesto? Escribe un monto, como 15000.',
      'Sem compra, sem taxa de serviço. Quer a taxa exata para o seu orçamento? Digite um valor, como 15000.'],
    shipcost: ['Pickup or delivery, the car comes to you. See your total with the calculator.',
      'Recogida o entrega, el auto llega a ti. Mira tu total con la calculadora.',
      'Retirada ou entrega, o carro chega até você. Veja o seu total na calculadora.'],
    depositAmount: ['The deposit is what turns your search into a real bid on the car you approved.',
      'El depósito es lo que convierte tu búsqueda en una oferta real por el auto que aprobaste.',
      'O depósito é o que transforma a sua busca num lance de verdade pelo carro que você aprovou.'],
    refund: ['Written rules, and you approve every step. Ready to see what your car would cost?',
      'Reglas escritas, y tú apruebas cada paso. ¿Listo para ver cuánto costaría tu auto?',
      'Regras escritas, e você aprova cada passo. Pronto para ver quanto sairia o seu carro?'],
    backout: ['You only commit to a car you already reviewed and approved. See your numbers first, with no obligation.',
      'Solo te comprometes con un auto que ya revisaste y aprobaste. Mira tus números primero, sin obligación.',
      'Você só se compromete com um carro que já analisou e aprovou. Veja seus números antes, sem obrigação.'],
    deposit: ['It\'s the step that puts your max on the table for the car you chose. Want to see your total before it?',
      'Es el paso que pone tu máximo sobre la mesa por el auto que elegiste. ¿Quieres ver tu total antes?',
      'É o passo que coloca o seu máximo na mesa pelo carro que você escolheu. Quer ver o seu total antes?'],
    lose: ['Different cars come in every day, so there\'s always a next chance. What car should we go after?',
      'Cada día entran autos distintos, siempre hay una próxima oportunidad. ¿Qué auto buscamos?',
      'Todo dia entram carros diferentes, sempre tem uma próxima chance. Qual carro a gente vai buscar?'],
    decide: ['You set the ceiling, we fight for the car below it. What car and what max do you have in mind?',
      'Tú pones el techo, nosotros peleamos por el auto debajo de él. ¿Qué auto y qué máximo tienes en mente?',
      'Você define o teto, a gente briga pelo carro abaixo dele. Qual carro e qual máximo você tem em mente?'],
    license: ['No license needed: you get in through the same door dealers use. What car do you want?',
      'No necesitas licencia: entras por la misma puerta que los dealers. ¿Qué auto quieres?',
      'Sem licença: você entra pela mesma porta dos dealers. Qual carro você quer?'],
    choose: ['You choose the car, we do the hunting. Which one is it?',
      'Tú eliges el auto, nosotros lo cazamos. ¿Cuál es?',
      'Você escolhe o carro, a gente vai atrás. Qual é?'],
    after: ['From the winning bid to pickup or delivery, you\'re not alone. Want to see the full cost up front?',
      'Desde la oferta ganadora hasta la recogida o la entrega, no estás solo. ¿Quieres ver el costo completo desde ya?',
      'Do lance vencedor até a retirada ou a entrega, você não fica sozinho. Quer ver o custo completo desde já?'],
    testdrive: ['You decide with photos and condition info before any bid, and never pay above your max. Which car should we look for?',
      'Decides con fotos e información del estado antes de cualquier oferta, y nunca pagas más que tu máximo. ¿Qué auto buscamos?',
      'Você decide com fotos e informações da condição antes de qualquer lance, e nunca paga acima do seu máximo. Qual carro a gente procura?'],
    inspection: ['You see the condition before we bid a cent, so you decide with your eyes open. What car are you after?',
      'Ves el estado antes de que ofertemos un centavo, así decides con los ojos abiertos. ¿Qué auto buscas?',
      'Você vê a condição antes de qualquer centavo de lance, e decide de olhos abertos. Qual carro você procura?'],
    receive: ['Pick it up or have it shipped: either way, it\'s yours. Ready to see your numbers?',
      'Lo recoges o te lo enviamos: de cualquier forma, es tuyo. ¿Listo para ver tus números?',
      'Você retira ou a gente ajuda a enviar: de um jeito ou de outro, é seu. Pronto para ver seus números?'],
    finance: ['Financing the wholesale price instead of the dealer price can make the payment lighter. Tell us the car you want.',
      'Financiar el precio mayorista en vez del precio del dealer puede aliviar la cuota. Dinos el auto que quieres.',
      'Financiar o preço de atacado em vez do preço do dealer pode deixar a parcela mais leve. Diga o carro que você quer.'],
    pay: ['Your deposit counts toward the car, so nothing is wasted. A specialist walks you through it on WhatsApp.',
      'Tu depósito cuenta para el auto, nada se pierde. Un especialista te guía por WhatsApp.',
      'O seu depósito conta para o carro, nada se perde. Um especialista te acompanha no WhatsApp.'],
    bid: ['Live bidding, your rules. Which car should we bid on for you?',
      'Oferta en vivo, con tus reglas. ¿Por qué auto ofertamos por ti?',
      'Lance ao vivo, com as suas regras. Em qual carro a gente dá o lance por você?'],
    save: ['That\'s money that stays with you, not with a dealer. What could it be on your car?',
      'Ese dinero se queda contigo, no con un dealer. ¿Cuánto sería en tu auto?',
      'É dinheiro que fica com você, não com o dealer. Quanto seria no seu carro?'],
    markup: ['Same cars, without the markup. Want to see what that means on the car you want?',
      'Los mismos autos, sin el margen. ¿Quieres ver qué significa eso en el auto que quieres?',
      'Os mesmos carros, sem a margem. Quer ver o que isso significa no carro que você quer?'],
    total: ['You see every line before you decide. Run your numbers for the car you want.',
      'Ves cada línea antes de decidir. Calcula tus números para el auto que quieres.',
      'Você vê cada linha antes de decidir. Faça a conta do carro que você quer.'],
    calc: ['No obligation, and you see the whole picture. Try it now.',
      'Sin obligación, y ves el panorama completo. Pruébala ahora.',
      'Sem obrigação, e você vê o quadro completo. Experimente agora.'],
    reference: ['References help you set a smart max, and you decide where to stop. See the total for yours.',
      'Las referencias te ayudan a fijar un máximo inteligente, y tú decides dónde parar. Mira el total del tuyo.',
      'As referências ajudam você a definir um máximo inteligente, e você decide onde parar. Veja o total do seu.'],
    examples: ['Your car could be the next one on this list. Which one do you want?',
      'Tu auto puede ser el próximo de esta lista. ¿Cuál quieres?',
      'O seu carro pode ser o próximo desta lista. Qual você quer?'],
    title: ['That filter runs before you even see a car. What are you looking for?',
      'Ese filtro se aplica antes de que veas un auto. ¿Qué buscas?',
      'Esse filtro vem antes de você ver qualquer carro. O que você procura?'],
    carfax: ['You see the facts before you commit. What car should we look for?',
      'Ves los datos antes de comprometerte. ¿Qué auto buscamos?',
      'Você vê os fatos antes de se comprometer. Qual carro a gente procura?'],
    warranty: ['Knowing exactly what you\'re buying is your best protection, and you review every car before any bid. Which car do you want?',
      'Saber exactamente qué compras es tu mejor protección, y revisas cada auto antes de cualquier oferta. ¿Qué auto quieres?',
      'Saber exatamente o que você está comprando é a sua melhor proteção, e você analisa cada carro antes de qualquer lance. Qual carro você quer?'],
    time: ['The sooner we know your car and your max, the sooner we start bidding. What are you looking for?',
      'Cuanto antes sepamos tu auto y tu máximo, antes empezamos a ofertar. ¿Qué buscas?',
      'Quanto antes a gente souber o carro e o seu máximo, antes começa a dar lance. O que você procura?'],
    taxes: ['A specialist goes over your state with you, so you know the full cost before deciding.',
      'Un especialista revisa tu estado contigo, para que sepas el costo completo antes de decidir.',
      'Um especialista vê o seu estado com você, para você saber o custo completo antes de decidir.'],
    where: ['We buy nationwide, so distance doesn\'t limit your options. What car do you want?',
      'Compramos en todo el país, la distancia no limita tus opciones. ¿Qué auto quieres?',
      'A gente compra no país todo, a distância não limita as suas opções. Qual carro você quer?'],
    language: ['Talk in the language you\'re most comfortable with. A specialist is one message away.',
      'Habla en el idioma que te quede más cómodo. Un especialista está a un mensaje.',
      'Fale no idioma em que você se sente melhor. Um especialista está a uma mensagem.'],
    contact: ['Tell us the car you want in your first message, and we get started faster.',
      'Dinos el auto que quieres en tu primer mensaje, y empezamos más rápido.',
      'Diga o carro que você quer já na primeira mensagem, e a gente começa mais rápido.'],
    trust: ['Don\'t take our word for it: see the documented BMW X3 case and ask us anything on WhatsApp.',
      'No te quedes con nuestra palabra: mira el caso documentado del BMW X3 y pregúntanos lo que quieras por WhatsApp.',
      'Não fique só na nossa palavra: veja o caso documentado do BMW X3 e pergunte o que quiser no WhatsApp.'],
    mileage: ['Tell us your limit and we filter the auctions for you. What car, and up to how many miles?',
      'Dinos tu límite y filtramos las subastas por ti. ¿Qué auto, y hasta cuántas millas?',
      'Diga o seu limite e a gente filtra os leilões por você. Qual carro, e até quantas milhas?'],
    auction: ['Those doors are open to you now. Which car do you want?',
      'Esas puertas ahora están abiertas para ti. ¿Qué auto quieres?',
      'Essas portas agora estão abertas para você. Qual carro você quer?'],
    about: ['Ready to buy where dealers buy? Tell us the car.',
      '¿Listo para comprar donde compran los dealers? Dinos el auto.',
      'Pronto para comprar onde os dealers compram? Diga o carro.'],
    price: ['The best way to know your price is your own numbers. Run them now.',
      'La mejor forma de saber tu precio son tus propios números. Calcúlalos ahora.',
      'O melhor jeito de saber o seu preço são os seus números. Faça a conta agora.'],
    start: ['Today is a good day to start. Which car do you want?',
      'Hoy es un buen día para empezar. ¿Qué auto quieres?',
      'Hoje é um bom dia para começar. Qual carro você quer?'],
    hello: ['To start: what car are you looking for?',
      'Para empezar: ¿qué auto buscas?',
      'Para começar: qual carro você procura?']
  };
  var LANGS = ['en', 'es', 'pt'];
  function hookFor(id) { var list = HOOK[id]; return list ? list[LANGS.indexOf(lang())] || list[0] : ''; }

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
  /* O Sold é um martelo de leiloeiro de verdade, de pé: cabeça em barril de madeira escura laqueada (vinho), anéis e
     detalhes em dourado como o site, rosto pequeno em marfim e ouro. No ciclo ele bate três vezes no ar (sem mesa:
     só o estalo dourado) e pula de alegria, como quem acabou de arrematar. */
  function character(size, headOnly) {
    var id = 'sold' + Math.random().toString(36).slice(2, 8);
    var gold = '#e3c06a', ivory = '#f6ead2', dark = '#140705';
    var head =
      '<g class="sold-head">' +
        '<rect x="8" y="14" width="104" height="48" rx="16" fill="url(#' + id + 'w)"/>' +
        '<ellipse cx="11" cy="38" rx="5" ry="23.5" fill="url(#' + id + 'e)"/><ellipse cx="109" cy="38" rx="5" ry="23.5" fill="url(#' + id + 'e)"/>' +
        '<rect x="19" y="14" width="5" height="48" fill="url(#' + id + 'g)"/><rect x="96" y="14" width="5" height="48" fill="url(#' + id + 'g)"/>' +
        '<rect x="28" y="18.5" width="64" height="3.5" rx="1.75" fill="rgba(255,228,196,.2)"/>' +
        '<path d="M30 55 Q60 58 90 55" stroke="rgba(0,0,0,.25)" stroke-width="1.2" fill="none" stroke-linecap="round"/>' +
        '<path class="sold-brows" d="M42 28 Q48 25.5 54 28 M66 28 Q72 25.5 78 28" stroke="' + gold + '" stroke-width="2" fill="none" stroke-linecap="round"/>' +
        '<g class="sold-eyes">' +
          '<ellipse cx="48" cy="36" rx="4.6" ry="5.6" fill="' + ivory + '"/><ellipse cx="72" cy="36" rx="4.6" ry="5.6" fill="' + ivory + '"/>' +
          '<circle cx="48.7" cy="36.8" r="2.6" fill="' + dark + '"/><circle cx="72.7" cy="36.8" r="2.6" fill="' + dark + '"/>' +
          '<circle cx="49.7" cy="35.5" r=".9" fill="#fff"/><circle cx="73.7" cy="35.5" r=".9" fill="#fff"/>' +
        '</g>' +
        '<path class="sold-joy" d="M43 38 Q48 31 53 38 M67 38 Q72 31 77 38" stroke="' + gold + '" stroke-width="2.6" fill="none" stroke-linecap="round" opacity="0"/>' +
        '<path class="sold-mouth" d="M51 46 Q60 53 69 46" stroke="' + gold + '" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
        '<path class="sold-grin" d="M49 44 Q60 58 71 44 Z" fill="' + dark + '" stroke="' + gold + '" stroke-width="1.8" stroke-linejoin="round" opacity="0"/>' +
      '</g>';
    // fogos de artifício em segundo plano: raios e pontos saindo do centro
    function firework(n, cx, cy, r, color) {
      var rays = '', dots = '';
      for (var i = 0; i < 10; i++) {
        var a = i * Math.PI / 5 + n, c = Math.cos(a), s = Math.sin(a);
        rays += 'M' + (cx + c * r * .38).toFixed(1) + ' ' + (cy + s * r * .38).toFixed(1) + 'L' + (cx + c * r).toFixed(1) + ' ' + (cy + s * r).toFixed(1);
        dots += '<circle cx="' + (cx + c * r * 1.22).toFixed(1) + '" cy="' + (cy + s * r * 1.22).toFixed(1) + '" r="1.5"/>';
      }
      return '<g class="sold-fw sold-fw' + n + '" style="transform-origin:' + cx + 'px ' + cy + 'px" opacity="0" fill="' + color + '">' +
        '<path d="' + rays + '" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>' + dots + '</g>';
    }
    var body =
      '<g class="sold-sky" pointer-events="none">' +
        // as cores da bandeira dos EUA: vermelho, branco e azul (o azul da bandeira, #3C3B6E, some no fundo escuro,
        // então é o mesmo azul mais claro)
        firework(1, 8, -2, 25, '#e0283a') + firework(2, 114, -6, 23, '#4d6cf0') + firework(3, 62, -66, 21, '#ffffff') + firework(4, 18, -54, 16, '#4d6cf0') + firework(5, 106, -54, 16, '#e0283a') +
      '</g>' +
      '<ellipse class="sold-shadow" cx="60" cy="146" rx="22" ry="3" fill="rgba(0,0,0,.35)"/>' +

      '<g class="sold-rig">' +
        '<rect x="53" y="106" width="6" height="34" rx="3" fill="#3a1512"/><rect x="61" y="106" width="6" height="34" rx="3" fill="#3a1512"/>' +
        '<ellipse cx="54.5" cy="141.5" rx="7" ry="3.6" fill="#0b0b0c"/><ellipse cx="65.5" cy="141.5" rx="7" ry="3.6" fill="#0b0b0c"/>' +
        '<rect x="52" y="64" width="16" height="50" rx="8" fill="url(#' + id + 'h)"/>' +
        '<g class="sold-arm-wave"><path d="M53 76 Q42 72 35 60" stroke="#5a2620" stroke-width="4.5" fill="none" stroke-linecap="round"/><circle cx="34.5" cy="57.5" r="4.2" fill="' + gold + '"/></g>' +
        '<g class="sold-arm-r"><path d="M67 78 Q78 86 82 98" stroke="#5a2620" stroke-width="4.5" fill="none" stroke-linecap="round"/><circle cx="82.8" cy="101" r="4.2" fill="' + gold + '"/></g>' +
        '<rect x="49" y="61" width="22" height="7" rx="3" fill="url(#' + id + 'g2)"/>' +
        '<rect x="52" y="108" width="16" height="4" rx="2" fill="url(#' + id + 'g2)"/>';
    var defs =
      '<defs>' +
        '<linearGradient id="' + id + 'w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a1d18"/><stop offset=".28" stop-color="#8a4436"/><stop offset=".55" stop-color="#5e2822"/><stop offset="1" stop-color="#240c0a"/></linearGradient>' +
        '<linearGradient id="' + id + 'e" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1512"/><stop offset=".3" stop-color="#6a3128"/><stop offset="1" stop-color="#1a0806"/></linearGradient>' +
        '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b8923f"/><stop offset=".3" stop-color="#f6dd92"/><stop offset=".6" stop-color="#c9a34e"/><stop offset="1" stop-color="#7d612f"/></linearGradient>' +
        '<linearGradient id="' + id + 'g2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a6a2a"/><stop offset=".45" stop-color="#f6dd92"/><stop offset="1" stop-color="#9a7834"/></linearGradient>' +
        '<linearGradient id="' + id + 'h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2e110e"/><stop offset=".45" stop-color="#7a3a2e"/><stop offset="1" stop-color="#2a0f0c"/></linearGradient>' +
      '</defs>';
    var viewBox = headOnly ? '2 10 116 56' : '-8 6 128 146';
    // a palavra SOLD explode por cima de tudo quando ele sobe
    // o golpe no chão: o estalo dourado onde a ponta do martelo bate (na frente dele, para aparecer)
    var dust = '<g class="sold-dust" opacity="0" stroke="' + gold + '" stroke-width="3.2" stroke-linecap="round">' +
        '<path d="M-29 134 L-29 121 M-41 138 L-51 129 M-17 138 L-7 129 M-47 147 L-59 147 M-11 147 L1 147"/></g>';
    var word = dust + '<text class="sold-word" x="60" y="-14" text-anchor="middle" opacity="0" font-family="Barlow,system-ui,sans-serif" font-weight="900" font-size="31" letter-spacing="2" fill="url(#' + id + 'g)" stroke="' + dark + '" stroke-width="1.4" paint-order="stroke">SOLD</text>';
    return '<svg class="sold-figure" viewBox="' + viewBox + '" width="' + size + '" aria-hidden="true" focusable="false" overflow="visible">' + defs + (headOnly ? head : body + head + '</g>' + word) + '</svg>';
  }

  /* ---------- estilo ---------- */
  var css = [
    '.sold-launcher{position:fixed;right:10px;bottom:calc(158px + env(safe-area-inset-bottom,0px));z-index:71;width:66px;height:84px;padding:0;border:0;background:none;cursor:pointer;filter:drop-shadow(0 6px 10px rgba(0,0,0,.45)) drop-shadow(0 0 1px rgba(227,192,106,.55));-webkit-tap-highlight-color:transparent}',
    '.sold-launcher .sold-figure{display:block;width:66px;height:auto}',
    '.sold-launcher:focus-visible{outline:2px solid #c9a34e;outline-offset:4px;border-radius:12px}',
    '.sold-launcher.hidden{display:none}',
    '.sold-figure *{transform-box:view-box}',
    '.sold-head{transform-origin:60px 64px}.sold-rig{transform-origin:60px 146px}',
    '.sold-arm-wave{transform-origin:53px 76px}.sold-arm-r{transform-origin:67px 78px}.sold-eyes{transform-origin:60px 36px}',
    '.sold-eyes{animation:sold-blink 5s infinite}',
    /* o ciclo do arremate (5,4 s): parado, toma impulso, bate o martelo até o chão, sobe pulando de alegria
       enquanto os fogos estouram ao fundo e a palavra SOLD explode no alto */
    '.sold-launcher svg{pointer-events:none}',
    '.sold-word{transform-origin:60px -24px}',
    '.sold-launcher .sold-head{animation:sold-strike 5.4s ease-in-out infinite}',
    '.sold-launcher .sold-rig{animation:sold-hop 5.4s ease-in-out infinite}',
    '.sold-launcher .sold-dust{transform-origin:-29px 146px;animation:sold-dust 5.4s ease-out infinite}',
    '.sold-launcher .sold-fw{animation:sold-fw 5.4s ease-out infinite}',
    '.sold-launcher .sold-fw2{animation-delay:.18s}.sold-launcher .sold-fw3{animation-delay:.36s}.sold-launcher .sold-fw4{animation-delay:.54s}.sold-launcher .sold-fw5{animation-delay:.72s}',
    '.sold-launcher .sold-word{animation:sold-word 5.4s ease-out infinite}',
    '.sold-launcher .sold-eyes,.sold-launcher .sold-mouth,.sold-launcher .sold-brows{animation:sold-calm 5.4s step-end infinite}',
    '.sold-launcher .sold-joy,.sold-launcher .sold-grin{animation:sold-happy 5.4s step-end infinite}',
    '.sold-launcher .sold-arm-wave{animation:sold-cheer-l 5.4s ease-in-out infinite}',
    '.sold-launcher .sold-arm-r{animation:sold-cheer-r 5.4s ease-in-out infinite}',
    '.sold-launcher .sold-shadow{transform-origin:60px 146px;animation:sold-shadow 5.4s ease-in-out infinite}',
    '.sold-launcher:hover .sold-arm-wave,.sold-launcher:focus-visible .sold-arm-wave{animation:sold-wave .9s ease-in-out 2}',
    '.sold-tap .sold-head{animation:sold-tap .5s ease-out!important}',
    // corpo inclina 50° sobre os pés e a cabeça mais 40° no pescoço: a ponta do martelo encosta no chão (y=146).
    // A descida leva 4% do ciclo (216 ms) e a comemoração tem pulos, braços, fogos e SOLD 20% maiores.
    '@keyframes sold-strike{0%,30%{transform:rotate(0)}36%{transform:rotate(20deg)}40%,48%{transform:rotate(-40deg)}44%{transform:rotate(-36deg)}55%,100%{transform:rotate(0)}}',
    '@keyframes sold-hop{0%,30%{transform:translateY(0) rotate(0)}36%{transform:translateY(0) rotate(8deg)}40%,48%{transform:translateY(0) rotate(-50deg)}44%{transform:translateY(0) rotate(-46deg)}55%{transform:translateY(0) rotate(0)}61%{transform:translateY(-22px) rotate(-4deg)}67%{transform:translateY(0) rotate(0)}72%{transform:translateY(-13px) rotate(4deg)}77%,100%{transform:translateY(0) rotate(0)}}',
    '@keyframes sold-dust{0%,39.9%{opacity:0;transform:scale(.4)}40%{opacity:1;transform:scale(.7)}48%,100%{opacity:0;transform:scale(1.5)}}',
    '@keyframes sold-fw{0%,53.9%{opacity:0;transform:scale(.15)}54%{opacity:1;transform:scale(.15)}62%{opacity:1;transform:scale(1.32)}70%,100%{opacity:0;transform:scale(1.56)}}',
    '@keyframes sold-word{0%,53.9%{opacity:0;transform:scale(0)}57%{opacity:1;transform:scale(1.68)}60%{transform:scale(.9)}63%{transform:scale(1.08)}66%,84%{opacity:1;transform:scale(1)}91%,100%{opacity:0;transform:scale(1.12)}}',
    '@keyframes sold-calm{0%{opacity:1}40%{opacity:0}92%{opacity:1}}',
    '@keyframes sold-happy{0%{opacity:0}40%{opacity:1}92%{opacity:0}}',
    '@keyframes sold-cheer-l{0%,55%{transform:rotate(0)}61%{transform:rotate(-41deg)}67%{transform:rotate(-10deg)}72%{transform:rotate(-41deg)}80%,100%{transform:rotate(0)}}',
    '@keyframes sold-cheer-r{0%,55%{transform:rotate(0)}61%{transform:rotate(-79deg)}67%{transform:rotate(-42deg)}72%{transform:rotate(-79deg)}80%,100%{transform:rotate(0)}}',
    '@keyframes sold-shadow{0%,30%,55%,67%,77%,100%{transform:scaleX(1);opacity:1}40%,48%{transform:scaleX(1.5);opacity:.8}61%{transform:scaleX(.55);opacity:.45}72%{transform:scaleX(.74);opacity:.65}}',
    '@keyframes sold-wave{0%,100%{transform:rotate(0)}30%{transform:rotate(-16deg)}70%{transform:rotate(12deg)}}',
    '@keyframes sold-blink{0%,94%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}',
    '@keyframes sold-tap{0%{transform:rotate(0)}35%{transform:rotate(-30deg)}60%{transform:rotate(8deg)}100%{transform:rotate(0)}}',
    '.sold-teaser{position:fixed;right:82px;bottom:calc(196px + env(safe-area-inset-bottom,0px));z-index:71;max-width:230px;background:linear-gradient(176deg,#1d2025 0%,#0b0c0e 100%);color:#f2efe9;border:1px solid rgba(201,163,78,.6);border-radius:14px 14px 4px 14px;padding:11px 30px 11px 13px;font:600 14px/1.35 "Barlow",system-ui,sans-serif;box-shadow:0 12px 28px rgba(0,0,0,.45);cursor:pointer;animation:sold-pop .35s ease-out}',
    '.sold-teaser button{position:absolute;top:4px;right:4px;width:24px;height:24px;border:0;background:none;color:rgba(242,239,233,.6);font-size:16px;line-height:1;cursor:pointer}',
    '@keyframes sold-pop{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}',
    '.sold-panel{position:fixed;right:14px;bottom:calc(20px + env(safe-area-inset-bottom,0px));z-index:150;width:min(380px,calc(100vw - 28px));max-height:min(620px,calc(100vh - 40px));display:flex;flex-direction:column;background:#0d0e11;color:#f2efe9;border:1px solid rgba(201,163,78,.5);border-radius:18px;box-shadow:0 24px 60px rgba(0,0,0,.6),0 0 0 1px rgba(0,0,0,.4);overflow:hidden;font-family:"Barlow",system-ui,sans-serif;animation:sold-pop .25s ease-out}',
    '.sold-panel[hidden]{display:none}',
    '.sold-top{display:flex;align-items:center;gap:12px;padding:12px 14px;background:linear-gradient(176deg,#1d2025 0%,#0b0c0e 100%);color:#f2efe9;border-bottom:1px solid rgba(201,163,78,.45)}',
    '.sold-top .sold-figure{width:50px;height:auto;flex:0 0 auto;filter:drop-shadow(0 2px 4px rgba(0,0,0,.5))}',
    '.sold-top strong{display:block;font-size:17px;font-weight:800;letter-spacing:.18em;color:#c9a34e}',
    '.sold-top span{display:block;font-size:12.5px;letter-spacing:.04em;color:rgba(242,239,233,.7)}',
    '.sold-x{margin-left:auto;width:34px;height:34px;border-radius:50%;border:1px solid rgba(201,163,78,.45);background:none;color:#f2efe9;font-size:18px;cursor:pointer}',
    '.sold-log{flex:1 1 auto;overflow-y:auto;padding:16px 12px 8px;display:flex;flex-direction:column;gap:9px;background:radial-gradient(120% 60% at 50% 0%,rgba(201,163,78,.07),transparent 70%)}',
    '.sold-msg{max-width:88%;padding:10px 12px;border-radius:14px;font-size:14.5px;line-height:1.45;white-space:pre-line;overflow-wrap:anywhere}',
    '.sold-msg.bot{align-self:flex-start;background:#181a1f;color:#ece7de;border:1px solid rgba(201,163,78,.22);border-bottom-left-radius:4px}',
    '.sold-msg.me{align-self:flex-end;background:linear-gradient(180deg,#d8b65f 0%,#c9a34e 60%,#b08e44 100%);color:#111;font-weight:600;border-bottom-right-radius:4px}',
    '.sold-steps{margin:6px 0 0;padding-left:18px}.sold-steps li{margin:5px 0}.sold-steps li::marker{color:#c9a34e;font-weight:700}.sold-steps b{font-weight:700;color:#f2efe9}.sold-steps small{display:block;color:rgba(236,231,222,.65);font-size:13px}',
    '.sold-cta{align-self:flex-start;display:inline-flex;align-items:center;gap:8px;margin:2px 0 4px;padding:12px 16px;border:0;border-radius:10px;background:linear-gradient(180deg,#d8b65f 0%,#c9a34e 55%,#a8873f 100%);color:#111;font:800 14px/1 "Barlow",system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;box-shadow:0 4px 0 #6e5428,0 10px 18px rgba(0,0,0,.4)}',
    '.sold-cta:active{transform:translateY(3px);box-shadow:0 1px 0 #6e5428}',
    '.sold-link{align-self:flex-start;font-size:14px;font-weight:700;color:#3ede7c;text-decoration:none;padding:4px 2px}',
    '.sold-page{color:#c9a34e;padding-top:0}',
    '.sold-msg.sold-hook{background:linear-gradient(180deg,#221c12 0%,#17140f 100%);border-color:rgba(201,163,78,.55);border-left:3px solid #c9a34e;color:#f6ead2;font-weight:600}',
    '.sold-actions{align-self:stretch;display:flex;gap:8px;margin:2px 0 4px}',
    '.sold-btn{flex:1 1 0;display:flex;align-items:center;justify-content:center;min-height:44px;padding:10px 12px;border-radius:10px;font:800 14px/1.15 "Barlow",system-ui,sans-serif;letter-spacing:.03em;text-align:center;text-decoration:none}',
    '.sold-wa{background:#25d366;color:#06240f;box-shadow:0 3px 0 #128c4a}',
    '.sold-sms{background:transparent;color:#f2efe9;border:1px solid rgba(201,163,78,.6)}',
    '.sold-btn:active{transform:translateY(2px)}',
    '.sold-chips{flex:0 0 auto;display:flex;flex-wrap:nowrap;gap:6px;padding:8px 12px 10px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;border-top:1px solid rgba(201,163,78,.2);background:#0d0e11;mask-image:linear-gradient(90deg,#000 88%,transparent)}',
    '.sold-chip{flex:0 0 auto;white-space:nowrap;border:1px solid rgba(201,163,78,.45);background:transparent;color:#e9dcc0;border-radius:999px;padding:7px 12px;font:600 13px/1.2 "Barlow",system-ui,sans-serif;cursor:pointer}',
    '.sold-chip:hover{border-color:#c9a34e;background:rgba(201,163,78,.12)}',
    '.sold-form{flex:0 0 auto;display:flex;gap:8px;padding:10px 12px;border-top:1px solid rgba(201,163,78,.2);background:#0b0c0e}',
    '.sold-form input{flex:1 1 auto;min-width:0;border:1px solid rgba(201,163,78,.35);border-radius:10px;padding:10px 11px;font:500 15px "Barlow",system-ui,sans-serif;background:#16181c;color:#f2efe9;outline:none}.sold-form input::placeholder{color:rgba(242,239,233,.45)}.sold-form input:focus{border-color:#c9a34e;box-shadow:0 0 0 3px rgba(201,163,78,.18)}',
    '.sold-form button{border:0;border-radius:10px;padding:0 15px;background:linear-gradient(180deg,#d8b65f 0%,#c9a34e 55%,#a8873f 100%);color:#111;font:800 14px "Barlow",system-ui,sans-serif;letter-spacing:.04em;cursor:pointer}',
    '.sold-stamp{position:fixed;left:50%;top:42%;z-index:160;transform:translate(-50%,-50%) rotate(-12deg);padding:10px 26px;border:5px solid #9b1b23;border-radius:12px;color:#9b1b23;font:900 44px/1 "Barlow",system-ui,sans-serif;letter-spacing:.08em;background:rgba(255,255,255,.85);pointer-events:none;animation:sold-stamp .9s ease-out forwards}',
    '@keyframes sold-stamp{0%{opacity:0;transform:translate(-50%,-50%) rotate(-12deg) scale(2.2)}25%{opacity:1;transform:translate(-50%,-50%) rotate(-12deg) scale(.95)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) rotate(-12deg) scale(1)}}',
    '@media (max-width:820px){.sold-panel{right:0;left:0;bottom:0;width:100%;max-height:82vh;border-radius:18px 18px 0 0}}',
    /* computador: o WhatsApp fica no canto (22px); o Sold fica logo acima dele, centrado no mesmo eixo */
    '@media (min-width:821px){.sold-launcher{right:11px;bottom:74px}.sold-teaser{bottom:112px}}',
    '@media (prefers-reduced-motion:reduce){.sold-figure *,.sold-panel,.sold-teaser{animation:none!important}}'
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
  /* A mensagem já sai escrita: quem veio do site e, se a pessoa digitou uma pergunta, a pergunta dela. */
  var lastAsked = '';
  function prefill() { return t('prefill') + (lastAsked ? '\n' + fill(t('prefillQ'), { q: lastAsked }) : ''); }
  function waHref() { return WHATSAPP + '?text=' + encodeURIComponent(prefill()); }
  // "?&body=" abre o SMS com o texto no iPhone e no Android.
  function smsHref() { return SMS + '?&body=' + encodeURIComponent(prefill()); }
  function contactButtons() {
    var row = document.createElement('div');
    row.className = 'sold-actions';
    [['sold-btn sold-wa', waHref(), t('waButton'), '_blank'], ['sold-btn sold-sms', smsHref(), t('smsButton'), '']].forEach(function (item) {
      var link = document.createElement('a');
      link.className = item[0];
      link.href = item[1];
      link.textContent = item[2];
      if (item[3]) { link.target = item[3]; link.rel = 'noopener'; }
      row.appendChild(link);
    });
    log.appendChild(row);
    scrollDown();
  }
  function whatsappLink() {
    var link = document.createElement('a');
    link.className = 'sold-link';
    link.href = waHref();
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
    if (result && result.fee) { answerFee(result.fee); say(t('feeHook'), 'bot sold-hook'); cta(); sectionLink('taxas'); lastId = 'fees'; return; }
    if (!entry) { say(t('fallback')); contactButtons(); lastId = null; return; }
    lastId = entry.id;
    if (entry.special === 'how') answerHow();
    else if (entry[lang()]) say(compose(entry[lang()]));
    else if (entry.faq) say(dot(pageText('a' + entry.faq)) || t('fallback'));
    // esclarece e, logo depois, o gancho; sem destino próprio, o gancho leva para a calculadora
    var hook = hookFor(entry.id), go = entry.go || (hook ? 'calc' : '');
    if (hook) say(hook, 'bot sold-hook');
    if (go === 'calc' || go === 'both') cta();
    if (go === 'wa' || go === 'both') whatsappLink();
    if (go === 'contact') contactButtons();
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
      chip.addEventListener('click', function () { say(label, 'me'); lastAsked = ''; answer({ id: entry.id, entry: entry }); });
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
    lastAsked = text;
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
