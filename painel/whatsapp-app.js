'use strict';
// WhatsApp no celular. O painel instalado na tela inicial abre os links https://wa.me/ dentro do
// próprio navegador, que mostra a página do WhatsApp Web em vez de abrir o aplicativo. No celular,
// todo link wa.me do painel (sugestões, V1, fila de conversas) abre o aplicativo direto pelo
// endereço whatsapp://, com o mesmo número e o mesmo texto. No computador nada muda.
(function (root) {
  function appUrl(href) {
    let url;
    try { url = new URL(String(href || '')); } catch (error) { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'wa.me') return null;
    const phone = url.pathname.replace(/\D/g, '');
    if (!phone) return null;
    const text = url.searchParams.get('text');
    return 'whatsapp://send?phone=' + phone + (text ? '&text=' + encodeURIComponent(text) : '');
  }
  function isPhone(nav) {
    const agent = String(nav && nav.userAgent || '');
    return /iPhone|iPad|iPod|Android/i.test(agent) || (nav && nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  }
  const api = { appUrl, isPhone };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.MCSWhatsApp = api;
  if (!isPhone(root.navigator)) return;
  // Capture: runs before the link navigates; the other click handlers still run (no stopPropagation).
  root.document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest && event.target.closest('a[href^="https://wa.me/"]');
    const target = anchor && appUrl(anchor.href);
    if (!target) return;
    event.preventDefault();
    root.location.href = target;
  }, true);
})(typeof window !== 'undefined' ? window : null);
