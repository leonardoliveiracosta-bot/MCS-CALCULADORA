(() => {
  'use strict';
  const app = document.querySelector('#app');
  const token = location.pathname.split('/').filter(Boolean).at(-1);
  let whatsAppNumber = '';
  const money = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format((Number(value) || 0) / 100);
  // "2026-10-01" or "10/01/2026" has no time: show that calendar day as is, never a shifted hour or a countdown
  const dateOnly = (value) => {
    const text = String(value || '').trim();
    let hit = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (hit) return Date.UTC(Number(hit[1]), Number(hit[2]) - 1, Number(hit[3]));
    hit = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return hit ? Date.UTC(Number(hit[3]), Number(hit[1]) - 1, Number(hit[2])) : null;
  };
  const date = (value) => {
    if (!value) return '';
    const day = dateOnly(value);
    if (day !== null) return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(day));
    const time = new Date(value);
    return Number.isFinite(time.getTime()) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(time) : '';
  };
  const name = (vehicle) => [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ');
  const lines = (text) => `<div class="lines">${text}</div>`;
  const escape = (value) => String(value || '').replace(/[&<>"']/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
  async function event(eventType, code) { return fetch('/api/vitrine?token=' + encodeURIComponent(token), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ event:eventType, code }) }).catch(() => null); }
  function openWhatsApp(car, bid) {
    event('TAP', car.code);
    const text = bid ? `Hey, I want to bid on the ${name(car.vehicle)} (${car.code})` : `Hey, I'd like to see the ${name(car.vehicle)} (${car.code})`;
    location.href = 'https://wa.me/' + encodeURIComponent(whatsAppNumber) + '?text=' + encodeURIComponent(text);
  }
  function countdown(value) {
    const remaining = Date.parse(value) - Date.now();
    if (!Number.isFinite(remaining) || remaining < 0) return 'Auction time has passed';
    const hours = Math.ceil(remaining / 3600000), days = Math.floor(hours / 24);
    return days ? `${days} day ${hours % 24} h left` : `${hours} h left`;
  }
  function gallery(photos, carName) { return photos?.length ? `<div class="gallery">${photos.map((url) => `<img src="${escape(url)}" alt="${escape(carName)}">`).join('')}</div>` : ''; }
  function specs(vehicle) { return `<section class="specs">${[['Mileage', vehicle.miles ? Number(vehicle.miles).toLocaleString() + ' mi' : ''], ['Location', vehicle.state], ['Exterior', vehicle.exteriorColor], ['Interior', vehicle.interiorColor], ['Drivetrain', vehicle.drivetrain], ['Transmission', vehicle.transmission], ['Engine', vehicle.engine]].filter((item) => item[1]).map((item) => `<div><small>${item[0]}</small>${escape(item[1])}</div>`).join('')}</section>`; }
  function card(car, version) {
    const vehicle = car.vehicle, carName = name(vehicle), isV2 = version === 'V2';
    const tags = vehicle.cleanTitle || vehicle.odometerOk ? `<div class="tags">${vehicle.cleanTitle ? '<span>✓ Clean title</span>' : ''}${vehicle.odometerOk ? '<span>✓ Odometer OK</span>' : ''}</div>` : '';
    const limit = isV2 && car.customerLimitCents ? `<section class="limit"><div class="label">Your limit</div><div class="value">Up to ${money(car.customerLimitCents)}</div>${lines("You set the limit, we do the bidding\nYour limit is the most we'll bid, not what you pay\nIf we win it for less, you pay based on the winning bid")}</section>` : '';
    const note = isV2 && car.note ? `<p class="note">${escape(car.note)}</p>` : '';
    const when = date(vehicle.startsAt);
    const auction = when ? `<section class="auction"><div class="label">Auction day</div><div class="value">${escape(when)}</div>${dateOnly(vehicle.startsAt) === null ? `<b>${escape(countdown(vehicle.startsAt))}</b>` : ''}</section>` : '';
    // Without MMR there is no reference value: the block is left out instead of showing "~ $0"
    const average = Number(car.estimatedMarketReference) > 0 ? `<section><div class="label">Estimated market reference</div><div class="value">~ ${money(car.estimatedMarketReference * 100)}</div>${lines('A reference, not a fixed price\nThe final price is set on auction day')}</section>` : Number(car.averageAuctionValue) > 0 ? `<section><div class="label">Average auction value</div><div class="value">~ ${money(car.averageAuctionValue * 100)}</div>${lines('A reference, not a fixed price\nThe final price is set on auction day')}</section>` : '';
    // V2: o nome do carro ja e o titulo da pagina; ordem aprovada: galeria, selos, especificacoes, leilao, valor, limite, nota
    const head = isV2 ? '' : `<h2>${escape(carName)}</h2><p class="muted">${[vehicle.miles && Number(vehicle.miles).toLocaleString() + ' mi', vehicle.exteriorColor, vehicle.state].filter(Boolean).map(escape).join(' · ')}</p>`;
    return `<article class="car">${head}${gallery(car.photos, carName)}${tags}${isV2 ? specs(vehicle) + auction + average : auction + average}${limit}${note}<button data-code="${car.code}" data-bid="${isV2}">${isV2 ? 'I want to bid' : 'Show me this car'}</button><p class="muted">Opens WhatsApp with a ready message to our team</p></article>`;
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
    const version = data.version;
    app.innerHTML = `<div class="eyebrow">My Car Scout · Ref ${escape(data.referenceCode)}</div><h1 class="title">${version === 'V2' ? escape(name(data.cars[0]?.vehicle || {})) : `${data.customerName ? escape(data.customerName) + ', ' : ''}${data.cars.length} ${data.cars.length === 1 ? 'car' : 'cars'} for you`}</h1><p class="sub">${version === 'V2' ? `${escape(data.customerName || 'There')}, here's the car you asked to see` : 'Found by our team at wholesale auctions'}</p>${data.cars.map((car) => card(car, version)).join('')}${version === 'V2' ? '' : '<p class="footer">Tap the car you like and send the message\nOur team replies with photos and full details</p>'}`;
    app.querySelectorAll('button[data-code]').forEach((button) => { button.onclick = () => openWhatsApp(data.cars.find((car) => car.code === button.dataset.code), button.dataset.bid === 'true'); });
  }
  load().catch(() => { app.textContent = 'This link is unavailable'; });
})();
