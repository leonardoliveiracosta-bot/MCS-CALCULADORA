/* Sold: o assistente da página. É o martelo de madeira do leiloeiro em forma de gente.
   Responde só com o que a página já diz (FAQ e How it works) e leva a pessoa para a calculadora,
   que é onde o atendimento começa. Não usa IA nem servidor: nunca inventa preço, prazo ou promessa.
   O FAQ e o texto do botão vêm da própria página (data-i18n), então seguem o idioma escolhido. */
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
      first: 'Your first step is the calculator: you see your numbers, and one of our specialists follows up with you personally.',
      teaser: 'Want to see your numbers before a dealer sets your price?',
      how: 'How it works',
      howIntro: 'Six steps, and you approve every one:',
      price: 'Every car and auction is different, so the calculator shows your estimate: your max bid, the fees and the total. Run it and a specialist reviews it with you.',
      deposit: 'The deposit is refundable and locks your max before we bid for you. If we do not win the car, you choose: refund or keep it for the next search.',
      human: 'Our specialists answer on WhatsApp, in English, Spanish or Portuguese.',
      whatsapp: 'Message us on WhatsApp',
      fallback: "I don't have a ready answer for that one. The best way is to run your numbers: a specialist reviews your case and answers you personally.",
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
      first: 'El primer paso es la calculadora: ves tus números y uno de nuestros especialistas te atiende personalmente.',
      teaser: '¿Quieres ver tus números antes de que un dealer fije tu precio?',
      how: 'Cómo funciona',
      howIntro: 'Seis pasos, y tú apruebas cada uno:',
      price: 'Cada auto y cada subasta son distintos, por eso la calculadora muestra tu estimado: tu oferta máxima, las tarifas y el total. Úsala y un especialista lo revisa contigo.',
      deposit: 'El depósito es reembolsable y fija tu máximo antes de que ofertemos por ti. Si no ganamos el auto, tú eliges: reembolso o dejarlo para la próxima búsqueda.',
      human: 'Nuestros especialistas responden por WhatsApp, en inglés, español o portugués.',
      whatsapp: 'Escríbenos por WhatsApp',
      fallback: 'No tengo una respuesta lista para eso. Lo mejor es calcular tus números: un especialista revisa tu caso y te responde personalmente.',
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
      first: 'O primeiro passo é a calculadora: você vê seus números e um dos nossos especialistas te atende pessoalmente.',
      teaser: 'Quer ver seus números antes que um dealer defina o seu preço?',
      how: 'Como funciona',
      howIntro: 'Seis passos, e você aprova cada um:',
      price: 'Cada carro e cada leilão são diferentes, por isso a calculadora mostra a sua estimativa: o seu lance máximo, as taxas e o total. Faça a conta e um especialista revisa com você.',
      deposit: 'O depósito é reembolsável e trava o seu máximo antes do lance. Se não ganharmos o carro, você escolhe: reembolso ou deixar para a próxima busca.',
      human: 'Nossos especialistas atendem pelo WhatsApp, em inglês, espanhol ou português.',
      whatsapp: 'Fale no WhatsApp',
      fallback: 'Não tenho uma resposta pronta para isso. O melhor caminho é fazer a sua conta: um especialista revisa o seu caso e te responde pessoalmente.',
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

  /* Palavras de cada pergunta do FAQ (q1..q8), nos três idiomas, já sem acento. */
  var KEYS = {
    q1: ['license', 'licence', 'dealer license', 'licencia', 'licenca', 'permit'],
    q2: ['choose', 'pick', 'which car', 'any car', 'model', 'elegir', 'escoger', 'escolher', 'modelo', 'qualquer carro', 'cualquier'],
    q3: ['who decides', 'max bid', 'maximum bid', 'my max', 'limit', 'quien decide', 'quem decide', 'lance maximo', 'oferta maxima', 'limite'],
    q4: ['dont win', "don't win", 'not win', 'lose', 'lost', 'no ganamos', 'perder', 'nao ganhar', 'nao ganharmos', 'no gana'],
    q5: ['after', 'purchased', 'title', 'bought', 'despues', 'depois', 'titulo', 'comprado'],
    q6: ['test drive', 'test-drive', 'see the car', 'inspect', 'inspection', 'condition', 'prueba', 'test', 'ver el auto', 'ver o carro', 'inspecao', 'inspeccion', 'condicao', 'condicion'],
    q7: ['financ', 'loan', 'credit', 'lender', 'credito', 'prestamo', 'emprestimo', 'parcel'],
    q8: ['receive', 'delivery', 'deliver', 'ship', 'pickup', 'pick up', 'transport', 'entrega', 'envio', 'enviar', 'recoger', 'retirar', 'receber', 'transporte', 'frete']
  };
  var INTENTS = [
    ['how', ['how it works', 'how does', 'how do', 'process', 'steps', 'como funciona', 'proceso', 'processo', 'passos', 'pasos']],
    ['price', ['price', 'cost', 'how much', 'fee', 'fees', 'total', 'cheap', 'save', 'quanto', 'cuanto', 'preco', 'precio', 'costo', 'custo', 'taxa', 'tarifa', 'economi', 'ahorr']],
    ['deposit', ['deposit', 'refund', 'deposito', 'reembolso', 'devolu']],
    ['human', ['human', 'person', 'agent', 'talk', 'call', 'phone', 'whatsapp', 'specialist', 'falar', 'hablar', 'pessoa', 'persona', 'atendente', 'especialista', 'ligar', 'llamar']]
  ];

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
    '.sold-chips{display:flex;flex-wrap:nowrap;gap:6px;padding:6px 12px 10px;overflow-x:auto;scrollbar-width:thin;-webkit-overflow-scrolling:touch;border-top:1px solid #e4dccb;mask-image:linear-gradient(90deg,#000 88%,transparent)}',
    '.sold-chip{flex:0 0 auto;white-space:nowrap;border:1px solid #d9cfb9;background:#fff;color:#1a1d21;border-radius:999px;padding:7px 11px;font:600 13px/1.2 "Barlow",system-ui,sans-serif;cursor:pointer}',
    '.sold-chip:hover{border-color:#c9a34e}',
    '.sold-form{display:flex;gap:8px;padding:10px 12px;border-top:1px solid #e4dccb;background:#fbf9f4}',
    '.sold-form input{flex:1 1 auto;min-width:0;border:1px solid #d9cfb9;border-radius:10px;padding:10px 11px;font:500 15px "Barlow",system-ui,sans-serif;background:#fff;color:#1a1d21}',
    '.sold-form button{border:0;border-radius:10px;padding:0 14px;background:#1a1d21;color:#f2efe9;font:700 14px "Barlow",system-ui,sans-serif;cursor:pointer}',
    '.sold-stamp{position:fixed;left:50%;top:42%;z-index:160;transform:translate(-50%,-50%) rotate(-12deg);padding:10px 26px;border:5px solid #9b1b23;border-radius:12px;color:#9b1b23;font:900 44px/1 "Barlow",system-ui,sans-serif;letter-spacing:.08em;background:rgba(255,255,255,.85);pointer-events:none;animation:sold-stamp .9s ease-out forwards}',
    '@keyframes sold-stamp{0%{opacity:0;transform:translate(-50%,-50%) rotate(-12deg) scale(2.2)}25%{opacity:1;transform:translate(-50%,-50%) rotate(-12deg) scale(.95)}70%{opacity:1}100%{opacity:0;transform:translate(-50%,-50%) rotate(-12deg) scale(1)}}',
    '@media (max-width:820px){.sold-panel{right:0;left:0;bottom:0;width:100%;max-height:82vh;border-radius:18px 18px 0 0}}',
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
    cta();
  }
  function answerFaq(n) {
    var answer = pageText('a' + n);
    say(answer || t('fallback'));
    cta();
  }
  function answer(kind) {
    if (kind === 'how') return answerHow();
    if (kind === 'price') { say(t('price')); return cta(); }
    if (kind === 'deposit') { say(t('deposit')); return cta(); }
    if (kind === 'human') { say(t('human')); cta(); return whatsappLink(); }
    if (/^q[1-8]$/.test(kind)) return answerFaq(kind.slice(1));
    say(t('fallback'));
    cta();
    whatsappLink();
  }

  /* A pergunta digitada: a intenção mais específica primeiro (como funciona, preço, depósito, falar com alguém), depois o FAQ. */
  function classify(text) {
    var value = ' ' + fold(text).replace(/[^a-z0-9' ]+/g, ' ') + ' ';
    for (var i = 0; i < INTENTS.length; i++) if (INTENTS[i][1].some(function (word) { return value.indexOf(word) !== -1; })) return INTENTS[i][0];
    var best = null, score = 0;
    Object.keys(KEYS).forEach(function (key) {
      var hits = KEYS[key].filter(function (word) { return value.indexOf(word) !== -1; }).length;
      if (hits > score) { score = hits; best = key; }
    });
    return best;
  }

  function renderChips() {
    chips.innerHTML = '';
    var list = [['how', t('how')]];
    for (var n = 1; n <= 8; n++) { var question = pageText('q' + n); if (question) list.push(['q' + n, sentence(question)]); }
    list.forEach(function (entry) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sold-chip';
      chip.textContent = entry[1];
      chip.addEventListener('click', function () { say(entry[1], 'me'); answer(entry[0]); });
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
