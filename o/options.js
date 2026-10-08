(() => {
  // Cars that match the client's search, read live from the active batch. What the client needs to choose comes first: one
  // clear card per option with what differs between them (version, miles, location, colors), a live countdown to each
  // sale and, when the data shows it, why a car stands out among the others. Only what may leave the company: the car, miles, colors, the state, the sale day and
  // the VIN without its last 6 characters. No price and no auction name ever reach this page.
  const root = document.getElementById('options');
  const code = location.pathname.split('/').filter(Boolean).at(-1) || '';
  const add = (parent, tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); parent.append(node); return node; };
  const zone = { timeZone: 'America/New_York' };
  const format = (value, options) => { const time = new Date(value || ''); return Number.isFinite(time.getTime()) ? new Intl.DateTimeFormat('en-US', { ...zone, ...options }).format(time) : ''; };
  const day = (value) => format(value, { weekday: 'short', month: 'short', day: 'numeric' });
  const hour = (value) => format(value, { hour: 'numeric', minute: '2-digit' });
  // The time left to a sale, from this device's clock, to the second (redrawn every second).
  function left(value) {
    const ms = Date.parse(value || '') - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'now';
    const total = Math.floor(ms / 1000), days = Math.floor(total / 86400), hours = Math.floor((total % 86400) / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
    const two = (n) => String(n).padStart(2, '0');
    if (days) return `in ${days}d ${two(hours)}h ${two(minutes)}m ${two(seconds)}s`;
    if (hours) return `in ${hours}h ${two(minutes)}m ${two(seconds)}s`;
    return `in ${minutes}m ${two(seconds)}s`;
  }
  // A swatch for the color name the auction gives ("Obsidian Black", "Selenite Gray"); unknown names get a neutral tone.
  const SWATCHES = [['black', '#111214'], ['obsidian', '#111214'], ['onyx', '#141414'], ['white', '#f4f3ef'], ['pearl', '#efeee8'], ['ivory', '#efe8d6'], ['cream', '#efe4c9'],
    ['silver', '#c3c6cb'], ['graphite', '#4b4f55'], ['charcoal', '#3a3d42'], ['gray', '#7b7f86'], ['grey', '#7b7f86'], ['selenite', '#8a8e94'], ['blue', '#1f3f8a'], ['navy', '#1b2a4a'],
    ['red', '#9b1c22'], ['burgundy', '#5c1420'], ['orange', '#d0601e'], ['yellow', '#e3b81f'], ['green', '#2f5d3a'], ['beige', '#d9c6a5'], ['macchiato', '#c9ad86'], ['tan', '#c19a6b'],
    ['saddle', '#8b5a2b'], ['cognac', '#8f4a1f'], ['brown', '#5a3a26'], ['gold', '#c8a24a'], ['bronze', '#8c6239']];
  const swatch = (name) => { const text = String(name || '').toLowerCase(); const hit = SWATCHES.find(([key]) => text.includes(key)); return hit ? hit[1] : '#a7a7a7'; };
  // Why a car stands out, only from the data and only when it is the one (a tie says nothing).
  function standouts(cars) {
    const notes = new Map(cars.map((car) => [car, []]));
    if (cars.length < 2) return notes;
    const only = (list, pick, note) => { const values = list.map(pick).filter(Number.isFinite); if (values.length < 2) return; const best = Math.min(...values); const hits = list.filter((car) => pick(car) === best); if (hits.length === 1) notes.get(hits[0]).push(note); };
    only(cars, (car) => car.miles === null ? NaN : Number(car.miles), `Lowest miles of the ${cars.length}`);
    only(cars.filter((car) => car.sale && car.sale.kind !== 'AVAILABLE_UNTIL'), (car) => Date.parse(car.sale.at || ''), 'First to go to auction');
    only(cars, (car) => car.year ? -Number(car.year) : NaN, `Newest of the ${cars.length}`);
    return notes;
  }
  const timers = [];
  const tick = (node, at, prefix = '') => { const paint = () => { node.textContent = prefix + left(at); }; paint(); timers.push(paint); };

  function fact(parent, label, value, color) {
    if (!value) return;
    const cell = add(parent, 'div', 'fact');
    add(cell, 'span', 'fact-label', label);
    const text = add(cell, 'b', 'fact-value');
    if (color) add(text, 'i', 'swatch').style.background = swatch(color);
    text.append(String(value));
  }

  // One car, one card: what differs from the other options first (the client chose the make; it only shows when the
  // list mixes makes).
  function card(car, notes, index, count, showMake) {
    const article = add(root, 'article', 'car');
    add(article, 'div', 'car-option', count > 1 ? `Option ${index + 1} of ${count}` : 'Your option');
    add(article, 'h2', 'car-title', [car.year, showMake ? car.make : '', car.model, car.trim].filter(Boolean).join(' ') || 'Vehicle');
    const facts = add(article, 'div', 'facts');
    fact(facts, 'Miles', car.miles !== null && car.miles !== undefined ? Number(car.miles).toLocaleString('en-US') : '');
    fact(facts, 'Location', car.state);
    const colors = car.colors || {};
    fact(facts, 'Exterior', colors.exterior, colors.exterior);
    fact(facts, 'Interior', colors.interior, colors.interior);
    if (notes.length) add(article, 'div', 'why', '★ ' + notes.join(' · '));
    const sale = car.sale || {};
    const when = add(article, 'div', 'sale');
    const saleText = add(when, 'div', 'sale-text');
    if (sale.at) {
      add(saleText, 'b', '', sale.kind === 'AVAILABLE_UNTIL' ? 'Available until ' + day(sale.at) : (sale.kind === 'AUCTION' ? 'Auction · ' : 'Sale · ') + day(sale.at));
      add(saleText, 'span', '', hour(sale.at) + ' Florida time');
      tick(add(when, 'span', 'countdown'), sale.at, sale.kind === 'AVAILABLE_UNTIL' ? 'ends ' : '');
    } else add(saleText, 'b', '', sale.kind === 'AVAILABLE_UNTIL' ? 'Available now' : 'Auction date to be confirmed');
    // The last 6 VIN characters never reach this page: the blur covers placeholder characters, not the real ones.
    if (car.vin) {
      const line = add(article, 'p', 'vin', 'VIN ' + String(car.vin).replace(/•+$/, ''));
      if (/•+$/.test(car.vin)) { const hidden = add(line, 'span', 'vin-hidden', '000000'); hidden.setAttribute('aria-label', 'last 6 characters hidden'); }
    }
  }

  async function load() {
    try {
      const response = await fetch('/api/option-link?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      root.replaceChildren();
      const head = add(root, 'header', 'intro');
      add(head, 'div', 'eyebrow', 'My Car Scout');
      if (data.closed) { add(head, 'h1', 'title', 'This search is closed'); return; }
      const cars = data.cars || [], count = cars.length;
      add(head, 'h1', 'title', count ? `${count === 1 ? '1 option' : `${count} options`} for your search` : 'No cars match your search right now');
      add(head, 'p', 'sub', count ? 'Live at dealer-only auctions, matched to what you asked for.' : 'New auctions come in every week; our team keeps looking for you');
      const next = cars.map((car) => car.sale && car.sale.at).filter((at) => Date.parse(at || '') > Date.now()).sort()[0];
      if (next) { const pill = add(head, 'div', 'next'); add(pill, 'i', 'next-dot'); tick(add(pill, 'span'), next, 'Next auction '); }
      const notes = standouts(cars);
      const showMake = new Set(cars.map((car) => String(car.make || '').toLowerCase())).size > 1;
      cars.forEach((car, index) => card(car, notes.get(car), index, count, showMake));
      const foot = add(root, 'footer', 'outro');
      if (count) { add(foot, 'b', '', count === 1 ? 'Like it? Tell us.' : 'Tell us which option you like.'); add(foot, 'span', '', 'We look at every detail together before any bid.'); }
      add(foot, 'p', 'checked', `Checked ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', ...zone }).format(new Date(data.checkedAt || Date.now()))} (Florida time)`);
      if (timers.length) setInterval(() => timers.forEach((paint) => paint()), 1000);
    } catch (_) { root.replaceChildren(); add(root, 'p', 'muted', 'This page is unavailable right now'); }
  }
  load();
})();
