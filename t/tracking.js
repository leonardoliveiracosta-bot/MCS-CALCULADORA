(() => {
  const root = document.getElementById('tracking');
  const code = location.pathname.split('/').filter(Boolean).at(-1) || '';
  const add = (parent, tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = String(text); parent.append(node); return node; };
  async function load() {
    try {
      const response = await fetch('/api/tracking?code=' + encodeURIComponent(code), { cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const data = await response.json();
      root.replaceChildren();
      if (data.closed) { add(root, 'h1', '', 'This search is closed'); return; }
      add(root, 'div', 'brand', 'MY CAR SCOUT');
      add(root, 'h1', '', `Hi ${data.firstName}, here’s your search`);
      add(root, 'p', 'muted', `Ref ${data.ref} · Updated ${new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(data.updatedAt))}`);
      const steps = add(root, 'div', 'steps');
      ['Searching','Cars presented','Bid scheduled','Result'].forEach((label, index) => add(steps, 'div', 'step' + (index + 1 <= data.step ? ' on' : ''), label));
      if (data.step === 4) add(root, 'p', 'card', data.result === 'WON' ? "Won — we'll contact you about pickup" : 'Not won — your deposit is refunded or kept as credit, your choice');
      add(root, 'h2', '', 'Cars presented');
      if (!data.cars.length) add(root, 'p', 'muted', 'We’ll add your options here as soon as they’re ready.');
      data.cars.forEach((car) => {
        const card = add(root, 'section', 'card');
        add(card, 'div', 'car-title', [car.year,car.make,car.model,car.trim].filter(Boolean).join(' '));
        add(card, 'p', 'muted', [car.miles ? Number(car.miles).toLocaleString('en-US') + ' mi' : '',car.location,car.saleDate ? 'Sale ' + car.saleDate : ''].filter(Boolean).join(' · '));
        if (car.retailValue && car.retailUrl) {
          const p = add(card, 'p', '', 'Retail comparison: ' + new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(car.retailValue) + ' · ');
          const a = add(p, 'a', '', 'View comparison'); a.href = car.retailUrl; a.rel = 'noopener noreferrer';
        }
        if (car.response) { add(card, 'p', 'confirm', "Got it — we'll reach out shortly"); return; }
        for (const [label, value] of [['I want this','WANT'],['Not for me','DECLINE']]) {
          const button = add(card, 'button', value === 'DECLINE' ? 'alt' : '', label);
          button.type = 'button';
          button.addEventListener('click', async () => {
            button.disabled = true;
            try {
              const reply = await fetch('/api/tracking?code=' + encodeURIComponent(code), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({unitId:car.id,response:value}) });
              if (!reply.ok) {const failed=await reply.json().catch(()=>({}));throw new Error(reply.status===409?failed.message||'You already answered this car':'Please try again.');}
              card.querySelectorAll('button').forEach((item) => item.remove());
              add(card, 'p', 'confirm', "Got it — we'll reach out shortly");
            } catch (error) { button.disabled = false; add(card, 'p', 'muted', error.message||'Please try again.'); }
          });
        }
      });
    } catch (_) { root.replaceChildren(); add(root,'p','muted','This search is unavailable right now.'); }
  }
  load();
})();
