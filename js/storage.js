/**
 * storage.js — StorageService. Полный контракт §6 из 02_Schema v1.1 + v1.2 (unpublishCollection).
 *
 * Инварианты:
 *  - Все методы async, возвращают { ok: true, data, meta? } | { ok: false, error: {code, ...} }.
 *  - Никогда не throw наружу.
 *  - Единственный источник истины — localStorage 'giftbox:db'.
 *  - Паттерн read-modify-validate-write (§1.3).
 *  - Все мутации проходят через _withWrite(mutator).
 *  - Session-guard просмотров — sessionStorage, НЕ входит в giftbox:db (§6.5).
 */

import {
  uuid, nowIso, slugify, CATEGORIES,
  validateProductInput, validateCollectionInput, validateUrl,
} from './utils.js';

const DB_KEY = 'giftbox:db';
const BACKUP_KEY = 'giftbox:backup';
const VIEWED_PREFIX = 'giftbox:viewed:';
const SCHEMA_VERSION = 1;
const LIMIT_PRODUCTS = 200;
const LIMIT_COLLECTIONS = 50;

/* ─────────────────────────────────────────────
   Утилиты ошибок
   ───────────────────────────────────────────── */
function err(code, extra = {}) {
  return { ok: false, error: { code, ...extra } };
}

/* ─────────────────────────────────────────────
   Утилиты нормализации поисковой строки
   ───────────────────────────────────────────── */
// [FIX v1.4-search] Нормализация: lowercase + collapse пробелов + trim.
function normalizeSearch(str) {
  return String(str ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// [FIX v1.4-search] Разбиение запроса на токены (слова). Пустые отбрасываются.
function tokenizeQuery(q) {
  const norm = normalizeSearch(q);
  if (!norm) return [];
  return norm.split(' ').filter(Boolean);
}

/* ─────────────────────────────────────────────
   Дефолтное состояние
   ───────────────────────────────────────────── */
function emptyState() {
  const now = nowIso();
  return {
    schemaVersion: SCHEMA_VERSION,
    products: [],
    collections: [],
    meta: { lastSlugCounter: 0, createdAt: now, updatedAt: now },
  };
}

/* ─────────────────────────────────────────────
   StorageService
   ───────────────────────────────────────────── */
export class StorageService {
  constructor({ localStorage = window.localStorage, sessionStorage = window.sessionStorage } = {}) {
    this.ls = localStorage;
    this.ss = sessionStorage;

    /** @type {{ schemaVersion: number, products: any[], collections: any[], meta: any } | null} */
    this.state = null;

    // Индексы (§3)
    this.idxProductsById = new Map();
    this.idxProductsByCategory = new Map();
    this.idxProductsByTag = new Map();
    this.idxProductsSearch = new Map();
    this.idxCollectionsById = new Map();
    this.idxCollectionsBySlug = new Map();
    this.idxCollectionsByTheme = new Map();

    // Счётчики
    this.totalViews = 0;

    // Session-guard просмотров (§6.5)
    this._viewedThisSession = null;

    // Флаг: состояние повреждено и требуется сброс через UI
    this.corrupted = false;
  }

  /* ═════════════════════════════════════════
     INIT
     ═════════════════════════════════════════ */
  async init() {
    try {
      const raw = this.ls.getItem(DB_KEY);
      if (raw == null) {
        this.state = emptyState();
        this._persist(this.state);
        this._rebuildIndexes();
        return { ok: true, data: { fresh: true } };
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.corrupted = true;
        return err('STORAGE_CORRUPTED', { reason: 'JSON.parse' });
      }
      const validation = this._validateState(parsed);
      if (!validation.ok) {
        this.corrupted = true;
        return err('STORAGE_CORRUPTED', { reason: validation.error.reason, details: validation.error.details });
      }
      const healed = this._selfHeal(parsed);
      this.state = healed;
      if (healed !== parsed) this._persist(this.state);
      this._rebuildIndexes();
      this._initSessionGuard();
      return { ok: true, data: { fresh: false } };
    } catch (e) {
      this.corrupted = true;
      return err('STORAGE_CORRUPTED', { reason: 'unexpected', message: String(e && e.message) });
    }
  }

  /** Полный сброс БД + session-guard (§5.2). */
  async resetAll() {
    try {
      this.ls.removeItem(DB_KEY);
      this.ls.removeItem(BACKUP_KEY);
      try {
        const keys = [];
        for (let i = 0; i < this.ss.length; i++) {
          const k = this.ss.key(i);
          if (k && k.startsWith(VIEWED_PREFIX)) keys.push(k);
        }
        keys.forEach((k) => this.ss.removeItem(k));
      } catch { /* sessionStorage может быть недоступен */ }

      this._viewedThisSession = new Set();
      this.state = emptyState();
      this._persist(this.state);
      this._rebuildIndexes();
      this.corrupted = false;
      return { ok: true, data: true };
    } catch (e) {
      return err('STORAGE_QUOTA', { message: String(e && e.message) });
    }
  }

  /* ═════════════════════════════════════════
     PRODUCTS
     ═════════════════════════════════════════ */
  async getProducts({ search, category, tag } = {}) {
    try {
      if (!this.state) return err('STORAGE_CORRUPTED');
      let ids = null; // null = «все»

      if (category) {
        const set = this.idxProductsByCategory.get(category);
        ids = new Set(set ? [...set] : []);
      }
      if (tag) {
        const set = this.idxProductsByTag.get(String(tag).toLowerCase());
        const tagSet = new Set(set ? [...set] : []);
        ids = ids == null ? tagSet : new Set([...ids].filter((id) => tagSet.has(id)));
      }

      // [FIX v1.4-search] Поиск: нормализация + токенизация + fallback на state.products.
      // Раньше: hay.includes(q) — ломалось при лишних пробелах, не-массивах tags
      // и при рассинхроне индекса. Теперь:
      //   - q нормализуется (lowercase, collapse пробелов, trim);
      //   - разбивается на токены (слова);
      //   - товар матчится, если ВСЕ токены присутствуют в hay;
      //   - если индекс пуст/непокрыт, идём по state.products напрямую.
      if (search != null && String(search).trim() !== '') {
        const tokens = tokenizeQuery(search);
        if (tokens.length > 0) {
          const matched = new Set();

          // Основной проход по индексу
          for (const [id, hay] of this.idxProductsSearch) {
            if (this._hayMatchesTokens(hay, tokens)) matched.add(id);
          }

          // [FIX v1.4-search] Fallback: если индекс не дал результата, но товары есть —
          // пробегаем по state.products и строим hay на лету (страховка от рассинхрона).
          if (matched.size === 0 && this.state.products.length > 0) {
            for (const p of this.state.products) {
              const hay = this._buildSearchHay(p);
              if (this._hayMatchesTokens(hay, tokens)) matched.add(p.id);
            }
          }

          ids = ids == null ? matched : new Set([...ids].filter((id) => matched.has(id)));
        }
      }

      const result = ids == null
        ? [...this.state.products]
        : [...ids].map((id) => this.idxProductsById.get(id)).filter(Boolean);
      return { ok: true, data: result };
    } catch (e) {
      return err('STORAGE_CORRUPTED', { message: String(e && e.message) });
    }
  }

  async getProduct(id) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const p = this.idxProductsById.get(id);
    if (!p) return err('NOT_FOUND', { id });
    return { ok: true, data: p };
  }

  async createProduct(input) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    if (this.state.products.length >= LIMIT_PRODUCTS) return err('LIMIT_PRODUCTS');

    const v = validateProductInput(input);
    if (!v.ok) return err('VALIDATION_ERROR', { fields: v.errors });

    const product = {
      id: uuid(),
      title: v.data.title,
      price: v.data.price,
      category: v.data.category,
      imageUrl: v.data.imageUrl,
      description: v.data.description,
      tags: v.data.tags,
      createdAt: nowIso(),
    };

    return this._withWrite((state) => {
      state.products.push(product);
      return { data: product };
    });
  }

  async updateProduct(id, patch) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const existing = this.idxProductsById.get(id);
    if (!existing) return err('NOT_FOUND', { id });

    const merged = {
      title: patch.title ?? existing.title,
      price: patch.price ?? existing.price,
      category: patch.category ?? existing.category,
      imageUrl: 'imageUrl' in patch ? patch.imageUrl : existing.imageUrl,
      description: patch.description ?? existing.description,
      tags: patch.tags ?? existing.tags,
    };
    const v = validateProductInput(merged);
    if (!v.ok) return err('VALIDATION_ERROR', { fields: v.errors });

    const updated = { ...existing, ...v.data };

    return this._withWrite((state) => {
      const idx = state.products.findIndex((p) => p.id === id);
      state.products[idx] = updated;
      return { data: updated };
    });
  }

  async deleteProduct(id) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    if (!this.idxProductsById.has(id)) return err('NOT_FOUND', { id });

    return this._withWrite((state) => {
      state.products = state.products.filter((p) => p.id !== id);

      const removedFromCollections = [];
      for (const c of state.collections) {
        if (!c.productIds.includes(id)) continue;
        const before = c.productIds.length;
        c.productIds = c.productIds.filter((pid) => pid !== id);
        if (c.productIds.length === before) continue;

        let unpublished = false;
        if (c.isPublished && c.productIds.length === 0) {
          c.isPublished = false;
          c.slug = '';
          c.updatedAt = nowIso();
          unpublished = true;
        } else {
          c.updatedAt = nowIso();
        }
        removedFromCollections.push({ id: c.id, title: c.title, unpublished });
      }

      return { data: { id, removedFromCollections } };
    });
  }

  /* ═════════════════════════════════════════
     COLLECTIONS
     ═════════════════════════════════════════ */
  async getCollections({ sort = 'date', theme } = {}) {
    try {
      if (!this.state) return err('STORAGE_CORRUPTED');
      let list = [...this.state.collections];

      if (theme) {
        const ids = this.idxCollectionsByTheme.get(String(theme).toLowerCase());
        const set = ids || new Set();
        list = list.filter((c) => set.has(c.id));
      }

      list.sort((a, b) => {
        if (sort === 'views') return b.views - a.views;
        return b.updatedAt.localeCompare(a.updatedAt);
      });

      return { ok: true, data: list };
    } catch (e) {
      return err('STORAGE_CORRUPTED', { message: String(e && e.message) });
    }
  }

  async getCollection(id) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const c = this.idxCollectionsById.get(id);
    if (!c) return err('NOT_FOUND', { id });
    return { ok: true, data: c };
  }

  async getCollectionBySlug(slug) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    if (!slug) return { ok: true, data: null };
    const id = this.idxCollectionsBySlug.get(slug);
    if (!id) return { ok: true, data: null };
    const c = this.idxCollectionsById.get(id);
    return { ok: true, data: c || null };
  }

  async createCollection(input = {}) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    if (this.state.collections.length >= LIMIT_COLLECTIONS) return err('LIMIT_COLLECTIONS');

    const v = validateCollectionInput(input);
    if (!v.ok) return err('VALIDATION_ERROR', { fields: v.errors });

    const collection = {
      id: uuid(),
      slug: '',
      title: v.data.title,
      description: v.data.description,
      theme: v.data.theme,
      coverUrl: v.data.coverUrl,
      productIds: [],
      views: 0,
      isPublished: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    return this._withWrite((state) => {
      state.collections.push(collection);
      return { data: collection };
    });
  }

  async updateCollection(id, patch) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const existing = this.idxCollectionsById.get(id);
    if (!existing) return err('NOT_FOUND', { id });

    const ALLOWED = ['title', 'description', 'theme', 'coverUrl', 'productIds'];
    for (const key of Object.keys(patch)) {
      if (!ALLOWED.includes(key)) {
        return err('VALIDATION_ERROR', { field: key, message: `Поле "${key}" нельзя менять через updateCollection` });
      }
    }

    const merged = {
      title: patch.title ?? existing.title,
      theme: patch.theme ?? existing.theme,
      description: patch.description ?? existing.description,
      coverUrl: 'coverUrl' in patch ? patch.coverUrl : existing.coverUrl,
    };
    const v = validateCollectionInput(merged);
    if (!v.ok) return err('VALIDATION_ERROR', { fields: v.errors });

    let nextProductIds = existing.productIds;
    if ('productIds' in patch) {
      if (!Array.isArray(patch.productIds)) {
        return err('VALIDATION_ERROR', { field: 'productIds', message: 'productIds должен быть массивом' });
      }
      const known = new Set(this.state.products.map((p) => p.id));
      const seen = new Set();
      nextProductIds = [];
      for (const pid of patch.productIds) {
        if (!known.has(pid) || seen.has(pid)) continue;
        seen.add(pid);
        nextProductIds.push(pid);
      }
      if (existing.isPublished && nextProductIds.length === 0) {
        return err('VALIDATION_ERROR', {
          field: 'productIds',
          message: 'Нельзя опустошить опубликованную подборку. Используйте удаление товара (авто-снятие).',
        });
      }
    }

    const updated = {
      ...existing,
      ...v.data,
      productIds: nextProductIds,
      updatedAt: nowIso(),
    };

    return this._withWrite((state) => {
      const idx = state.collections.findIndex((c) => c.id === id);
      state.collections[idx] = updated;
      return { data: updated };
    });
  }

  async deleteCollection(id) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    if (!this.idxCollectionsById.has(id)) return err('NOT_FOUND', { id });
    return this._withWrite((state) => {
      state.collections = state.collections.filter((c) => c.id !== id);
      return { data: true };
    });
  }

  async duplicateCollection(id) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    if (this.state.collections.length >= LIMIT_COLLECTIONS) return err('LIMIT_COLLECTIONS');
    const src = this.idxCollectionsById.get(id);
    if (!src) return err('NOT_FOUND', { id });

    let title = `${src.title} (копия)`;
    if (title.length > 100) title = title.slice(0, 100);

    const copy = {
      id: uuid(),
      slug: '',
      title,
      description: src.description,
      theme: src.theme,
      coverUrl: src.coverUrl,
      productIds: [...src.productIds],
      views: 0,
      isPublished: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    return this._withWrite((state) => {
      state.collections.push(copy);
      return { data: copy };
    });
  }

  async reorderProducts(id, from, to) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const c = this.idxCollectionsById.get(id);
    if (!c) return err('NOT_FOUND', { id });
    const len = c.productIds.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return err('VALIDATION_ERROR', { field: 'from/to' });
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) {
      return err('VALIDATION_ERROR', { message: 'from/to вне диапазона' });
    }

    return this._withWrite((state) => {
      const col = state.collections.find((x) => x.id === id);
      const arr = col.productIds;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      col.updatedAt = nowIso();
      return { data: col };
    });
  }

  async publishCollection(id) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const c = this.idxCollectionsById.get(id);
    if (!c) return err('NOT_FOUND', { id });

    if (c.isPublished && c.slug) return { ok: true, data: c, meta: { already: true } };

    if (c.productIds.length < 1) {
      return err('VALIDATION_ERROR', {
        field: 'productIds',
        message: 'Для публикации нужен минимум один товар',
      });
    }

    return this._withWrite((state) => {
      const col = state.collections.find((x) => x.id === id);

      let base = slugify(col.title);
      let slug = base;
      let counter = state.meta.lastSlugCounter || 0;
      const taken = (s) => {
        const found = state.collections.find((x) => x.slug === s && x.id !== col.id);
        return Boolean(found);
      };
      if (taken(slug)) {
        for (const x of state.collections) {
          if (!x.slug) continue;
          const m = x.slug.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`));
          if (m) counter = Math.max(counter, Number(m[1]) + 1);
        }
        do {
          slug = `${base}-${counter}`;
          counter += 1;
        } while (taken(slug));
        state.meta.lastSlugCounter = counter;
      }

      col.slug = slug;
      col.isPublished = true;
      col.updatedAt = nowIso();
      return { data: col };
    });
  }

  async unpublishCollection(id) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const c = this.idxCollectionsById.get(id);
    if (!c) return err('NOT_FOUND', { id });

    if (!c.isPublished && !c.slug) {
      return { ok: true, data: c, meta: { already: true } };
    }

    return this._withWrite((state) => {
      const col = state.collections.find((x) => x.id === id);
      if (!col) return { error: err('NOT_FOUND', { id }) };
      col.isPublished = false;
      col.slug = '';
      col.updatedAt = nowIso();
      return { data: col };
    });
  }

  async incrementViews(slug) {
    if (!this.state) return err('STORAGE_CORRUPTED');
    const c = this.idxCollectionsBySlug.get(slug)
      ? this.idxCollectionsById.get(this.idxCollectionsBySlug.get(slug))
      : null;
    if (!c) return err('NOT_FOUND', { slug });

    if (this._viewedThisSession == null) this._initSessionGuard();
    if (this._viewedThisSession.has(slug)) {
      return { ok: true, data: c.views, meta: { skipped: true } };
    }

    return this._withWrite((state) => {
      const col = state.collections.find((x) => x.slug === slug);
      if (!col) return err('NOT_FOUND', { slug });
      col.views = Math.floor(col.views) + 1;
      this._viewedThisSession.add(slug);
      try { this.ss.setItem(VIEWED_PREFIX + slug, '1'); } catch { /* noop */ }
      return { data: col.views, meta: { skipped: false } };
    });
  }

  async getStats() {
    if (!this.state) return err('STORAGE_CORRUPTED');
    return {
      ok: true,
      data: {
        totalProducts: this.state.products.length,
        totalCollections: this.state.collections.length,
        totalViews: this.totalViews,
      },
    };
  }

  /* ═════════════════════════════════════════
     ВНУТРЕННИЕ
     ═════════════════════════════════════════ */

  async _withWrite(mutator) {
    let draft;
    try {
      draft = structuredClone(this.state);
    } catch (e) {
      return err('STORAGE_CORRUPTED', { message: 'structuredClone failed' });
    }
    draft.meta.updatedAt = nowIso();

    let result;
    try {
      result = mutator(draft);
    } catch (e) {
      return err('VALIDATION_ERROR', { message: String(e && e.message) });
    }
    if (result && result.error) return result.error;

    const validation = this._validateState(draft);
    if (!validation.ok) {
      return err('VALIDATION_ERROR', { message: 'Инвариант нарушен: ' + validation.error.reason });
    }

    const writeRes = this._persist(draft);
    if (!writeRes.ok) return writeRes;

    this.state = draft;
    this._rebuildIndexes();
    return { ok: true, data: result ? result.data : null };
  }

  _persist(state) {
    try {
      const currentRaw = this.ls.getItem(DB_KEY);
      if (currentRaw) this.ls.setItem(BACKUP_KEY, currentRaw);
      this.ls.setItem(DB_KEY, JSON.stringify(state));
      return { ok: true };
    } catch (e) {
      try {
        const backup = this.ls.getItem(BACKUP_KEY);
        if (backup) this.ls.setItem(DB_KEY, backup);
      } catch { /* noop */ }
      if (e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
        return err('STORAGE_QUOTA');
      }
      return err('STORAGE_QUOTA', { message: String(e && e.message) });
    }
  }

  /**
   * [FIX v1.4-search] Единая точка построения поискового «сена» для товара.
   * Устойчиво к: не-массивам tags, кириллице, лишним пробелам.
   */
  _buildSearchHay(p) {
    const title = typeof p.title === 'string' ? p.title : '';
    const tags = Array.isArray(p.tags)
      ? p.tags
      : (typeof p.tags === 'string' ? p.tags.split(',') : []);
    const tagStr = tags
      .map((t) => (typeof t === 'string' ? t : String(t ?? '')))
      .filter(Boolean)
      .join(' ');
    return normalizeSearch(`${title} ${tagStr}`);
  }

  /**
   * [FIX v1.4-search] Матчинг hay по токенам: все токены должны присутствовать.
   * Логика:
   *   - «подарок» → matched, если hay содержит «подарок»;
   *   - «подарок девушке» → matched, если hay содержит и «подарок», и «девушке»;
   *   - токены могут идти в hay в любом порядке.
   */
  _hayMatchesTokens(hay, tokens) {
    if (!hay) return false;
    for (const token of tokens) {
      if (!hay.includes(token)) return false;
    }
    return true;
  }

  _rebuildIndexes() {
    const s = this.state;
    // Products
    this.idxProductsById.clear();
    this.idxProductsByCategory.clear();
    this.idxProductsByTag.clear();
    this.idxProductsSearch.clear();
    for (const p of s.products) {
      this.idxProductsById.set(p.id, p);
      if (!this.idxProductsByCategory.has(p.category)) this.idxProductsByCategory.set(p.category, new Set());
      this.idxProductsByCategory.get(p.category).add(p.id);

      // [FIX v1.4-search] Defensive: tags может быть не массивом в повреждённых данных.
      const tags = Array.isArray(p.tags)
        ? p.tags
        : (typeof p.tags === 'string' ? p.tags.split(',') : []);
      for (const t of tags) {
        const str = typeof t === 'string' ? t : String(t ?? '');
        const key = normalizeSearch(str);
        if (!key) continue;
        if (!this.idxProductsByTag.has(key)) this.idxProductsByTag.set(key, new Set());
        this.idxProductsByTag.get(key).add(p.id);
      }

      // [FIX v1.4-search] Строим hay через единый хелпер — тот же, что в fallback.
      // Это гарантирует, что индекс и fallback дают идентичный результат.
      this.idxProductsSearch.set(p.id, this._buildSearchHay(p));
    }

    // Collections
    this.idxCollectionsById.clear();
    this.idxCollectionsBySlug.clear();
    this.idxCollectionsByTheme.clear();
    let totalViews = 0;
    for (const c of s.collections) {
      this.idxCollectionsById.set(c.id, c);
      if (c.slug) this.idxCollectionsBySlug.set(c.slug, c.id);
      const themeKey = (c.theme || '').toLowerCase();
      if (themeKey) {
        if (!this.idxCollectionsByTheme.has(themeKey)) this.idxCollectionsByTheme.set(themeKey, new Set());
        this.idxCollectionsByTheme.get(themeKey).add(c.id);
      }
      totalViews += Number.isFinite(c.views) ? c.views : 0;
    }
    this.totalViews = totalViews;
  }

  _initSessionGuard() {
    this._viewedThisSession = new Set();
    try {
      for (let i = 0; i < this.ss.length; i++) {
        const k = this.ss.key(i);
        if (k && k.startsWith(VIEWED_PREFIX)) {
          this._viewedThisSession.add(k.slice(VIEWED_PREFIX.length));
        }
      }
    } catch { /* sessionStorage может быть недоступен */ }
  }

  _selfHeal(state) {
    let changed = false;
    let maxCounter = state.meta.lastSlugCounter || 0;
    for (const c of state.collections) {
      if (c.isPublished && (!c.productIds || c.productIds.length === 0)) {
        c.isPublished = false;
        c.slug = '';
        changed = true;
      }
      if (!c.slug) continue;
      const m = c.slug.match(/-(\d+)$/);
      if (m) maxCounter = Math.max(maxCounter, Number(m[1]) + 1);
    }
    if (maxCounter > (state.meta.lastSlugCounter || 0)) {
      state.meta.lastSlugCounter = maxCounter;
      changed = true;
    }
    return state;
  }

  _validateState(s) {
    if (!s || typeof s !== 'object') return { ok: false, error: { reason: 'not_object' } };
    if (s.schemaVersion !== SCHEMA_VERSION) return { ok: false, error: { reason: 'schema_version' } };
    if (!Array.isArray(s.products) || !Array.isArray(s.collections)) return { ok: false, error: { reason: 'arrays' } };
    if (!s.meta || typeof s.meta !== 'object') return { ok: false, error: { reason: 'meta' } };

    if (s.products.length > LIMIT_PRODUCTS) return { ok: false, error: { reason: 'limit_products' } };
    if (s.collections.length > LIMIT_COLLECTIONS) return { ok: false, error: { reason: 'limit_collections' } };

    const productIds = new Set();
    for (const p of s.products) {
      if (!p || typeof p.id !== 'string' || productIds.has(p.id)) {
        return { ok: false, error: { reason: 'product_id_dup' } };
      }
      productIds.add(p.id);
      if (typeof p.title !== 'string' || p.title.length < 2 || p.title.length > 80) {
        return { ok: false, error: { reason: 'product_title', id: p.id } };
      }
      if (!Number.isFinite(p.price) || p.price < 0) {
        return { ok: false, error: { reason: 'product_price', id: p.id } };
      }
      if (!CATEGORIES.includes(p.category)) {
        return { ok: false, error: { reason: 'product_category', id: p.id } };
      }
      if (p.imageUrl != null) {
        const v = validateUrl(p.imageUrl);
        if (!v.ok) return { ok: false, error: { reason: 'product_image', id: p.id } };
      }
      if (typeof p.description !== 'string' || p.description.length > 300) {
        return { ok: false, error: { reason: 'product_desc', id: p.id } };
      }
      if (!Array.isArray(p.tags) || p.tags.length > 10) {
        return { ok: false, error: { reason: 'product_tags', id: p.id } };
      }
      for (const t of p.tags) {
        if (typeof t !== 'string' || t.length === 0 || t.length > 24) {
          return { ok: false, error: { reason: 'product_tag_item', id: p.id } };
        }
      }
      if (typeof p.createdAt !== 'string' || Number.isNaN(Date.parse(p.createdAt))) {
        return { ok: false, error: { reason: 'product_date', id: p.id } };
      }
    }

    const colIds = new Set();
    const slugs = new Set();
    for (const c of s.collections) {
      if (!c || typeof c.id !== 'string' || colIds.has(c.id)) {
        return { ok: false, error: { reason: 'collection_id_dup' } };
      }
      colIds.add(c.id);
      if (typeof c.slug !== 'string') return { ok: false, error: { reason: 'collection_slug_type' } };
      if (c.slug) {
        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.slug)) {
          return { ok: false, error: { reason: 'collection_slug_format', id: c.id } };
        }
        if (slugs.has(c.slug)) return { ok: false, error: { reason: 'collection_slug_dup' } };
        slugs.add(c.slug);
      }
      if (typeof c.title !== 'string' || c.title.length < 2 || c.title.length > 100) {
        return { ok: false, error: { reason: 'collection_title', id: c.id } };
      }
      if (typeof c.description !== 'string' || c.description.length > 500) {
        return { ok: false, error: { reason: 'collection_desc', id: c.id } };
      }
      if (typeof c.theme !== 'string' || c.theme.length > 50) {
        return { ok: false, error: { reason: 'collection_theme', id: c.id } };
      }
      if (c.coverUrl != null) {
        const v = validateUrl(c.coverUrl);
        if (!v.ok) return { ok: false, error: { reason: 'collection_cover', id: c.id } };
      }
      if (!Array.isArray(c.productIds)) return { ok: false, error: { reason: 'collection_productIds_type' } };
      const seenP = new Set();
      for (const pid of c.productIds) {
        if (!productIds.has(pid)) return { ok: false, error: { reason: 'collection_ref', id: c.id, pid } };
        if (seenP.has(pid)) return { ok: false, error: { reason: 'collection_productIds_dup', id: c.id } };
        seenP.add(pid);
      }
      if (!Number.isInteger(c.views) || c.views < 0) {
        return { ok: false, error: { reason: 'collection_views', id: c.id } };
      }
      if (typeof c.isPublished !== 'boolean') {
        return { ok: false, error: { reason: 'collection_isPublished' } };
      }
      if (c.isPublished !== (c.slug !== '')) {
        return { ok: false, error: { reason: 'collection_publish_sync', id: c.id } };
      }
      if (c.isPublished && c.productIds.length === 0) {
        return { ok: false, error: { reason: 'collection_publish_empty', id: c.id } };
      }
      if (typeof c.createdAt !== 'string' || Number.isNaN(Date.parse(c.createdAt))) {
        return { ok: false, error: { reason: 'collection_createdAt', id: c.id } };
      }
      if (typeof c.updatedAt !== 'string' || Number.isNaN(Date.parse(c.updatedAt))) {
        return { ok: false, error: { reason: 'collection_updatedAt', id: c.id } };
      }
    }

    if (!Number.isInteger(s.meta.lastSlugCounter) || s.meta.lastSlugCounter < 0) {
      return { ok: false, error: { reason: 'meta_counter' } };
    }
    return { ok: true };
  }
}