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
  function saleFacts(value, prefix = 'Auction') {
    if (!value || !date(value)) return [];
    const calendar = dateOnly(value);
    const instant = new Date(calendar === null ? value : calendar);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: calendar === null ? 'America/New_York' : 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(instant);
    const facts = [[prefix + ' day', day]];
    if (calendar === null) facts.push([prefix + ' time', new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(instant)]);
    return facts;
  }
  // Small vector pictograms identify the V1 facts without changing their labels or values.
  const v1FactIcons = {
    Mileage: '<path d="M3 18a9 9 0 1 1 18 0H3Zm9-5 4-5M5 12l2 1m10 0 2-1M12 4v2"/><circle cx="12" cy="14" r="1"/>',
    Engine: '<path d="M3 10h3l3-3h8l3 3v8h-3v3H8v-3H5v-4H3zM10 3h6m-3 0v4M20 11h2v6h-2M1 9v7"/>',
    Transmission: '<path d="M5 5v14m7-14v14m7-14v7H5"/><circle cx="5" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="19" cy="4" r="2"/><circle cx="5" cy="20" r="2"/><circle cx="12" cy="20" r="2"/>',
    Drivetrain: '<rect x="3" y="2" width="4" height="7" rx="1"/><rect x="17" y="2" width="4" height="7" rx="1"/><rect x="3" y="15" width="4" height="7" rx="1"/><rect x="17" y="15" width="4" height="7" rx="1"/><path d="M7 6h10M7 18h10M12 6v12"/>',
    Interior: '<rect x="9" y="2" width="6" height="4" rx="1.5"/><rect x="7" y="9" width="10" height="9" rx="3"/><path d="M6 22h12M10 6v3m4-3v3"/>',
    Exterior: '<path d="m4 10 8-8 9 9-8 8-9-9Zm1 1h15M8 2l3 3M20 16s-2 2.5-2 4a2 2 0 0 0 4 0c0-1.5-2-4-2-4Z"/>',
    Location: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    day: '<rect x="3" y="5" width="18" height="17" rx="2"/><path d="M7 2v6m10-6v6M3 11h18m-14 4h3m4 0h3m-10 4h3"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>'
  };
  function v1FactIcon(label) {
    const shape = v1FactIcons[label] || v1FactIcons[label.split(' ').at(-1)];
    return shape ? `<svg class="mcs-spec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${shape}</svg>` : '';
  }
  function v1Card(car, print) {
    const vehicle = car.vehicle || {}, carName = name(vehicle);
    const sales = (vehicle.purchaseOptions || []).filter(s => !Number.isFinite(Date.parse(s.endsAt)) || Date.parse(s.endsAt) > Date.now());
    const primary = sales[0];
    const timedSale = primary?.startsAt || (!primary ? vehicle.startsAt : null);
    const facts = [
      ['Mileage', vehicle.miles !== null && vehicle.miles !== undefined && vehicle.miles !== '' && Number.isFinite(Number(vehicle.miles)) ? Number(vehicle.miles).toLocaleString('en-US') + ' mi' : null],
      ['Engine', vehicle.engine], ['Transmission', vehicle.transmission], ['Drivetrain', vehicle.drivetrain],
      ['Interior', vehicle.interiorColor], ['Exterior', vehicle.exteriorColor], ['Location', vehicle.state],
      ...saleFacts(timedSale), ...(!timedSale ? saleFacts(primary?.endsAt || vehicle.endsAt, 'Available until') : [])
    ];
    const reference = Number(car.estimatedMarketReference) > 0 ? car.estimatedMarketReference : car.averageAuctionValue;
    const suffix = /^[A-HJ-NPR-Z0-9]{6}$/.test(car.vinLast6 || '') ? `VIN <b>${escape(car.vinLast6)}</b>` : '';
    const badges = [vehicle.cleanTitle === true ? '✓ Clean title' : '', vehicle.odometerOk === true ? '✓ Odometer OK' : ''].filter(Boolean);
    // Additional sale options remain available; never substitute their buy-now price for the reference.
    const options = sales.length > 1 || sales.some(s => Number(String(s.buyNowPrice || '').replace(/[$,]/g, '')) > 0 || (!s.startsAt && s.saleType)) ? `<section class="mcs-options"><span class="mcs-label">Ways to buy</span>${sales.map(s => `<p>${[s.saleType, Number(String(s.buyNowPrice || '').replace(/[$,]/g, '')) > 0 ? 'Buy Now ' + money(Number(String(s.buyNowPrice).replace(/[$,]/g, '')) * 100) : '', date(s.startsAt), s.endsAt ? 'until ' + date(s.endsAt) : ''].filter(Boolean).map(escape).join(' · ')}</p>`).join('')}</section>` : '';
    return `<article class="car mcs-car"><div class="mcs-hero"><div class="mcs-car-name"><p class="mcs-year">${[vehicle.year, vehicle.make].filter(Boolean).map(escape).join(' · ')}</p><h2>${escape(vehicle.model || carName || 'Vehicle')}</h2><p class="mcs-trim">${[escape(vehicle.trim), suffix].filter(Boolean).join(' · ')}</p></div>${Number(reference) > 0 ? `<div class="mcs-reference"><span class="mcs-label">Auction reference</span><strong>${money(reference * 100)}</strong><p>Final price set at auction</p></div>` : ''}</div>${car.whyChosen ? `<p class="mcs-why"><strong>Why we picked it:</strong> ${escape(car.whyChosen)}</p>` : ''}${gallery(car.photos, carName)}<dl class="mcs-facts">${facts.map(([label, value]) => `<div><dt>${v1FactIcon(label)}<span>${escape(label)}</span></dt><dd>${escape(value || 'Not listed')}</dd></div>`).join('')}</dl>${options}<footer class="mcs-action"><div>${badges.length ? `<p class="mcs-checks">${badges.join(' · ')}</p>` : ''}${print ? '' : '<p class="mcs-hint">Photos and full details on WhatsApp</p>'}</div>${print ? '' : `<button type="button" class="mcs-select" data-code="${escape(car.code)}" data-bid="false">Show me this car</button>`}</footer></article>`;
  }
  function v1Page(data, print) {
    return `<div class="v1-page"><header class="mcs-top">MY CAR SCOUT</header><div class="mcs-intro"><h1>${data.cars.length} ${data.cars.length === 1 ? 'car' : 'cars'}, selected for you</h1><span>${[escape(data.customerName), 'Ref ' + escape(data.referenceCode)].filter(Boolean).join(' · ')}</span></div>${data.cars.map(car => v1Card(car, print)).join('')}</div>`;
  }
  // print: the PDF of ENVIAR OPÇÕES, the same page without the interactive buttons.
  function card(car, version, print) {
    if (version === 'V1') return v1Card(car, print);
    const vehicle = car.vehicle, carName = name(vehicle), isV2 = version === 'V2';
    const tags = vehicle.cleanTitle || vehicle.odometerOk ? `<div class="tags">${vehicle.cleanTitle ? '<span>✓ Clean title</span>' : ''}${vehicle.odometerOk ? '<span>✓ Odometer OK</span>' : ''}</div>` : '';
    const limit = isV2 && car.customerLimitCents ? `<section class="limit"><div class="label">Your limit</div><div class="value">Up to ${money(car.customerLimitCents)}</div>${lines("You set the limit, we do the bidding\nYour limit is the most we'll bid, not what you pay\nIf we win it for less, you pay based on the winning bid")}</section>` : '';
    const note = isV2 && car.note ? `<p class="note">${escape(car.note)}</p>` : '';
    const why = car.whyChosen ? `<p class="why"><strong>Why we picked it:</strong> ${escape(car.whyChosen)}</p>` : '';
    const when = date(vehicle.startsAt);
    const sales = (vehicle.purchaseOptions || []).filter(s => !Number.isFinite(Date.parse(s.endsAt)) || Date.parse(s.endsAt)>Date.now());
    const auction = sales.length ? `<section class="auction"><div class="label">Ways to buy</div>${sales.map(s=>`<div>${[s.lane&&s.run?`Auction Lane ${s.lane} / Run ${s.run}`:'',Number(String(s.buyNowPrice||'').replace(/[$,]/g,''))>0?`Buy Now ${money(Number(String(s.buyNowPrice).replace(/[$,]/g,''))*100)}`:'',s.saleType,date(s.startsAt),s.endsAt?`until ${date(s.endsAt)}`:''].filter(Boolean).map(escape).join(' · ')}</div>`).join('')}</section>` : when ? `<section class="auction"><div class="label">Auction day</div><div class="value">${escape(when)}</div>${dateOnly(vehicle.startsAt) === null ? `<b>${escape(countdown(vehicle.startsAt))}</b>` : ''}</section>` : '';
    // Without MMR there is no reference value: the block is left out instead of showing "~ $0"
    const average = Number(car.estimatedMarketReference) > 0 ? `<section class="average"><div class="label">Estimated market reference</div><div class="value">~ ${money(car.estimatedMarketReference * 100)}</div>${lines('A reference, not a fixed price\nThe final price is set on auction day')}</section>` : Number(car.averageAuctionValue) > 0 ? `<section class="average"><div class="label">Average auction value</div><div class="value">~ ${money(car.averageAuctionValue * 100)}</div>${lines('A reference, not a fixed price\nThe final price is set on auction day')}</section>` : '';
    // V2: o nome do carro ja e o titulo da pagina; ordem aprovada: galeria, selos, especificacoes, leilao, valor, limite, nota
    const head = isV2 ? '' : `<h2>${escape(carName)}</h2><p class="muted">${[vehicle.miles && Number(vehicle.miles).toLocaleString('en-US') + ' mi', vehicle.exteriorColor, vehicle.state].filter(Boolean).map(escape).join(' · ')}</p>`;
    return `<article class="car">${head}${why}${gallery(car.photos, carName)}${tags}${isV2 ? specs(vehicle) + auction + average : auction + average}${limit}${note}${print ? '' : `<button data-code="${car.code}" data-bid="${isV2}">${isV2 ? 'I want to bid' : 'Show me this car'}</button><p class="muted">Opens WhatsApp with a ready message to our team</p>`}</article>`;
  }
  function page(data, print) {
    if (data.version === 'V1') return v1Page(data, print);
    const version = data.version;
    const content = `<div class="eyebrow">My Car Scout · Ref ${escape(data.referenceCode)}</div><h1 class="title">${version === 'V2' ? escape(name(data.cars[0]?.vehicle || {})) : `${data.customerName ? escape(data.customerName) + ', ' : ''}${data.cars.length} ${data.cars.length === 1 ? 'car' : 'cars'} for you`}</h1><p class="sub">${version === 'V2' ? `${escape(data.customerName || 'There')}, here's the car you asked to see` : 'Found by our team at wholesale auctions'}</p>${data.cars.map((car) => card(car, version, print)).join('')}${version === 'V2' ? '' : '<p class="footer">Tap the car you like and send the message\nOur team replies with photos and full details</p>'}`;
    return version === 'V2' ? `<div class="v2-page">${content}</div>` : content;
  }
  window.MCSVitrineRender = { page, name, escape, date, dateOnly, money };
})();
