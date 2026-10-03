(() => {
  'use strict';

  const running = new WeakSet();

  function scopeFor(button, requested) {
    if (requested) return requested;
    return button?.closest('.item-card,.queue-item,.lead-card,.record-block,.sms-print-missing,.panel-view') || document.body;
  }

  function feedback(scope, message, tone = '', key = 'action') {
    if (!scope || !message) return null;
    scope.querySelectorAll(`.action-feedback[data-action-key="${key}"]`).forEach((node) => node.remove());
    const notice = document.createElement('p');
    notice.className = `status action-feedback${tone ? ` ${tone}` : ''}`;
    notice.dataset.actionKey = key;
    notice.setAttribute('role', tone === 'error' ? 'alert' : 'status');
    notice.textContent = message;
    // D20: a notice for the whole page (scope = body) is pinned to the bottom of the screen by CSS
    // (body > .action-feedback); a scoped notice is scrolled into view next to the card.
    scope.append(notice);
    if (scope !== document.body && typeof notice.scrollIntoView === 'function') notice.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    else if (scope === document.body) {
      // pinned notices leave on their own: 12 s, or 30 s when they carry a Desfazer button
      [setTimeout(() => { if (notice.isConnected && !notice.querySelector?.('button')) notice.remove(); }, 12000),
        setTimeout(() => { if (notice.isConnected) notice.remove(); }, 30000)].forEach((timer) => timer?.unref?.());
    }
    return notice;
  }

  async function run(options) {
    const button = options?.button;
    if (!button || running.has(button)) return { ok: false, duplicate: true };
    const scope = scopeFor(button, options.scope);
    const wasDisabled = button.disabled;
    running.add(button);
    button.disabled = true;
    let snapshot;
    try {
      snapshot = options.optimistic ? options.optimistic() : undefined;
      const result = await options.commit();
      let notice = null;
      const successScope=options.successScope||scope;
      const successText = typeof options.successText === 'function' ? options.successText(result) : options.successText;
      if (successText) notice = feedback(successScope, successText, '', options.feedbackKey);
      // undo may depend on the answer (a function of the result): no undo when the server says so.
      const undoSpec = typeof options.undo === 'function' ? options.undo(result, snapshot) : options.undo;
      if (undoSpec && notice) {
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'quiet small';
        undo.textContent = 'Desfazer';
        notice.append(' ', undo);
        undo.addEventListener('click', () => run({
          button: undo,
          scope:successScope,
          feedbackKey: options.feedbackKey,
          optimistic: undoSpec.optimistic,
          commit: () => undoSpec.commit(result, snapshot),
          rollback: undoSpec.rollback,
          successText: undoSpec.successText || 'Ação desfeita',
          errorText: undoSpec.errorText || options.errorText,
          refresh: undoSpec.refresh || options.refresh
        }));
      }
      if (options.refresh) Promise.resolve().then(() => options.refresh(result, snapshot)).catch(() => {});
      if (options.onSuccess) options.onSuccess(result, snapshot, notice);
      return { ok: true, result };
    } catch (error) {
      if (options.rollback) await options.rollback(snapshot, error);
      const errorText = typeof options.errorText === 'function' ? options.errorText(error) : options.errorText;
      feedback(scope, errorText || 'Não consegui salvar, tente de novo', 'error', options.feedbackKey);
      if (options.onError) options.onError(error, snapshot);
      return { ok: false, error };
    } finally {
      running.delete(button);
      if (button.isConnected) button.disabled = wasDisabled;
    }
  }

  function bind(button, options) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const resolved = typeof options === 'function' ? options(event) : options;
      return run({ ...resolved, button });
    });
    return button;
  }

  window.MCSAction = Object.freeze({ bind, feedback, run });
})();
