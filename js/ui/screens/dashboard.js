/**
 * dashboard.js — экран #/dashboard.
 * Рендер статистики, списка коллекций, фильтров, кнопок действий.
 */
import { el, clear, formatDate } from '../../utils.js';
import { toast } from '../toast.js';

export class DashboardScreen {
  /**
   * @param {{ storage: import('../../storage.js').StorageService, router: any, confirm: any, navigate: (h:string)=>void }} deps
   */
  constructor({ storage, router, confirm, navigate }) {
    this.storage = storage;
    this.router = router;
    this.confirm = confirm;
    this.navigate = navigate;

    this.sort = 'date';
    this.theme = '';
    this._bound = false;
  }

  mount() {
    if (this._bound) return;
    this._bound = true;

    const createBtn = document.getElementById('btn-create-collection');
    if (createBtn) {
      createBtn.addEventListener('click', () => this._createCollection());
    }

    const emptyCreate = document.querySelector('[data-action="create-collection-from-empty"]');
    if (emptyCreate) {
      emptyCreate.addEventListener('click', () => this._createCollection());
    }

    const sortEl = document.getElementById('dashboard-sort');
    if (sortEl) {
      sortEl.addEventListener('change', (e) => {
        this.sort = e.target.value;
        this.render();
      });
    }

    const themeEl = document.getElementById('dashboard-theme');
    if (themeEl) {
      themeEl.addEventListener('change', (e) => {
        this.theme = e.target.value;
        this.render();
      });
    }

    // Делегирование на карточки
    const list = document.getElementById('dashboard-list');
    if (list) {
      list.addEventListener('click', (e) => this._onCardClick(e));
    }
  }

  async show() {
    // Переключение видимости экранов
    this._showScreen('screen-dashboard');
    // Активный пункт навигации
    this._setActiveNav('dashboard');

    await this.render();
  }

  async render() {
    // Статистика
    const stats = await this.storage.getStats();
    if (stats.ok) {
      document.getElementById('stat-products').textContent = String(stats.data.totalProducts);
      document.getElementById('stat-collections').textContent = String(stats.data.totalCollections);
      document.getElementById('stat-views').textContent = String(stats.data.totalViews);
    }

    // Теми
    await this._renderThemes();

    // Список
    const collectionsRes = await this.storage.getCollections({ sort: this.sort, theme: this.theme || undefined });
    const list = document.getElementById('dashboard-list');
    const empty = document.getElementById('dashboard-empty');
    if (!list || !empty) return;

    // [FIX v1.3-1] Принудительный сброс перед проверкой общего empty-state,
    // чтобы пустой блок не «залипал» при переходе из пустого состояния в непустое.
    empty.hidden = true;
    list.hidden = false;

    clear(list);

    if (!collectionsRes.ok) {
      toast('Не удалось загрузить подборки', 'error');
      return;
    }
    const collections = collectionsRes.data;

    // Общий empty-state (нет ни одной коллекции)
    if (collections.length === 0 && !this.theme) {
      empty.hidden = false;
      list.hidden = true;
      return;
    }

    if (collections.length === 0) {
      // Фильтр не дал результатов
      list.appendChild(el('li', { class: 'empty-state empty-state--compact' }, [
        el('p', { class: 'empty-state__text', text: 'По выбранной теме подборок нет.' }),
      ]));
      return;
    }

    for (const c of collections) {
      list.appendChild(await this._renderCard(c));
    }
  }

  async _renderThemes() {
    const themeEl = document.getElementById('dashboard-theme');
    if (!themeEl) return;
    const all = await this.storage.getCollections({ sort: 'date' });
    if (!all.ok) return;
    const themes = new Set();
    for (const c of all.data) {
      if (c.theme) themes.add(c.theme);
    }
    // сохранить текущее значение
    const current = this.theme;
    clear(themeEl);
    themeEl.appendChild(el('option', { value: '', text: 'Все темы' }));
    for (const t of [...themes].sort((a, b) => a.localeCompare(b))) {
      themeEl.appendChild(el('option', { value: t, text: t }));
    }
    themeEl.value = current;
    if (themeEl.value !== current) {
      themeEl.value = '';
      this.theme = '';
    }
  }

  async _renderCard(c) {
    const productsRes = await this.storage.getProducts();
    const products = productsRes.ok ? productsRes.data : [];
    const productsById = new Map(products.map((p) => [p.id, p]));
    const firstProduct = c.productIds[0] ? productsById.get(c.productIds[0]) : null;

    // coverUrl fallback → обложка первого товара (§6.6, UI-слой)
    const coverSrc = c.coverUrl || (firstProduct && firstProduct.imageUrl) || null;

    const cover = el('div', { class: 'collection-card__cover' }, [
      coverSrc
        ? el('img', { src: coverSrc, alt: '', loading: 'lazy' })
        : el('span', { class: 'collection-card__cover-placeholder', 'aria-hidden': 'true', text: '🎁' }),
    ]);

    const badges = el('div', { class: 'collection-card__badges' }, [
      c.isPublished
        ? el('span', { class: 'badge badge--published', text: 'Опубликована' })
        : el('span', { class: 'badge badge--draft', text: 'Черновик' }),
      c.theme ? el('span', { class: 'badge badge--category', text: c.theme }) : null,
    ]);
    cover.appendChild(badges);

    const title = el('h3', { class: 'collection-card__title', text: c.title });

    const meta = el('div', { class: 'collection-card__meta' }, [
      el('span', { class: 'collection-card__meta-item', text: `🛒 ${c.productIds.length} тов.` }),
      el('span', { class: 'collection-card__meta-item', text: `👁 ${c.views}` }),
      el('span', { class: 'collection-card__meta-item', text: formatDate(c.updatedAt) }),
    ]);

    const body = el('div', { class: 'collection-card__body' }, [title, meta]);

    const actions = el('div', { class: 'collection-card__actions' }, [
      el('a', {
        class: 'btn btn--secondary btn--sm',
        href: `#/collections/${encodeURIComponent(c.id)}`,
        text: 'Редактировать',
      }),
      c.isPublished
        ? el('button', {
            type: 'button',
            class: 'btn btn--ghost btn--sm',
            'data-action': 'copy-link',
            'data-slug': c.slug,
            text: 'Скопировать ссылку',
          })
        : null,
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        'data-action': 'delete',
        'data-id': c.id,
        text: 'Удалить',
      }),
    ]);

    const card = el('li', { class: 'collection-card', 'data-id': c.id }, [cover, body, actions]);
    return card;
  }

  async _onCardClick(e) {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'copy-link') {
      const slug = btn.dataset.slug;
      const url = `${location.origin}${location.pathname}#/share/${encodeURIComponent(slug)}`;
      await this._copyToClipboard(url);
      return;
    }
    if (action === 'delete') {
      const id = btn.dataset.id;
      const res = await this.storage.getCollection(id);
      if (!res.ok) { toast('Подборка не найдена', 'error'); return; }
      const confirmed = await this.confirm.ask({
        title: 'Удалить подборку?',
        text: `«${res.data.title}» будет удалена безвозвратно.`,
        okLabel: 'Удалить',
      });
      if (!confirmed) return;
      const del = await this.storage.deleteCollection(id);
      if (!del.ok) { toast('Не удалось удалить', 'error'); return; }
      toast('Подборка удалена', 'success');
      await this.render();
    }
  }

  async _copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        toast('Ссылка скопирована', 'success');
        return true;
      }
    } catch { /* fallthrough */ }
    // Fallback: показать ссылку в модалке шаринга
    const input = document.getElementById('share-url');
    if (input) input.value = text;
    if (window.__modals) window.__modals.open('modal-share-fallback');
    return false;
  }

  async _createCollection() {
    // Проверка лимита
    const stats = await this.storage.getStats();
    if (stats.ok && stats.data.totalCollections >= 50) {
      toast('Достигнут лимит 50 подборок', 'warning');
      return;
    }
    // Создаём сразу черновик с дефолтным названием и открываем редактор
    // (форма редактирования на экране редактора, не в модалке — ASSUMPTIONS п.2)
    const res = await this.storage.createCollection({ title: 'Новая подборка' });
    if (!res.ok) {
      if (res.error.code === 'LIMIT_COLLECTIONS') toast('Достигнут лимит 50 подборок', 'warning');
      else toast('Не удалось создать подборку', 'error');
      return;
    }
    this.navigate(`#/collections/${encodeURIComponent(res.data.id)}`);
  }

  _showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.hidden = s.id !== id;
    });
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  _setActiveNav(key) {
    document.querySelectorAll('.app-nav__link').forEach((a) => {
      a.classList.toggle('is-active', a.dataset.nav === key);
    });
  }
}