(() => {
  'use strict';
  // Markup of the customer page (/v/<token>), shared by the link page and the PDF of ENVIAR OPÇÕES so both are the same thing.
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
  function countdown(value) {
    const remaining = Date.parse(value) - Date.now();
    if (!Number.isFinite(remaining) || remaining < 0) return 'Auction time has passed';
    const hours = Math.ceil(remaining / 3600000), days = Math.floor(hours / 24);
    return '⏱ ' + (days ? `${days} ${days === 1 ? 'day' : 'days'} ${hours % 24} h left` : `${hours} h left`);
  }
  function gallery(photos, carName) { return photos?.length ? `<div class="gallery">${photos.map((url) => `<img src="${escape(url)}" alt="${escape(carName)}">`).join('')}</div>` : ''; }
  function specs(vehicle) { return `<section class="specs">${[['Mileage', vehicle.miles ? Number(vehicle.miles).toLocaleString('en-US') + ' mi' : ''], ['Location', vehicle.state], ['Exterior', vehicle.exteriorColor], ['Interior', vehicle.interiorColor], ['Drivetrain', vehicle.drivetrain], ['Transmission', vehicle.transmission], ['Engine', vehicle.engine]].filter((item) => item[1]).map((item) => `<div><small>${item[0]}</small>${escape(item[1])}</div>`).join('')}</section>`; }
  // print: the PDF of ENVIAR OPÇÕES, the same page without the interactive buttons.
  function card(car, version, print) {
    const vehicle = car.vehicle, carName = name(vehicle), isV2 = version === 'V2';
    const tags = vehicle.cleanTitle || vehicle.odometerOk ? `<div class="tags">${vehicle.cleanTitle ? '<span>✓ Clean title</span>' : ''}${vehicle.odometerOk ? '<span>✓ Odometer OK</span>' : ''}</div>` : '';
    const limit = isV2 && car.customerLimitCents ? `<section class="limit"><div class="label">Your limit</div><div class="value">Up to ${money(car.customerLimitCents)}</div>${lines("You set the limit, we do the bidding\nYour limit is the most we'll bid, not what you pay\nIf we win it for less, you pay based on the winning bid")}</section>` : '';
    const note = isV2 && car.note ? `<p class="note">${escape(car.note)}</p>` : '';
    const when = date(vehicle.startsAt);
    const sales = (vehicle.purchaseOptions || []).filter(s => !Number.isFinite(Date.parse(s.endsAt)) || Date.parse(s.endsAt)>Date.now());
    const auction = sales.length ? `<section class="auction"><div class="label">Ways to buy</div>${sales.map(s=>`<div>${[s.lane&&s.run?`Auction Lane ${s.lane} / Run ${s.run}`:'',Number(String(s.buyNowPrice||'').replace(/[$,]/g,''))>0?`Buy Now ${money(Number(String(s.buyNowPrice).replace(/[$,]/g,''))*100)}`:'',s.saleType,date(s.startsAt),s.endsAt?`until ${date(s.endsAt)}`:''].filter(Boolean).map(escape).join(' · ')}</div>`).join('')}</section>` : when ? `<section class="auction"><div class="label">Auction day</div><div class="value">${escape(when)}</div>${dateOnly(vehicle.startsAt) === null ? `<b>${escape(countdown(vehicle.startsAt))}</b>` : ''}</section>` : '';
    // Without MMR there is no reference value: the block is left out instead of showing "~ $0"
    const average = Number(car.estimatedMarketReference) > 0 ? `<section class="average"><div class="label">Estimated market reference</div><div class="value">~ ${money(car.estimatedMarketReference * 100)}</div>${lines('A reference, not a fixed price\nThe final price is set on auction day')}</section>` : Number(car.averageAuctionValue) > 0 ? `<section class="average"><div class="label">Average auction value</div><div class="value">~ ${money(car.averageAuctionValue * 100)}</div>${lines('A reference, not a fixed price\nThe final price is set on auction day')}</section>` : '';
    // V2: o nome do carro ja e o titulo da pagina; ordem aprovada: galeria, selos, especificacoes, leilao, valor, limite, nota
    const head = isV2 ? '' : `<h2>${escape(carName)}</h2><p class="muted">${[vehicle.miles && Number(vehicle.miles).toLocaleString('en-US') + ' mi', vehicle.exteriorColor, vehicle.state].filter(Boolean).map(escape).join(' · ')}</p>`;
    return `<article class="car">${head}${gallery(car.photos, carName)}${tags}${isV2 ? specs(vehicle) + auction + average : auction + average}${limit}${note}${print ? '' : `<button data-code="${car.code}" data-bid="${isV2}">${isV2 ? 'I want to bid' : 'Show me this car'}</button><p class="muted">Opens WhatsApp with a ready message to our team</p>`}</article>`;
  }
  function page(data, print) {
    const version = data.version;
    return `<div class="eyebrow">My Car Scout · Ref ${escape(data.referenceCode)}</div><h1 class="title">${version === 'V2' ? escape(name(data.cars[0]?.vehicle || {})) : `${data.customerName ? escape(data.customerName) + ', ' : ''}${data.cars.length} ${data.cars.length === 1 ? 'car' : 'cars'} for you`}</h1><p class="sub">${version === 'V2' ? `${escape(data.customerName || 'There')}, here's the car you asked to see` : 'Found by our team at wholesale auctions'}</p>${data.cars.map((car) => card(car, version, print)).join('')}${version === 'V2' ? '' : '<p class="footer">Tap the car you like and send the message\nOur team replies with photos and full details</p>'}`;
  }
  window.MCSVitrineRender = { page, name, escape, date, dateOnly, money };
})();
