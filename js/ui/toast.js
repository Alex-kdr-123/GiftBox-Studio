/**
 * toast.js — тосты (aria-live polite). Автоскрытие через 4с.
 */
import { el } from '../utils.js';

const TYPES = new Set(['success', 'error', 'warning', 'info']);

export function toast(message, type = 'info', { duration = 4000 } = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const kind = TYPES.has(type) ? type : 'info';
  const node = el('div', { class: `toast toast--${kind}`, role: 'status' }, [message]);
  container.appendChild(node);

  const remove = () => {
    node.style.opacity = '0';
    node.style.transform = 'translateX(20px)';
    node.style.transition = 'opacity 200ms ease, transform 200ms ease';
    setTimeout(() => node.remove(), 220);
  };
  setTimeout(remove, duration);
  node.addEventListener('click', remove);
}