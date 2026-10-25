/**
 * catalog.js — экран #/catalog.
 * Поиск, фильтр по категории, CRUD товаров через модалку.
 */
import { el, clear, formatPrice, debounce, validateProductInput, CATEGORIES } from '../../utils.js';
import { toast } from '../toast.js';

export class CatalogScreen {
  constructor({ storage, router, confirm, navigate, modals }) {
    this.storage = storage;
    this.router = router;
    this.confirm = confirm;
    this.navigate = navigate;
    this.modals = modals;

    this.search = '';
    this.category = '';
    this.editingId = null;
    this._bound = false;
  }

  mount() {
    if (this._bound) return;
    this._bound = true;

    const search = document.getElementById('catalog-search');
    if (search) {
      search.addEventListener('input', debounce((e) => {
        this.search = String(e.target.value ?? '');
        this.render();
      }, 150));
    }

    document.querySelectorAll('.chips .chip[data-category]').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.category = chip.dataset.category || '';
        document.querySelectorAll('.chips .chip[data-category]').forEach((c) => {
          const active = (c.dataset.category || '') === this.category;
          c.classList.toggle('chip--active', active);
          c.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        this.render();
      });
    });

    const createBtn = document.getElementById('btn-create-product');
    if (createBtn) createBtn.addEventListener('click', () => this._openCreate());

    const emptyBtn = document.querySelector('[data-action="create-product-from-empty"]');
    if (emptyBtn) emptyBtn.addEventListener('click', () => this._openCreate());

    const list = document.getElementById('catalog-list');
    if (list) list.addEventListener('click', (e) => this._onCardClick(e));

    const form = document.getElementById('form-product');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this._submitProduct();
      });
    }
  }

  async show() {
    document.querySelectorAll('.screen').forEach((s) => {
      s.hidden = s.id !== 'screen-catalog';
    });
    document.querySelectorAll('.app-nav__link').forEach((a) => {
      a.classList.toggle('is-active', a.dataset.nav === 'catalog');
    });
    window.scrollTo({ top: 0 });
    await this.render();
  }

  async render() {
    const filters = { search: this.search, category: this.category };
    console.debug('[catalog] getProducts filters:', filters);

    const res = await this.storage.getProducts(filters);
    const list = document.getElementById('catalog-list');
    const empty = document.getElementById('catalog-empty');
    if (!list || !empty) return;

    // [FIX v1.5-empty] Принудительный сброс состояния ДО любой проверки.
    empty.hidden = true;
    list.hidden = false;

    clear(list);

    if (!res.ok) {
      toast('Не удалось загрузить товары', 'error');
      return;
    }
    const products = res.data;

    const all = await this.storage.getProducts();
    const total = all.ok ? all.data.length : 0;

    if (total === 0) {
      empty.hidden = false;
      list.hidden = true;
      return;
    }

    if (products.length === 0) {
      const q = String(this.search || '').trim();
      const text = q
        ? `По запросу «${q}» ничего не найдено. Попробуйте изменить фильтры.`
        : 'Ничего не найдено. Попробуйте изменить фильтры.';
      list.appendChild(el('li', { class: 'empty-state empty-state--compact' }, [
        el('p', { class: 'empty-state__text', text }),
      ]));
      return;
    }

    for (const p of products) {
      list.appendChild(this._renderCard(p));
    }
  }

  _renderCard(p) {
    const image = el('div', { class: 'product-card__image' }, [
      p.imageUrl
        ? el('img', { src: p.imageUrl, alt: '', loading: 'lazy' })
        : el('span', { class: 'product-card__image-placeholder', 'aria-hidden': 'true', text: '📦' }),
    ]);

    const body = el('div', { class: 'product-card__body' }, [
      el('h3', { class: 'product-card__title', text: p.title }),
      el('p', { class: 'product-card__price', text: formatPrice(p.price) }),
      el('div', { class: 'product-card__meta' }, [
        el('span', { class: 'badge badge--category', text: p.category }),
        ...p.tags.slice(0, 3).map((t) => el('span', { class: 'text-muted', text: `#${t}` })),
      ]),
    ]);

    const actions = el('div', { class: 'product-card__actions' }, [
      el('button', {
        type: 'button', class: 'btn btn--secondary btn--sm',
        'data-action': 'edit', 'data-id': p.id, text: 'Редактировать',
      }),
      el('button', {
        type: 'button', class: 'btn btn--ghost btn--sm',
        'data-action': 'delete', 'data-id': p.id, text: 'Удалить',
      }),
    ]);

    return el('li', { class: 'product-card', 'data-id': p.id }, [image, body, actions]);
  }

  async _onCardClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit') {
      await this._openEdit(id);
    } else if (btn.dataset.action === 'delete') {
      const res = await this.storage.getProduct(id);
      if (!res.ok) return;
      const confirmed = await this.confirm.ask({
        title: 'Удалить товар?',
        text: `«${res.data.title}» будет удалён из всех подборок.`,
        okLabel: 'Удалить',
      });
      if (!confirmed) return;
      const del = await this.storage.deleteProduct(id);
      if (!del.ok) { toast('Не удалось удалить', 'error'); return; }
      const removed = del.data.removedFromCollections || [];
      if (removed.length > 0) {
        const unpub = removed.filter((r) => r.unpublished);
        if (unpub.length > 0) {
          toast(`Снято с публикации: ${unpub.map((r) => r.title).join(', ')}`, 'warning', { duration: 6000 });
        }
        toast('Товар удалён из подборок', 'success');
      } else {
        toast('Товар удалён', 'success');
      }
      await this.render();
    }
  }

  _openCreate() {
    this.editingId = null;
    this._resetForm();
    const title = document.getElementById('modal-product-title');
    if (title) title.textContent = 'Добавить товар';
    this.modals.open('modal-product');
  }

  async _openEdit(id) {
    const res = await this.storage.getProduct(id);
    if (!res.ok) { toast('Товар не найден', 'error'); return; }
    this.editingId = id;
    this._resetForm();
    const p = res.data;
    document.getElementById('product-title').value = p.title;
    document.getElementById('product-price').value = String(p.price);
    document.getElementById('product-category').value = p.category;
    document.getElementById('product-image-url').value = p.imageUrl || '';
    document.getElementById('product-description').value = p.description || '';
    document.getElementById('product-tags').value = p.tags.join(', ');
    const titleEl = document.getElementById('modal-product-title');
    if (titleEl) titleEl.textContent = 'Редактировать товар';
    this.modals.open('modal-product');
  }

  _resetForm() {
    const form = document.getElementById('form-product');
    if (!form) return;
    form.reset();
    this._clearErrors();
    document.getElementById('product-category').value = '';
  }

  _clearErrors() {
    ['product-title-error', 'product-price-error', 'product-category-error', 'product-image-url-error', 'product-tags-error'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) { node.hidden = true; node.textContent = ''; }
    });
    ['product-title', 'product-price', 'product-category', 'product-image-url', 'product-tags'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) node.setAttribute('aria-invalid', 'false');
    });
  }

  _showFieldError(fieldId, errorId, message) {
    const field = document.getElementById(fieldId);
    const err = document.getElementById(errorId);
    if (field) field.setAttribute('aria-invalid', 'true');
    if (err) { err.textContent = message; err.hidden = false; }
  }

  async _submitProduct() {
    this._clearErrors();
    const data = {
      title: document.getElementById('product-title').value,
      price: document.getElementById('product-price').value,
      category: document.getElementById('product-category').value,
      imageUrl: document.getElementById('product-image-url').value,
      description: document.getElementById('product-description').value,
      tags: document.getElementById('product-tags').value,
    };
    const v = validateProductInput(data);
    if (!v.ok) {
      if (v.errors.title) this._showFieldError('product-title', 'product-title-error', v.errors.title);
      if (v.errors.price) this._showFieldError('product-price', 'product-price-error', v.errors.price);
      if (v.errors.category) this._showFieldError('product-category', 'product-category-error', v.errors.category);
      if (v.errors.imageUrl) this._showFieldError('product-image-url', 'product-image-url-error', v.errors.imageUrl);
      if (v.errors.tags) this._showFieldError('product-tags', 'product-tags-error', v.errors.tags);
      return;
    }

    let res;
    if (this.editingId) {
      res = await this.storage.updateProduct(this.editingId, v.data);
    } else {
      res = await this.storage.createProduct(v.data);
    }

    if (!res.ok) {
      if (res.error.code === 'LIMIT_PRODUCTS') toast('Лимит 200 товаров', 'warning');
      else if (res.error.code === 'BASE64_FORBIDDEN') this._showFieldError('product-image-url', 'product-image-url-error', 'Base64 запрещён');
      else if (res.error.fields) {
        for (const [k, msg] of Object.entries(res.error.fields)) {
          const map = { title: ['product-title', 'product-title-error'], price: ['product-price', 'product-price-error'], category: ['product-category', 'product-category-error'], imageUrl: ['product-image-url', 'product-image-url-error'], tags: ['product-tags', 'product-tags-error'] };
          if (map[k]) this._showFieldError(map[k][0], map[k][1], msg);
        }
      } else {
        toast('Не удалось сохранить товар', 'error');
      }
      return;
    }

    this.modals.close();
    toast(this.editingId ? 'Товар обновлён' : 'Товар добавлен', 'success');
    this.editingId = null;
    await this.render();
  }
}