// RETOMAR: the 3 messages sent, one bubble at a time, to a client who wrote more than 15 days ago and got no reply.
// English is Leo's text (13/10), with the client's car in message 1 and a direct question to close message 3 (a reply
// takes the conversation out of WhatsApp's "no reply" count). Portuguese and Spanish carry the same meaning. At most 3 bubbles:
// the Florida rule (501.616(6)(b)) allows 3 sales messages per person in 24 h.
// Message 3 has two versions: with the options link (the client has options in the active batch) or, without
// options, asking for the car and the budget (never the calculator: the lead stays with us).

(function attachMensagens(root) {
'use strict';
const firstName = (name) => {
  const word = String(name || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}'-]{1,30}$/u.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : '';
};

const TEXT = {
  en: {
    one: (who, car) => `Hi${who ? ' ' + who : ''}, how are you? First, I’m really sorry for taking so long to get back to you${car ? ` about the ${car}` : ''}. We’re helping you make a purchase with your money, and we take that seriously. That’s why we made the tough call to pause replies rather than rush through them just to clear our inbox.`,
    two: 'As you may remember, we look for deals at the same dealer auctions where dealerships, big and small, buy cars for their inventory.',
    link: (link, car) => `I’m not sure if you’ve already bought a car since we last spoke, but I picked out some options based on what you asked for so you can see what’s out there:\n${link}\n\nThere are plenty of options there, but our job is to find which ones make the most sense for you and look for a good buy below market value. We can go through the options together and help you choose. ${car ? `Still looking for the ${car}?` : 'Are you still looking for a car?'}`,
    ask: (car) => `I’m not sure if you’ve already bought a car since we last spoke. Our job is to find the options that make the most sense for you and look for a good buy below market value. If you tell me ${car ? 'the years and your max budget' : 'the car and your max budget'}, I’ll pick out options at this week’s auctions and we go through them together. ${car ? `Still looking for the ${car}?` : 'Are you still looking for a car?'}`
  },
  pt: {
    one: (who, car) => `Oi${who ? ', ' + who : ''}, tudo bem? Antes de tudo, me desculpe de verdade pela demora em te responder${car ? ` sobre o ${car}` : ''}. Estamos te ajudando a fazer uma compra com o seu dinheiro, e levamos isso a sério. Por isso tomamos a decisão difícil de pausar as respostas em vez de responder correndo só para zerar a caixa de mensagens.`,
    two: 'Como você deve lembrar, buscamos oportunidades nos mesmos leilões de dealers onde as concessionárias, grandes e pequenas, compram carros para o estoque delas.',
    link: (link, car) => `Não sei se você já comprou um carro desde a última vez que conversamos, mas separei algumas opções de acordo com o que você pediu, para você ver o que existe:\n${link}\n\nTem bastante opção ali, mas o nosso trabalho é encontrar as que fazem mais sentido para você e buscar uma boa compra abaixo do valor de mercado. Podemos ver as opções juntos e te ajudar a escolher. ${car ? `Ainda está procurando o ${car}?` : 'Você ainda está procurando um carro?'}`,
    ask: (car) => `Não sei se você já comprou um carro desde a última vez que conversamos. O nosso trabalho é encontrar as opções que fazem mais sentido para você e buscar uma boa compra abaixo do valor de mercado. Se você me disser ${car ? 'os anos e o seu valor máximo' : 'o carro e o seu valor máximo'}, eu separo opções nos leilões desta semana e vemos juntos. ${car ? `Ainda está procurando o ${car}?` : 'Você ainda está procurando um carro?'}`
  },
  es: {
    one: (who, car) => `Hola${who ? ' ' + who : ''}, ¿cómo estás? Primero, de verdad disculpa por tardar tanto en responderte${car ? ` sobre el ${car}` : ''}. Te estamos ayudando a hacer una compra con tu dinero y eso lo tomamos en serio. Por eso tomamos la difícil decisión de pausar las respuestas en vez de contestar a la carrera solo para vaciar la bandeja.`,
    two: 'Como recordarás, buscamos oportunidades en las mismas subastas de dealers donde los concesionarios, grandes y pequeños, compran autos para su inventario.',
    link: (link, car) => `No sé si ya compraste un auto desde la última vez que hablamos, pero te separé algunas opciones según lo que pediste, para que veas lo que hay:\n${link}\n\nHay muchas opciones ahí, pero nuestro trabajo es encontrar las que más sentido tienen para ti y buscar una buena compra por debajo del valor de mercado. Podemos ver las opciones juntos y ayudarte a elegir. ${car ? `¿Sigues buscando el ${car}?` : '¿Todavía estás buscando auto?'}`,
    ask: (car) => `No sé si ya compraste un auto desde la última vez que hablamos. Nuestro trabajo es encontrar las opciones que más sentido tienen para ti y buscar una buena compra por debajo del valor de mercado. Si me dices ${car ? 'los años y tu valor máximo' : 'qué auto y tu valor máximo'}, te separo opciones en las subastas de esta semana y las vemos juntos. ${car ? `¿Sigues buscando el ${car}?` : '¿Todavía estás buscando auto?'}`
  }
};

const LANGS = ['en', 'pt', 'es'];

function sequence({ lang = 'en', name, link = null, car = null } = {}) {
  const t = TEXT[LANGS.includes(lang) ? lang : 'en'];
  const vehicle = car ? String(car).replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  return [t.one(firstName(name), vehicle), t.two, link ? t.link(link, vehicle) : t.ask(vehicle)];
}

// Portuguese copy of any sequence, for Leo to review what goes out in English or Spanish.
const review = (input) => sequence({ ...input, lang: 'pt' });

const api = { LANGS, sequence, review, firstName };
if (typeof module === 'object' && module.exports) module.exports = api;
if (root) root.MCSRetomarMensagens = api;
})(typeof window !== 'undefined' ? window : null);
