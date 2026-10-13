'use strict';
// Idioma do painel (PT/EN/ES). Português é o padrão e nada muda nele: sem tradução, sem observador, só o seletor no topo.
// Em inglês ou espanhol, a tela é traduzida depois de desenhada (textos, title, placeholder, aria-label, confirmações),
// e quem lê o texto pela programação continua lendo o original em português, então nenhuma ação muda de comportamento.
// O que é do cliente ou da IA (mensagens, notas, prévias do que vai ser enviado, campos de texto) fica como está.
(function () {
  var KEY = 'mcs_panel_lang';
  var LANGS = ['pt', 'en', 'es'];
  var lang = 'pt';
  try { lang = localStorage.getItem(KEY) || 'pt'; } catch (_) { lang = 'pt'; }
  if (LANGS.indexOf(lang) < 0) lang = 'pt';
  var api = window.MCSI18N = { lang: lang, translate: function (text) { return text; } };

  function choose(next) {
    try { if (next === 'pt') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch (_) {}
    location.reload();
  }
  function picker(className) {
    var select = document.createElement('select');
    select.className = 'mcs-lang ' + className;
    select.setAttribute('aria-label', 'Idioma · Language · Idioma');
    select.setAttribute('data-no-i18n', '');
    LANGS.forEach(function (code) {
      var option = document.createElement('option');
      option.value = code; option.textContent = code.toUpperCase(); option.selected = code === lang;
      select.appendChild(option);
    });
    select.addEventListener('change', function () { choose(select.value); });
    return select;
  }
  function mountPickers() {
    var style = document.createElement('style');
    style.textContent = '.mcs-lang{width:auto;min-width:0;padding:4px 6px;font-size:12px;line-height:1.2;border-radius:6px}'
      + '.mcs-lang-login{display:block;margin:0 0 10px auto}';
    document.head.appendChild(style);
    var actions = document.querySelector('.topbar-actions');
    if (actions) actions.insertBefore(picker('mcs-lang-top'), actions.querySelector('.settings-link') || actions.firstChild);
    var login = document.getElementById('login-view');
    if (login) login.insertBefore(picker('mcs-lang-login'), login.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPickers); else mountPickers();
  if (lang === 'pt') return;

  document.documentElement.lang = lang;
  // The dictionary loads before the rest of the panel, so the first paint is already translated.
  api.start = function (dict) {
    var index = lang === 'en' ? 0 : 1;
    var exact = new Map();
    Object.keys(dict.lit).forEach(function (pt) { var value = dict.lit[pt][index]; if (value) exact.set(pt, value); });
    var templates = dict.tpl.map(function (row) {
      var target = row[1 + index];
      if (!target) return null;
      var holes = [];
      var source = row[0].replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{(\d+)\\?\}/g, function (_, n) { holes.push(Number(n)); return '([\\s\\S]*?)'; });
      var literal = row[0].replace(/\{\d+\}/g, '\u0000').split('\u0000').sort(function (a, b) { return b.length - a.length; })[0];
      return { re: new RegExp('^' + source + '$'), holes: holes, target: target, anchor: literal, weight: row[0].replace(/\{\d+\}/g, '').length };
    }).filter(Boolean).sort(function (a, b) { return b.weight - a.weight; });

    var cache = new Map();
    function piece(text, depth) {
      if (!text || depth > 3) return null;
      var found = exact.get(text);
      if (found !== undefined) return found;
      for (var i = 0; i < templates.length; i += 1) {
        var t = templates[i];
        if (t.anchor && text.indexOf(t.anchor) < 0) continue;
        var match = t.re.exec(text);
        if (!match) continue;
        var values = {};
        t.holes.forEach(function (n, k) { var raw = match[k + 1]; var inner = raw.trim() ? piece(raw.trim(), depth + 1) : null; values[n] = inner === null ? raw : raw.replace(raw.trim(), inner); });
        return t.target.replace(/\{(\d+)\}/g, function (_, n) { return values[n] !== undefined ? values[n] : ''; });
      }
      var parts = text.split(' · ');
      if (parts.length > 1) {
        var changed = false;
        var out = parts.map(function (part) { var inner = piece(part.trim(), depth + 1); if (inner === null) return part; changed = true; return part.replace(part.trim(), inner); });
        if (changed) return out.join(' · ');
      }
      var lead = /^([^\p{L}\p{N}]+)([\s\S]+)$/u.exec(text);
      if (lead) { var rest = piece(lead[2], depth + 1); if (rest !== null) return lead[1] + rest; }
      var tail = /^([\s\S]+?)([:：…?!.]+)$/.exec(text);
      if (tail) { var head = piece(tail[1], depth + 1); if (head !== null) return head + tail[2]; }
      return dates(text);
    }
    // Dates written out in Portuguese by the browser ("terça-feira, 13 de outubro").
    var DAYS = { 'segunda-feira': ['Monday', 'lunes'], 'terça-feira': ['Tuesday', 'martes'], 'quarta-feira': ['Wednesday', 'miércoles'], 'quinta-feira': ['Thursday', 'jueves'], 'sexta-feira': ['Friday', 'viernes'], 'sábado': ['Saturday', 'sábado'], 'domingo': ['Sunday', 'domingo'] };
    var MONTHS = { janeiro: ['January', 'enero'], fevereiro: ['February', 'febrero'], 'março': ['March', 'marzo'], abril: ['April', 'abril'], maio: ['May', 'mayo'], junho: ['June', 'junio'], julho: ['July', 'julio'], agosto: ['August', 'agosto'], setembro: ['September', 'septiembre'], outubro: ['October', 'octubre'], novembro: ['November', 'noviembre'], dezembro: ['December', 'diciembre'] };
    var DATE = new RegExp('(\\d{1,2}) de (' + Object.keys(MONTHS).join('|') + ')(?: de (\\d{4}))?', 'g');
    var WEEKDAY = new RegExp('(^|[^\\p{L}])(' + Object.keys(DAYS).join('|') + ')(?=$|[^\\p{L}-])', 'gu');
    function dates(text) {
      if (!/feira|sábado|domingo| de (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/.test(text)) return null;
      var out = text.replace(DATE, function (_, day, month, year) {
        var name = MONTHS[month][index];
        return index === 0 ? name + ' ' + day + (year ? ', ' + year : '') : day + ' de ' + name + (year ? ' de ' + year : '');
      }).replace(WEEKDAY, function (_, before, day) { return before + DAYS[day][index]; });
      return out === text ? null : out;
    }
    function translate(value) {
      if (typeof value !== 'string' || !/\p{L}/u.test(value)) return null;
      if (cache.has(value)) return cache.get(value);
      var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(value);
      var core = m[2].replace(/\s+/g, ' ');
      var out = piece(core, 0);
      var result = out === null || out === core ? null : m[1] + out + m[3];
      if (cache.size > 20000) cache.clear();
      cache.set(value, result);
      return result;
    }
    api.translate = function (text) { var out = translate(String(text)); return out === null ? text : out; };

    // What the client or the AI wrote, and what is about to be sent, is never touched.
    var CONTENT = '[data-no-i18n],[contenteditable=""],[contenteditable="true"],blockquote,pre,code,'
      + '.message-body,.message-preview,.card-last-message-text,.card-last-message-translation,.client-last-message,.context-evidence,'
      + '.lead-message,.lead-quick-note-text,.wa-bubble,.unlock-message,.unlock-message-pt,.suggestion-body,.request-evidence';
    var SKIP = 'script,style,textarea,' + CONTENT;
    var original = new WeakMap(); // text node -> Portuguese text
    var written = new WeakMap(); // text node -> what this module wrote
    var attrOriginal = new WeakMap();
    var ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
    function skipped(element, selector) { return !element || (element.closest && element.closest(selector || SKIP)); }
    function text(node) {
      var value = node.data;
      if (written.get(node) === value) return;
      if (skipped(node.parentElement)) { original.delete(node); return; }
      var out = translate(value);
      if (out === null) { original.delete(node); written.delete(node); return; }
      original.set(node, value); written.set(node, out); node.data = out;
    }
    function attributes(element) {
      if (skipped(element, CONTENT)) return;
      var saved = attrOriginal.get(element) || {};
      ATTRS.forEach(function (name) {
        if (!element.hasAttribute(name)) return;
        var value = element.getAttribute(name);
        if (saved[name] && saved[name].out === value) return;
        var out = translate(value);
        if (out === null) { delete saved[name]; return; }
        saved[name] = { pt: value, out: out };
        element.setAttribute(name, out);
      });
      attrOriginal.set(element, saved);
    }
    function tree(root) {
      if (root.nodeType === 3) { text(root); return; }
      if (root.nodeType !== 1 && root.nodeType !== 11 && root.nodeType !== 9) return;
      if (root.nodeType === 1) { attributes(root); if (skipped(root)) return; }
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) { if (node.nodeType === 3) text(node); else attributes(node); }
    }

    // Code that reads text back (comparisons, restoring a label) keeps reading the Portuguese original.
    var native = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    function originalOf(node) { var pt = original.get(node); return pt !== undefined && written.get(node) === node.data ? pt : node.data; }
    Object.defineProperty(Node.prototype, 'textContent', {
      configurable: true, enumerable: native.enumerable,
      get: function () {
        var type = this.nodeType;
        if (type === 3) return originalOf(this);
        if (type !== 1 && type !== 11) return native.get.call(this);
        var walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT | 8 /* CDATA */);
        var out = '', node;
        while ((node = walker.nextNode())) out += node.nodeType === 3 ? originalOf(node) : node.data;
        return out;
      },
      set: function (value) { native.set.call(this, value); }
    });
    ['confirm', 'alert', 'prompt'].forEach(function (name) {
      var fn = window[name];
      if (typeof fn !== 'function') return;
      window[name] = function (message) { var args = Array.prototype.slice.call(arguments); if (typeof message === 'string') args[0] = api.translate(message); return fn.apply(window, args); };
    });

    new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === 'characterData') text(record.target);
        else if (record.type === 'attributes') attributes(record.target);
        else record.addedNodes.forEach(tree);
      });
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    tree(document.documentElement);
  };
  document.write('<script src="/painel/i18n-' + lang + '.js?v=20261013a"><\/script>');
})();
