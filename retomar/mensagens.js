// RETOMAR: the 3 messages sent, one bubble at a time, to a client who wrote more than 15 days ago and got no reply.
// 1 owns the delay (with the client's car when known), 2 gives the advantage (and the options link when the client
// has options in the active batch), 3 is an open question that leads to our next step. Portuguese and Spanish carry
// the same meaning. Never the calculator: the lead stays with us.

(function attachMensagens(root) {
'use strict';
const firstName = (name) => {
  const word = String(name || '').trim().split(/\s+/)[0] || '';
  return /^[\p{L}][\p{L}'-]{1,30}$/u.test(word) ? word.charAt(0).toUpperCase() + word.slice(1) : '';
};

// Clienteling, as the luxury houses do it (Leo, 14/10): own the delay once, give the advantage first (access to the
// dealer-only auctions and what fits the client this week), then an open question that leads to the next step on our
// side. Never a yes/no the client can leave by, never "are you still looking". At most 3 bubbles (Florida 501.616(6)(b)).
const TEXT = {
  en: {
    one: (who, car) => `Hi${who ? ' ' + who : ''}, how are you? I owe you a reply${car ? ` about the ${car}` : ''}, and I’m sorry it took this long. You’re trusting us with a purchase made with your money, and that deserves our full attention, not a rushed answer just to clear an inbox.`,
    two: (link) => `As you may remember, we buy where dealerships buy: the dealer-only auctions, before the markup.${link ? ` I pulled what’s coming up this week that fits what you asked for:\n${link}` : ''}`,
    three: (link, car) => link
      ? 'As you look through them, which one feels closest to what you had in mind? From there I take care of the rest: the full history, the condition and the right number to bid.'
      : car
        ? `What would the right ${car} look like for you this time? The years, the color, the number you’d feel good about. With that, I’ll bring you what comes up at this week’s auctions.`
        : 'What are you looking to drive next? The car, the years and the number you’d feel good about. With that, I’ll bring you what comes up at this week’s auctions.'
  },
  pt: {
    one: (who, car) => `Oi${who ? ' ' + who : ''}, tudo bem? Eu te devia uma resposta${car ? ` sobre o ${car}` : ''}, e desculpa ter demorado tanto. Você está confiando a nós uma compra feita com o seu dinheiro, e isso merece a nossa atenção total, não uma resposta corrida só para zerar a caixa de mensagens.`,
    two: (link) => `Como você deve lembrar, a gente compra onde as concessionárias compram: nos leilões exclusivos de dealers, antes da margem delas.${link ? ` Separei o que está entrando nesta semana dentro do que você pediu:\n${link}` : ''}`,
    three: (link, car) => link
      ? 'Olhando as opções, qual delas mais se aproxima do que você tinha em mente? A partir daí eu cuido do resto: o histórico completo, a condição e o valor certo para o lance.'
      : car
        ? `Como seria o ${car} certo para você desta vez? Os anos, a cor, o valor com que você se sentiria bem. Com isso eu te trago o que aparecer nos leilões desta semana.`
        : 'Qual é o próximo carro que você quer dirigir? O carro, os anos e o valor com que você se sentiria bem. Com isso eu te trago o que aparecer nos leilões desta semana.'
  },
  es: {
    one: (who, car) => `Hola${who ? ' ' + who : ''}, ¿cómo estás? Te debía una respuesta${car ? ` sobre el ${car}` : ''}, y disculpa que haya tardado tanto. Nos estás confiando una compra hecha con tu dinero, y eso merece toda nuestra atención, no una respuesta apurada solo para vaciar la bandeja.`,
    two: (link) => `Como recordarás, compramos donde compran los concesionarios: en las subastas exclusivas para dealers, antes de su margen.${link ? ` Te separé lo que entra esta semana dentro de lo que pediste:\n${link}` : ''}`,
    three: (link, car) => link
      ? 'Al revisarlas, ¿cuál se acerca más a lo que tenías en mente? A partir de ahí yo me encargo del resto: el historial completo, la condición y el valor correcto para la oferta.'
      : car
        ? `¿Cómo sería el ${car} ideal para ti esta vez? Los años, el color, el valor con el que te sentirías bien. Con eso te traigo lo que salga en las subastas de esta semana.`
        : '¿Qué auto quieres manejar ahora? El auto, los años y el valor con el que te sentirías bien. Con eso te traigo lo que salga en las subastas de esta semana.'
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
  return [t.one(firstName(name), vehicle), t.two(link), t.three(link, vehicle)];
}

// Portuguese copy of any sequence, for Leo to review what goes out in English or Spanish.
const review = (input) => sequence({ ...input, lang: 'pt' });

const api = { LANGS, sequence, review, firstName, boughtReply };
if (typeof module === 'object' && module.exports) module.exports = api;
if (root) root.MCSRetomarMensagens = api;
})(typeof window !== 'undefined' ? window : null);
