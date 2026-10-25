/**
 * editor.js — экран #/collections/:id.
 * Форма настроек + список товаров с reorder ↑/↓ + publish/unpublish + picker.
 */
import { el, clear, formatPrice, validateCollectionInput } from '../../utils.js';
import { toast } from '../toast.js';

export class EditorScreen {
  constructor({ storage, router, confirm, navigate, modals }) {
    this.storage = storage;
    this.router = router;
    this.confirm = confirm;
    this.navigate = navigate;
    this.modals = modals;

    this.id = null;
    this.collection = null;
    this.pickerSelected = new Set();
    this._bound = false;
  }

  mount() {
    if (this._bound) return;
    this._bound = true;

    const form = document.getElementById('form-collection');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); this._save(); });

    // [FIX v1.3-5] Дублирующий click-обработчик на #btn-save-collection удалён.
    // Кнопка имеет type="submit" внутри формы — submit-обработчик покрывает её.
    // Раньше _save() вызывался дважды на один клик (submit + click).

    const dup = document.getElementById('btn-duplicate-collection');
    if (dup) dup.addEventListener('click', () => this._duplicate());

    const del = document.getElementById('btn-delete-collection');
    if (del) del.addEventListener('click', () => this._delete());

    const pub = document.getElementById('btn-publish-collection');
    if (pub) pub.addEventListener('click', () => this._publish());

    const unpub = document.getElementById('btn-unpublish-collection');
    if (unpub) unpub.addEventListener('click', () => this._unpublish());

    const addBtn = document.getElementById('btn-add-products');
    if (addBtn) addBtn.addEventListener('click', () => this._openPicker());

    // Picker
    const pickerSearch = document.getElementById('picker-search');
    if (pickerSearch) {
      pickerSearch.addEventListener('input', () => this._renderPicker());
    }
    const pickerList = document.getElementById('picker-list');
    if (pickerList) {
      pickerList.addEventListener('change', (e) => {
        const cb = e.target.closest('input[type="checkbox"][data-pid]');
        if (!cb) return;
        if (cb.checked) this.pickerSelected.add(cb.dataset.pid);
        else this.pickerSelected.delete(cb.dataset.pid);
      });
    }
    const confirmBtn = document.getElementById('btn-picker-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', () => this._confirmPicker());

    // Reorder через делегирование
    const list = document.getElementById('editor-products-list');
    if (list) {
      list.addEventListener('click', (e) => this._onProductAction(e));
    }
  }

  async show({ id }) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.hidden = s.id !== 'screen-editor';
    });
    document.querySelectorAll('.app-nav__link').forEach((a) => a.classList.remove('is-active'));
    window.scrollTo({ top: 0 });

    this.id = id;
    const res = await this.storage.getCollection(id);
    if (!res.ok) {
      toast('Подборка не найдена', 'error');
      this.navigate('#/dashboard');
      return;
    }
    this.collection = res.data;
    this._fillForm();
    await this._renderProducts();
    this._updateButtons();
  }

  _fillForm() {
    const c = this.collection;
    document.getElementById('collection-title').value = c.title;
    document.getElementById('collection-theme').value = c.theme || '';
    document.getElementById('collection-description').value = c.description || '';
    document.getElementById('collection-cover-url').value = c.coverUrl || '';
    document.getElementById('collection-slug').value = c.slug || '';
    document.getElementById('editor-title').textContent = c.title || 'Редактор подборки';

    const status = document.getElementById('collection-status');
    if (status) {
      status.textContent = c.isPublished ? 'Опубликована' : 'Черновик';
      status.className = c.isPublished ? 'badge badge--published' : 'badge badge--draft';
    }

    // Кнопки publish/unpublish
    const pub = document.getElementById('btn-publish-collection');
    const unpub = document.getElementById('btn-unpublish-collection');
    if (pub) pub.hidden = c.isPublished;
    if (unpub) unpub.hidden = !c.isPublished;
  }

  _updateButtons() {
    const c = this.collection;
    const pub = document.getElementById('btn-publish-collection');
    if (pub) {
      const canPublish = c.productIds.length >= 1;
      pub.hidden = c.isPublished;
      pub.disabled = !canPublish;
      pub.setAttribute('aria-disabled', canPublish ? 'false' : 'true');
    }
    const hint = document.getElementById('editor-publish-hint');
    if (hint) {
      hint.textContent = c.isPublished
        ? 'Подборка опубликована. Ссылка доступна по кнопке на дашборде.'
        : (c.productIds.length === 0
            ? 'Чтобы опубликовать подборку, добавьте минимум один товар.'
            : 'Можно публиковать — добавлен минимум один товар.');
    }
  }

  async _renderProducts() {
    const list = document.getElementById('editor-products-list');
    const empty = document.getElementById('editor-products-empty');
    if (!list || !empty) return;
    clear(list);

    const c = this.collection;
    if (c.productIds.length === 0) {
      empty.hidden = false;
      list.hidden = true;
      return;
    }
    empty.hidden = true;
    list.hidden = false;

    // Подтянуть все товары
    const productsRes = await this.storage.getProducts();
    const products = productsRes.ok ? productsRes.data : [];
    const byId = new Map(products.map((p) => [p.id, p]));

    c.productIds.forEach((pid, index) => {
      const p = byId.get(pid);
      if (!p) return;

      const thumb = el('div', { class: 'sortable-item__thumb' }, [
        p.imageUrl
          ? el('img', { src: p.imageUrl, alt: '', loading: 'lazy' })
          : el('span', { 'aria-hidden': 'true', text: '📦' }),
      ]);
      const info = el('div', { class: 'sortable-item__info' }, [
        el('p', { class: 'sortable-item__title', text: p.title }),
        el('p', { class: 'sortable-item__price', text: formatPrice(p.price) }),
      ]);
      const controls = el('div', { class: 'sortable-item__controls' }, [
        el('button', {
          type: 'button', class: 'icon-btn', 'data-action': 'up', 'data-index': String(index),
          'aria-label': 'Переместить выше', disabled: index === 0 ? 'disabled' : undefined,
          text: '↑',
        }),
        el('button', {
          type: 'button', class: 'icon-btn', 'data-action': 'down', 'data-index': String(index),
          'aria-label': 'Переместить ниже', disabled: index === c.productIds.length - 1 ? 'disabled' : undefined,
          text: '↓',
        }),
        el('button', {
          type: 'button', class: 'icon-btn icon-btn--danger', 'data-action': 'remove', 'data-index': String(index),
          'aria-label': 'Убрать из подборки', text: '✕',
        }),
      ]);

      list.appendChild(el('li', { class: 'sortable-item' }, [thumb, info, controls]));
    });
  }

  async _onProductAction(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    const action = btn.dataset.action;
    const c = this.collection;

    if (action === 'up' || action === 'down') {
      const to = action === 'up' ? idx - 1 : idx + 1;
      if (to < 0 || to >= c.productIds.length) return;
      const res = await this.storage.reorderProducts(c.id, idx, to);
      if (!res.ok) { toast('Не удалось переместить', 'error'); return; }
      this.collection = res.data;
      await this._renderProducts();
      this._updateButtons();
    } else if (action === 'remove') {
      const pid = c.productIds[idx];
      const next = c.productIds.filter((x) => x !== pid);
      // Обновляем через updateCollection (whitelist productIds)
      const res = await this.storage.updateCollection(c.id, { productIds: next });
      if (!res.ok) {
        if (res.error.field === 'productIds') {
          toast('Нельзя опустошить опубликованную подборку. Сначала снимите с публикации.', 'warning', { duration: 5000 });
        } else {
          toast('Не удалось удалить товар из подборки', 'error');
        }
        return;
      }
      this.collection = res.data;
      await this._renderProducts();
      this._updateButtons();
    }
  }

  async _save() {
    // Очистить ошибку title
    const titleErr = document.getElementById('collection-title-error');
    if (titleErr) { titleErr.hidden = true; titleErr.textContent = ''; }
    document.getElementById('collection-title').setAttribute('aria-invalid', 'false');

    const data = {
      title: document.getElementById('collection-title').value,
      theme: document.getElementById('collection-theme').value,
      description: document.getElementById('collection-description').value,
      coverUrl: document.getElementById('collection-cover-url').value,
    };
    const v = validateCollectionInput(data);
    if (!v.ok) {
      if (v.errors.title && titleErr) {
        document.getElementById('collection-title').setAttribute('aria-invalid', 'true');
        titleErr.textContent = v.errors.title;
        titleErr.hidden = false;
      }
      if (v.errors.coverUrl) toast(v.errors.coverUrl, 'error');
      return;
    }
    const res = await this.storage.updateCollection(this.id, v.data);
    if (!res.ok) { toast('Не удалось сохранить', 'error'); return; }
    this.collection = res.data;
    document.getElementById('editor-title').textContent = res.data.title;
    toast('Сохранено', 'success');
    this._fillForm();
  }

  async _duplicate() {
    const res = await this.storage.duplicateCollection(this.id);
    if (!res.ok) {
      if (res.error.code === 'LIMIT_COLLECTIONS') toast('Достигнут лимит 50 подборок', 'warning');
      else toast('Не удалось дублировать', 'error');
      return;
    }
    toast('Подборка скопирована', 'success');
    this.navigate(`#/collections/${encodeURIComponent(res.data.id)}`);
  }

  async _delete() {
    const confirmed = await this.confirm.ask({
      title: 'Удалить подборку?',
      text: `«${this.collection.title}» будет удалена безвозвратно.`,
      okLabel: 'Удалить',
    });
    if (!confirmed) return;
    const res = await this.storage.deleteCollection(this.id);
    if (!res.ok) { toast('Не удалось удалить', 'error'); return; }
    toast('Подборка удалена', 'success');
    this.navigate('#/dashboard');
  }

  async _publish() {
    const res = await this.storage.publishCollection(this.id);
    if (!res.ok) {
      if (res.error.code === 'VALIDATION_ERROR' && res.error.field === 'productIds') {
        toast('Добавьте хотя бы один товар', 'warning');
      } else {
        toast('Не удалось опубликовать', 'error');
      }
      return;
    }
    this.collection = res.data;
    this._fillForm();
    this._updateButtons();
    toast('Подборка опубликована', 'success');
  }

  /**
   * Снятие с публикации через StorageService.unpublishCollection.
   * Slug становится '', ссылка перестаёт работать (share → not-found).
   * Если товаров 0 — не ошибка, подборка становится черновиком.
   */
  async _unpublish() {
    const res = await this.storage.unpublishCollection(this.id);
    if (!res.ok) {
      if (res.error.code === 'NOT_FOUND') {
        toast('Подборка не найдена', 'error');
        this.navigate('#/dashboard');
      } else {
        toast('Не удалось снять с публикации', 'error');
      }
      return;
    }
    this.collection = res.data;
    this._fillForm();
    this._updateButtons();
    toast('Подборка снята с публикации', 'success');
  }

  async _openPicker() {
    this.pickerSelected = new Set();
    const search = document.getElementById('picker-search');
    if (search) search.value = '';
    await this._renderPicker();
    this.modals.open('modal-product-picker');
  }

  async _renderPicker() {
    const list = document.getElementById('picker-list');
    const empty = document.getElementById('picker-empty');
    if (!list || !empty) return;
    clear(list);

    const search = (document.getElementById('picker-search')?.value || '').trim();
    const res = await this.storage.getProducts({ search });
    const products = res.ok ? res.data : [];

    if (products.length === 0) {
      empty.hidden = false;
      list.hidden = true;
      return;
    }
    empty.hidden = true;
    list.hidden = false;

    const inCollection = new Set(this.collection.productIds);
    for (const p of products) {
      const disabled = inCollection.has(p.id);
      const cb = el('input', {
        type: 'checkbox',
        'data-pid': p.id,
        ...(this.pickerSelected.has(p.id) ? { checked: 'checked' } : {}),
        ...(disabled ? { disabled: 'disabled' } : {}),
      });
      const info = el('div', { class: 'picker-item__info' }, [
        el('p', { class: 'picker-item__title', text: p.title }),
        el('p', { class: 'picker-item__meta', text: `${p.category} · ${formatPrice(p.price)}` }),
      ]);
      list.appendChild(el('li', { class: 'picker-item' }, [cb, info]));
    }
  }

  async _confirmPicker() {
    const selected = [...this.pickerSelected];
    if (selected.length === 0) { this.modals.close(); return; }
    const next = [...this.collection.productIds, ...selected];
    const res = await this.storage.updateCollection(this.id, { productIds: next });
    if (!res.ok) { toast('Не удалось добавить товары', 'error'); return; }
    this.collection = res.data;
    this.modals.close();
    await this._renderProducts();
    this._updateButtons();
    toast(`Добавлено товаров: ${selected.length}`, 'success');
  }
}