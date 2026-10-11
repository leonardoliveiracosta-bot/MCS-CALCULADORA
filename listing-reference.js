/* Optional listing shortcut. No requests until the visitor uses it. */
(function () {
  'use strict';
  var copy = {
    en: { shortcut:'Already found a car? Paste the listing', heading:'Use a car as your reference', placeholder:'Paste the listing link', use:'Use as reference', close:'Close', loading:'Reading the listing…', invalid:'Paste a valid https listing link.', attached:'Reference listing', remove:'Remove reference', unavailable:'We could not read this listing. The link is attached; enter the car you want below.' },
    es: { shortcut:'¿Ya encontraste un auto? Pega el anuncio', heading:'Usa un auto como referencia', placeholder:'Pega el enlace del anuncio', use:'Usar como referencia', close:'Cerrar', loading:'Leyendo el anuncio…', invalid:'Pega un enlace https válido del anuncio.', attached:'Anuncio de referencia', remove:'Quitar referencia', unavailable:'No pudimos leer este anuncio. El enlace está adjunto; indica abajo el auto que buscas.' },
    pt: { shortcut:'Já encontrou um carro? Cole o anúncio', heading:'Use um carro como referência', placeholder:'Cole o link do anúncio', use:'Usar como referência', close:'Fechar', loading:'Lendo o anúncio…', invalid:'Cole um link https válido do anúncio.', attached:'Anúncio de referência', remove:'Remover referência', unavailable:'Não conseguimos ler este anúncio. O link está anexado; informe abaixo o carro que você procura.' }
  };
  var entry = document.querySelector('#path-entry .gate-inner');
  var form = document.getElementById('find-form');
  if (!entry || !form || typeof abrirCaminho !== 'function') return;
  var source = '', unavailable = false, controller = null, generation = 0;
  function text(key) { return (copy[document.documentElement.lang] || copy.en)[key]; }
  var toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = 'listing-reference-toggle'; toggle.className = 'listing-reference-toggle';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'listing-reference-box');
  var box = document.createElement('form');
  box.id = 'listing-reference-box'; box.className = 'listing-reference-box'; box.hidden = true;
  box.innerHTML = '<label for="listing-reference-url"></label><input id="listing-reference-url" type="url" inputmode="url" autocomplete="url" maxlength="2048" required><button type="submit" class="listing-reference-use"></button><p class="listing-reference-status" role="status" aria-live="polite"></p><button type="button" class="listing-reference-close"></button>';
  var input = box.querySelector('input'), submit = box.querySelector('[type="submit"]'), status = box.querySelector('[role="status"]');
  var banner = document.createElement('div');
  banner.className = 'listing-reference-attached'; banner.id = 'listing-reference-attached'; banner.hidden = true;
  var sourceLink = document.createElement('a'); sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer';
  var remove = document.createElement('button'); remove.type = 'button'; remove.className = 'listing-reference-remove';
  var note = document.createElement('p'); note.setAttribute('role', 'status');
  banner.append(sourceLink, document.createTextNode(' · '), remove, note);
  form.before(banner);
  var proof = document.getElementById('gate-proof');
  entry.insertBefore(toggle, proof); entry.insertBefore(box, proof);
  function paint() {
    toggle.textContent = text('shortcut'); box.querySelector('label').textContent = text('heading');
    input.placeholder = text('placeholder'); submit.textContent = text(controller ? 'loading' : 'use');
    box.querySelector('.listing-reference-close').textContent = text('close');
    sourceLink.textContent = text('attached'); remove.textContent = text('remove');
    note.textContent = unavailable ? text('unavailable') : ''; note.hidden = !unavailable;
  }
  new MutationObserver(paint).observe(document.documentElement, { attributes:true, attributeFilter:['lang'] });
  function cancel() { generation++; if (controller) controller.abort(); controller = null; submit.disabled = false; paint(); }
  function close() { cancel(); box.hidden = true; toggle.setAttribute('aria-expanded', 'false'); status.textContent = ''; }
  toggle.addEventListener('click', function () {
    if (!box.hidden) { close(); return; }
    box.hidden = false; toggle.setAttribute('aria-expanded', 'true'); input.focus();
  });
  box.querySelector('.listing-reference-close').addEventListener('click', function () { close(); toggle.focus(); });
  box.addEventListener('keydown', function (event) { if (event.key === 'Escape') { close(); toggle.focus(); } });
  document.querySelectorAll('[data-start], [data-back-choice]').forEach(function (button) { button.addEventListener('click', close); });
  function fillEmpty(id, value) {
    var field = document.getElementById(id);
    if (!field || field.value || value === undefined || value === '') return;
    field.value = String(value); field.dispatchEvent(new Event('change', { bubbles:true }));
  }
  function applyVehicle(vehicle) {
    if (!vehicle || !vehicle.make || !vehicle.model) return;
    var make = document.getElementById('find-marca'), model = document.getElementById('find-modelo');
    if ((make.value && make.value !== vehicle.make) || (model.value && model.value !== vehicle.model)) return;
    // Only supported catalog values; all fields remain editable in the existing form.
    if (!Array.from(make.options).some(function(o) { return o.value === vehicle.make; })) return;
    fillEmpty('find-marca', vehicle.make);
    if (!Array.from(model.options).some(function(o) { return o.value === vehicle.model; })) return;
    fillEmpty('find-modelo', vehicle.model);
    if (vehicle.year) {
      var from = document.getElementById('find-year-from'), to = document.getElementById('find-year-to');
      if ((!to.value || Number(to.value) >= vehicle.year) && Array.from(from.options).some(function(o) { return o.value === String(vehicle.year); })) fillEmpty('find-year-from', vehicle.year);
      if (Number(from.value) <= vehicle.year) fillEmpty('find-year-to', vehicle.year);
    }
    if (!document.getElementById('find-trim-unsure').checked) fillEmpty('find-trim', vehicle.trim);
    atualizarFindLink();
  }
  window.MCSListingReference = {
    get url() { return source; },
    messageLine:function () { return source ? text('attached') + ': ' + source : ''; }
  };
  remove.addEventListener('click', function () { source = ''; unavailable = false; banner.hidden = true; atualizarFindLink(); });
  box.addEventListener('submit', async function (event) {
    event.preventDefault(); if (controller) return;
    var url;
    try {
      url = new URL(input.value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || input.value.length > 2048) throw new Error('INVALID_URL');
      url.hash = '';
    } catch (_) { status.textContent = text('invalid'); input.focus(); return; }
    controller = new AbortController(); var current = ++generation, signal = controller.signal;
    submit.disabled = true; status.textContent = ''; paint();
    var timer = setTimeout(function () { if (current === generation && controller) controller.abort(); }, 25000);
    try {
      var response = await fetch('/api/listing-reference?url=' + encodeURIComponent(url.href), { signal:signal, headers:{ accept:'application/json' } });
      var data = await response.json();
      if (current !== generation) return;
      if (response.status === 400) { status.textContent = text('invalid'); return; }
      source = url.href; unavailable = !response.ok || !data.vehicle;
      sourceLink.href = source; banner.hidden = false;
      abrirCaminho('find'); if (response.ok) applyVehicle(data.vehicle); atualizarFindLink();
      box.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    } catch (_) {
      if (current !== generation) return;
      source = url.href; unavailable = true; sourceLink.href = source; banner.hidden = false;
      abrirCaminho('find'); atualizarFindLink(); box.hidden = true; toggle.setAttribute('aria-expanded', 'false');
    } finally { clearTimeout(timer); if (current === generation) { controller = null; submit.disabled = false; paint(); } }
  });
  paint();
}());
