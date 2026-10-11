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
  var source = '', vehicle = null, controller = null, generation = 0;
  function text(key) { return (copy[document.documentElement.lang] || copy.en)[key]; }
  var toggle = document.createElement('button');
  toggle.type = 'button'; toggle.id = 'listing-reference-toggle'; toggle.className = 'listing-reference-toggle';
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'listing-reference-box');
  var box = document.createElement('form');
  box.id = 'listing-reference-box'; box.className = 'listing-reference-box'; box.hidden = true;
  box.innerHTML = '<label for="listing-reference-url"></label><input id="listing-reference-url" type="url" inputmode="url" autocomplete="url" maxlength="2048" required><button type="submit" class="listing-reference-use"></button><p class="listing-reference-status" role="status" aria-live="polite"></p><button type="button" class="listing-reference-close"></button>';
  var input = box.querySelector('input'), submit = box.querySelector('[type="submit"]'), status = box.querySelector('[role="status"]');
  var screen = document.createElement('section');
  screen.id = 'path-reference'; screen.className = 'listing-reference-screen'; screen.hidden = true;
  screen.innerHTML = '<div class="listing-reference-inner"><div class="listing-reference-nav"><button type="button" class="path-back listing-reference-back"></button><div class="listing-reference-languages"></div></div><p class="listing-reference-eyebrow"></p><h1 tabindex="-1"></h1><div class="listing-reference-car"><h2></h2><p></p></div><p class="listing-reference-link-label"></p><a class="listing-reference-source" target="_blank" rel="noopener noreferrer"></a><a id="reference-wa" class="listing-reference-use" target="_blank" rel="noopener noreferrer"></a><a id="reference-sms" class="listing-reference-sms"></a></div>';
  document.getElementById('path-entry').after(screen);
  var sourceLink = screen.querySelector('.listing-reference-source');
  ['en','es','pt'].forEach(function(lang) {
    var button = document.createElement('button'); button.type = 'button'; button.dataset.lang = lang; button.textContent = lang.toUpperCase();
    button.addEventListener('click', function() { trocarIdioma(lang); });
    screen.querySelector('.listing-reference-languages').appendChild(button);
  });
  screen.querySelector('.listing-reference-back').addEventListener('click', function() {
    screen.hidden = true; source = ''; vehicle = null; voltarEscolha(); toggle.focus();
  });
  var proof = document.getElementById('gate-proof');
  entry.insertBefore(toggle, proof); entry.insertBefore(box, proof);
  function paint() {
    toggle.textContent = text('shortcut'); box.querySelector('label').textContent = text('heading');
    input.placeholder = text('placeholder'); submit.textContent = text(controller ? 'loading' : 'use');
    box.querySelector('.listing-reference-close').textContent = text('close');
    screen.querySelector('.listing-reference-back').textContent = text('back');
    screen.querySelector('.listing-reference-eyebrow').textContent = text('eyebrow');
    screen.querySelector('h1').textContent = text('title');
    var car = screen.querySelector('.listing-reference-car'); car.hidden = !vehicle;
    car.querySelector('h2').textContent = vehicle ? vehicle.make + ' ' + vehicle.model : '';
    car.querySelector('p').textContent = vehicle ? [vehicle.year, vehicle.trim].filter(Boolean).join(' · ') : '';
    screen.querySelector('.listing-reference-link-label').textContent = text('attached');
    sourceLink.textContent = source ? new URL(source).hostname : ''; sourceLink.href = source || '#';
    var lines = [text('hello')];
    if (vehicle) lines.push([vehicle.year,vehicle.make,vehicle.model,vehicle.trim].filter(Boolean).join(' '));
    lines.push(text('attached') + ': ' + source);
    var wa = screen.querySelector('#reference-wa'); wa.textContent = text('wa'); wa.href = montarLink(lines);
    var sms = screen.querySelector('#reference-sms'); sms.textContent = text('sms');
    sms.href = 'sms:+' + String(CONFIG.whatsapp).replace(/\D/g,'') + (/iPad|iPhone|iPod/.test(navigator.userAgent) ? '&' : '?') + 'body=' + encodeURIComponent(lines.join('\n'));
    screen.querySelectorAll('[data-lang]').forEach(function(button) { button.setAttribute('aria-pressed',String(button.dataset.lang === document.documentElement.lang)); });
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
  function show(url, data) {
    source = url; vehicle = data && data.make && data.model ? data : null;
    abrirCaminho('reference'); screen.hidden = false;
    box.hidden = true; toggle.setAttribute('aria-expanded','false'); paint(); screen.querySelector('h1').focus();
  }
  box.addEventListener('submit', async function (event) {
    event.preventDefault(); if (controller) return;
    var url;
    try {
      url = new URL(input.value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) || /^[\d.]+$|^\[/.test(url.hostname) || /\.(exe|msi|bat|cmd|ps1|sh|dll|scr|apk|dmg)$/i.test(decodeURIComponent(url.pathname)) || input.value.length > 2048) throw new Error('INVALID_URL');
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
      show(url.href, response.ok ? data.vehicle : null);
    } catch (_) {
      if (current !== generation) return;
      show(url.href, null);
    } finally { clearTimeout(timer); if (current === generation) { controller = null; submit.disabled = false; paint(); } }
  });
  Object.assign(copy.en,{back:'Back',eyebrow:'YOUR REFERENCE',title:'Send us this car',hello:'I am interested in a car like this:',wa:'SEND VIA WHATSAPP',sms:'SEND VIA SMS'});
  Object.assign(copy.es,{back:'Volver',eyebrow:'TU REFERENCIA',title:'Envíanos este auto',hello:'Me interesa un auto como este:',wa:'ENVIAR POR WHATSAPP',sms:'ENVIAR POR SMS'});
  Object.assign(copy.pt,{back:'Voltar',eyebrow:'SUA REFERÊNCIA',title:'Envie este carro para nós',hello:'Tenho interesse em um carro como este:',wa:'ENVIAR PELO WHATSAPP',sms:'ENVIAR POR SMS'});
  paint();
}());
