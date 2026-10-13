'use strict';
// Links de envio do WhatsApp, uma função única para todo o painel.
//  * Celular (Android, iPhone, iPad pelo navegador): continua https://wa.me/ (abre o aplicativo).
//  * Computador (todo o resto, inclusive Chromebook "CrOS"): https://web.whatsapp.com/send?phone=…&text=…,
//    sem a página "Continue to WhatsApp Web", sempre na MESMA aba nomeada "mcs-whatsapp"
//    (window.open sem noopener, que impediria o reuso). A referência da aba fica guardada.
//  * Mensagem em partes: a parte 1 abre ou reusa a aba; as demais não navegam (não recarregam o
//    WhatsApp): copiam a parte e tentam trazer a aba para frente. Aba fechada: abre com o link.
//  * Os links vindos do servidor continuam wa.me; a troca é feita aqui, na hora do clique.
(function (root) {
  const TARGET = 'mcs-whatsapp';
  const NOTICE_KEY = 'mcs-wa-tab-notice';
  const NOTICE = "Use a aba do WhatsApp que o painel abre e feche outras abas do WhatsApp Web, para não aparecer 'Usar nesta janela'.";
  let tab = null;

  // Decided by the device's browser only (never touch or screen width).
  function isPhone(nav) {
    return /Android|iPhone|iPad|iPod/i.test(String(nav && nav.userAgent || ''));
  }
  // { phone: digits, text } of a wa.me / api.whatsapp.com / web.whatsapp.com link, or null.
  function parse(href) {
    let url;
    try { url = new URL(String(href || '')); } catch (_) { return null; }
    if (url.protocol !== 'https:') return null;
    let phone = '';
    if (url.hostname === 'wa.me') { try { phone = decodeURIComponent(url.pathname).replace(/\D/g, ''); } catch (_) { return null; } }
    else if (['api.whatsapp.com', 'web.whatsapp.com'].includes(url.hostname) && url.pathname === '/send') phone = String(url.searchParams.get('phone') || '').replace(/\D/g, '');
    else return null;
    if (!phone) return null;
    return { phone, text: url.searchParams.get('text') || '' };
  }
  function webUrl(href) {
    const link = parse(href);
    if (!link) return null;
    return 'https://web.whatsapp.com/send?phone=' + link.phone + (link.text ? '&text=' + encodeURIComponent(link.text) : '');
  }
  // The link for this device: wa.me on the phone, WhatsApp Web on a computer.
  function linkFor(href, nav = root && root.navigator) {
    if (isPhone(nav)) return href;
    return webUrl(href) || href;
  }
  const tabOpen = () => Boolean(tab && !tab.closed);

  function showNotice(win = root) {
    const doc = win && win.document;
    if (!doc || !doc.body) return null;
    try { if (win.localStorage && win.localStorage.getItem(NOTICE_KEY) === '1') return null; } catch (_) { /* no storage: show it */ }
    if (doc.querySelector('.wa-tab-notice')) return null;
    const box = doc.createElement('div');
    box.className = 'wa-tab-notice';
    box.setAttribute('role', 'status');
    const text = doc.createElement('span'); text.textContent = NOTICE;
    const ok = doc.createElement('button'); ok.type = 'button'; ok.className = 'small'; ok.textContent = 'Entendi';
    ok.addEventListener('click', () => { try { win.localStorage.setItem(NOTICE_KEY, '1'); } catch (_) { /* ignore */ } box.remove(); });
    box.append(text, ok);
    doc.body.append(box);
    return box;
  }

  // A button that first waits for the server (V1, V2) reserves the tab at the click itself: the browser only allows a new
  // tab right after a click, so opening it after the wait was blocked as a pop-up. An existing "mcs-whatsapp" tab is
  // only returned (an empty URL does not reload it). On the phone nothing is reserved (the app opens in this page).
  function reserve(win = root) {
    if (!win || isPhone(win.navigator)) return null;
    let reserved = null;
    try { reserved = win.open('', TARGET); } catch (_) { reserved = null; }
    if (reserved) tab = reserved;
    return reserved;
  }
  // Nothing to open after all (error, no phone): a blank tab reserved by the click is closed; a WhatsApp tab stays.
  function release(reserved) {
    if (!reserved || reserved.closed) return;
    let blank = false;
    try { blank = reserved.location.href === 'about:blank'; } catch (_) { blank = false; }
    if (!blank) return;
    try { reserved.close(); } catch (_) { /* ignore */ }
    if (tab === reserved) tab = null;
  }
  // Opens (or reuses) the "mcs-whatsapp" tab with the link. Returns the window, or null (phone, or blocked by the browser).
  function open(href, win = root, reserved = null) {
    const url = linkFor(href, win && win.navigator);
    if (isPhone(win && win.navigator)) { win.location.href = url; return null; }
    let opened = null;
    if (reserved && !reserved.closed) { try { reserved.location.href = url; opened = reserved; } catch (_) { opened = null; } }
    if (!opened) opened = win.open(url, TARGET);
    if (opened) tab = opened;
    try { if (opened && opened.focus) opened.focus(); } catch (_) { /* Chrome may ignore it */ }
    showNotice(win);
    return opened;
  }

  async function copy(text, win = root) {
    try { await win.navigator.clipboard.writeText(text); return true; } catch (_) { return false; }
  }
  // One part of a message in several parts (index starts at 1). Part 1 opens or reuses the tab;
  // the others copy and bring the tab forward without navigating, unless the tab is gone.
  async function sendPart({ href, text, index, total }, win = root) {
    if (isPhone(win && win.navigator)) { open(href, win); return { opened: true, message: '' }; }
    if (index <= 1 || !tabOpen()) { open(href, win); return { opened: true, message: total > 1 ? `Parte ${index} de ${total} aberta no WhatsApp` : '' }; }
    const copied = await copy(text, win);
    try { tab.focus(); } catch (_) { /* Chrome may ignore it: the message says where to go */ }
    return { opened: false, copied, message: copied ? `Parte ${index} copiada: vá para a aba do WhatsApp, cole (Ctrl+V) e envie` : `Não consegui copiar a parte ${index} · selecione o texto, copie e cole na aba do WhatsApp` };
  }

  // Every wa.me link of the panel, on a computer: opened in the "mcs-whatsapp" tab. Bubble phase,
  // so the link's own handlers (which may update the text or cancel) run first.
  function install(win = root) {
    if (!win || !win.document || isPhone(win.navigator)) return false;
    win.document.addEventListener('click', (event) => {
      if (event.defaultPrevented || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const anchor = event.target && event.target.closest && event.target.closest('a[href^="https://wa.me/"],a[href^="https://api.whatsapp.com/send"]');
      if (!anchor || !parse(anchor.href)) return;
      event.preventDefault();
      open(anchor.href, win);
    });
    return true;
  }

  const api = { TARGET, NOTICE, isPhone, parse, webUrl, linkFor, open, reserve, release, sendPart, install, showNotice, reset: () => { tab = null; }, get tab() { return tab; } };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.MCSWaLink = api;
  install(root);
})(typeof window !== 'undefined' ? window : null);
