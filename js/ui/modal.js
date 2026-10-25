/**
 * modal.js — менеджер модалок.
 * - Открытие/закрытие с focus trap.
 * - Esc закрывает.
 * - Клик по backdrop закрывает (кроме alertdialog — для storage-reset НЕ закрываем).
 * - Возврат фокуса на trigger.
 */
let openCount = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export class ModalManager {
  constructor() {
    this.active = null;
    this._prevFocus = null;
    this._onKeydown = this._handleKeydown.bind(this);
  }

  /**
   * @param {string} id — id элемента .modal (например 'modal-product')
   */
  open(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (this.active) this.close();

    this._prevFocus = document.activeElement;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    openCount++;
    this.active = { id, modal };

    document.addEventListener('keydown', this._onKeydown);

    // Фокус на первый фокусируемый или на close
    const focusable = modal.querySelector(FOCUSABLE);
    if (focusable) focusable.focus();
  }

  close() {
    if (!this.active) return;
    const { modal } = this.active;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    this.active = null;
    document.removeEventListener('keydown', this._onKeydown);
    openCount = Math.max(0, openCount - 1);
    if (openCount === 0) document.body.style.overflow = '';

    if (this._prevFocus && typeof this._prevFocus.focus === 'function') {
      try { this._prevFocus.focus(); } catch { /* noop */ }
    }
    this._prevFocus = null;
  }

  closeAll() {
    while (this.active) this.close();
  }

  _handleKeydown(e) {
    if (!this.active) return;
    if (e.key === 'Escape') {
      // alertdialog без data-close-modal не закрываем Esc-ом
      const { modal } = this.active;
      const isAlert = modal.getAttribute('role') === 'alertdialog';
      if (isAlert) return;
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === 'Tab') {
      const { modal } = this.active;
      const nodes = [...modal.querySelectorAll(FOCUSABLE)];
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }
}

/** Глобальный делегированный обработчик [data-close-modal] */
export function bindCloseButtons(manager) {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-close-modal]');
    if (!target) return;
    // Не закрываем, если это кнопка внутри alertdialog с data-close-modal (edge case)
    const modal = target.closest('.modal');
    if (modal && modal.getAttribute('role') === 'alertdialog') return;
    manager.close();
  });

  // Backdrop click
  document.addEventListener('click', (e) => {
    const backdrop = e.target.closest('.modal__backdrop');
    if (!backdrop) return;
    const modal = backdrop.closest('.modal');
    if (!modal) return;
    if (modal.getAttribute('role') === 'alertdialog') return;
    if (manager.active && manager.active.modal === modal) manager.close();
  });
}