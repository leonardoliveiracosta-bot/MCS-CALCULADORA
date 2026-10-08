(() => {
  // Cars that match the client's search, read live from the active batch: the car, its miles, the colors, the VIN without
  // the last 6 characters (blurred), the state and the sale day. No price and no auction name ever reach this page.
  const root = document.getElementById('options');
  const code = location.pathname.split('/').filter(Boolean).at(-1) || '';
  const add = (parent, tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); parent.append(node); return node; };
  const name = (car) => [car.year, car.make, car.model, car.trim].filter(Boolean).join(' ');
  const when = (value) => {
    const time = new Date(value || '');
    if (!Number.isFinite(time.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(time) + ' (Florida time)';
  };
  const saleText = (sale) => {
    const at = when(sale && sale.at);
    if (sale && sale.kind === 'AVAILABLE_UNTIL') return at ? 'Available until ' + at : 'Available now';
    return at ? 'Auction · ' + at : 'Auction date to be confirmed';
  };

  function card(car) {
    const article = add(root, 'article', 'car');
    add(article, 'h2', '', name(car));
    add(article, 'p', 'muted', [car.miles !== null ? Number(car.miles).toLocaleString('en-US') + ' mi' : '', car.state].filter(Boolean).join(' · '));
    const colors = car.colors || {};
    const paint = [colors.exterior ? 'Exterior ' + colors.exterior : '', colors.interior ? 'Interior ' + colors.interior : ''].filter(Boolean).join(' · ');
    if (paint) add(article, 'p', 'muted colors', paint);
    // The last 6 VIN characters never reach this page: the blur covers placeholder characters, not the real ones.
    if (car.vin) {
      const line = add(article, 'p', 'muted vin', 'VIN ' + String(car.vin).replace(/•+$/, ''));
      if (/•+$/.test(car.vin)) { const hidden = add(line, 'span', 'vin-hidden', '000000'); hidden.setAttribute('aria-label', 'last 6 characters hidden'); }
    }
    add(article, 'p', 'sale', saleText(car.sale));
  }

  async function load() {
    try {
      const response = await fetch('/api/option-link?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      root.replaceChildren();
      if (data.closed) { add(root, 'h1', 'title', 'This search is closed'); return; }
      const count = data.cars.length;
      add(root, 'div', 'eyebrow', 'My Car Scout');
      add(root, 'h1', 'title', count ? `${count} ${count === 1 ? 'car matches' : 'cars match'} your search` : 'No cars match your search right now');
      add(root, 'p', 'sub', count ? 'Available at wholesale dealer auctions right now' : 'New auctions come in every week; our team keeps looking for you');
      data.cars.forEach(card);
      if (count) add(root, 'p', 'footer', 'Tell our team which cars you like\nWe review each one with you before any bid');
      add(root, 'p', 'muted', `Checked ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/New_York' }).format(new Date(data.checkedAt || Date.now()))} (Florida time)`);
    } catch (_) { root.replaceChildren(); add(root, 'p', 'muted', 'This page is unavailable right now'); }
  }
  load();
})();
