/**
 * Gega Gallery — App 根组件
 *
 * 三栏布局：左 Sidebar (192px) | 中 Canvas (flex-1) | 右 DetailPanel (256px)
 * 顶部栏统一 48px，区块边界通过 token 化分隔线与背景层级区分。
 */

import React, { Suspense, useEffect, useCallback, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Sidebar } from './components/sidebar/Sidebar';
import { Toast } from './components/common/Toast';
import { Icon } from './components/common/Icon';
import { ImportProgressBar } from './components/common/ImportProgressBar';
import { LibrarySetup } from './components/library/LibrarySetup';
import { ConfirmModal } from './components/ConfirmModal';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { useUiStore, initPreferences } from './stores/uiStore';
import { useMediaStore } from './stores/mediaStore';
import { listen } from '@tauri-apps/api/event';
import { getPreference } from './utils/preferences';

const STARTUP_TIMEOUT_MS = 7000;
const STARTUP_BACKFILL_PROGRESS_REFRESH_MS = 1500;
const Canvas = React.lazy(() => import('./components/canvas/Canvas').then((module) => ({ default: module.Canvas })));
const DetailPanel = React.lazy(() => import('./components/detail/DetailPanel').then((module) => ({ default: module.DetailPanel })));
const PreferencesPanel = React.lazy(() => import('./components/preferences/PreferencesPanel').then((module) => ({ default: module.PreferencesPanel })));
const WebPage = React.lazy(() => import('./components/web/WebPage').then((module) => ({ default: module.WebPage })));

let startupBootstrapPromise: Promise<string | null> | null = null;
let startupBootstrapResolvedRoot: string | null = null;
let startupBackgroundTasksStarted = false;
let startupMicroBackfillScheduled = false;
let startupMicroBackfillTriggered = false;
let startupMicroBackfillHandledForSession = false;
let startupBackfillRefreshScheduled = false;
let startupBackfillRefreshTriggered = false;
let startupBackfillProgressRefreshTimer: number | null = null;
let startupBackfillProgressRefreshInFlight = false;
let lastStartupBackfillProgressRefreshAt = 0;

const resetStartupBootstrapCache = () => {
  startupBootstrapPromise = null;
  startupBootstrapResolvedRoot = null;
  startupBackgroundTasksStarted = false;
  startupMicroBackfillScheduled = false;
  startupMicroBackfillTriggered = false;
  startupMicroBackfillHandledForSession = false;
  startupBackfillRefreshScheduled = false;
  startupBackfillRefreshTriggered = false;
  startupBackfillProgressRefreshInFlight = false;
  lastStartupBackfillProgressRefreshAt = 0;
  if (typeof window !== 'undefined' && startupBackfillProgressRefreshTimer !== null) {
    window.clearTimeout(startupBackfillProgressRefreshTimer);
  }
  startupBackfillProgressRefreshTimer = null;
};

const scheduleMicroBackfill = (sourceFolder?: string | null, activeNav?: string | null) => {
  if (startupMicroBackfillScheduled || startupMicroBackfillHandledForSession) {
    return;
  }
  startupMicroBackfillScheduled = true;

  const fireAndForget = () => {
    if (startupMicroBackfillTriggered || startupMicroBackfillHandledForSession) {
      return;
    }
    startupMicroBackfillTriggered = true;
    startupMicroBackfillHandledForSession = true;
    void invoke('regenerate_missing_micro', {
      sourceFolder: sourceFolder ?? null,
      activeNav: activeNav ?? null,
    }).catch((err) => {
      console.warn('[Startup] micro backfill trigger failed:', err);
    });
  };

  if (typeof window === 'undefined') {
    fireAndForget();
    return;
  }

  const idleCallback = window.requestIdleCallback;
  if (typeof idleCallback === 'function') {
    idleCallback(() => fireAndForget(), { timeout: 3000 });
    return;
  }

  window.setTimeout(() => fireAndForget(), 0);
};

const scheduleStartupBackfillRefresh = (fetchFiles: (page?: number) => Promise<unknown>) => {
  if (startupBackfillRefreshScheduled || startupBackfillRefreshTriggered) {
    return;
  }
  startupBackfillRefreshScheduled = true;

  const refresh = () => {
    if (startupBackfillRefreshTriggered) {
      return;
    }
    startupBackfillRefreshTriggered = true;
    void fetchFiles(1).catch((err) => {
      console.warn('[App] startup backfill refresh failed:', err);
    });
  };

  if (typeof window === 'undefined') {
    refresh();
    return;
  }

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => refresh());
    return;
  }

  window.setTimeout(() => refresh(), 0);
};

const scheduleStartupBackfillProgressRefresh = (fetchFiles: (page?: number) => Promise<unknown>) => {
  if (startupBackfillProgressRefreshTimer !== null || startupBackfillProgressRefreshInFlight) {
    return;
  }

  const runRefresh = () => {
    startupBackfillProgressRefreshTimer = null;
    if (startupBackfillProgressRefreshInFlight) {
      return;
    }
    startupBackfillProgressRefreshInFlight = true;
    lastStartupBackfillProgressRefreshAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    void fetchFiles(1)
      .catch((err) => {
        console.warn('[App] startup backfill progress refresh failed:', err);
      })
      .finally(() => {
        startupBackfillProgressRefreshInFlight = false;
      });
  };

  if (typeof window === 'undefined') {
    runRefresh();
    return;
  }

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = now - lastStartupBackfillProgressRefreshAt;
  const delay = Math.max(0, STARTUP_BACKFILL_PROGRESS_REFRESH_MS - elapsed);
  startupBackfillProgressRefreshTimer = window.setTimeout(runRefresh, delay);
};

export const App: React.FC = () => {
  const isDetailPanelOpen = useUiStore((s) => s.isDetailPanelOpen);
  const showToast = useUiStore((s) => s.showToast);
  const fetchFiles = useMediaStore((s) => s.fetchFiles);
  const activeNav = useUiStore((s) => s.activeNav);
  const confirmModal = useUiStore((s) => s.confirmModal);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);
  // showConfirm 在 AddBookmarkModal 内部声明使用

  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [showAddBookmarkModal, setShowAddBookmarkModal] = useState(false);

  const pendingMetadataRefreshIds = useRef<Set<string>>(new Set());
  const metadataRefreshTimer = useRef<number | null>(null);
  const startupReleasedRef = useRef(false);
  const startupTaskCancelledRef = useRef(false);
  const startupTimeoutRef = useRef<number | null>(null);
  const startupSequenceRef = useRef(0);
  // Inspector 宽度状态（持久化到 SQLite）
  const [inspectorWidth, setInspectorWidth] = useState<number>(256);

  // 渲染中间内容区域
  const renderContent = () => {
    if (activeNav === 'web-pages') {
      return (
        <Suspense fallback={null}>
          <WebPage onAddBookmark={() => setShowAddBookmarkModal(true)} />
        </Suspense>
      );
    }
    return (
      <ErrorBoundary>
        <Suspense fallback={null}>
          <Canvas />
        </Suspense>
      </ErrorBoundary>
    );
  };

  // 监听后台扫描完成补全事件，刷新单个卡片元数据（如缩略图、颜色）
  useEffect(() => {
    const unlistenSingle = listen<{ id: string }>('media_metadata_updated', (event) => {
      const { id } = event.payload;
      pendingMetadataRefreshIds.current.add(id);

      if (metadataRefreshTimer.current !== null) {
        return;
      }

      metadataRefreshTimer.current = window.setTimeout(() => {
        metadataRefreshTimer.current = null;
        const ids = Array.from(pendingMetadataRefreshIds.current);
        pendingMetadataRefreshIds.current.clear();
        ids.forEach((mediaId) => {
          void useMediaStore.getState().refreshFileById(mediaId);
        });
      }, 300);
    });

    const unlistenBatch = listen<{ ids: string[] }>('media_metadata_updated_batch', (event) => {
      const { ids } = event.payload;
      if (!ids || ids.length === 0) return;
      ids.forEach((id) => pendingMetadataRefreshIds.current.add(id));

      if (metadataRefreshTimer.current !== null) {
        return;
      }

      metadataRefreshTimer.current = window.setTimeout(() => {
        metadataRefreshTimer.current = null;
        const idsToRefresh = Array.from(pendingMetadataRefreshIds.current);
        pendingMetadataRefreshIds.current.clear();
        idsToRefresh.forEach((mediaId) => {
          void useMediaStore.getState().refreshFileById(mediaId);
        });
      }, 300);
    });

    const unlistenStartupBackfillComplete = listen<{ processed: number; remaining: number }>('startup_backfill_complete', () => {
      scheduleStartupBackfillRefresh(fetchFiles);
    });
    const unlistenStartupBackfillProgress = listen<{ current: number; total: number }>('startup_backfill_progress', () => {
      scheduleStartupBackfillProgressRefresh(fetchFiles);
    });

    return () => {
      unlistenSingle.then((fn) => fn());
      unlistenBatch.then((fn) => fn());
      unlistenStartupBackfillComplete.then((fn) => fn());
      unlistenStartupBackfillProgress.then((fn) => fn());
      if (metadataRefreshTimer.current !== null) {
        window.clearTimeout(metadataRefreshTimer.current);
        metadataRefreshTimer.current = null;
      }
    };
  }, [fetchFiles, libraryRoot]);

  // 启动时异步加载用户偏好（主题、列数、Inspector 宽度）
  useEffect(() => {
    initPreferences();
    getPreference('inspector-width', '256').then(val => {
      const width = parseInt(val, 10);
      if (width >= 240 && width <= 600) {
        setInspectorWidth(width);
      }
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const platform = window.navigator.userAgent.toLowerCase().includes('mac') ? 'macos' : 'windows';
    document.documentElement.setAttribute('data-platform', platform);
  }, []);

  // 检查是否已配置库根目录并自动扫描
  useEffect(() => {
    const isDev = import.meta.env.DEV;
    const logStartup = (...args: unknown[]) => {
      if (!isDev) return;
      console.log(...args);
    };
    const logStartupWarn = (...args: unknown[]) => {
      if (!isDev) return;
      console.warn(...args);
    };

    let cancelled = false;
    const startupRunId = ++startupSequenceRef.current;
    startupReleasedRef.current = false;
    startupTaskCancelledRef.current = false;

    if (startupTimeoutRef.current !== null) {
      window.clearTimeout(startupTimeoutRef.current);
      startupTimeoutRef.current = null;
    }

    const isCurrentRun = () => !cancelled && startupRunId === startupSequenceRef.current;
    const safeSetState = (fn: () => void) => {
      if (!isCurrentRun()) return;
      fn();
    };
    const releaseShell = (stage: string) => {
      if (!isCurrentRun() || startupReleasedRef.current) return;
      startupReleasedRef.current = true;
      logStartup('[Startup] release shell:', stage);
      safeSetState(() => setIsChecking(false));
    };

    const startBackgroundTasks = (resolvedRoot: string | null) => {
      if (!isCurrentRun()) return;
      if (startupBackgroundTasksStarted) {
        logStartup('[Startup] background tasks already started, skipping duplicate launch');
        return;
      }
      startupBackgroundTasksStarted = true;

      logStartup('[Startup] first media page started ...');
      void fetchFiles(1)
        .then(() => {
          if (!isCurrentRun()) return;
          logStartup('[Startup] first media page ready ...');
          const currentNav = useUiStore.getState().activeNav;
          scheduleMicroBackfill(currentNav === 'library' ? '灵感库' : null, currentNav);
        })
        .catch((err) => {
          if (!isCurrentRun()) return;
          console.error('[Startup] first media page failed:', err);
          if (isDev) {
            console.warn('[Startup] continuing to main UI despite first page failure');
          }
        });

      logStartup('[Startup] background scan skipped on launch');

      void invoke('get_nav_item_counts', { navIds: ['library', 'ai-prompts', 'projects', 'trash', 'web-pages'], libraryRoot: resolvedRoot })
        .then((counts) => {
          if (!isCurrentRun()) return;
          logStartup('[Startup] nav counts refreshed:', counts);
        })
        .catch((e) => {
          if (!isCurrentRun()) return;
          logStartupWarn('[Startup] nav count refresh failed:', e);
        });
    };

    const runBootstrap = async (): Promise<string | null> => {
      if (startupBootstrapResolvedRoot !== null) {
        return startupBootstrapResolvedRoot;
      }
      if (!startupBootstrapPromise) {
        startupBootstrapPromise = invoke<string | null>('get_library_root')
          .then((root) => {
            startupBootstrapResolvedRoot = root;
            return root;
          })
          .catch((err) => {
            resetStartupBootstrapCache();
            throw err;
          });
      }
      return startupBootstrapPromise;
    };

    logStartup('[Startup] db ready ...');
    releaseShell('db-ready');

    logStartup('[Startup] root lookup started ...');
    void runBootstrap()
      .then((root) => {
        if (!isCurrentRun()) return;
        if (!root) {
          logStartup('[Startup] root ready ...', null);
          safeSetState(() => setLibraryRoot(null));
          return;
        }

        logStartup('[Startup] root ready ...', root);
        safeSetState(() => setLibraryRoot(root));
        startBackgroundTasks(root);
      })
      .catch((err) => {
        if (!isCurrentRun()) return;
        console.error('[Startup] Startup error:', err);
        safeSetState(() => setLibraryRoot(null));
      });

    startupTimeoutRef.current = window.setTimeout(() => {
      if (!isCurrentRun() || startupReleasedRef.current) return;
      logStartupWarn('[Startup] timeout reached, forcing shell release');
      startupReleasedRef.current = true;
      safeSetState(() => setIsChecking(false));
    }, STARTUP_TIMEOUT_MS);

    return () => {
      cancelled = true;
      startupTaskCancelledRef.current = true;
      if (startupTimeoutRef.current !== null) {
        window.clearTimeout(startupTimeoutRef.current);
        startupTimeoutRef.current = null;
      }
    };
  }, [fetchFiles]);

  // 处理库根目录设置完成
  const handleLibrarySetup = useCallback(async (selectedPath: string) => {
    console.log('[App] handleLibrarySetup called with selectedPath:', selectedPath);

    // selectedPath 现在是用户选择的父目录，init_library 会返回完整的 NocturneGallery 路径
    console.log('[App] Calling init_library with parent_path:', selectedPath);
    const libraryRoot = await invoke<string>('init_library', { parentPath: selectedPath });
    console.log('[App] Library initialized at:', libraryRoot);
    resetStartupBootstrapCache();
    setLibraryRoot(libraryRoot);
    showToast('灵感库初始化完成');

    // 与启动页一致：先释放主界面，再后台补全数据，不让 fetch/scan 阻塞 shell
    void fetchFiles(1).catch((err) => {
      console.error('[App] Initial fetch after library setup failed:', err);
    });
    scheduleMicroBackfill('灵感库', 'library');
    void invoke('scan_directory', { path: libraryRoot })
      .then(() => console.log('[App] Background scan complete'))
      .catch((err) => console.error('[App] Background scan failed:', err));
  }, [fetchFiles, showToast]);

  // 打开首选项面板
  const handleOpenPreferences = useCallback(() => {
    console.log('[App] Opening preferences panel');
    setIsPreferencesOpen(true);
  }, []);

  // 加载中
  if (isChecking) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          backgroundColor: 'var(--bg-primary)',
          fontFamily: 'var(--font-family)',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <Icon
            name="progress_activity"
            size={48}
            style={{
              color: 'var(--accent)',
              animation: 'spin 2s linear infinite',
            }}
          />
          <p style={{ color: 'var(--text-secondary)', marginTop: '16px' }}>
            正在加载...
          </p>
        </div>
      </div>
    );
  }

  // 首次启动，显示欢迎页面
  if (!libraryRoot) {
    return <LibrarySetup onSetup={handleLibrarySetup} initialRoot={libraryRoot} />;
  }

  // 正常显示主界面
  return (
    <div
      style={{
        ['--detail-width' as string]: `${inspectorWidth}px`,
        display: 'grid',
        gridTemplateColumns: `var(--sidebar-width) minmax(0, 1fr) ${inspectorWidth}px`,
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-primary)',
        fontFamily: 'var(--font-family)',
      }}
    >
      {/* 全局样式注入 */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      {/* 左侧导航栏 */}
      <Sidebar onOpenPreferences={handleOpenPreferences} libraryRoot={libraryRoot} />

      {/* 中间区域：画布 */}
      <div style={{ minWidth: 0, display: 'flex', overflow: 'hidden' }}>
        {renderContent()}
      </div>

      {/* 右侧详情面板 */}
      <div
        style={{
          width: inspectorWidth,
          flexShrink: 0,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {isDetailPanelOpen && (
          <ErrorBoundary>
            <Suspense fallback={null}>
              <DetailPanel
                setInspectorWidth={setInspectorWidth}
                inspectorWidth={inspectorWidth}
              />
            </Suspense>
          </ErrorBoundary>
        )}
      </div>

      {/* 首选项弹窗（居中 Modal） */}
      {isPreferencesOpen && (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <PreferencesPanel
              onClose={() => {
                setIsPreferencesOpen(false);
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      {/* 全局 Toast */}
      <Toast />

      {/* 全局 ConfirmModal */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        title={confirmModal.title}
        message={confirmModal.message}
        confirmText={confirmModal.confirmText}
        cancelText={confirmModal.cancelText}
        danger={confirmModal.danger}
        onConfirm={() => {
          resolveConfirm(true);
        }}
        onCancel={() => {
          resolveConfirm(false);
        }}
      />

      {/* 添加书签弹窗（仅在网页管理页面） */}
      {activeNav === 'web-pages' && showAddBookmarkModal && (
        <AddBookmarkModal
          isOpen={showAddBookmarkModal}
          onClose={() => setShowAddBookmarkModal(false)}
        />
      )}

      {/* 导入进度条 */}
      <ImportProgressBar />

    </div>
  );
};

// ----------------------------------------------------------------
// Add Bookmark Modal Component
// ----------------------------------------------------------------

interface AddBookmarkModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const AddBookmarkModal: React.FC<AddBookmarkModalProps> = ({ isOpen, onClose }) => {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const showConfirm = useUiStore((s) => s.showConfirm);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!url.trim()) {
      await showConfirm({
        title: '提示',
        message: '请输入网址',
        confirmText: '确定',
        cancelText: '',
      });
      return;
    }

    let validatedUrl = url.trim();
    if (!validatedUrl.startsWith('http://') && !validatedUrl.startsWith('https://')) {
      validatedUrl = 'https://' + validatedUrl;
    }

    try {
      await invoke('add_bookmark', {
        url: validatedUrl,
        title: title.trim() || null,
        description: null,
        tags: tags.trim() || null,
      });
      setUrl('');
      setTitle('');
      setTags('');
      onClose();
      // 触发页面刷新事件
      window.dispatchEvent(new CustomEvent('bookmarks-updated'));
    } catch (err) {
      console.error('[App] Failed to add bookmark:', err);
      await showConfirm({
        title: '添加失败',
        message: (err as Error).message,
        confirmText: '确定',
        cancelText: '',
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'var(--overlay-backdrop)',
          zIndex: 9998,
        }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-card)',
          padding: '24px',
          minWidth: '400px',
          zIndex: 9999,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-family)',
            fontSize: '20px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: '0 0 20px 0',
          }}
        >
          收藏网页
        </h2>

        {/* URL 输入框 */}
        <div style={{ marginBottom: '16px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            网址 *
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="https://example.com"
            autoFocus
            style={{
              width: '100%',
              height: '40px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 标题输入框 */}
        <div style={{ marginBottom: '16px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            标题（可选）
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="自定义标题"
            style={{
              width: '100%',
              height: '40px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 标签输入框 */}
        <div style={{ marginBottom: '20px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            标签（可选）
          </label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="设计、灵感、工具"
            style={{
              width: '100%',
              height: '40px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 按钮组 */}
        <div
          style={{
            display: 'flex',
            gap: '12px',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onClose}
            style={{
              height: '36px',
              padding: '0 16px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'transparent',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            style={{
              height: '36px',
              padding: '0 20px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            收藏
          </button>
        </div>
      </div>
    </>
  );
};
