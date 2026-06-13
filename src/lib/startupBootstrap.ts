/**
 * 应用启动：库根目录解析、首屏数据拉取与后台 micro/backfill 调度
 */

import { invoke } from '@tauri-apps/api/core';
import { appLogger } from './appLogger';
import { useUiStore } from '../stores/uiStore';
import {
  getStartupRuntime,
  resetStartupRuntime,
  STARTUP_BACKFILL_PROGRESS_DEBOUNCE_MS,
} from './startupRuntime';

export const STARTUP_TIMEOUT_MS = 7000;

type FetchFiles = (page: number) => Promise<void>;

export function resetStartupBootstrapCache(): void {
  resetStartupRuntime();
}

export function isStartupBackgroundTasksStarted(): boolean {
  return getStartupRuntime().backgroundTasksStarted;
}

export function markStartupBackgroundTasksStarted(): void {
  getStartupRuntime().backgroundTasksStarted = true;
}

export function resolveLibraryRoot(): Promise<string | null> {
  const rt = getStartupRuntime();
  if (rt.cachedLibraryRoot !== null) {
    return Promise.resolve(rt.cachedLibraryRoot);
  }

  if (!rt.libraryRootPromise) {
    const invokeRoot = invoke<string | null>('get_library_root');
    const timeoutMs = 8000;
    const timeout =
      typeof window === 'undefined'
        ? new Promise<null>(() => undefined)
        : new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), timeoutMs);
          });
    rt.libraryRootPromise = Promise.race([invokeRoot, timeout])
      .then((root) => {
        getStartupRuntime().cachedLibraryRoot = root;
        if (root === null && typeof window !== 'undefined') {
          appLogger.warn('[Startup] get_library_root timed out or returned null');
        }
        return root;
      })
      .catch((err) => {
        resetStartupRuntime();
        appLogger.error('[Startup] get_library_root failed:', err);
        return null;
      });
  }

  return rt.libraryRootPromise;
}

export function scheduleMicroBackfill(
  sourceFolder: string | null,
  activeNav: string | null,
): void {
  const rt = getStartupRuntime();
  if (rt.microBackfillGateEntered || rt.microBackfillInvokeDone) {
    return;
  }
  rt.microBackfillGateEntered = true;

  const trigger = () => {
    const inner = getStartupRuntime();
    if (inner.microBackfillInvokeStarted || inner.microBackfillInvokeDone) {
      return;
    }
    inner.microBackfillInvokeStarted = true;
    inner.microBackfillInvokeDone = true;

    void invoke('regenerate_missing_micro', {
      sourceFolder: sourceFolder ?? null,
      activeNav: activeNav ?? null,
    }).catch((err) => {
      appLogger.warn('[Startup] micro backfill trigger failed:', err);
    });
  };

  if (typeof window === 'undefined') {
    trigger();
    return;
  }

  const idle = window.requestIdleCallback;
  if (typeof idle === 'function') {
    idle(() => trigger(), { timeout: 3000 });
    return;
  }

  window.setTimeout(() => trigger(), 0);
}

export function scheduleStartupBackfillRefresh(fetchFiles: FetchFiles): void {
  const rt = getStartupRuntime();
  if (rt.startupBackfillRefreshScheduled || rt.startupBackfillRefreshDone) {
    return;
  }
  rt.startupBackfillRefreshScheduled = true;

  const run = () => {
    const inner = getStartupRuntime();
    if (inner.startupBackfillRefreshDone) {
      return;
    }
    inner.startupBackfillRefreshDone = true;
    void fetchFiles(1).catch((err) => {
      appLogger.warn('[App] startup backfill refresh failed:', err);
    });
  };

  if (typeof window === 'undefined') {
    run();
    return;
  }

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => run());
    return;
  }

  window.setTimeout(() => run(), 0);
}

export function scheduleStartupBackfillProgressRefresh(fetchFiles: FetchFiles): void {
  const rt = getStartupRuntime();
  if (rt.startupBackfillProgressTimer !== null || rt.startupBackfillProgressInFlight) {
    return;
  }

  const run = () => {
    const inner = getStartupRuntime();
    inner.startupBackfillProgressTimer = null;
    if (inner.startupBackfillProgressInFlight) {
      return;
    }

    inner.startupBackfillProgressInFlight = true;
    inner.startupBackfillProgressLastAt =
      typeof performance !== 'undefined' ? performance.now() : Date.now();

    void fetchFiles(1)
      .catch((err) => {
        appLogger.warn('[App] startup backfill progress refresh failed:', err);
      })
      .finally(() => {
        getStartupRuntime().startupBackfillProgressInFlight = false;
      });
  };

  if (typeof window === 'undefined') {
    run();
    return;
  }

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = now - rt.startupBackfillProgressLastAt;
  const delay = Math.max(0, STARTUP_BACKFILL_PROGRESS_DEBOUNCE_MS - elapsed);

  rt.startupBackfillProgressTimer = window.setTimeout(run, delay);
}

export interface StartupBootstrapHandlers {
  setLibraryRoot: (root: string | null) => void;
  setIsChecking: (checking: boolean) => void;
  fetchFiles: FetchFiles;
}

/**
 * 启动流程：尽快释放 shell，后台解析库根并拉取首屏数据
 * @returns effect 清理函数
 */
export function runStartupBootstrap(handlers: StartupBootstrapHandlers): () => void {
  let cancelled = false;
  let startupRunId = 0;
  startupRunId += 1;
  const currentRunId = startupRunId;
  let shellReleased = false;
  let startupTimeoutId: number | null = null;

  const isCurrentRun = () => !cancelled && currentRunId === startupRunId;
  const safeSetState = (fn: () => void) => {
    if (!isCurrentRun()) return;
    fn();
  };

  const releaseShell = (stage: string) => {
    if (!isCurrentRun() || shellReleased) return;
    shellReleased = true;
    appLogger.debug('[Startup] release shell:', stage);
    safeSetState(() => handlers.setIsChecking(false));
  };

  const startBackgroundTasks = (resolvedRoot: string | null) => {
    if (!isCurrentRun()) return;
    if (isStartupBackgroundTasksStarted()) {
      appLogger.debug('[Startup] background tasks already started, skipping duplicate launch');
      return;
    }
    markStartupBackgroundTasksStarted();

    appLogger.debug('[Startup] first media page started ...');
    void handlers
      .fetchFiles(1)
      .then(() => {
        if (!isCurrentRun()) return;
        appLogger.debug('[Startup] first media page ready ...');
        const currentNav = useUiStore.getState().activeNav;
        scheduleMicroBackfill(currentNav === 'library' ? '灵感库' : null, currentNav);
      })
      .catch((err) => {
        if (!isCurrentRun()) return;
        appLogger.error('[Startup] first media page failed:', err);
        appLogger.warn('[Startup] continuing to main UI despite first page failure');
      });

    appLogger.debug('[Startup] background scan skipped on launch');

    void invoke('get_nav_item_counts', {
      navIds: ['library', 'ai-prompts', 'projects', 'trash', 'web-pages'],
      libraryRoot: resolvedRoot,
    })
      .then((counts) => {
        if (!isCurrentRun()) return;
        appLogger.debug('[Startup] nav counts refreshed:', counts);
      })
      .catch((e) => {
        if (!isCurrentRun()) return;
        appLogger.warn('[Startup] nav count refresh failed:', e);
      });
  };

  appLogger.debug('[Startup] db ready ...');
  releaseShell('db-ready');

  appLogger.debug('[Startup] root lookup started ...');
  void resolveLibraryRoot()
    .then((root) => {
      if (!isCurrentRun()) return;
      if (!root) {
        appLogger.debug('[Startup] root ready ...', null);
        safeSetState(() => handlers.setLibraryRoot(null));
        return;
      }

      appLogger.debug('[Startup] root ready ...', root);
      safeSetState(() => handlers.setLibraryRoot(root));
      startBackgroundTasks(root);
    })
    .catch((err) => {
      if (!isCurrentRun()) return;
      appLogger.error('[Startup] Startup error:', err);
      safeSetState(() => handlers.setLibraryRoot(null));
    });

  if (typeof window !== 'undefined') {
    startupTimeoutId = window.setTimeout(() => {
      if (!isCurrentRun() || shellReleased) return;
      appLogger.warn('[Startup] timeout reached, forcing shell release');
      shellReleased = true;
      safeSetState(() => handlers.setIsChecking(false));
    }, STARTUP_TIMEOUT_MS);
  }

  return () => {
    cancelled = true;
    if (startupTimeoutId !== null) {
      window.clearTimeout(startupTimeoutId);
      startupTimeoutId = null;
    }
  };
}