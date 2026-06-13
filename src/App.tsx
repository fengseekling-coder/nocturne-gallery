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
import { AddBookmarkModal } from './components/web/AddBookmarkModal';
import { appLogger } from './lib/appLogger';
import {
  resetStartupBootstrapCache,
  scheduleMicroBackfill,
  scheduleStartupBackfillRefresh,
  scheduleStartupBackfillProgressRefresh,
  runStartupBootstrap,
} from './lib/startupBootstrap';

const Canvas = React.lazy(() =>
  import('./components/canvas/Canvas').then((m) => ({ default: m.Canvas })),
);
const DetailPanel = React.lazy(() =>
  import('./components/detail/DetailPanel').then((m) => ({ default: m.DetailPanel })),
);
const PreferencesPanel = React.lazy(() =>
  import('./components/preferences/PreferencesPanel').then((m) => ({
    default: m.PreferencesPanel,
  })),
);
const WebPage = React.lazy(() =>
  import('./components/web/WebPage').then((m) => ({ default: m.WebPage })),
);

export const App: React.FC = () => {
  const isDetailPanelOpen = useUiStore((s) => s.isDetailPanelOpen);
  const showToast = useUiStore((s) => s.showToast);
  const fetchFiles = useMediaStore((s) => s.fetchFiles);
  const activeNav = useUiStore((s) => s.activeNav);
  const confirmModal = useUiStore((s) => s.confirmModal);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [showAddBookmarkModal, setShowAddBookmarkModal] = useState(false);

  const pendingMetadataRefreshIds = useRef<Set<string>>(new Set());
  const metadataRefreshTimer = useRef<number | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState<number>(256);

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

    const unlistenStartupBackfillComplete = listen<{ processed: number; remaining: number }>(
      'startup_backfill_complete',
      () => {
        scheduleStartupBackfillRefresh(fetchFiles);
      },
    );
    const unlistenStartupBackfillProgress = listen<{ current: number; total: number }>(
      'startup_backfill_progress',
      () => {
        scheduleStartupBackfillProgressRefresh(fetchFiles);
      },
    );

    const unlistenLibraryRootChanged = listen<{ root: string }>('library_root_changed', (event) => {
      const root = event.payload?.root;
      if (!root) return;
      resetStartupBootstrapCache();
      setLibraryRoot(root);
      void fetchFiles(1).catch((err) => {
        appLogger.error('[App] fetch after library_root_changed failed:', err);
      });
    });

    const unlistenLibraryImported = listen<{ imported?: number }>('library_files_imported', (event) => {
      const n = event.payload?.imported ?? 0;
      if (n <= 0) return;
      void fetchFiles(1).catch((err) => {
        appLogger.error('[App] fetch after library_files_imported failed:', err);
      });
    });

    const unlistenScanComplete = listen<{ total?: number }>('scan_complete', (event) => {
      const total = event.payload?.total ?? 0;
      if (total <= 0) return;
      void fetchFiles(1).catch((err) => {
        appLogger.error('[App] fetch after scan_complete failed:', err);
      });
    });

    return () => {
      unlistenSingle.then((fn) => fn());
      unlistenBatch.then((fn) => fn());
      unlistenStartupBackfillComplete.then((fn) => fn());
      unlistenStartupBackfillProgress.then((fn) => fn());
      unlistenLibraryRootChanged.then((fn) => fn());
      unlistenLibraryImported.then((fn) => fn());
      unlistenScanComplete.then((fn) => fn());
      if (metadataRefreshTimer.current !== null) {
        window.clearTimeout(metadataRefreshTimer.current);
        metadataRefreshTimer.current = null;
      }
    };
  }, [fetchFiles, libraryRoot]);

  useEffect(() => {
    initPreferences();
    getPreference('inspector-width', '256').then((val) => {
      const width = parseInt(val, 10);
      if (width >= 240 && width <= 600) {
        setInspectorWidth(width);
      }
    });
  }, []);

  useEffect(() => {
    return runStartupBootstrap({
      setLibraryRoot,
      setIsChecking,
      fetchFiles,
    });
  }, [fetchFiles]);

  const handleLibrarySetup = useCallback(
    async (selectedPath: string) => {
      appLogger.debug('[App] handleLibrarySetup:', selectedPath);
      const newLibraryRoot = await invoke<string>('init_library', { parentPath: selectedPath });
      appLogger.debug('[App] Library initialized at:', newLibraryRoot);
      resetStartupBootstrapCache();
      setLibraryRoot(newLibraryRoot);
      showToast('灵感库初始化完成');

      void fetchFiles(1).catch((err) => {
        appLogger.error('[App] Initial fetch after library setup failed:', err);
      });
      scheduleMicroBackfill('灵感库', 'library');
      void invoke('scan_directory', { path: newLibraryRoot })
        .then(() => appLogger.debug('[App] Background scan complete'))
        .catch((err) => appLogger.error('[App] Background scan failed:', err));
    },
    [fetchFiles, showToast],
  );

  const handleOpenPreferences = useCallback(() => {
    setIsPreferencesOpen(true);
  }, []);

  const handleLibraryRootChanged = useCallback(
    (root: string) => {
      resetStartupBootstrapCache();
      setLibraryRoot(root);
      void fetchFiles(1).catch((err) => {
        appLogger.error('[App] fetch after library switch failed:', err);
      });
    },
    [fetchFiles],
  );

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
          <p style={{ color: 'var(--text-secondary)', marginTop: '16px' }}>正在加载...</p>
        </div>
      </div>
    );
  }

  if (!libraryRoot) {
    return <LibrarySetup onSetup={handleLibrarySetup} initialRoot={libraryRoot} />;
  }

  return (
    <div
      data-testid="app-shell"
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
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>

      <Sidebar onOpenPreferences={handleOpenPreferences} libraryRoot={libraryRoot} />

      <div style={{ minWidth: 0, display: 'flex', overflow: 'hidden' }}>{renderContent()}</div>

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

      {isPreferencesOpen && (
        <ErrorBoundary>
          <Suspense fallback={null}>
            <PreferencesPanel
              onClose={() => {
                setIsPreferencesOpen(false);
              }}
              onLibraryRootChanged={handleLibraryRootChanged}
            />
          </Suspense>
        </ErrorBoundary>
      )}

      <Toast />

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

      {activeNav === 'web-pages' && showAddBookmarkModal && (
        <AddBookmarkModal
          isOpen={showAddBookmarkModal}
          onClose={() => setShowAddBookmarkModal(false)}
        />
      )}

      <ImportProgressBar />
    </div>
  );
};