(() => {
  'use strict';
  const app = document.querySelector('#app');
  const token = location.pathname.split('/').filter(Boolean).at(-1);
  let whatsAppNumber = '';
  const { name, escape } = window.MCSVitrineRender;
  async function event(eventType, code) { return fetch('/api/vitrine?token=' + encodeURIComponent(token), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ event:eventType, code }) }).catch(() => null); }
  function openWhatsApp(car, bid) {
    event('TAP', car.code);
    const text = bid ? `Hey, I want to bid on the ${name(car.vehicle)} (${car.code})` : `Hey, I'd like to see the ${name(car.vehicle)} (${car.code})`;
    location.href = 'https://wa.me/' + encodeURIComponent(whatsAppNumber) + '?text=' + encodeURIComponent(text);
  }
  async function load() {
    const response = await fetch('/api/vitrine?token=' + encodeURIComponent(token));
    if (!response.ok) throw Error();
    const data = await response.json();
    whatsAppNumber = String(data.whatsAppNumber || '');
    if (data.expired) {
      app.innerHTML = '<section class="expired"><h1>This auction has ended</h1><p>Ask us about similar cars</p><button>Ask our team</button></section>';
      app.querySelector('button').onclick = () => { location.href = 'https://wa.me/' + encodeURIComponent(whatsAppNumber) + '?text=' + encodeURIComponent(`Hey, I'd like to see similar cars (Ref ${data.referenceCode})`); };
      return;
    }
    event('OPEN');
    app.innerHTML = window.MCSVitrineRender.page(data, false);
    app.querySelectorAll('button[data-code]').forEach((button) => { button.onclick = () => openWhatsApp(data.cars.find((car) => car.code === button.dataset.code), button.dataset.bid === 'true'); });
  }
  load().catch(() => { app.textContent = 'This link is unavailable'; });
})();
