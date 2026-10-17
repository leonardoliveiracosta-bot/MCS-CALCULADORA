(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else if (!root.MCSCalcMeta) root.MCSCalcMeta = factory(root);
})(typeof window !== 'undefined' ? window : this, function (win) {
  'use strict';
  var pixel = '2308379543262592';
  var active = false;
  function track(name, data) {
    if (!active || !/^(CalculationCompleted|ContactInitiated)$/.test(name)) return;
    try {
      var safe = {};
      if (data && /^(VALOR|CARRO)$/.test(data.logical_mode)) safe.logical_mode = data.logical_mode;
      if (data && /^(whatsapp|sms)$/.test(data.channel)) safe.channel = data.channel;
      win.fbq('trackSingleCustom', pixel, name, safe);
    } catch (e) {}
  }
  try {
    var nav = win.navigator || {};
    if (!/^(www\.)?mycarscout\.net$/i.test(win.location.hostname) ||
        win.location.pathname !== '/msc-calculadora.html' ||
        nav.globalPrivacyControl === true || nav.doNotTrack === '1' || win.doNotTrack === '1') return { track: track };
    if (!win.fbq) {
      var fbq = function () {
        if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
        else fbq.queue.push(arguments);
      };
      win.fbq = fbq;
      if (!win._fbq) win._fbq = fbq;
      fbq.push = fbq;
      fbq.loaded = true;
      fbq.version = '2.0';
      fbq.queue = [];
      var script = win.document.createElement('script');
      script.async = true;
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      win.document.head.appendChild(script);
    }
    // Only explicit calculator events. No form scraping or advanced matching.
    win.fbq('set', 'autoConfig', false, pixel);
    win.fbq('init', pixel);
    win.fbq('trackSingle', pixel, 'PageView');
    active = true;
  } catch (e) {}
  return { track: track };
});
