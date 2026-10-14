// RETOMAR: the 3 messages sent, one bubble at a time, to a client who wrote more than 15 days ago and got no reply.
// 1 owns the delay (with the client's car when known), 2 gives the advantage (and the options link when the client
// has options in the active batch), 3 closes the sequence and leaves the door open: it never depends on a reply
// (Leo, 14/10: most do not answer, so the 3 bubbles go at once and say everything). Portuguese and Spanish carry
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
      ? 'Take your time with them. When one catches your eye, just tell me which and I’ll take care of the rest: the full history, the condition and the right number to bid. I’m here whenever you’re ready.'
      : car
        ? `When you’re ready, just tell me the years and the number you’d feel good about for the ${car}, and I’ll bring you what comes up at the auctions. No rush, I’m here.`
        : 'When you’re ready, just tell me the car and the number you’d feel good about, and I’ll bring you what comes up at the auctions. No rush, I’m here.'
  },
  pt: {
    one: (who, car) => `Oi${who ? ' ' + who : ''}, tudo bem? Eu te devia uma resposta${car ? ` sobre o ${car}` : ''}, e desculpa ter demorado tanto. Você está confiando a nós uma compra feita com o seu dinheiro, e isso merece a nossa atenção total, não uma resposta corrida só para zerar a caixa de mensagens.`,
    two: (link) => `Como você deve lembrar, a gente compra onde as concessionárias compram: nos leilões exclusivos de dealers, antes da margem delas.${link ? ` Separei o que está entrando nesta semana dentro do que você pediu:\n${link}` : ''}`,
    three: (link, car) => link
      ? 'Veja com calma. Quando alguma chamar a sua atenção, é só me dizer qual que eu cuido do resto: o histórico completo, a condição e o valor certo para o lance. Estou aqui quando você quiser.'
      : car
        ? `Quando quiser, é só me dizer os anos e o valor com que você se sentiria bem no ${car}, que eu te trago o que aparecer nos leilões. Sem pressa, estou aqui.`
        : 'Quando quiser, é só me dizer o carro e o valor com que você se sentiria bem, que eu te trago o que aparecer nos leilões. Sem pressa, estou aqui.'
  },
  es: {
    one: (who, car) => `Hola${who ? ' ' + who : ''}, ¿cómo estás? Te debía una respuesta${car ? ` sobre el ${car}` : ''}, y disculpa que haya tardado tanto. Nos estás confiando una compra hecha con tu dinero, y eso merece toda nuestra atención, no una respuesta apurada solo para vaciar la bandeja.`,
    two: (link) => `Como recordarás, compramos donde compran los concesionarios: en las subastas exclusivas para dealers, antes de su margen.${link ? ` Te separé lo que entra esta semana dentro de lo que pediste:\n${link}` : ''}`,
    three: (link, car) => link
      ? 'Míralas con calma. Cuando alguna te llame la atención, solo dime cuál y yo me encargo del resto: el historial completo, la condición y el valor correcto para la oferta. Aquí estoy cuando quieras.'
      : car
        ? `Cuando quieras, solo dime los años y el valor con el que te sentirías bien para el ${car}, y te traigo lo que salga en las subastas. Sin prisa, aquí estoy.`
        : 'Cuando quieras, solo dime qué auto y el valor con el que te sentirías bien, y te traigo lo que salga en las subastas. Sin prisa, aquí estoy.'
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

// When the client answers: what he said (label for Leo, in Portuguese) and the reply in his language. Each one gives
// something and moves one step (choose a car, check it, V1).
const REPLIES = [
  { label: 'Escolheu um carro', en: 'Great choice. I’ll pull its full history and condition and come back to you with the number I’d bid.', pt: 'Ótima escolha. Vou puxar o histórico completo e a condição e volto com o valor que eu daria de lance.', es: 'Excelente elección. Saco el historial completo y la condición y vuelvo con el valor que yo ofrecería.' },
  { label: 'Pediu mais informação ou como funciona', en: 'Happy to. The short version: you pick the car and set your max, we bid and never go above it. Which of the options caught your eye first?', pt: 'Com prazer. Resumindo: você escolhe o carro e define o seu máximo, a gente dá o lance e nunca passa disso. Qual das opções te chamou atenção primeiro?', es: 'Con gusto. En resumen: tú eliges el auto y defines tu máximo, nosotros ofertamos y nunca lo pasamos. ¿Cuál de las opciones te llamó la atención primero?' },
  { label: 'Perguntou o preço', en: 'The link shows an auction ceiling as a reference. The real number depends on the car’s history and condition, and you always set the max. Which one would you like me to check first?', pt: 'O link mostra um teto de leilão como referência. O valor real depende do histórico e da condição do carro, e quem define o máximo é sempre você. Qual você quer que eu confira primeiro?', es: 'El link muestra un tope de subasta como referencia. El valor real depende del historial y la condición del auto, y el máximo siempre lo defines tú. ¿Cuál quieres que revise primero?' },
  { label: 'Disse que já comprou', en: BOUGHT.en, pt: BOUGHT.pt, es: BOUGHT.es },
  { label: 'Respondeu algo vago (ok, obrigado)', en: 'My pleasure. When you have a minute, tell me which one stands out to you and I’ll take it from there.', pt: 'Imagina. Quando tiver um minuto, me diz qual te chama mais atenção e eu sigo daí.', es: 'Con gusto. Cuando tengas un minuto, dime cuál te llama más la atención y sigo desde ahí.' }
];
const replies = (lang) => REPLIES.map((reply) => ({ label: reply.label, text: reply[LANGS.includes(lang) ? lang : 'en'] }));

function sequence({ lang = 'en', name, link = null, car = null } = {}) {
  const t = TEXT[LANGS.includes(lang) ? lang : 'en'];
  const vehicle = car ? String(car).replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  return [t.one(firstName(name), vehicle), t.two(link), t.three(link, vehicle)];
}

// Portuguese copy of any sequence, for Leo to review what goes out in English or Spanish.
const review = (input) => sequence({ ...input, lang: 'pt' });

const api = { LANGS, sequence, review, firstName, boughtReply, replies };
if (typeof module === 'object' && module.exports) module.exports = api;
if (root) root.MCSRetomarMensagens = api;
})(typeof window !== 'undefined' ? window : null);
