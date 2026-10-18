(() => {
  // Cars that match the client's search, read live from the active batch. Calm and short: the count shows how much is out
  // there, five cars stand out (each for one reason taken from the data), the rest sit behind one button as single lines,
  // three terms are explained and the specialist takes it from there. Only what may leave the company: the car, miles,
  // color, the state, the sale day and the estimated market reference (the same value as the V1). Never the MMR, the Buy
  // Now, the auction name or the VIN.
  const root = document.getElementById('options');
  const code = location.pathname.split('/').filter(Boolean).at(-1) || '';
  const PICKS = 5;
  const add = (parent, tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); parent.append(node); return node; };
  const zone = { timeZone: 'America/New_York' };
  const format = (value, options) => { const time = new Date(value || ''); return Number.isFinite(time.getTime()) ? new Intl.DateTimeFormat('en-US', { ...zone, ...options }).format(time) : ''; };
  const day = (value) => format(value, { weekday: 'short', month: 'short', day: 'numeric' });
  const shortDay = (value) => format(value, { month: 'short', day: 'numeric' });
  const money = (dollars) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(dollars);
  const miles = (car) => (car.miles === null || car.miles === undefined || !Number.isFinite(Number(car.miles)) ? '' : Number(car.miles).toLocaleString('en-US'));
  const price = (car) => { const value = Number(car.estimatedMarketReference); return Number.isFinite(value) && value > 0 ? value : null; };
  // One sentence per line, no final period: calmer to read.
  const lines = (parent, cls, list) => { const box = add(parent, 'div', cls); list.forEach((text) => add(box, 'span', '', text)); return box; };
  const time = (car) => { const at = Date.parse((car.sale && car.sale.at) || ''); return Number.isFinite(at) ? at : Infinity; };
  function saleText(car) {
    const sale = car.sale || {};
    if (sale.kind === 'AVAILABLE_UNTIL') return sale.at ? 'Available until ' + shortDay(sale.at) : 'Available now';
    if (!sale.at) return 'Date to be confirmed';
    return (sale.kind === 'AUCTION' ? 'Auction · ' : 'Sale · ') + day(sale.at);
  }

  // Five that stand out, each for one reason that is true in the data. A car is picked once; a reason whose car was
  // already picked is skipped; the remaining places go to the next cars to sell, without a reason.
  function standouts(cars) {
    if (cars.length <= PICKS) return cars.map((car) => ({ car, why: '' }));
    const picked = [];
    const has = (car) => picked.some((pick) => pick.car === car);
    const best = (list, value) => list.filter((car) => Number.isFinite(value(car))).sort((a, b) => value(a) - value(b) || time(a) - time(b))[0];
    const reasons = [
      ['Lowest miles', best(cars, (car) => (miles(car) ? Number(car.miles) : NaN))],
      ['Lowest price', best(cars, (car) => price(car) ?? NaN)],
      ['Newest', best(cars, (car) => (car.year ? -Number(car.year) : NaN))],
      ['First to auction', best(cars.filter((car) => car.sale && car.sale.kind !== 'AVAILABLE_UNTIL' && time(car) > Date.now()), time)],
      ['Can be bought now', best(cars.filter((car) => car.sale && car.sale.kind === 'AVAILABLE_UNTIL'), time)]
    ];
    reasons.forEach(([why, car]) => { if (car && !has(car) && picked.length < PICKS) picked.push({ car, why }); });
    cars.forEach((car) => { if (!has(car) && picked.length < PICKS) picked.push({ car, why: '' }); });
    return picked;
  }

  function card(parent, car, why) {
    const article = add(parent, 'article', 'car');
    if (why) add(article, 'p', 'tag', why);
    const fields = add(article, 'dl', 'fields');
    const colors = car.colors || {};
    [['Make', car.make], ['Model', car.model], ['Trim', car.trim], ['Year', car.year], ['Miles', miles(car)],
      ['Color', colors.exterior], ['Location', car.state], ['Sale', saleText(car)]].forEach(([label, value]) => {
      const cell = add(fields, 'div');
      add(cell, 'dt', '', label);
      add(cell, 'dd', '', value || 'Not listed');
    });
    const value = price(car);
    if (value) { const line = add(article, 'div', 'price'); add(line, 'span', '', 'Reference price for this vehicle'); add(line, 'b', '', money(value)); }
  }

  function row(parent, car) {
    const item = add(parent, 'li');
    add(item, 'span', '', [[car.year, car.model, car.trim].filter(Boolean).join(' '), miles(car) ? miles(car) + ' mi' : '', car.state].filter(Boolean).join(' · '));
    const value = price(car);
    if (value) add(item, 'b', '', money(value));
  }

  async function load() {
    try {
      const response = await fetch('/api/option-link?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      root.replaceChildren();
      const head = add(root, 'header', 'intro');
      add(head, 'p', 'brand', 'My Car Scout');
      if (data.closed) { add(head, 'h1', '', 'This search is closed'); return; }
      const cars = (data.cars || []).slice().sort((a, b) => time(a) - time(b)), count = cars.length;
      if (!count) {
        add(head, 'h1', '', 'No cars match your search right now');
        lines(head, 'lead', ['New auctions come in every week', 'Our buying team keeps looking for you']);
        return;
      }
      add(head, 'h1', '', count === 1 ? '1 car matches your search' : `${count} cars match your search`);
      lines(head, 'lead', ['From auctions open only to dealers', 'Before any dealer markup'].concat(count > PICKS ? [`The ${PICKS} that stand out`] : []));

      const picks = standouts(cars);
      const list = add(root, 'section', 'picks');
      picks.forEach(({ car, why }) => card(list, car, why));
      const rest = cars.filter((car) => !picks.some((pick) => pick.car === car));
      if (rest.length) {
        const more = add(add(root, 'div', 'more'), 'button', '', `See the other ${rest.length}`);
        more.type = 'button';
        const rows = add(root, 'ul', 'rows');
        rows.hidden = true;
        rest.forEach((car) => row(rows, car));
        more.addEventListener('click', () => { rows.hidden = !rows.hidden; more.textContent = rows.hidden ? `See the other ${rest.length}` : 'Show fewer'; });
      }

      const know = add(root, 'section', 'know');
      [['Trim', 'The version of the model', 'It changes equipment and finish'],
        ['Available until', 'The car can be bought before this date', 'No need to wait for the auction'],
        ['Reference price', 'Our estimate for this vehicle at auction', 'The final price is set on auction day']].forEach(([term, ...text]) => {
        const item = lines(know, 'term', text);
        item.prepend(Object.assign(document.createElement('b'), { textContent: term }));
      });
      const closing = add(root, 'footer', 'closing');
      add(closing, 'p', '', 'Your specialist will go over these with you before any bid');
      lines(closing, 'after', ['You’ll receive the photos, the history report', 'and the full auction listing of each car']);
    } catch (_) { root.replaceChildren(); add(root, 'p', 'muted', 'This page is unavailable right now'); }
  }
  load();
})();
