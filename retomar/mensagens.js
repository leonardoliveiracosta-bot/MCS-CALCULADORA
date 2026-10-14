// RETOMAR: the 3 messages sent, one bubble at a time, to a client who wrote more than 15 days ago and got no reply.
// English is Leo's text (13/10), with the client's car in message 1. Message 3 closes with the next step on our side
// (which option to check first, or the years and the max), never a yes/no the client can leave by (Leo, 14/10). Portuguese and Spanish carry the same meaning. At most 3 bubbles:
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
    one: (who, car) => `Hi${who ? ' ' + who : ''}, how are you? First, I owe you a reply${car ? ` about the ${car}` : ''} and I’m sorry it took this long. We’re helping you make a purchase with your money, and we take that seriously. That’s why we made the tough call to pause replies rather than rush through them just to clear our inbox.`,
    two: 'As you may remember, we look for deals at the same dealer auctions where dealerships, big and small, buy cars for their inventory.',
    link: (link, car) => `I’m not sure if you’ve already bought a car since we last spoke, but I picked out some options based on what you asked for so you can see what’s out there:\n${link}\n\nThere are plenty of options there, but our job is to find which ones make the most sense for you and look for a good buy below market value. Take a look and tell me which one you want me to check first. I’ll pull the full history before its auction date.`,
    ask: (car) => `Our job is to find the options that make the most sense for you and look for a good buy below market value. ${car ? `Tell me the years and the max you’d put on the ${car}` : 'Tell me the car and the max you have in mind'}, and I’ll bring you what comes up at this week’s auctions.`
  },
  pt: {
    one: (who, car) => `Oi${who ? ', ' + who : ''}, tudo bem? Antes de tudo, eu te devia uma resposta${car ? ` sobre o ${car}` : ''} e desculpa ter demorado tanto. Estamos te ajudando a fazer uma compra com o seu dinheiro, e levamos isso a sério. Por isso tomamos a decisão difícil de pausar as respostas em vez de responder correndo só para zerar a caixa de mensagens.`,
    two: 'Como você deve lembrar, buscamos oportunidades nos mesmos leilões de dealers onde as concessionárias, grandes e pequenas, compram carros para o estoque delas.',
    link: (link, car) => `Não sei se você já comprou um carro desde a última vez que conversamos, mas separei algumas opções de acordo com o que você pediu, para você ver o que existe:\n${link}\n\nTem bastante opção ali, mas o nosso trabalho é encontrar as que fazem mais sentido para você e buscar uma boa compra abaixo do valor de mercado. Dá uma olhada e me diz qual você quer que eu confira primeiro. Eu puxo o histórico completo antes da data do leilão.`,
    ask: (car) => `O nosso trabalho é encontrar as opções que fazem mais sentido para você e buscar uma boa compra abaixo do valor de mercado. ${car ? `Me diz os anos e o máximo que você colocaria no ${car}` : 'Me diz o carro e o máximo que você tem em mente'}, que eu te trago o que aparecer nos leilões desta semana.`
  },
  es: {
    one: (who, car) => `Hola${who ? ' ' + who : ''}, ¿cómo estás? Primero, te debía una respuesta${car ? ` sobre el ${car}` : ''} y disculpa que haya tardado tanto. Te estamos ayudando a hacer una compra con tu dinero y eso lo tomamos en serio. Por eso tomamos la difícil decisión de pausar las respuestas en vez de contestar a la carrera solo para vaciar la bandeja.`,
    two: 'Como recordarás, buscamos oportunidades en las mismas subastas de dealers donde los concesionarios, grandes y pequeños, compran autos para su inventario.',
    link: (link, car) => `No sé si ya compraste un auto desde la última vez que hablamos, pero te separé algunas opciones según lo que pediste, para que veas lo que hay:\n${link}\n\nHay muchas opciones ahí, pero nuestro trabajo es encontrar las que más sentido tienen para ti y buscar una buena compra por debajo del valor de mercado. Échale un vistazo y dime cuál quieres que revise primero. Saco el historial completo antes de la fecha de la subasta.`,
    ask: (car) => `Nuestro trabajo es encontrar las opciones que más sentido tienen para ti y buscar una buena compra por debajo del valor de mercado. ${car ? `Dime los años y el máximo que pondrías en el ${car}` : 'Dime qué auto y el máximo que tienes en mente'}, y te traigo lo que salga en las subastas de esta semana.`
  }
};

const LANGS = ['en', 'pt', 'es'];

// The client answers "I already bought one": he wins (he bought), we stay at the table as the ones who know the
// real auction price (Leo, 14/10).
const BOUGHT = {
  en: 'Congrats on the car! If you ever want to see how what you paid compares with what that same car goes for at the dealer auctions, send me the VIN and I’ll check it for you.',
  pt: 'Parabéns pelo carro! Se um dia quiser ver como o que você pagou se compara com o que esse mesmo carro sai nos leilões de dealers, me manda o VIN que eu confiro para você.',
  es: '¡Felicidades por el auto! Si algún día quieres ver cómo se compara lo que pagaste con lo que ese mismo auto sale en las subastas de dealers, mándame el VIN y te lo reviso.'
};
const boughtReply = (lang) => BOUGHT[LANGS.includes(lang) ? lang : 'en'];

function sequence({ lang = 'en', name, link = null, car = null } = {}) {
  const t = TEXT[LANGS.includes(lang) ? lang : 'en'];
  const vehicle = car ? String(car).replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  return [t.one(firstName(name), vehicle), t.two, link ? t.link(link, vehicle) : t.ask(vehicle)];
}

// Portuguese copy of any sequence, for Leo to review what goes out in English or Spanish.
const review = (input) => sequence({ ...input, lang: 'pt' });

const api = { LANGS, sequence, review, firstName, boughtReply };
if (typeof module === 'object' && module.exports) module.exports = api;
if (root) root.MCSRetomarMensagens = api;
})(typeof window !== 'undefined' ? window : null);
