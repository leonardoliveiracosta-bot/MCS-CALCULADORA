// Enviar com as duas opções: no computador, "No celular" (QR code do link wa.me, gerado com o texto do momento, e,
// se os avisos do painel estiverem ativos, "Enviar para meu celular") e "No WhatsApp Web" (aberto pelo wa-link.js na
// aba "mcs-whatsapp", direto no WhatsApp Web).
// No celular, o link direto continua igual.
(function attachWhatsAppHandoff(root) {
  'use strict';
  // Phone or computer by the device's browser only (Chromebook is a computer), as in wa-link.js.
  const isPhone = () => root.MCSWaLink ? root.MCSWaLink.isPhone(navigator) : /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  let pushState = null;
  async function pushAvailable(request) {
    if (!request) return false;
    if (pushState && Date.now() - pushState.at < 60000) return pushState.ok;
    const ok = await request('/api/panel/push-handoff', { method: 'GET' }).then((answer) => Boolean(answer && answer.available)).catch(() => false);
    pushState = { ok, at: Date.now() };
    return ok;
  }
  function qrSvg(text) {
    if (typeof root.qrcode !== 'function') return null;
    try { const qr = root.qrcode(0, 'L'); qr.addData(text, 'Byte'); qr.make(); return qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true }); } catch (_) { return null; }
  }
  function openModal(url, request) {
    document.querySelector('.wa-handoff-dialog')?.remove();
    const dialog = el('dialog', 'wa-handoff-dialog');
    const box = el('div', 'wa-handoff-box');
    box.append(el('h3', 'wa-handoff-title', 'No celular'));
    const svg = qrSvg(url);
    const code = el('div', 'wa-handoff-qr');
    if (svg) code.innerHTML = svg; else code.append(el('p', 'muted', 'Texto longo demais para o QR code · use Copiar ou o WhatsApp Web'));
    box.append(code, el('p', 'wa-handoff-hint', 'Aponte a câmera do celular'));
    const status = el('p', 'muted wa-handoff-status', '');
    const actions = el('div', 'inline-actions wa-handoff-actions');
    const close = el('button', 'quiet small', 'Fechar'); close.type = 'button'; close.addEventListener('click', () => dialog.close());
    actions.append(close);
    box.append(actions, status);
    dialog.append(box);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    pushAvailable(request).then((ok) => {
      if (!ok || !dialog.isConnected) return;
      const push = el('button', 'small wa-handoff-push', 'Enviar para meu celular'); push.type = 'button';
      push.addEventListener('click', async () => {
        push.disabled = true; status.textContent = 'Enviando…';
        try { const answer = await request('/api/panel/push-handoff', { method: 'POST', body: JSON.stringify({ url }) }); status.textContent = answer && answer.accepted ? 'Enviado · toque no aviso no celular para abrir a conversa' : 'O aviso não chegou a nenhum aparelho'; }
        catch (_) { status.textContent = 'Não consegui enviar o aviso agora · use o QR code'; }
        finally { push.disabled = false; }
      });
      actions.prepend(push);
    });
    return dialog;
  }
  // anchor: the existing wa.me link. On a computer it becomes "No WhatsApp Web" and "No celular" goes right before it.
  function attach(anchor, { request = null, before = null } = {}) {
    if (!anchor || isPhone()) return null;
    anchor.textContent = 'No WhatsApp Web';
    anchor.classList.add('wa-web');
    const phone = el('button', 'small wa-phone', 'No celular'); phone.type = 'button';
    phone.addEventListener('click', (event) => {
      event.preventDefault(); event.stopPropagation();
      if (before && before() === false) return;
      openModal(anchor.href, request);
    });
    anchor.before(phone);
    return phone;
  }
  root.MCSWaHandoff = { attach, openModal, isPhone };
}(typeof window !== 'undefined' ? window : globalThis));
