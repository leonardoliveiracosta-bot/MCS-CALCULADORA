(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MCSIgHandoff = api.capture(root);
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  var key = 'mcs_ig_handoff_v1';
  function clean(value) {
    return value && /^[1-9][0-9]{4,19}$/.test(String(value.contact_id || ''))
      ? { contact_id: String(value.contact_id), source: 'manychat' } : null;
  }
  function capture(win) {
    var result = null;
    try {
      var url = new URL(win.location.href);
      var explicit = url.searchParams.has('mcs_contact');
      var source = (url.searchParams.get('utm_source') || '').toLowerCase();
      if (explicit) result = clean({ contact_id: url.searchParams.get('mcs_contact') });
      else if (!source) {
        try { result = clean(JSON.parse(win.sessionStorage.getItem(key) || 'null')); } catch (_) {}
      }
      try {
        if (result) win.sessionStorage.setItem(key, JSON.stringify(result));
        else win.sessionStorage.removeItem(key);
      } catch (_) {}
      // Remove the internal contact ID before analytics and outgoing links can see it.
      // Campaign labels stay independent; the ID is only saved with our own request.
      if (explicit) {
        url.searchParams.delete('mcs_contact');
        win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
      }
    } catch (_) {}
    return result;
  }
  return { capture: capture, clean: clean };
});
