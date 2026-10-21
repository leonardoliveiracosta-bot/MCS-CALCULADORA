(function () {
  'use strict';
  var section = document.getElementById('calculadora-widget');
  var frame = section && section.querySelector('iframe.calc-frame');
  var choices = document.getElementById('home-start-choices');
  if (!section || !frame || !choices) return;
  var selected = null, ready = false;
  var allowed = ['calculate', 'find', 'finance'];
  // This is the event total (recalculations included), never the old count of distinct sessions.
  var proof = document.getElementById('home-purchase-proof');
  if (proof) {
    fetch('/api/calc-stats?metric=scenarios', { headers:{accept:'application/json'} })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (stats) {
        if (!stats || stats.days !== 30 || !Number.isSafeInteger(stats.scenarios) || stats.scenarios < 1) return;
        // Keep the English number style in every language, matching the auction figures on the site.
        proof.querySelector('strong').textContent = stats.scenarios.toLocaleString('en-US');
        proof.hidden = false;
      }).catch(function () {});
  }
  // Keep floating assistance clear of the entry choices and active forms.
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      document.body.classList.toggle('home-choices-visible', entries[0].isIntersecting);
    }).observe(choices);
  }
  function language() { return document.documentElement.lang || 'en'; }
  function scrollTo(element) { element.scrollIntoView({ block:'start', behavior:'instant' }); }
  function ensureFrame(path) {
    if (frame.hasAttribute('src')) return;
    var url = new URL(frame.dataset.src, location.href);
    url.searchParams.set('entry', 'home');
    url.searchParams.set('lang', language());
    if (allowed.indexOf(path) !== -1) url.searchParams.set('start', path);
    frame.loading = 'eager';
    frame.src = url.pathname + url.search;
  }
  function sendPath() {
    if (!ready || !selected || !frame.contentWindow) return;
    frame.contentWindow.postMessage({ mcsOpenPath:selected, mcsLang:language(), mcsRequestHeight:true }, location.origin);
  }
  function reveal() {
    section.hidden = false;
    document.body.classList.add('home-form-open');
  }
  function goToForm() { scrollTo(section); }
  function navigate() { if (section.hidden) goToChoices(false); else goToForm(); }
  function open(path) {
    if (allowed.indexOf(path) === -1) return;
    selected = path;
    reveal();
    ensureFrame(path);
    sendPath();
    goToForm();
  }
  function goToChoices(focus) {
    section.hidden = true;
    document.body.classList.remove('home-form-open');
    scrollTo(choices);
    if (focus) {
      var button = choices.querySelector('[data-home-start="' + selected + '"]') || choices.querySelector('a');
      if (button) button.focus({preventScroll:true});
    }
    selected = null;
  }
  choices.querySelectorAll('[data-home-start]').forEach(function (button) {
    button.addEventListener('click', function (event) { event.preventDefault(); open(button.dataset.homeStart); });
  });
  // Existing footer, menu, assistant and campaign anchors keep their destination.
  document.addEventListener('click', function (event) {
    var anchor = event.target.closest('a[href="#calculadora-widget"]');
    if (!anchor || anchor.hasAttribute('data-home-start')) return;
    event.preventDefault();
    navigate();
  });
  window.addEventListener('message', function (event) {
    if (event.source !== frame.contentWindow || event.origin !== location.origin || !event.data) return;
    if (event.data.type === 'mcs:calculator-ready') { ready = true; sendPath(); }
    if (event.data.type === 'mcs:calculator-back') goToChoices(true);
  });
  window.MCSHomeStart = {
    ensureFrame:function () { ensureFrame(); },
    showReference:function () { selected = 'reference'; reveal(); },
    navigate:navigate
  };
  function fromLocation() {
    var path = new URLSearchParams(location.search).get('start');
    if (allowed.indexOf(path) !== -1) open(path);
    else if (location.hash === '#calculadora-widget') {
      if (section.hidden) goToChoices(false); else goToForm();
    }
  }
  window.addEventListener('hashchange', fromLocation);
  if (document.readyState === 'complete') fromLocation();
  else window.addEventListener('load', fromLocation, {once:true});
})();
