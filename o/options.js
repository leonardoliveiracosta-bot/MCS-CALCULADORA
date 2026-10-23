(() => {
  // Cars that match the client's search, read live from the active batch. Five compact rows open first;
  // the rest sit behind one button in the same format,
  // three terms are explained and the specialist takes it from there. Only what may leave the company: the car, miles,
  // color, the state, the sale day and the estimated market reference (the same value as the V1). Never the MMR, the Buy
  // Now, the auction name or the full VIN. Only the last 6 VIN characters identify each car.
  const root = document.getElementById('options');
  const code = location.pathname.split('/').filter(Boolean).at(-1) || '';
  const PICKS = 5;
  const add = (parent, tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); parent.append(node); return node; };
  const money = (dollars) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(dollars);
  const miles = (car) => (car.miles === null || car.miles === undefined || !Number.isFinite(Number(car.miles)) ? '' : Number(car.miles).toLocaleString('en-US'));
  const price = (car) => { const value = Number(car.estimatedMarketReference); return Number.isFinite(value) && value > 0 ? value : null; };
  // One sentence per line, no final period: calmer to read.
  const lines = (parent, cls, list) => { const box = add(parent, 'div', cls); list.forEach((text) => add(box, 'span', '', text)); return box; };
  const time = (car) => { const at = Date.parse((car.sale && car.sale.at) || ''); return Number.isFinite(at) ? at : Infinity; };
  function row(parent, car) {
    const item = add(parent, 'li');
    add(item, 'span', '', [[car.year, car.make, car.model, car.trim].filter(Boolean).join(' '), miles(car) ? miles(car) + ' mi' : '', car.state, car.vinLast6 ? 'VIN ' + car.vinLast6 : 'VIN not listed'].filter(Boolean).join(' · '));
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
      lines(head, 'lead', ['From auctions open only to dealers', 'Before any dealer markup']);

      const list = add(root, 'ul', 'rows first-options');
      cars.slice(0, PICKS).forEach((car) => row(list, car));
      const rest = cars.slice(PICKS);
      if (rest.length) {
        const more = add(add(root, 'div', 'more'), 'button', '', `See the other ${rest.length}`);
        more.type = 'button';
        const rows = add(root, 'ul', 'rows other-options');
        rows.hidden = true;
        rows.id = 'other-options';more.setAttribute('aria-controls', rows.id);more.setAttribute('aria-expanded', 'false');
        rest.forEach((car) => row(rows, car));
        more.addEventListener('click', () => { rows.hidden = !rows.hidden; more.textContent = rows.hidden ? `See the other ${rest.length}` : 'Show fewer';more.setAttribute('aria-expanded', String(!rows.hidden)); });
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
