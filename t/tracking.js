(() => {
  // The customer's search page. The cars look the same as the V1 page (/v/): auction day, average
  // auction value and "Show me this car", which records the answer and opens WhatsApp with a ready message.
  const root = document.getElementById('tracking');
  const code = location.pathname.split('/').filter(Boolean).at(-1) || '';
  const add = (parent, tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); parent.append(node); return node; };
  const money = (dollars) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(dollars) || 0);
  // "2026-10-01" has no time: that calendar day as is, never a shifted hour or a countdown.
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
  function countdown(value) {
    const remaining = Date.parse(value) - Date.now();
    if (!Number.isFinite(remaining) || remaining < 0) return 'Auction time has passed';
    const hours = Math.ceil(remaining / 3600000), days = Math.floor(hours / 24);
    return '⏱ ' + (days ? `${days} ${days === 1 ? 'day' : 'days'} ${hours % 24} h left` : `${hours} h left`);
  }
  const name = (car) => [car.year, car.make, car.model, car.trim].filter(Boolean).join(' ');
  const answer = (unitId, response) => fetch('/api/tracking?code=' + encodeURIComponent(code), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unitId, response }) });

  function card(car, data) {
    const vehicle = car.vehicle || {};
    const article = add(root, 'article', 'car');
    add(article, 'h2', '', name(car));
    add(article, 'p', 'muted', [car.miles ? Number(car.miles).toLocaleString('en-US') + ' mi' : '', vehicle.exteriorColor, vehicle.state].filter(Boolean).join(' · '));
    if (vehicle.cleanTitle || vehicle.odometerOk) {
      const tags = add(article, 'div', 'tags');
      if (vehicle.cleanTitle) add(tags, 'span', '', '✓ Clean title');
      if (vehicle.odometerOk) add(tags, 'span', '', '✓ Odometer OK');
    }
    const when = date(vehicle.startsAt);
    if (when) {
      const auction = add(article, 'section', 'auction');
      add(auction, 'div', 'label', 'Auction day');
      add(auction, 'div', 'value', when);
      if (dateOnly(vehicle.startsAt) === null) add(auction, 'b', '', countdown(vehicle.startsAt));
    }
    // Without MMR there is no reference value: the block is left out instead of showing "~ $0".
    if (Number(vehicle.averageAuctionValue) > 0) {
      const average = add(article, 'section', 'average');
      add(average, 'div', 'label', 'Average auction value');
      add(average, 'div', 'value', '~ ' + money(vehicle.averageAuctionValue));
      add(average, 'div', 'lines', 'What similar cars have been selling for at auction\nA reference, not a fixed price\nThe final price is set on auction day');
    }
    if (car.retailValue && car.retailUrl) {
      const retail = add(article, 'p', 'muted', 'Retail comparison: ' + money(car.retailValue) + ' · ');
      const link = add(retail, 'a', '', 'View comparison'); link.href = car.retailUrl; link.rel = 'noopener noreferrer';
    }
    const show = add(article, 'button', '', 'Show me this car'); show.type = 'button';
    add(article, 'p', 'muted', 'Opens WhatsApp with a ready message to our team');
    const status = add(article, 'p', car.response === 'WANT' ? 'confirm' : 'muted', car.response === 'WANT' ? "Got it — we'll reach out shortly" : car.response === 'DECLINE' ? 'You passed on this car' : '');
    let decline = null;
    if (!car.response) { decline = add(article, 'button', 'decline', 'Not for me'); decline.type = 'button'; }
    show.addEventListener('click', async () => {
      show.disabled = true;
      // The answer is recorded first (the team sees it in the panel); WhatsApp opens either way.
      if (!car.response) {
        try { const reply = await answer(car.id, 'WANT'); if (reply.ok || reply.status === 409) { car.response = 'WANT'; status.className = 'confirm'; status.textContent = "Got it — we'll reach out shortly"; if (decline) decline.remove(); } } catch (_) {}
      }
      show.disabled = false;
      location.href = 'https://wa.me/' + encodeURIComponent(data.whatsAppNumber || '') + '?text=' + encodeURIComponent(`Hey, I'd like to see the ${name(car)} (Ref ${data.ref})`);
    });
    if (decline) decline.addEventListener('click', async () => {
      decline.disabled = true;
      try {
        const reply = await answer(car.id, 'DECLINE');
        if (!reply.ok) { const failed = await reply.json().catch(() => ({})); throw new Error(failed.message || 'Please try again'); }
        car.response = 'DECLINE'; decline.remove(); status.className = 'muted'; status.textContent = 'You passed on this car';
      } catch (error) { decline.disabled = false; status.className = 'muted'; status.textContent = error.message || 'Please try again'; }
    });
  }

  async function load() {
    try {
      const response = await fetch('/api/tracking?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      root.replaceChildren();
      if (data.closed) { add(root, 'h1', 'title', 'This search is closed'); return; }
      const first = data.firstName && data.firstName !== 'there' ? data.firstName : '';
      const count = data.cars.length;
      add(root, 'div', 'eyebrow', `My Car Scout · Ref ${data.ref}`);
      add(root, 'h1', 'title', count ? `${first ? first + ', ' : ''}${count} ${count === 1 ? 'car' : 'cars'} for you` : `Hi ${first || 'there'}, here’s your search`);
      add(root, 'p', 'sub', count ? 'Found by our team at wholesale auctions' : 'We’ll add your options here as soon as they’re ready');
      if (data.step === 4) add(root, 'p', 'result', data.result === 'WON' ? "Won — we'll contact you about pickup" : 'Not won — your deposit is refunded or kept as credit, your choice');
      data.cars.forEach((car) => card(car, data));
      if (count) add(root, 'p', 'footer', 'Tap the car you like and send the message\nOur team replies with photos and full details');
      const steps = add(root, 'div', 'steps');
      ['Searching', 'Cars presented', 'Bid scheduled', 'Result'].forEach((label, index) => add(steps, 'div', 'step' + (index + 1 <= data.step ? ' on' : ''), label));
      add(root, 'p', 'muted', `Updated ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(data.updatedAt))}`);
    } catch (_) { root.replaceChildren(); add(root, 'p', 'muted', 'This search is unavailable right now'); }
  }
  load();
})();
