// RETOMAR: the 3 messages sent, one bubble at a time, to a client who wrote more than 15 days ago and got no reply.
// English is Leo's text (13/10), word for word. Portuguese and Spanish carry the same meaning. At most 3 bubbles:
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
    one: (who) => `Hi${who ? ' ' + who : ''}, how are you? First, I’m really sorry for taking so long to get back to you. We’re helping you make a purchase with your money, and we take that seriously. That’s why we made the tough call to pause replies rather than rush through them just to clear our inbox.`,
    two: 'As you may remember, we look for deals at the same dealer auctions where dealerships, big and small, buy cars for their inventory.',
    link: (link) => `I’m not sure if you’ve already bought a car since we last spoke, but I picked out some options based on what you asked for so you can see what’s out there:\n${link}\n\nThere are plenty of options there, but our job is to find which ones make the most sense for you and look for a good buy below market value. If you’re still looking for a car, let me know and we’ll get in touch to go through the options together and help you choose.`,
    ask: (car) => `I’m not sure if you’ve already bought a car since we last spoke. If you’re still looking${car ? ` for the ${car}` : ''}, tell me ${car ? 'the years and the max budget you have in mind' : 'the car and the max budget you have in mind'} and I’ll pick out options at this week’s auctions. Our job is to find which ones make the most sense for you and look for a good buy below market value, and then we go through them together to help you choose.`
  },
  pt: {
    one: (who) => `Oi${who ? ', ' + who : ''}, tudo bem? Antes de tudo, me desculpe de verdade pela demora em te responder. Estamos te ajudando a fazer uma compra com o seu dinheiro, e levamos isso a sério. Por isso tomamos a decisão difícil de pausar as respostas em vez de responder correndo só para zerar a caixa de mensagens.`,
    two: 'Como você deve lembrar, buscamos oportunidades nos mesmos leilões de dealers onde as concessionárias, grandes e pequenas, compram carros para o estoque delas.',
    link: (link) => `Não sei se você já comprou um carro desde a última vez que conversamos, mas separei algumas opções de acordo com o que você pediu, para você ver o que existe:\n${link}\n\nTem bastante opção ali, mas o nosso trabalho é encontrar as que fazem mais sentido para você e buscar uma boa compra abaixo do valor de mercado. Se você ainda está procurando um carro, me avise que a gente entra em contato para ver as opções juntos e te ajudar a escolher.`,
    ask: (car) => `Não sei se você já comprou um carro desde a última vez que conversamos. Se ainda está procurando${car ? ` o ${car}` : ''}, me diga ${car ? 'os anos e o valor máximo que você tem em mente' : 'o carro e o valor máximo que você tem em mente'} que eu separo opções nos leilões desta semana. O nosso trabalho é encontrar as que fazem mais sentido para você e buscar uma boa compra abaixo do valor de mercado, e depois vemos juntos para te ajudar a escolher.`
  },
  es: {
    one: (who) => `Hola${who ? ' ' + who : ''}, ¿cómo estás? Primero, de verdad disculpa por tardar tanto en responderte. Te estamos ayudando a hacer una compra con tu dinero y eso lo tomamos en serio. Por eso tomamos la difícil decisión de pausar las respuestas en vez de contestar a la carrera solo para vaciar la bandeja.`,
    two: 'Como recordarás, buscamos oportunidades en las mismas subastas de dealers donde los concesionarios, grandes y pequeños, compran autos para su inventario.',
    link: (link) => `No sé si ya compraste un auto desde la última vez que hablamos, pero te separé algunas opciones según lo que pediste, para que veas lo que hay:\n${link}\n\nHay muchas opciones ahí, pero nuestro trabajo es encontrar las que más sentido tienen para ti y buscar una buena compra por debajo del valor de mercado. Si todavía estás buscando auto, avísame y te contactamos para ver las opciones juntos y ayudarte a elegir.`,
    ask: (car) => `No sé si ya compraste un auto desde la última vez que hablamos. Si todavía estás buscando${car ? ` el ${car}` : ''}, dime ${car ? 'los años y el valor máximo que tienes en mente' : 'qué auto y el valor máximo que tienes en mente'} y te separo opciones en las subastas de esta semana. Nuestro trabajo es encontrar las que más sentido tienen para ti y buscar una buena compra por debajo del valor de mercado, y luego las vemos juntos para ayudarte a elegir.`
  }
};

const LANGS = ['en', 'pt', 'es'];

function sequence({ lang = 'en', name, link = null, car = null } = {}) {
  const t = TEXT[LANGS.includes(lang) ? lang : 'en'];
  const vehicle = car ? String(car).replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  return [t.one(firstName(name)), t.two, link ? t.link(link) : t.ask(vehicle)];
}

// Portuguese copy of any sequence, for Leo to review what goes out in English or Spanish.
const review = (input) => sequence({ ...input, lang: 'pt' });

const api = { LANGS, sequence, review, firstName };
if (typeof module === 'object' && module.exports) module.exports = api;
if (root) root.MCSRetomarMensagens = api;
})(typeof window !== 'undefined' ? window : null);
