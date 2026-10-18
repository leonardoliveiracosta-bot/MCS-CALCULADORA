/* Optional listing shortcut. No requests until the visitor uses it. */
(function () {
  'use strict';
  var copy = {
    en: { invalid:'Paste a valid https listing link.', attached:'Reference listing' },
    es: { invalid:'Pega un enlace https válido del anuncio.', attached:'Anuncio de referencia' },
    pt: { invalid:'Cole um link https válido do anúncio.', attached:'Anúncio de referência' }
  };
  var entry = document.querySelector('#path-entry .gate-inner');
  var form = document.getElementById('find-form');
  if (!entry || !form || typeof abrirCaminho !== 'function') return;
  var source = '', vehicle = null, controller = null, generation = 0;
  function text(key) { return (copy[document.documentElement.lang] || copy.en)[key]; }
  var screen = document.createElement('section');
  screen.id = 'path-reference'; screen.className = 'listing-reference-screen'; screen.hidden = true;
  screen.innerHTML = '<div class="listing-reference-inner"><div class="listing-reference-nav"><button type="button" class="path-back listing-reference-back"></button><div class="listing-reference-languages"></div></div><p class="listing-reference-eyebrow"></p><h1 tabindex="-1"></h1><div class="listing-reference-car"><h2></h2><p></p></div><p class="listing-reference-link-label"></p><a class="listing-reference-source" target="_blank" rel="noopener noreferrer"></a><a id="reference-wa" class="listing-reference-use mcs-action mcs-action--primary" target="_blank" rel="noopener noreferrer"></a><a id="reference-sms" class="listing-reference-sms mcs-action"></a></div>';
  document.getElementById('path-entry').after(screen);
  var sourceLink = screen.querySelector('.listing-reference-source');
  ['en','es','pt'].forEach(function(lang) {
    var button = document.createElement('button'); button.type = 'button'; button.dataset.lang = lang; button.textContent = lang.toUpperCase();
    button.addEventListener('click', function() { trocarIdioma(lang); });
    screen.querySelector('.listing-reference-languages').appendChild(button);
  });
  screen.querySelector('.listing-reference-back').addEventListener('click', function() {
    screen.hidden = true; source = ''; vehicle = null; voltarEscolha(); entry.querySelector('[data-start]').focus();
  });
  function paint() {
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
  function cancel() { generation++; if (controller) controller.abort(); controller = null; }
  document.querySelectorAll('[data-start], [data-back-choice]').forEach(function (button) { button.addEventListener('click', function(){cancel();screen.hidden=true;}); });
  function show(url, data) {
    source = url; vehicle = data && data.make && data.model ? data : null;
    abrirCaminho('reference'); screen.hidden = false;
    paint(); screen.querySelector('h1').focus();
  }
  window.MCSListingReference = { use: async function (raw) {
    if (controller) return {cancelled:true};
    var url;
    try {
      url = new URL(String(raw).trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.port || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(url.hostname) || /^[\d.]+$|^\[/.test(url.hostname) || /\.(exe|msi|bat|cmd|ps1|sh|dll|scr|apk|dmg)$/i.test(decodeURIComponent(url.pathname)) || String(raw).length > 2048) throw new Error('INVALID_URL');
      url.hash = '';
    } catch (_) { return {error:text('invalid')}; }
    controller = new AbortController(); var current = ++generation, signal = controller.signal;
    var timer = setTimeout(function () { if (current === generation && controller) controller.abort(); }, 25000);
    try {
      var response = await fetch('/api/listing-reference?url=' + encodeURIComponent(url.href), { signal:signal, headers:{ accept:'application/json' } });
      var data = await response.json();
      if (current !== generation) return {cancelled:true};
      if (response.status === 400) return {error:text('invalid')};
      show(url.href, response.ok ? data.vehicle : null);
      return {ok:true};
    } catch (_) {
      if (current !== generation) return {cancelled:true};
      show(url.href, null);
      return {ok:true};
    } finally { clearTimeout(timer); if (current === generation) controller = null; }
  } };
  Object.assign(copy.en,{back:'Back',eyebrow:'YOUR REFERENCE',title:"LET'S FIND ONE LIKE THIS",hello:'I am interested in a car like this:',wa:'SEND VIA WHATSAPP',sms:'SEND VIA SMS'});
  Object.assign(copy.es,{back:'Volver',eyebrow:'TU REFERENCIA',title:'BUSQUEMOS UNO ASÍ',hello:'Me interesa un auto como este:',wa:'ENVIAR POR WHATSAPP',sms:'ENVIAR POR SMS'});
  Object.assign(copy.pt,{back:'Voltar',eyebrow:'SUA REFERÊNCIA',title:'VAMOS BUSCAR UM ASSIM',hello:'Tenho interesse em um carro como este:',wa:'ENVIAR PELO WHATSAPP',sms:'ENVIAR POR SMS'});
  paint();
}());
