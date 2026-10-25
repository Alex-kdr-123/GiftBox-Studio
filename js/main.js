/**
 * main.js — точка входа.
 * Инициализация StorageService, роутера, экранов, глобальных обработчиков.
 */
import { StorageService } from './storage.js';
import { Router } from './router.js';
import { ModalManager, bindCloseButtons } from './ui/modal.js';
import { ConfirmDialog } from './ui/confirm.js';
import { toast } from './ui/toast.js';
import { DashboardScreen } from './ui/screens/dashboard.js';
import { CatalogScreen } from './ui/screens/catalog.js';
import { EditorScreen } from './ui/screens/editor.js';
import { ShareScreen } from './ui/screens/share.js';

async function bootstrap() {
  const storage = new StorageService();
  const initRes = await storage.init();

  // Обработка STORAGE_CORRUPTED
  if (!initRes.ok && initRes.error.code === 'STORAGE_CORRUPTED') {
    const modalsEarly = new ModalManager();
    const resetBtn = document.getElementById('btn-storage-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        const r = await storage.resetAll();
        if (r.ok) {
          modalsEarly.close();
          toast('Хранилище сброшено', 'success');
          // [FIX v1.3-3] Полная перезагрузка вместо рекурсивного bootstrap().
          // Рекурсивный вызов накапливал бы слушатели и состояние.
          location.reload();
        } else {
          toast('Не удалось сбросить хранилище', 'error');
        }
      }, { once: true });
    }
    modalsEarly.open('modal-storage-reset');
    return;
  }

  const modals = new ModalManager();
  bindCloseButtons(modals);
  window.__modals = modals;

  const confirm = new ConfirmDialog(modals);

  const navigate = (hash) => {
    if (location.hash === hash) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      location.hash = hash;
    }
  };

  const deps = { storage, modals, confirm, navigate };

  const dashboard = new DashboardScreen({ ...deps, router: null });
  const catalog = new CatalogScreen({ ...deps, router: null });
  const editor = new EditorScreen({ ...deps, router: null });
  const share = new ShareScreen({ ...deps, router: null });

  dashboard.mount();
  catalog.mount();
  editor.mount();
  share.mount();

  const router = new Router({
    routes: {
      dashboard: () => dashboard.show(),
      catalog: () => catalog.show(),
      collections: (params) => editor.show({ id: params.id }),
      share: (params) => share.show({ slug: params.slug }),
    },
    onBefore: () => {
      // Закрыть модалки при смене роута
      modals.closeAll();
    },
  });

  // Проброс router в экраны (нужен для навигации)
  dashboard.router = router;
  catalog.router = router;
  editor.router = router;
  share.router = router;

  router.start();

  // Если hash пустой — на дашборд
  if (!window.location.hash) navigate('#/dashboard');
}

document.addEventListener('DOMContentLoaded', () => {
  bootstrap().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[GiftBox] bootstrap failed:', e);
  });
});