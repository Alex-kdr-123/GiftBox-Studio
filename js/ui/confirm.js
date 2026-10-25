/**
 * confirm.js — обёртка над #modal-confirm.
 * Возвращает Promise<boolean>.
 */
import { ModalManager } from './modal.js';

export class ConfirmDialog {
  constructor(modalManager) {
    this.manager = modalManager;
    this._resolve = null;
    this._bound = false;
  }

  _bind() {
    if (this._bound) return;
    this._bound = true;
    const ok = document.getElementById('btn-confirm-ok');
    const modal = document.getElementById('modal-confirm');
    if (!ok || !modal) return;

    ok.addEventListener('click', () => {
      const r = this._resolve;
      this._resolve = null;
      this.manager.close();
      if (r) r(true);
    });

    // Отмена (кнопки с data-close-modal="confirm")
    modal.addEventListener('click', (e) => {
      const t = e.target.closest('[data-close-modal="confirm"]');
      if (!t) return;
      const r = this._resolve;
      this._resolve = null;
      if (r) r(false);
    });
  }

  /**
   * @param {{title?: string, text: string, okLabel?: string, danger?: boolean}} opts
   * @returns {Promise<boolean>}
   */
  ask({ title = 'Подтвердите действие', text, okLabel = 'Подтвердить', danger = true } = {}) {
    this._bind();
    const titleEl = document.getElementById('modal-confirm-title');
    const textEl = document.getElementById('modal-confirm-text');
    const okBtn = document.getElementById('btn-confirm-ok');
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;
    if (okBtn) {
      okBtn.textContent = okLabel;
      okBtn.classList.toggle('btn--danger', !!danger);
      okBtn.classList.toggle('btn--primary', !danger);
    }

    return new Promise((resolve) => {
      this._resolve = resolve;
      this.manager.open('modal-confirm');
    });
  }
}