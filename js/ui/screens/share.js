/**
 * share.js — экран #/share/:slug.
 * Рендер опубликованной подборки, инкремент просмотров, Web Share / copy / fallback.
 */
import { el, clear, formatPrice } from '../../utils.js';
import { toast } from '../toast.js';

export class ShareScreen {
  constructor({ storage, router, navigate, modals }) {
    this.storage = storage;
    this.router = router;
    this.navigate = navigate;
    this.modals = modals;
    this.currentSlug = null;
    this._bound = false;
  }

  mount() {
    if (this._bound) return;
    this._bound = true;

    const shareBtn = document.getElementById('btn-share');
    if (shareBtn) shareBtn.addEventListener('click', () => this._share());
  }

  async show({ slug }) {
    document.querySelectorAll('.screen').forEach((s) => {
      s.hidden = s.id !== 'screen-share';
    });
    document.querySelectorAll('.app-nav__link').forEach((a) => a.classList.remove('is-active'));
    window.scrollTo({ top: 0 });

    this.currentSlug = slug;
    const res = await this.storage.getCollectionBySlug(slug);
    if (!res.ok || !res.data || !res.data.isPublished) {
      this._showNotFound();
      return;
    }
    const collection = res.data;

    // Increment views (с session-guard)
    await this.storage.incrementViews(slug);
    // Перечитать актуальное значение views
    const fresh = await this.storage.getCollectionBySlug(slug);
    if (fresh.ok && fresh.data) {
      this._render(fresh.data);
    } else {
      this._render(collection);
    }
  }

  _showNotFound() {
    document.getElementById('share-content').hidden = true;
    document.getElementById('share-not-found').hidden = false;
  }

  async _render(c) {
    document.getElementById('share-content').hidden = false;
    document.getElementById('share-not-found').hidden = true;

    // Обложка: coverUrl || обложка первого товара (§6.6 UI-fallback)
    const productsRes = await this.storage.getProducts();
    const products = productsRes.ok ? productsRes.data : [];
    const byId = new Map(products.map((p) => [p.id, p]));
    const first = c.productIds[0] ? byId.get(c.productIds[0]) : null;
    const coverSrc = c.coverUrl || (first && first.imageUrl) || null;

    const img = document.getElementById('share-cover-img');
    const placeholder = document.getElementById('share-cover-placeholder');
    if (img && placeholder) {
      if (coverSrc) {
        img.src = coverSrc;
        img.alt = '';
        img.hidden = false;
        placeholder.hidden = true;
      } else {
        img.hidden = true;
        placeholder.hidden = false;
      }
    }

    document.getElementById('share-title').textContent = c.title;
    const theme = document.getElementById('share-theme');
    if (theme) {
      theme.textContent = c.theme || '';
      theme.hidden = !c.theme;
    }
    const desc = document.getElementById('share-description');
    if (desc) {
      desc.textContent = c.description || '';
      desc.hidden = !c.description;
    }
    document.getElementById('share-views-count').textContent = String(c.views);

    const list = document.getElementById('share-products-list');
    const empty = document.getElementById('share-products-empty');
    clear(list);

    if (c.productIds.length === 0) {
      empty.hidden = false;
      list.hidden = true;
      return;
    }
    empty.hidden = true;
    list.hidden = false;

    for (const pid of c.productIds) {
      const p = byId.get(pid);
      if (!p) continue;
      const thumb = el('div', { class: 'share__product-thumb' }, [
        p.imageUrl
          ? el('img', { src: p.imageUrl, alt: '', loading: 'lazy' })
          : el('span', { 'aria-hidden': 'true', text: '📦' }),
      ]);
      const info = el('div', { class: 'share__product-info' }, [
        el('p', { class: 'share__product-title', text: p.title }),
        p.description ? el('p', { class: 'share__product-desc', text: p.description }) : null,
      ]);
      const price = el('span', { class: 'share__product-price', text: formatPrice(p.price) });
      list.appendChild(el('li', { class: 'share__product-item' }, [thumb, info, price]));
    }
  }

  async _share() {
    const url = `${location.origin}${location.pathname}#/share/${encodeURIComponent(this.currentSlug)}`;
    const title = document.getElementById('share-title')?.textContent || 'GiftBox Studio';

    // 1) Web Share API
    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        // fallthrough
      }
    }
    // 2) Clipboard
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        toast('Ссылка скопирована', 'success');
        return;
      }
    } catch { /* fallthrough */ }
    // 3) Fallback modal
    const input = document.getElementById('share-url');
    if (input) input.value = url;
    this.modals.open('modal-share-fallback');
  }
}