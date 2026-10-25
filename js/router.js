/**
 * router.js — hashchange-роутинг.
 * Поддерживаемые маршруты:
 *   #/dashboard
 *   #/catalog
 *   #/collections/:id
 *   #/share/:slug
 *   <empty> → редирект на #/dashboard
 *   неизвестный → #/dashboard (без 404-экрана, кроме share not found)
 */

export class Router {
  /**
   * @param {{ routes: Record<string, (params: object) => void>, onBefore?: (route: string) => void }} opts
   */
  constructor({ routes, onBefore }) {
    this.routes = routes;
    this.onBefore = onBefore;
    this._handler = this._handle.bind(this);
  }

  start() {
    window.addEventListener('hashchange', this._handler);
    this._handle();
  }

  stop() {
    window.removeEventListener('hashchange', this._handler);
  }

  navigate(hash) {
    if (window.location.hash === hash) {
      this._handle();
    } else {
      window.location.hash = hash;
    }
  }

  _parse() {
    const raw = window.location.hash || '';
    const path = raw.replace(/^#/, '') || '/dashboard';
    // normalized "/dashboard", "/catalog", "/collections/abc", "/share/slug"
    const parts = path.split('/').filter(Boolean);
    return parts;
  }

  _handle() {
    const parts = this._parse();
    const [root, param] = parts;
    let route;
    let params = {};

    if (root === 'dashboard' || root === undefined) {
      route = 'dashboard';
    } else if (root === 'catalog') {
      route = 'catalog';
    } else if (root === 'collections' && param) {
      route = 'collections';
      params.id = decodeURIComponent(param);
    } else if (root === 'share' && param) {
      route = 'share';
      params.slug = decodeURIComponent(param);
    } else {
      // fallback
      this.navigate('#/dashboard');
      return;
    }

    if (this.onBefore) this.onBefore(route, params);
    const fn = this.routes[route];
    if (typeof fn === 'function') fn(params);
  }
}