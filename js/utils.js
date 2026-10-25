/**
 * utils.js — чистые утилиты: валидация, форматирование, id, debounce.
 * Никаких side-effect'ов, никаких DOM-запросов.
 */

/* ─────────────────────────────────────────────
   ID / дата
   ───────────────────────────────────────────── */
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback для старых браузеров
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowIso() {
  return new Date().toISOString();
}

/* ─────────────────────────────────────────────
   Форматирование
   ───────────────────────────────────────────── */
const rubFormatter = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});

export function formatPrice(n) {
  if (!Number.isFinite(n)) return '—';
  return rubFormatter.format(n);
}

export function formatDate(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(d);
  } catch {
    return '—';
  }
}

/* ─────────────────────────────────────────────
   Транслитерация для slug (§6.3 схемы)
   ───────────────────────────────────────────── */
const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e',
  ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '',
  ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function translit(str) {
  return String(str)
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('');
}

export function slugify(title) {
  const base = translit(title)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'collection';
}

/* ─────────────────────────────────────────────
   Валидация полей
   ───────────────────────────────────────────── */
export const CATEGORIES = ['Сувениры', 'Цветы', 'Гаджеты', 'Сладости', 'Открытки'];

const URL_RE = /^https?:\/\/.+/i;

export function validateUrl(value) {
  if (value == null || value === '') return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: 'Некорректный URL' };
  if (value.startsWith('data:')) return { ok: false, error: 'BASE64_FORBIDDEN' };
  if (!URL_RE.test(value)) return { ok: false, error: 'URL должен начинаться с http:// или https://' };
  return { ok: true, value };
}

export function validateProductInput(data) {
  const errors = {};
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (title.length < 2 || title.length > 80) errors.title = 'Название: 2–80 символов';

  // [FIX v1.3-2] Пустая цена — отдельная ошибка «Цена обязательна»,
  // иначе Number('') === 0 проходит проверку isFinite.
  if (data.price === '' || data.price == null) {
    errors.price = 'Цена обязательна';
  } else {
    const price = Number(data.price);
    if (!Number.isFinite(price) || price < 0) errors.price = 'Цена: число ≥ 0';
  }

  if (!CATEGORIES.includes(data.category)) errors.category = 'Выберите категорию';

  const img = validateUrl(data.imageUrl);
  if (!img.ok) errors.imageUrl = img.error === 'BASE64_FORBIDDEN'
    ? 'Base64 запрещён, используйте http(s)-ссылку'
    : img.error;

  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (description.length > 300) errors.description = 'Описание: до 300 символов';

  // tags: строка через запятую или массив
  const tagsRaw = Array.isArray(data.tags)
    ? data.tags
    : typeof data.tags === 'string' ? data.tags.split(',') : [];
  const tags = [];
  const seen = new Set();
  for (const t of tagsRaw) {
    const norm = String(t).trim();
    if (!norm) continue;
    if (norm.length > 24) {
      errors.tags = 'Каждый тег: до 24 символов';
      break;
    }
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(norm);
  }
  if (tags.length > 10) errors.tags = 'Максимум 10 тегов';

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      title,
      price: Number(data.price),
      category: data.category,
      imageUrl: img.value,
      description,
      tags,
    },
  };
}

export function validateCollectionInput(data) {
  const errors = {};
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (title.length < 2 || title.length > 100) errors.title = 'Название: 2–100 символов';

  const theme = typeof data.theme === 'string' ? data.theme.trim() : '';
  if (theme.length > 50) errors.theme = 'Тема: до 50 символов';

  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (description.length > 500) errors.description = 'Описание: до 500 символов';

  const cover = validateUrl(data.coverUrl);
  if (!cover.ok) errors.coverUrl = cover.error === 'BASE64_FORBIDDEN'
    ? 'Base64 запрещён'
    : cover.error;

  if (Object.keys(errors).length) return { ok: false, errors };

  return {
    ok: true,
    data: {
      title,
      theme,
      description,
      coverUrl: cover.value,
    },
  };
}

/* ─────────────────────────────────────────────
   Debounce
   ───────────────────────────────────────────── */
export function debounce(fn, ms = 200) {
  let t = null;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

/* ─────────────────────────────────────────────
   Безопасный текстовый рендер (без innerHTML)
   ───────────────────────────────────────────── */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}