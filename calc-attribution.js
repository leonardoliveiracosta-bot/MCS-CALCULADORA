(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MCSCalcAttribution = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  // Only campaign labels and delivery IDs, never the full URL, click ID or personal data.
  var fields = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adset_id', 'ad_id', 'placement'];
  var key = 'mcs_campaign_attribution_v1';
  function clean(input) {
    var result = {};
    fields.forEach(function (field) {
      var value = String(input && input[field] || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (value && !/[{}]/.test(value)) result[field] = value.slice(0, 120);
    });
    return result;
  }
  function capture(win) {
    var current = {}, saved = {};
    try {
      var url = new URL(win.location.href);
      // The calculator also runs in the site's iframe. Trust only our own parent site.
      if (win.self !== win.top && win.document.referrer) {
        var parent = new URL(win.document.referrer);
        if (/^(www\.)?mycarscout\.net$/i.test(parent.hostname)) {
          fields.forEach(function (field) {
            if (!url.searchParams.has(field) && parent.searchParams.has(field)) url.searchParams.set(field, parent.searchParams.get(field));
          });
        }
      }
      fields.forEach(function (field) { current[field] = url.searchParams.get(field); });
      current = clean(current);
    } catch (_) {}
    try { saved = clean(JSON.parse(win.sessionStorage.getItem(key) || '{}')); } catch (_) {}
    // An explicit new source/campaign replaces the earlier visit; a reload keeps it.
    var result = Object.keys(current).length ? current : saved;
    try { if (Object.keys(result).length) win.sessionStorage.setItem(key, JSON.stringify(result)); } catch (_) {}
    return result;
  }
  function origin(attribution, fallback) {
    var labels = ['utm_source', 'utm_medium', 'utm_campaign'].map(function (field) { return attribution[field]; }).filter(Boolean);
    return (labels.join(' / ') || fallback || 'direto').slice(0, 200);
  }
  return { capture: capture, clean: clean, origin: origin };
});
