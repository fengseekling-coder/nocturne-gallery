/*
 * Nocturne Gallery — Canvas
 *
 * 瀑布流布局：CSS columns 实现，卡片无文字纯图片
 * 灵感库、作品集、AI 提示词库使用瀑布流，回收站保持网格
 */

import React, { useEffect, useRef, useCallback, useState, useMemo, startTransition } from 'react';
import { useMediaStore } from '../../stores/mediaStore';
import { useUiStore } from '../../stores/uiStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { MediaCard } from './MediaCard';
import { TopToolbar } from './TopToolbar';
import { ContextMenu } from '../common/ContextMenu/ContextMenu';
import { Icon } from '../common/Icon';
import { WindowControls } from '../common/WindowControls';
// FullScreenPreview 内嵌在 Canvas 中，不再单独导入
import { DuplicateModal } from '../common/DuplicateModal';
import type { ContextMenuAction } from '../../types/context-menu';
import type { MediaFile } from '../../types/media';
import type { DuplicateInfo, DuplicateAction } from '../common/DuplicateModal';
import { loadFullResolution } from '../../lib/loadFullResolution';
import { notifyCanvasScrollActivity } from '../../lib/scrollActivityBus';


// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface CanvasProps {}

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}

interface MasonryPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PositionedCard {
  file: MediaFile;
  index: number;
  pos: MasonryPosition;
  top: number;
  bottom: number;
}

interface MasonryLayoutCache {
  files: MediaFile[];
  positions: MasonryPosition[];
  columnHeights: number[];
  columnCount: number;
  columnWidth: number;
  totalHeight: number;
}

interface BatchFileOperationResult {
  succeeded: number;
  failed: number;
}

interface NativeDropPosition {
  x: number;
  y: number;
}

interface NativeDropTarget {
  targetNav: string | null;
  targetFolder: string;
  targetCategory: string | null;
}

// ----------------------------------------------------------------
// Static styles (module-level — no runtime dependencies)
// ----------------------------------------------------------------

const CONTENT_PADDING_TOP = 18;
const CONTENT_PADDING_X = 20;
const CONTENT_PADDING_BOTTOM = 32;
// 方向感知预加载边距：向下滚动是主流浏览方向，下方 2500px 给预加载充足提前量；
// 上方 500px 处理短距离回滚，超出则由卡片常驻 DOM + thumbhash 兜底。
const IO_MARGIN_TOP = 500;
const IO_MARGIN_BOTTOM = 2500;
const REFRESH_COALESCE_MS = 120;
const SINGLE_FILE_DUPLICATE_CHECK_MAX_BYTES = 64 * 1024 * 1024;
const isDev = import.meta.env.DEV;

const canvasDebugLog = (...args: unknown[]) => {
  if (isDev) {
    console.log(...args);
  }
};

const canvasDebugWarn = (...args: unknown[]) => {
  if (isDev) {
    console.warn(...args);
  }
};

const canvasDebugError = (...args: unknown[]) => {
  if (isDev) {
    console.error(...args);
  }
};

const canvasPerfState = {
  lastCanvasSummaryAt: 0,
};

const MAX_RENDERED_CARDS = 64;
const MIN_OVERSCAN = 360;
const MAX_OVERSCAN = 720;
const DEFAULT_OVERSCAN = 480;
const SCROLL_IDLE_MS = 180;
const EAGER_CARD_COUNT = 96;
/** 合并两个已按 (top, index) 排序的 PositionedCard 数组 */
function mergeSortedCards(a: PositionedCard[], b: PositionedCard[]): PositionedCard[] {
  const result: PositionedCard[] = new Array(a.length + b.length);
  let ai = 0, bi = 0, ri = 0;
  while (ai < a.length && bi < b.length) {
    const ac = a[ai], bc = b[bi];
    if (ac.top < bc.top || (ac.top === bc.top && ac.index < bc.index)) {
      result[ri++] = ac;
      ai++;
    } else {
      result[ri++] = bc;
      bi++;
    }
  }
  while (ai < a.length) result[ri++] = a[ai++];
  while (bi < b.length) result[ri++] = b[bi++];
  return result;
}

/** 快速校验 files 前缀是否与缓存一致（仅比对首尾引用，O(1) 代替 O(n) every） */
function filesPrefixMatches(files: MediaFile[], cachedLength: number, cachedCards: PositionedCard[]): boolean {
  if (cachedLength === 0 || files.length < cachedLength) return false;
  return files[0] === cachedCards[0]?.file
      && files[cachedLength - 1] === cachedCards[cachedCards.length - 1]?.file;
}

const canvasRootStyle: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column',
  height: '100%', overflow: 'hidden',
  backgroundColor: 'var(--bg-primary)', position: 'relative',
};
const dragOverlayStyle: React.CSSProperties = {
  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
  backgroundColor: 'var(--accent-dim)', opacity: 0.67,
  borderRadius: 'var(--radius-card)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 999, pointerEvents: 'none',
};
const dragOverlayContentStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px',
};
const dragOverlayIconStyle: React.CSSProperties = { fontSize: '64px', color: 'var(--accent)' };
const dragOverlayTextStyle: React.CSSProperties = {
    fontFamily: 'var(--font-family)', fontSize: '16px',
  fontWeight: 600, color: 'var(--accent)', margin: 0,
};
const previewWrapperStyle: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', height: '100%', position: 'relative',
};
const previewTopBarStyle: React.CSSProperties = {
  height: '48px', display: 'flex', alignItems: 'center',
  padding: '0 24px', justifyContent: 'space-between',
  zIndex: 10, background: 'var(--bg-primary)',
};
const previewBackBtnStyle: AppRegionStyle = {
  display: 'flex', alignItems: 'center', gap: '8px',
  background: 'transparent', border: 'none',
  color: 'var(--text-secondary)', fontSize: '14px',
  cursor: 'pointer', padding: '4px 8px', marginLeft: '-8px',
  WebkitAppRegion: 'no-drag',
};
const previewBackIconStyle: React.CSSProperties = { fontSize: '18px' };
const previewFilenameStyle: React.CSSProperties = {
  fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500,
  maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const previewWindowCtrlsStyle: AppRegionStyle = {
  width: '80px', display: 'flex', justifyContent: 'flex-end', WebkitAppRegion: 'no-drag',
};
const previewNavIconStyle: React.CSSProperties = { fontSize: '20px' };
const previewNavBtnBaseStyle: React.CSSProperties = {
  width: '32px', height: '32px', display: 'flex', alignItems: 'center',
  justifyContent: 'center', background: 'var(--bg-surface)',
  border: 'none', borderRadius: '50%', color: 'var(--text-primary)',
};
const previewBottomBarStyle: React.CSSProperties = {
  height: '56px', display: 'flex', alignItems: 'center',
  justifyContent: 'center', gap: '24px', zIndex: 10,
};
const previewPageCountStyle: React.CSSProperties = {
  fontSize: '12px', color: 'var(--text-secondary)', minWidth: '60px', textAlign: 'center',
};
const scaleIndicatorStyle: React.CSSProperties = {
  position: 'absolute', right: 16, bottom: 16, fontSize: '11px',
  color: 'var(--text-muted)', background: 'var(--bg-surface)',
  padding: '2px 8px', borderRadius: 'var(--radius-control)', pointerEvents: 'none', zIndex: 20,
};
const gridWrapperStyle: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
};
const contentScrollStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: `${CONTENT_PADDING_TOP}px ${CONTENT_PADDING_X}px ${CONTENT_PADDING_BOTTOM}px ${CONTENT_PADDING_X}px`,
  position: 'relative', scrollbarWidth: 'none', msOverflowStyle: 'none',
};
const emptyStateStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', height: '100%', minHeight: '300px', gap: '20px',
};
const emptyIconStyle: React.CSSProperties = { fontSize: '56px', color: 'var(--text-muted)' };
const emptyTextStyle: React.CSSProperties = {
    fontFamily: 'var(--font-family)', fontSize: '15px', color: 'var(--text-muted)', margin: 0,
};
const loadingDotsWrapperStyle: React.CSSProperties = {
  padding: '16px 0', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px',
};
const sentinelStyle: React.CSSProperties = { height: '1px' };
const footerTextStyle: React.CSSProperties = {
    padding: '16px 0', textAlign: 'center', fontFamily: 'var(--font-family)',
  fontSize: '13px', color: 'var(--text-muted)', userSelect: 'none',
};

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

interface FileInfoPayload {
  size: number;
  isDir: boolean;
}

interface ImportSkippedPayload {
  filename: string;
  targetFolder?: string;
  reason: 'existing-file';
}

interface ImportIndexCommittedPayload {
  current: number;
  total: number;
}

interface ImportPathsPayload {
  importedCount: number;
  skippedCount: number;
  failedCount: number;
}

interface DuplicatePlacementPayload {
  sourceFolder: string | null;
  categoryName: string | null;
}

interface PendingDuplicateImport {
  filePath: string;
  targetFolder: string;
  duplicateInfo: DuplicateInfo;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const Canvas: React.FC<CanvasProps> = () => {
  const files = useMediaStore((s) => s.files);
  const isLoading = useMediaStore((s) => s.isLoading);
  const currentPage = useMediaStore((s) => s.currentPage);
  const totalCount = useMediaStore((s) => s.totalCount);
  const fetchFiles = useMediaStore((s) => s.fetchFiles);
  const selectFile = useMediaStore((s) => s.selectFile);
  const selectFiles = useMediaStore((s) => s.selectFiles);
  const setSelectedIds = useMediaStore((s) => s.setSelectedIds);
  const deselectAll = useMediaStore((s) => s.deselectAll);
  const applyFilters = useMediaStore((s) => s.applyFilters);
  const activeNav = useUiStore((s) => s.activeNav);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const canvasAttachmentPreview = useUiStore((s) => s.canvasAttachmentPreview);
  const closeCanvasAttachmentPreview = useUiStore((s) => s.closeCanvasAttachmentPreview);
  const setCanvasAttachmentPreviewActive = useUiStore((s) => s.setCanvasAttachmentPreviewActive);
  const sourceFolder = useUiStore((s) => s.sourceFolder);
  const showToast = useUiStore((s) => s.showToast);
  const columnCount = useUiStore((s) => s.columnCount);
  const showConfirm = useUiStore((s) => s.showConfirm);
  const targetFileId = useContextMenuStore((s) => s.targetFileId);
  const hideMenu = useContextMenuStore((s) => s.hideMenu);
  // 普通选中不让 Canvas 重渲染；卡片自己只订阅单张卡的选中布尔值。
  // selectedIds 不再在 Canvas 层订阅：
  // - isSelected/isActive 移入各 MediaCard 窄选择器
  // - 批量操作（右键菜单）通过 useMediaStore.getState() 读取快照
  // - 唯一剩余需求（hasSelection）已内置在 MediaCard 的 handleClick 里

  const [isDragOver, setIsDragOver] = useState(false);

  // 重复检测状态
  const [duplicateInfo, setDuplicateInfo] = useState<DuplicateInfo | null>(null);
  const pendingDuplicateRef = useRef<PendingDuplicateImport | null>(null);
  const duplicateResolveRef = useRef<((action: DuplicateAction) => void) | null>(null);

  // 原地预览状态
  const [viewMode, setViewMode] = useState<'grid' | 'preview'>('grid');
  const [previewIndex, setPreviewIndex] = useState(0);
  const [scrollY, setScrollY] = useState(0);

  // 大图缩放/平移状态
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isPreviewDragging, setIsPreviewDragging] = useState(false);
  const previewDragStart = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 });
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const [previewDisplaySrc, setPreviewDisplaySrc] = useState<string>('');
  const [isLoadingPreviewOriginal, setIsLoadingPreviewOriginal] = useState(false);
  const previewOriginalAbortRef = useRef<AbortController | null>(null);
  const currentPreviewFile = viewMode === 'preview' ? files[previewIndex] ?? null : null;
  const isAttachmentPreviewMode = canvasAttachmentPreview !== null;
  const isAnyPreviewMode = viewMode === 'preview' || isAttachmentPreviewMode;
  const activeCanvasAttachmentItem = useMemo(
    () => canvasAttachmentPreview?.items.find((item) => item.id === canvasAttachmentPreview.activeId)
      ?? canvasAttachmentPreview?.items[0]
      ?? null,
    [canvasAttachmentPreview],
  );
  const previewResolvedSrc = useMemo(
    () => (previewDisplaySrc ? convertFileSrc(previewDisplaySrc) : ''),
    [previewDisplaySrc],
  );

  // 搜索状态
  const [searchQuery, setSearchQuery] = useState('');
  const setFilter = useMediaStore((s) => s.setFilter);
  const filter = useMediaStore((s) => s.filter);

  const isProcessingPaste = useRef(false);
  const lastNativeDropAtRef = useRef(0);

  // 框选矩形状态 - 实时存储以支持 mousemove 渲染
  // 使用相对于容器内容的绝对坐标（包含滚动偏移）
  const [selectionRect, setSelectionRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const dragStartPos = useRef<{ x: number; y: number } | null>(null);
  const isDraggingCard = useRef(false);
  const mainRef = useRef<HTMLDivElement>(null);
  const selectionRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  // 框选刚结束标志：防止 mouseup 后触发的 click 事件清空选中
  const rubberBandJustEndedRef = useRef(false);

  // Masonry 布局：测量容器内容宽度
  const contentRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const layoutCacheRef = useRef<MasonryLayoutCache | null>(null);
  const positionedCardsCacheRef = useRef<{ filesLength: number; cards: PositionedCard[] }>({ filesLength: 0, cards: [] });

  // 可见性跟踪（仅用于懒加载触发，卡片常驻 DOM 不卸载）
  const leaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const preloadedCardIdsRef = useRef<Set<string>>(new Set());

  // 共享 IntersectionObserver：所有 MediaCard 复用同一个实例
  const sharedObserverRef = useRef<IntersectionObserver | null>(null);
  const lazyCallbacksRef = useRef<Map<Element, () => void>>(new Map());
  const cardElementsRef = useRef<Map<string, HTMLElement>>(new Map());

  useEffect(() => {
    const root = contentRef.current;
    sharedObserverRef.current = new IntersectionObserver(
      (entries) => {
        const pendingCallbacks: (() => void)[] = [];

        for (const entry of entries) {
          const cardId = entry.target.getAttribute('data-card-id');
          if (!cardId) continue;

          if (entry.isIntersecting) {
            const timer = leaveTimersRef.current.get(cardId);
            if (timer) {
              clearTimeout(timer);
              leaveTimersRef.current.delete(cardId);
            }

            if (!preloadedCardIdsRef.current.has(cardId)) {
              preloadedCardIdsRef.current.add(cardId);
            }

            const cb = lazyCallbacksRef.current.get(entry.target);
            if (cb) {
              pendingCallbacks.push(cb);
              lazyCallbacksRef.current.delete(entry.target);
            }
          } else {
            if (!leaveTimersRef.current.has(cardId)) {
              const timer = setTimeout(() => {
                // dev: keep observer light; card deactivation is handled by visibility/lazy cache
                leaveTimersRef.current.delete(cardId);
              }, 150);
              leaveTimersRef.current.set(cardId, timer);
            }
          }
        }

        for (const cb of pendingCallbacks) cb();
      },
      {
        root,
        rootMargin: `${IO_MARGIN_TOP}px 0px ${IO_MARGIN_BOTTOM}px 0px`,
      }
    );
    const lazyCallbacks = lazyCallbacksRef.current;
    const leaveTimers = leaveTimersRef.current;
    return () => {
      sharedObserverRef.current?.disconnect();
      sharedObserverRef.current = null;
      lazyCallbacks.clear();
      leaveTimers.forEach(clearTimeout);
      leaveTimers.clear();
    };
  }, []);

  const observeElement = useCallback((el: Element, onVisible: () => void) => {
    lazyCallbacksRef.current.set(el, onVisible);
    const cardId = el.getAttribute('data-card-id');
    if (cardId) {
      cardElementsRef.current.set(cardId, el as HTMLElement);
    }
    sharedObserverRef.current?.observe(el);
  }, []);

  const unobserveElement = useCallback((el: Element) => {
    lazyCallbacksRef.current.delete(el);
    const cardId = el.getAttribute('data-card-id');
    if (cardId) {
      cardElementsRef.current.delete(cardId);
    }
    sharedObserverRef.current?.unobserve(el);
  }, []);

  // 获取目标文件信息
  const filesById = useMemo(() => {
    const map = new Map<string, MediaFile>();
    for (const file of files) {
      map.set(file.id, file);
    }
    return map;
  }, [files]);

  const targetFile = targetFileId ? filesById.get(targetFileId) ?? null : null;

  // 获取导航名称
  const getNavDisplayName = useCallback(() => {
    switch (activeNav) {
      case 'library': return '灵感库';
      case 'ai-prompts': return 'AI 提示词库';
      case 'projects': return '作品集管理';
      case 'web-pages': return '网页管理';
      case 'trash': return '回收站';
      default: return '灵感库';
    }
  }, [activeNav]);

  const previewSelectionPendingRef = useRef<string | null>(null);

  const previewUnloadRef = useRef<(() => void) | null>(null);

  const releasePreviewResources = useCallback((clearDisplaySrc: boolean) => {
    if (previewUnloadRef.current) {
      previewUnloadRef.current();
      previewUnloadRef.current = null;
    }
    if (previewOriginalAbortRef.current) {
      previewOriginalAbortRef.current.abort();
      previewOriginalAbortRef.current = null;
    }

    setIsLoadingPreviewOriginal(false);
    if (clearDisplaySrc) {
      setPreviewDisplaySrc('');
    }
  }, []);

  // 处理预览导航
  const previewPerfStartRef = useRef<number | null>(null);

  const handleNext = useCallback(() => {
    if (previewIndex < files.length - 1) {
      previewPerfStartRef.current = performance.now();
      const nextIdx = previewIndex + 1;
      const nextFile = files[nextIdx];
      previewSelectionPendingRef.current = nextFile.id;
      startTransition(() => {
        setPreviewIndex(nextIdx);
        setScale(1);
        setOffset({ x: 0, y: 0 });
      });
      window.requestAnimationFrame(() => {
        void useMediaStore.getState().focusFile(nextFile.id);
      });
      releasePreviewResources(true);
    }
  }, [previewIndex, files, releasePreviewResources]);

  const handlePrev = useCallback(() => {
    if (previewIndex > 0) {
      previewPerfStartRef.current = performance.now();
      const prevIdx = previewIndex - 1;
      const prevFile = files[prevIdx];
      previewSelectionPendingRef.current = prevFile.id;
      startTransition(() => {
        setPreviewIndex(prevIdx);
        setScale(1);
        setOffset({ x: 0, y: 0 });
      });
      window.requestAnimationFrame(() => {
        void useMediaStore.getState().focusFile(prevFile.id);
      });
      releasePreviewResources(true);
    }
  }, [previewIndex, files, releasePreviewResources]);

  // 滚轮缩放逻辑
  const handleWheel = useCallback((e: WheelEvent) => {
    if (!isAnyPreviewMode) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setScale((prev) => Math.min(Math.max(prev + delta, 0.2), 5));
  }, [isAnyPreviewMode]);

  useEffect(() => {
    const el = previewContainerRef.current;
    if (el) {
      el.addEventListener('wheel', handleWheel, { passive: false });
    }
    return () => {
      if (el) el.removeEventListener('wheel', handleWheel);
    };
  }, [handleWheel]);

  useEffect(() => {
    if (!currentPreviewFile) {
      releasePreviewResources(true);
      previewSelectionPendingRef.current = null;
      previewPerfStartRef.current = null;
      return;
    }

    releasePreviewResources(false);

    const abort = new AbortController();
    previewOriginalAbortRef.current = abort;

    previewUnloadRef.current = loadFullResolution({
      imagePath: currentPreviewFile.filepath,
      thumbnailPreviewPath: currentPreviewFile.thumbnailPreviewPath,
      originalDelayMs: 120,
      signal: abort.signal,
      onDisplayPathChange: setPreviewDisplaySrc,
      onLoadingOriginalChange: setIsLoadingPreviewOriginal,
    });

    return () => {
      abort.abort();
      if (previewUnloadRef.current) {
        previewUnloadRef.current();
        previewUnloadRef.current = null;
      }
      previewOriginalAbortRef.current = null;
    };
  }, [currentPreviewFile, releasePreviewResources]);

  useEffect(() => {
    if (!canvasAttachmentPreview) {
      return;
    }

    setScale(1);
    setOffset({ x: 0, y: 0 });
    setIsPreviewDragging(false);
  }, [canvasAttachmentPreview]);

  useEffect(() => {
    if (viewMode !== 'preview' || !currentPreviewFile) {
      return;
    }
    const pendingId = previewSelectionPendingRef.current;
    if (pendingId === currentPreviewFile.id) {
      previewSelectionPendingRef.current = null;
      if (previewPerfStartRef.current !== null) {
        const elapsed = performance.now() - previewPerfStartRef.current;
        canvasDebugLog(`[Canvas] preview switch settled in ${elapsed.toFixed(1)}ms`);
        previewPerfStartRef.current = null;
      }
      return;
    }
    // 只在外部切换导致状态不同步时补同步，避免翻页时重复触发 selectFile
    if (useMediaStore.getState().selectedId !== currentPreviewFile.id) {
      void useMediaStore.getState().focusFile(currentPreviewFile.id);
    }
  }, [currentPreviewFile, selectFile, viewMode]);

  const handleBackToGrid = useCallback(() => {
    releasePreviewResources(true);
    setViewMode('grid');
    // 修复：[P1] 滚动发生在 contentRef（overflow:auto），不是 mainRef（overflow:hidden）
    requestAnimationFrame(() => {
      if (contentRef.current) {
        contentRef.current.scrollTop = scrollY;
      }
    });
  }, [releasePreviewResources, scrollY]);

  const handleBackFromAttachmentPreview = useCallback(() => {
    closeCanvasAttachmentPreview();
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setIsPreviewDragging(false);
  }, [closeCanvasAttachmentPreview]);

  const refreshTimeoutRef = useRef<number | null>(null);
  const refreshGenerationRef = useRef(0);
  const lastAppliedFilterKeyRef = useRef<string>('');
  const inflightFilterKeyRef = useRef<string>('');
  const lastFilterRequestTokenRef = useRef(0);

  const scheduleListRefresh = useCallback((reason: string, delay = REFRESH_COALESCE_MS) => {
    refreshGenerationRef.current += 1;
    const generation = refreshGenerationRef.current;

    if (refreshTimeoutRef.current !== null) {
      window.clearTimeout(refreshTimeoutRef.current);
    }

    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null;
      if (generation !== refreshGenerationRef.current) {
        return;
      }
      canvasDebugLog('[Canvas] Running coalesced refresh:', reason);
      fetchFiles(1);
    }, delay);
  }, [fetchFiles]);

  const getStableFilterKey = useCallback((nav: string, folder: string | null, tab: string, currentFilterValue: typeof filter, query: string) => {
    const tagIds = currentFilterValue.tagIds ? [...currentFilterValue.tagIds].sort() : [];
    const builtinTabsByNav: Record<string, Set<string>> = {
      'library': new Set(['全部', '图片', '视频']),
      'ai-prompts': new Set(['全部', '已填写', '未填写']),
      'projects': new Set(['全部']),
      'web-pages': new Set(['全部']),
      'trash': new Set(['全部']),
    };
    const builtinTabs = builtinTabsByNav[nav] ?? new Set(['全部']);
    const isCustomTab = tab.length > 0 && !builtinTabs.has(tab);
    const fileTypes = tab === '图片' ? ['image'] : tab === '视频' ? ['video'] : [];
    const aiMetadataStatus = tab === '已填写' ? 'filled' : tab === '未填写' ? 'empty' : '';
    return JSON.stringify({
      nav,
      folder: folder ?? '',
      tab,
      categoryName: isCustomTab ? tab : '',
      searchQuery: query,
      tagIds,
      fileTypes,
      onlyTrashed: nav === 'trash',
      hasAiMetadata: !!currentFilterValue.hasAiMetadata,
      aiMetadataStatus,
      categoryId: currentFilterValue.categoryId ?? '',
    });
  }, []);

  const applyFiltersIfNeeded = useCallback(async (reason: string) => {
    const currentFilterValue = useMediaStore.getState().filter;
    const nextKey = getStableFilterKey(activeNav, sourceFolder, activeTab, currentFilterValue, searchQuery);
    const requestToken = ++lastFilterRequestTokenRef.current;

    if (nextKey === lastAppliedFilterKeyRef.current || nextKey === inflightFilterKeyRef.current) {
      canvasDebugLog('[Canvas] Skipping duplicate filter apply:', reason, nextKey);
      return;
    }

    inflightFilterKeyRef.current = nextKey;
    try {
      await applyFilters(activeNav, sourceFolder, activeTab);
      if (requestToken !== lastFilterRequestTokenRef.current) {
        return;
      }
      lastAppliedFilterKeyRef.current = nextKey;
    } finally {
      if (inflightFilterKeyRef.current === nextKey) {
        inflightFilterKeyRef.current = '';
      }
    }
  }, [activeNav, activeTab, applyFilters, getStableFilterKey, searchQuery, sourceFolder]);

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  const getCurrentCustomGroupName = useCallback(() => {
    const builtinTabsByNav: Record<string, Set<string>> = {
      'library': new Set(['全部', '图片', '视频']),
      'ai-prompts': new Set(['全部', '已填写', '未填写']),
      'projects': new Set(['全部']),
      'web-pages': new Set(['全部']),
      'trash': new Set(['全部']),
    };

    if (!activeTab) return null;
    const builtinTabs = builtinTabsByNav[activeNav] ?? new Set(['全部']);
    return builtinTabs.has(activeTab) ? null : activeTab;
  }, [activeNav, activeTab]);

  // 添加粘贴事件处理器
  const handlePaste = useCallback(async (event: ClipboardEvent) => {
    // 防重复：处理中直接返回
    if (isProcessingPaste.current) {
      canvasDebugLog('[Canvas] Paste already processing, ignoring');
      return;
    }
    isProcessingPaste.current = true;

    canvasDebugLog('[Canvas] Paste event detected');

    // 只在灵感库、AI提示词库或作品集页面才处理粘贴
    if (!['library', 'ai-prompts', 'projects'].includes(activeNav)) {
      canvasDebugLog('[Canvas] Paste ignored - not in supported nav:', activeNav);
      isProcessingPaste.current = false; // Reset the flag before returning
      return;
    }

    const items = event.clipboardData?.items;
    if (!items) {
      canvasDebugLog('[Canvas] No clipboard items found');
      isProcessingPaste.current = false; // Reset the flag before returning
      return;
    }

    // Collect all image items to process
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        imageItems.push(items[i]);
      }
    }

    if (imageItems.length === 0) {
      canvasDebugLog('[Canvas] No image items found in clipboard');
      isProcessingPaste.current = false; // Reset the flag before returning
      return;
    }

    event.preventDefault(); // 阻止默认行为 once for all images

    try {
      // Process all images in parallel to prevent UI blocking
      const promises = imageItems.map(async (item, index) => {
        try {
          canvasDebugLog(`[Canvas] Processing image ${index + 1}/${imageItems.length} from clipboard:`, item.type);

          const blob = item.getAsFile();
          if (!blob) {
            canvasDebugError('[Canvas] Could not get blob from clipboard item');
            return Promise.reject(new Error('Could not get blob from clipboard item'));
          }

          // Directly convert blob to ArrayBuffer and then to Uint8Array (no base64!)
          const arrayBuffer = await blob.arrayBuffer();
          const imageBytes = Array.from(new Uint8Array(arrayBuffer));

          // Determine file name: prefer original file name, fallback to timestamp
          const extension = blob.type.split('/')[1] || 'png';
          let fileName: string;

          // Try to use the original file name from the blob
          if (blob.name && blob.name !== 'image.png' && blob.name !== 'image.jpeg' && blob.name !== 'image.jpg') {
            // Use original file name (from file system copy)
            fileName = blob.name;
          } else {
            // Fallback to timestamp for screenshots or unnamed sources
            fileName = `gega_paste_${Date.now()}_${index}.${extension}`;
          }

          canvasDebugLog('[Canvas] Saving clipboard image with name:', fileName);
          canvasDebugLog('[Canvas] Saving clipboard image directly to library...');

          // Use the new command that accepts raw bytes and handles scanning internally
          const filePath = await invoke<string>('save_clipboard_image', {
            fileName: fileName,
            imageBytes: imageBytes,
            targetFolder: activeNav === 'projects' ? '作品集' : '灵感库',
            targetCategory: getCurrentCustomGroupName(),
          });

          canvasDebugLog('[Canvas] Image saved directly to library:', filePath);
          return Promise.resolve(filePath);
        } catch (err) {
          canvasDebugError('[Canvas] Error processing pasted image:', err);
          return Promise.reject(err);
        }
      });

      // Wait for all images to be processed in parallel
      const results = await Promise.allSettled(promises);

      // Count successful imports
      const successfulImports = results.filter(result => result.status === 'fulfilled').length;

      if (successfulImports > 0) {
        showToast(`已从剪贴板导入 ${successfulImports} 张图片`);
        scheduleListRefresh('clipboard-import');
      } else {
        showToast('所有图片粘贴失败');
      }
    } catch (err) {
      canvasDebugError('[Canvas] Error processing paste:', err);
      showToast('粘贴图片失败：' + (err as Error).message);
    } finally {
      // Reset the processing flag after all images are handled
      isProcessingPaste.current = false;
    }
  }, [activeNav, getCurrentCustomGroupName, scheduleListRefresh, showToast]);

  // 添加粘贴事件监听器
  useEffect(() => {
    canvasDebugLog('[Canvas] Adding paste event listener');
    window.addEventListener('paste', handlePaste);
    return () => {
      canvasDebugLog('[Canvas] Removing paste event listener');
      window.removeEventListener('paste', handlePaste);
    };
  }, [handlePaste]);

  // 导航/Tab/sourceFolder 任意变化时统一发起一次 fetch
  // （sliderValue 同步已在上方 useState 初始化行的 useEffect 中处理，此处无需重复）
  // 之前分两个 useEffect 分别调用 filterByNav + setFilterByTab，会在
  // 切换导航（同时重置 activeTab='全部'）时触发双重 fetch导致 MediaCard
  // 卸载重挂 2 次，视觉上表现为多次闪烁
  useEffect(() => {
    canvasDebugLog('[Canvas] filter changed:', { activeNav, sourceFolder, activeTab });
    setViewMode('grid');

    // 切换导航 / 来源文件夹 / Tab 时，立即回到列表顶部，避免旧 scrollTop 残留
    const contentEl = contentRef.current;
    if (contentEl) {
      contentEl.scrollTop = 0;
    }
    setScrollTop(0);
    lastScrollStateValueRef.current = 0;
    lastScrollStateTimeRef.current = performance.now();

    void applyFiltersIfNeeded('filter-change');
  }, [activeNav, sourceFolder, activeTab, applyFiltersIfNeeded]);

  // 监听回收站更新事件（当在其他视图移入回收站时，如果当前在回收站视图则刷新）
  useEffect(() => {
    const handleTrashUpdated = () => {
      if (activeNav === 'trash') {
        canvasDebugLog('[Canvas] Trash updated, refreshing...');
        scheduleListRefresh('trash-updated-event');
      }
    };

    window.addEventListener('trash-updated', handleTrashUpdated);
    return () => window.removeEventListener('trash-updated', handleTrashUpdated);
  }, [activeNav, scheduleListRefresh]);

  // 检查重复并返回结果
  const checkFileDuplicate = useCallback(async (filePath: string): Promise<{
    hasDuplicate: boolean;
    duplicateType?: 'exact' | 'similar';
    existingFile?: MediaFile;
    similarity?: number;
    existingPlacement?: DuplicatePlacementPayload;
    pendingPreview?: string | null;
  }> => {
    try {
      const result = await invoke<{
        duplicateType: string | null;
        existingItem: MediaFile | null;
        similarity: number;
        existingPlacement: DuplicatePlacementPayload | null;
        pendingPreview: string | null;
      }>('check_duplicate', { filePath });

      if (result.duplicateType && result.existingItem) {
        return {
          hasDuplicate: true,
          duplicateType: result.duplicateType as 'exact' | 'similar',
          existingFile: result.existingItem,
          similarity: result.similarity,
          existingPlacement: result.existingPlacement ?? {
            sourceFolder: result.existingItem.sourceFolder ?? null,
            categoryName: null,
          },
          pendingPreview: result.pendingPreview,
        };
      }
    } catch (err) {
      console.error('[Canvas] Duplicate check failed:', err);
    }
    return { hasDuplicate: false };
  }, []);

  const createPendingDuplicateImport = useCallback((
    filePath: string,
    targetFolder: string,
    targetCategory: string | null,
    fileSize: number,
    duplicateCheck: {
      hasDuplicate: boolean;
      duplicateType?: 'exact' | 'similar';
      existingFile?: MediaFile;
      similarity?: number;
      existingPlacement?: DuplicatePlacementPayload;
      pendingPreview?: string | null;
    },
  ): PendingDuplicateImport | null => {
    if (!duplicateCheck.hasDuplicate || !duplicateCheck.existingFile || !duplicateCheck.duplicateType) {
      return null;
    }

    const existingPlacement = {
      sourceFolder: duplicateCheck.existingPlacement?.sourceFolder ?? duplicateCheck.existingFile.sourceFolder ?? null,
      groupName: duplicateCheck.existingPlacement?.categoryName ?? null,
    };
    const targetPlacement = {
      sourceFolder: targetFolder,
      groupName: targetCategory,
    };

    return {
      filePath,
      targetFolder,
      duplicateInfo: {
        type: duplicateCheck.duplicateType,
        newFile: {
          path: filePath,
          name: filePath.split(/[\\/]/).pop() || filePath,
          size: fileSize,
          previewSrc: duplicateCheck.pendingPreview ?? null,
        },
        existingFile: duplicateCheck.existingFile,
        similarity: duplicateCheck.similarity ?? 0,
        existingPlacement,
        targetPlacement,
        canUseExisting: existingPlacement.sourceFolder === targetFolder,
      },
    };
  }, []);

  const promptDuplicateAction = useCallback((pendingDuplicate: PendingDuplicateImport) => (
    new Promise<DuplicateAction>((resolve) => {
      pendingDuplicateRef.current = pendingDuplicate;
      setDuplicateInfo(pendingDuplicate.duplicateInfo);
      duplicateResolveRef.current = (action: DuplicateAction) => {
        pendingDuplicateRef.current = null;
        duplicateResolveRef.current = null;
        setDuplicateInfo(null);
        resolve(action);
      };
    })
  ), []);

  const processPendingDuplicateImport = useCallback(async (pendingDuplicate: PendingDuplicateImport) => {
    const action = await promptDuplicateAction(pendingDuplicate);
    const currentGroupName = pendingDuplicate.duplicateInfo.targetPlacement.groupName;
    const existingGroupName = pendingDuplicate.duplicateInfo.existingPlacement.groupName;
    const existingFile = pendingDuplicate.duplicateInfo.existingFile;

    if (action === 'skip') {
      return;
    }

    if (action === 'import') {
      await invoke('import_file_to_library', {
        sourcePath: pendingDuplicate.filePath,
        targetFolder: pendingDuplicate.targetFolder,
        targetCategory: currentGroupName,
      });
      return;
    }

    if (currentGroupName && existingGroupName !== currentGroupName) {
      await invoke('ai_set_category', {
        itemId: existingFile.id,
        categoryName: currentGroupName,
      });
    }

    setSelectedIds([existingFile.id]);
    await useMediaStore.getState().focusFile(existingFile.id);
  }, [promptDuplicateAction, setSelectedIds]);

  useEffect(() => {
    const unlistenImportSkipped = listen<ImportSkippedPayload>('import_skipped', (event) => {
      const skippedName = event.payload.filename?.trim() || '该素材';
      showToast(`素材已存在，已跳过：${skippedName}`);
    });

    const unlistenImportIndexCommitted = listen<ImportIndexCommittedPayload>('import_index_committed', (event) => {
      if (event.payload.current > 0) {
        scheduleListRefresh('import-index-committed', 250);
      }
    });

    return () => {
      unlistenImportSkipped.then((unlistenEvent) => unlistenEvent());
      unlistenImportIndexCommitted.then((unlistenEvent) => unlistenEvent());
    };
  }, [scheduleListRefresh, showToast]);

  // 监听 Tauri drag-drop 事件（外部文件拖入）
  useEffect(() => {
    /* legacy drag-drop listener disabled
      canvasDebugLog('[Canvas] Drag-drop event received:', { pathCount: event.payload.paths.length });
      const paths = event.payload.paths;

      // 根据当前导航确定目标文件夹
      const folderMap: Record<string, string> = {
        'library': '灵感库',
        'projects': '作品集',
        'trash': '回收站',
      };
      const targetFolder = folderMap[activeNav] || '灵感库';

      for (const filePath of paths) {
        try {
          await importDraggedFile(filePath, targetFolder);
        } catch (e) {
          canvasDebugError('[Canvas] Import failed:', filePath, e);
        }
      }
      scheduleListRefresh('drag-drop-import');
    */

    return () => {};
  }, [activeNav, scheduleListRefresh]);

  // 处理重复弹窗操作
  const getImportTargetFolder = useCallback(() => {
    switch (activeNav) {
      case 'projects':
        return '作品集';
      case 'library':
      case 'trash':
      default:
        return '灵感库';
    }
  }, [activeNav]);

  const getImportTargetCategory = useCallback(() => getCurrentCustomGroupName(), [getCurrentCustomGroupName]);

  const resolveNativeDropTarget = useCallback((position: NativeDropPosition): NativeDropTarget | null => {
    const scale = window.devicePixelRatio || 1;
    const points = [
      { x: position.x / scale, y: position.y / scale },
      { x: position.x, y: position.y },
    ];

    for (const point of points) {
      const element = document.elementFromPoint(point.x, point.y);
      const target = element?.closest<HTMLElement>('[data-drop-target-folder]');
      const targetFolder = target?.dataset.dropTargetFolder;
      if (!target || !targetFolder) {
        continue;
      }

      return {
        targetNav: target.dataset.dropTargetNav || null,
        targetFolder,
        targetCategory: target.dataset.dropTargetCategory || null,
      };
    }

    return null;
  }, []);

  const importDroppedPaths = useCallback(async (paths: string[], dropTarget: NativeDropTarget | null = null) => {
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
    if (uniquePaths.length === 0) return;

    const targetFolder = dropTarget?.targetFolder ?? getImportTargetFolder();
    const targetCategory = dropTarget?.targetCategory ?? getImportTargetCategory();

    if (uniquePaths.length > 1) {
      try {
        const result = await invoke<ImportPathsPayload>('import_paths_to_library', {
          sourcePaths: uniquePaths,
          targetFolder,
          targetCategory,
        });

        if (result.failedCount > 0) {
          showToast(`导入失败 ${result.failedCount} 项`);
        }
      } catch (error) {
        canvasDebugError('[Canvas] Batch import failed:', uniquePaths, error);
        showToast('批量导入失败');
      }
      scheduleListRefresh('drag-drop-import');
      return;
    }

    const singlePath = uniquePaths[0];
    let fileInfo: FileInfoPayload;
    try {
      fileInfo = await invoke<FileInfoPayload>('get_file_info', { path: singlePath });
    } catch (error) {
      canvasDebugError('[Canvas] Failed to inspect dropped path:', error);
      showToast('读取拖入素材失败');
      return;
    }

    const fileEntries = fileInfo.isDir ? [] : [{ path: singlePath, size: fileInfo.size }];
    const directoryPaths = fileInfo.isDir ? [singlePath] : [];

    const pendingDuplicates: PendingDuplicateImport[] = [];
    let importableFilePaths = fileEntries.map((entry) => entry.path);
    const shouldPrecheckDuplicate =
      fileEntries.length === 1 &&
      directoryPaths.length === 0 &&
      fileEntries[0].size <= SINGLE_FILE_DUPLICATE_CHECK_MAX_BYTES;

    if (shouldPrecheckDuplicate) {
      const entry = fileEntries[0];
      const duplicateCheck = await checkFileDuplicate(entry.path);
      const duplicateImport = createPendingDuplicateImport(
        entry.path,
        targetFolder,
        targetCategory,
        entry.size,
        duplicateCheck,
      );

      if (duplicateImport) {
        pendingDuplicates.push(duplicateImport);
        importableFilePaths = [];
      }
    }

    const batchedImportPaths = [...importableFilePaths, ...directoryPaths];
    if (batchedImportPaths.length > 0) {
      try {
        const result = await invoke<ImportPathsPayload>('import_paths_to_library', {
          sourcePaths: batchedImportPaths,
          targetFolder,
          targetCategory,
        });

        if (result.failedCount > 0) {
          showToast(`导入失败 ${result.failedCount} 项`);
        }
      } catch (error) {
        canvasDebugError('[Canvas] Batch import failed:', batchedImportPaths, error);
        showToast('批量导入失败');
      }
    }

    for (const pendingDuplicate of pendingDuplicates) {
      try {
        await processPendingDuplicateImport(pendingDuplicate);
        const result = { failedCount: 0 };

        if (result.failedCount > 0) {
          showToast(`目录导入失败 ${result.failedCount} 项`);
        }
      } catch (error) {
        canvasDebugError('[Canvas] Duplicate import resolution failed:', pendingDuplicate.filePath, error);
        showToast('目录导入失败');
      }
    }

    scheduleListRefresh('drag-drop-import');
  }, [
    checkFileDuplicate,
    createPendingDuplicateImport,
    getImportTargetCategory,
    getImportTargetFolder,
    processPendingDuplicateImport,
    scheduleListRefresh,
    showToast,
  ]);

  const importWebDroppedContent = useCallback(async (dataTransfer: DataTransfer) => {
    if (Date.now() - lastNativeDropAtRef.current < 400) {
      return false;
    }

    const inferExtension = (mimeType: string) => {
      switch (mimeType.toLowerCase()) {
        case 'image/jpeg':
          return 'jpg';
        case 'image/png':
          return 'png';
        case 'image/gif':
          return 'gif';
        case 'image/webp':
          return 'webp';
        case 'image/svg+xml':
          return 'svg';
        case 'video/mp4':
          return 'mp4';
        case 'video/webm':
          return 'webm';
        case 'video/quicktime':
          return 'mov';
        default:
          return 'png';
      }
    };

    const saveBlobToLibrary = async (blob: Blob, suggestedName?: string | null) => {
      const arrayBuffer = await blob.arrayBuffer();
      const imageBytes = Array.from(new Uint8Array(arrayBuffer));
      const extension = inferExtension(blob.type || '');
      const sanitizedName = suggestedName?.trim();
      const fileName = sanitizedName && sanitizedName.length > 0
        ? sanitizedName
        : `gega_drop_${crypto.randomUUID()}.${extension}`;

      await invoke<string>('save_clipboard_image', {
        fileName,
        imageBytes,
        targetFolder: getImportTargetFolder(),
        targetCategory: getImportTargetCategory(),
      });
    };

    let importedCount = 0;
    let attempted = false;
    const droppedFiles = Array.from(dataTransfer.files ?? []);
    for (const file of droppedFiles) {
      attempted = true;
      try {
        await saveBlobToLibrary(file, file.name);
        importedCount += 1;
      } catch (error) {
        canvasDebugError('[Canvas] Failed to import dropped browser file:', file.name, error);
      }
    }

    if (importedCount === 0) {
      const uriCandidates = [
        ...dataTransfer.getData('text/uri-list').split(/\r?\n/),
        dataTransfer.getData('text/plain'),
      ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && !value.startsWith('#'))
        .filter((value, index, array) => array.indexOf(value) === index)
        .filter((value) => /^https?:\/\//i.test(value) || /^data:image\//i.test(value));

      for (const uri of uriCandidates) {
        attempted = true;
        try {
          const response = await fetch(uri);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const blob = await response.blob();
          if (blob.size <= 0) {
            throw new Error('Empty blob');
          }

          let filename: string | undefined;
          if (/^https?:\/\//i.test(uri)) {
            try {
              const url = new URL(uri);
              const lastSegment = url.pathname.split('/').filter(Boolean).pop();
              filename = lastSegment && lastSegment.includes('.') ? decodeURIComponent(lastSegment) : undefined;
            } catch {
              filename = undefined;
            }
          }

          await saveBlobToLibrary(blob, filename);
          importedCount += 1;
        } catch (error) {
          canvasDebugError('[Canvas] Failed to import dropped URI:', uri, error);
        }
      }
    }

    if (importedCount > 0) {
      scheduleListRefresh('web-drop-import');
      return true;
    }

    if (attempted) {
      showToast('网页拖拽导入失败');
      return true;
    }

    return false;
  }, [getImportTargetCategory, getImportTargetFolder, scheduleListRefresh, showToast]);

  useEffect(() => {
    let disposed = false;
    let unlisten: null | (() => void) = null;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (isAnyPreviewMode) return;

        const payload = event.payload;
        if (payload.type === 'enter' || payload.type === 'over') {
          setIsDragOver(true);
          return;
        }

        if (payload.type === 'leave') {
          setIsDragOver(false);
          return;
        }

        setIsDragOver(false);
        lastNativeDropAtRef.current = Date.now();
        const dropTarget = resolveNativeDropTarget(payload.position);

        if (dropTarget?.targetNav && dropTarget.targetNav !== activeNav) {
          setActiveNav(dropTarget.targetNav);
        }

        if (dropTarget?.targetCategory) {
          setActiveTab(dropTarget.targetCategory);
        }

        canvasDebugLog('[Canvas] Drag-drop event received:', {
          pathCount: payload.paths.length,
          dropTarget,
        });
        await importDroppedPaths(payload.paths, dropTarget);
      })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error) => {
        canvasDebugError('[Canvas] Failed to bind drag-drop listener:', error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [activeNav, importDroppedPaths, isAnyPreviewMode, resolveNativeDropTarget, setActiveNav, setActiveTab]);

  const handleDuplicateAction = useCallback((action: DuplicateAction) => {
    if (duplicateResolveRef.current) {
      duplicateResolveRef.current(action);
    }
  }, []);

  const sentinelRef = useRef<HTMLDivElement>(null);

  const nextCursor = useMediaStore((s) => s.nextCursor);
  // keyset 分页：有 nextCursor 表示后端还有更多数据，比 files.length < totalCount 更准确
  const hasMore = nextCursor !== null;

  // IntersectionObserver：距底部 1500px 时加载下一页
  // 之前 600px 只覆盖约 3 行视觉，快速滚动时 sentinel 进入视口才触发，
  // 用户能看到底部白屏几百毫秒。1500px ≈ 7-8 行预加载，给 SQL 查询 + 缩略图
  // 解码足够提前量。如果 micro 缩略图加载快（~30KB/张 WebP），
  // 用户基本无感新数据加载。
  const loadMore = useCallback(() => {
    if (!isLoading && hasMore && viewMode === 'grid') {
      startTransition(() => {
        fetchFiles(currentPage + 1);
      });
    }
  }, [isLoading, hasMore, fetchFiles, currentPage, viewMode]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = contentRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { root, rootMargin: '3000px' },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  // ResizeObserver：监听滚动容器宽度变化，驱动 Masonry 重新布局
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      setContainerWidth(el.clientWidth || rect.width || 0);
      setViewportHeight(el.clientHeight || rect.height || 0);
    };

    measure();

    const rafId = window.requestAnimationFrame(measure);
    const observer = new ResizeObserver(entries => {
      if (entries[0]) {
        setContainerWidth(entries[0].contentRect.width);
        setViewportHeight(entries[0].contentRect.height);
      }
    });
    observer.observe(el);

    return () => {
      window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  // Masonry 核心算法：N 列瀑布流（最短列优先），columnCount 直接控制列数
  const MASONRY_GAP = 4;
  const columnWidth = containerWidth > 0
    ? Math.floor((containerWidth - (columnCount - 1) * MASONRY_GAP) / columnCount)
    : Math.floor((400 - (columnCount - 1) * MASONRY_GAP) / columnCount);
  const masonryLayout = useMemo(() => {
    const perfStart = isDev ? performance.now() : 0;
    if (columnWidth === 0 || files.length === 0) {
      layoutCacheRef.current = null;
      return { positions: [] as MasonryPosition[], totalHeight: 0 };
    }

    const previous = layoutCacheRef.current;
    // O(1) 首尾引用校验代替 O(n) every()：翻页追加时 spread 保留旧引用，
    // files[0] 和 files[prevLen-1] 与缓存一致即前缀未变
    const canAppendIncrementally =
      previous !== null &&
      previous.columnCount === columnCount &&
      previous.columnWidth === columnWidth &&
      files.length >= previous.files.length &&
      previous.files.length > 0 &&
      files[0] === previous.files[0] &&
      files[previous.files.length - 1] === previous.files[previous.files.length - 1];

    // 标准 N 列 Masonry：每列等宽，图片高度由宽高比决定
    // 仅在分页追加且前缀未变时复用旧布局，否则全量重算
    const colHeights = canAppendIncrementally
      ? [...previous.columnHeights]
      : new Array<number>(columnCount).fill(0);
    const positions: MasonryPosition[] = canAppendIncrementally
      ? previous.positions.slice()
      : new Array(files.length);
    const startIndex = canAppendIncrementally ? previous.files.length : 0;

    for (let i = startIndex; i < files.length; i++) {
      const file = files[i];
      // 找最短列
      let shortestCol = 0;
      for (let c = 1; c < columnCount; c++) {
        if (colHeights[c] < colHeights[shortestCol]) shortestCol = c;
      }

      const x = shortestCol * (columnWidth + MASONRY_GAP);
      const y = colHeights[shortestCol];

      // 根据原图宽高比计算卡片高度；缺失尺寸信息时使用中性 1:1，避免强行按竖图布局
      const ratio = file.width && file.height && file.width > 0 && file.height > 0
        ? file.width / file.height
        : 1;
      const height = Math.round(columnWidth / ratio);

      positions[i] = { x, y, width: columnWidth, height };
      colHeights[shortestCol] = y + height + MASONRY_GAP;
    }

    const totalHeight = Math.max(0, Math.max(...colHeights) - MASONRY_GAP);

    layoutCacheRef.current = {
      files,
      positions,
      columnHeights: colHeights,
      columnCount,
      columnWidth,
      totalHeight,
    };

    if (isDev) {
      const elapsed = performance.now() - perfStart;
      if (elapsed > 12) {
        canvasDebugWarn(`[Perf][Canvas] masonry ${elapsed.toFixed(1)}ms files=${files.length}`);
      }
    }

    return { positions, totalHeight };
  }, [files, columnCount, columnWidth]);

  const positionedCards = useMemo<PositionedCard[]>(() => {
    const perfStart = isDev ? performance.now() : 0;
    const cache = positionedCardsCacheRef.current;
    const canIncremental =
      cache.filesLength > 0 &&
      files.length > cache.filesLength &&
      filesPrefixMatches(files, cache.filesLength, cache.cards);

    let result: PositionedCard[];
    if (canIncremental) {
      const newCards: PositionedCard[] = [];
      for (let i = cache.filesLength; i < files.length; i += 1) {
        const pos = masonryLayout.positions[i];
        if (!pos) continue;
        newCards.push({
          file: files[i],
          index: i,
          pos,
          top: pos.y,
          bottom: pos.y + pos.height,
        });
      }
      newCards.sort((a, b) => a.top - b.top || a.index - b.index);
      result = mergeSortedCards(cache.cards, newCards);
    } else {
      result = files
        .map((file, index) => {
          const pos = masonryLayout.positions[index];
          if (!pos) return null;
          return { file, index, pos, top: pos.y, bottom: pos.y + pos.height };
        })
        .filter((item): item is PositionedCard => item !== null)
        .sort((a, b) => a.top - b.top || a.index - b.index);
    }

    positionedCardsCacheRef.current = { filesLength: files.length, cards: result };
    if (isDev) {
      const elapsed = performance.now() - perfStart;
      if (elapsed > 12) {
        canvasDebugWarn(`[Perf][Canvas] windowing ${elapsed.toFixed(1)}ms rendered=${result.length}`);
      }
    }
    return result;
  }, [files, masonryLayout.positions]);

  const SCROLL_SYNC_MS = 120;
  const SCROLL_FAST_THRESHOLD = 900;
  const SCROLL_SYNC_PX = 420;
  const USE_VIRTUAL = totalCount > 1500;
  const [scrollTop, setScrollTop] = useState(0);
  const lastScrollStateValueRef = useRef(0);
  const lastScrollStateTimeRef = useRef(0);
  const lastScrollTopForVelocityRef = useRef(0);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!USE_VIRTUAL) {
      return;
    }
    const el = contentRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const now = performance.now();
      const current = el.scrollTop;
      notifyCanvasScrollActivity();
      if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = setTimeout(() => {
        scrollIdleTimerRef.current = null;
      }, SCROLL_IDLE_MS);
      const dt = now - lastScrollStateTimeRef.current;
      const dp = Math.abs(current - lastScrollStateValueRef.current);
      if (dt >= SCROLL_SYNC_MS || dp >= SCROLL_SYNC_PX) {
        lastScrollStateTimeRef.current = now;
        lastScrollStateValueRef.current = current;
        lastScrollTopForVelocityRef.current = current;
        setScrollTop(current);
        if (timer) { clearTimeout(timer); timer = null; }
      } else if (!timer) {
        timer = setTimeout(() => {
          lastScrollStateTimeRef.current = performance.now();
          lastScrollStateValueRef.current = el.scrollTop;
          lastScrollTopForVelocityRef.current = el.scrollTop;
          setScrollTop(el.scrollTop);
          timer = null;
        }, SCROLL_SYNC_MS);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
      if (scrollIdleTimerRef.current) {
        clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
    };
  }, [USE_VIRTUAL]);

  const visibleCards = useMemo(() => {
    const perfStart = isDev ? performance.now() : 0;
    if (!USE_VIRTUAL) return positionedCards;
    if (positionedCards.length === 0) return positionedCards;

    const safeViewportHeight = viewportHeight > 0
      ? viewportHeight
      : Math.max(window.innerHeight || 0, 720);
    const effectiveScrollTop = viewportHeight > 0 ? scrollTop : 0;
    const scrollVelocity = Math.abs(effectiveScrollTop - lastScrollTopForVelocityRef.current);
    const dynamicOverscan = Math.min(
      MAX_OVERSCAN,
      Math.max(
        MIN_OVERSCAN,
        scrollVelocity > SCROLL_FAST_THRESHOLD ? 1200 : DEFAULT_OVERSCAN,
      ),
    );

    const minY = Math.max(0, effectiveScrollTop - dynamicOverscan);
    const maxY = effectiveScrollTop + safeViewportHeight + dynamicOverscan;

    let lo = 0;
    let hi = positionedCards.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (positionedCards[mid].bottom < minY) lo = mid + 1;
      else hi = mid;
    }

    const result: PositionedCard[] = [];
    for (let i = lo; i < positionedCards.length; i += 1) {
      if (positionedCards[i].top > maxY) break;
      result.push(positionedCards[i]);
      if (result.length >= MAX_RENDERED_CARDS) break;
    }
    const finalCards = result.length > 0
      ? result
      : positionedCards.slice(0, Math.min(positionedCards.length, MAX_RENDERED_CARDS));

    if (isDev) {
      const elapsed = performance.now() - perfStart;
      if (elapsed > 12) {
        canvasDebugWarn(`[Perf][Canvas] windowing ${elapsed.toFixed(1)}ms rendered=${finalCards.length}`);
      }
    }
    return finalCards;
  }, [positionedCards, scrollTop, viewportHeight, USE_VIRTUAL]);

  const positionedCardsLayoutRef = useRef<PositionedCard[]>([]);
  positionedCardsLayoutRef.current = positionedCards;

  const renderCards = USE_VIRTUAL ? visibleCards : positionedCards;

  const isEmpty = !isLoading && files.length === 0;
  const isTrash = activeNav === 'trash';
  const isEmptyStateText = isTrash ? '回收站是空的' : '还没有内容';
  const shouldShowLoadMoreDots = USE_VIRTUAL ? isLoading && files.length > 0 : false;

  React.useEffect(() => {
    if (!isDev) return;
    const now = performance.now();
    if (now - canvasPerfState.lastCanvasSummaryAt < 1000) return;
    canvasPerfState.lastCanvasSummaryAt = now;
    canvasDebugLog(
      `[Perf][Canvas] files=${files.length} rendered=${visibleCards.length} virtualized=${USE_VIRTUAL} scrollTop=${Math.round(scrollTop)} viewport=${Math.round(viewportHeight)} overscan=${Math.round(Math.min(MAX_OVERSCAN, Math.max(MIN_OVERSCAN, DEFAULT_OVERSCAN)))}`,
    );
  }, [files.length, totalCount, visibleCards.length, USE_VIRTUAL, scrollTop, viewportHeight]);

  // ── 动态样式（useMemo，低频变化）────────────────────────────────

  const mainStyle = useMemo<React.CSSProperties>(() => ({
    flex: 1, display: 'flex', flexDirection: 'column', height: '100%',
    overflow: viewMode === 'grid' ? 'auto' : 'hidden',
    backgroundColor: 'var(--bg-primary)', position: 'relative',
  }), [viewMode]);

  const previewContainerStyle = useMemo<React.CSSProperties>(() => ({
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg-primary)', padding: '12px 24px', overflow: 'hidden',
    cursor: scale > 1 ? (isPreviewDragging ? 'grabbing' : 'grab') : 'default',
  }), [scale, isPreviewDragging]);

  const previewImgStyle = useMemo<React.CSSProperties>(() => ({
    maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block',
    transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
    transformOrigin: 'center center',
    transition: isPreviewDragging ? 'none' : 'transform 150ms ease',
    userSelect: 'none',
  }), [offset.x, offset.y, scale, isPreviewDragging]);

  const prevBtnStyle = useMemo<React.CSSProperties>(() => ({
    ...previewNavBtnBaseStyle,
    cursor: previewIndex === 0 ? 'default' : 'pointer',
    opacity: previewIndex === 0 ? 0.3 : 1,
  }), [previewIndex]);

  const nextBtnStyle = useMemo<React.CSSProperties>(() => ({
    ...previewNavBtnBaseStyle,
    cursor: previewIndex === files.length - 1 ? 'default' : 'pointer',
    opacity: previewIndex === files.length - 1 ? 0.3 : 1,
  }), [previewIndex, files.length]);



  const masonryContainerStyle = useMemo<React.CSSProperties>(() => ({
    position: 'relative',
    height: masonryLayout.totalHeight,
    // 不加 transition：新一页加载时容器高度骤变，transition:'all' 会引发卡顿和闪烁
  }), [masonryLayout.totalHeight]);

  const openPreviewForFile = useCallback(async (file: MediaFile) => {
    const idx = files.findIndex((candidate) => candidate.id === file.id);
    if (idx === -1) return;

    closeCanvasAttachmentPreview();
    setScrollY(contentRef.current?.scrollTop || 0);
    setSelectedIds([file.id]);
    await useMediaStore.getState().focusFile(file.id);
    startTransition(() => {
      setPreviewIndex(idx);
      setViewMode('preview');
    });
  }, [closeCanvasAttachmentPreview, files, setSelectedIds]);

  // 处理右键菜单动作
  const handleContextMenuAction = useCallback(async (action: ContextMenuAction) => {
    if (!targetFile) return;

    canvasDebugLog('[Canvas] Context menu action:', action, 'file:', targetFile.filename);

    try {
      switch (action) {
        case 'copy-path': {
          await navigator.clipboard.writeText(targetFile.filepath);
          showToast('路径已复制');
          break;
        }

        case 'paste': {
          // TODO: 实现粘贴功能
          showToast('粘贴功能待实现');
          break;
        }

        case 'save-as': {
          const result = await invoke<string>('save_file_as', {
            source_path: targetFile.filepath,
          });
          canvasDebugLog('[Canvas] File saved to:', result);
          showToast('文件已保存');
          break;
        }

        case 'move-to-trash': {
          // 若右键目标在多选集中，批量移入回收站；否则仅操作单个
          const { selectedIds: _sIds1 } = useMediaStore.getState();
          const idsToMove = _sIds1.size > 1 && _sIds1.has(targetFile.id)
            ? Array.from(_sIds1)
            : [targetFile.id];
          const result = await invoke<BatchFileOperationResult>('batch_move_to_trash', { ids: idsToMove });
          if (result.succeeded > 0) {
            showToast(
              result.failed > 0
                ? `已移入回收站 ${result.succeeded} 个，失败 ${result.failed} 个`
                : result.succeeded > 1
                  ? `已将 ${result.succeeded} 个文件移入回收站`
                  : '已移入回收站'
            );
            scheduleListRefresh('move-to-trash');
            // 触发回收站更新事件，让回收站视图知道有新项目
            window.dispatchEvent(new CustomEvent('trash-updated'));
          } else {
            showToast('移入回收站失败');
          }
          break;
        }

        case 'delete': {
          // 若右键目标在多选集中，批量永久删除；否则仅操作单个
          const { selectedIds: _sIds2 } = useMediaStore.getState();
          const idsToDelete = _sIds2.size > 1 && _sIds2.has(targetFile.id)
            ? Array.from(_sIds2)
            : [targetFile.id];

          const confirmMessage = idsToDelete.length > 1
            ? `确定要永久删除选中的 ${idsToDelete.length} 个文件吗？\n\n此操作不可恢复！`
            : `确定要永久删除 "${targetFile.filename}" 吗？\n\n此操作不可恢复！`;

          const confirmed = await showConfirm({
            title: '确认删除',
            message: confirmMessage,
            danger: true,
          });
          if (!confirmed) break;

          try {
            const result = await invoke<BatchFileOperationResult>('batch_delete_files_permanently', { ids: idsToDelete });
            if (result.succeeded > 0) {
              showToast(
                result.failed > 0
                  ? `已永久删除 ${result.succeeded} 个，失败 ${result.failed} 个`
                  : result.succeeded > 1
                    ? `已永久删除 ${result.succeeded} 个文件`
                    : '文件已永久删除'
              );
              scheduleListRefresh('delete-permanently');
            } else {
              showToast('删除失败');
            }
          } catch (err) {
            canvasDebugError('[Canvas] Delete failed:', err);
            showToast('删除失败：' + (err as Error).message);
          }
          break;
        }

        case 'view-full': {
          await openPreviewForFile(targetFile);
          break;
        }

        case 'show-in-explorer': {
          try {
            await invoke('show_in_folder', { path: targetFile.filepath });
          } catch (err) {
            canvasDebugError('[Canvas] show_in_folder failed:', err);
            showToast('无法打开文件夹');
          }
          break;
        }

        case 'restore': {
          const { selectedIds: _sIds3 } = useMediaStore.getState();
          const idsToRestore = _sIds3.size > 1 && _sIds3.has(targetFile.id)
            ? Array.from(_sIds3)
            : [targetFile.id];
          const result = await invoke<BatchFileOperationResult>('batch_restore_from_trash', { ids: idsToRestore });
          if (result.succeeded > 0) {
            showToast(
              result.failed > 0
                ? `已恢复 ${result.succeeded} 个，失败 ${result.failed} 个`
                : result.succeeded > 1
                  ? `已恢复 ${result.succeeded} 个文件`
                  : '文件已恢复'
            );
            scheduleListRefresh('restore-from-trash');
            window.dispatchEvent(new CustomEvent('trash-updated'));
          } else {
            showToast('恢复失败');
          }
          break;
        }

        default:
          canvasDebugWarn('[Canvas] Unknown action:', action);
      }
    } catch (err) {
      canvasDebugError('[Canvas] Context menu action failed:', err);
      showToast('操作失败：' + (err as Error).message);
    }

    hideMenu();
  }, [targetFile, showToast, scheduleListRefresh, hideMenu, openPreviewForFile, showConfirm]);

  // 窗口级别框选事件监听（始终激活，内部判断是否处于拖拽状态）
  useEffect(() => {
    // RAF 节流：避免每帧都做 querySelectorAll + getBoundingClientRect
    let rafId: number | null = null;

    // 拖动期间命中的卡片 id（仅本地，不入 store；避免每帧 setSelectedIds 让所有可见 MediaCard
    // 的 selectedIds.has() 选择器重新求值）
    let dragPreviewIds: Set<string> = new Set();

    // 直接 DOM 操作切换 .is-drag-preview class —— 比 setState 路径快一个数量级，
    // 因为不进入 React 调度也不触发 zustand 订阅。
    const applyDragPreviewDiff = (newIds: Set<string>) => {
      // 新进入：加 class
      for (const id of newIds) {
        if (!dragPreviewIds.has(id)) {
          const el = cardElementsRef.current.get(id);
          el?.classList.add('is-drag-preview');
        }
      }
      // 不再命中：去 class
      for (const id of dragPreviewIds) {
        if (!newIds.has(id)) {
          const el = cardElementsRef.current.get(id);
          el?.classList.remove('is-drag-preview');
        }
      }
      dragPreviewIds = newIds;
    };

    const clearDragPreview = () => {
      if (dragPreviewIds.size === 0) return;
      for (const id of dragPreviewIds) {
        const el = cardElementsRef.current.get(id);
        el?.classList.remove('is-drag-preview');
      }
      dragPreviewIds = new Set();
    };

    // 命中测试：用 Masonry 布局矩形 + scroll，避免 N 次 getBoundingClientRect
    const hitTest = (screenRect: { left: number; top: number; width: number; height: number }): Set<string> => {
      const scrollEl = contentRef.current;
      const scrollLeft = scrollEl?.scrollLeft ?? 0;
      const scrollTop = scrollEl?.scrollTop ?? 0;
      const contentRect = scrollEl?.getBoundingClientRect();
      const originLeft = contentRect?.left ?? 0;
      const originTop = contentRect?.top ?? 0;

      const selLeft = screenRect.left - originLeft + scrollLeft;
      const selTop = screenRect.top - originTop + scrollTop;
      const selRight = selLeft + screenRect.width;
      const selBottom = selTop + screenRect.height;

      const idSet = new Set<string>();
      for (const { file, pos } of positionedCardsLayoutRef.current) {
        const cardLeft = pos.x;
        const cardTop = pos.y;
        const cardRight = pos.x + pos.width;
        const cardBottom = pos.y + pos.height;
        const isIntersecting = !(
          cardRight < selLeft ||
          cardLeft > selRight ||
          cardBottom < selTop ||
          cardTop > selBottom
        );
        if (isIntersecting) {
          idSet.add(file.id);
        }
      }
      return idSet;
    };

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (isDraggingCard.current) return;
      if (!dragStartPos.current) return;

      const startX = dragStartPos.current.x;
      const startY = dragStartPos.current.y;
      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);

      const rect = { left, top, width, height };
      selectionRectRef.current = rect;
      setSelectionRect(rect);

      // RAF 节流：仅维护 drag-preview 视觉，不动 store
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (!selectionRectRef.current) return;
        if (selectionRectRef.current.width < 5 || selectionRectRef.current.height < 5) return;
        applyDragPreviewDiff(hitTest(selectionRectRef.current));
        rafId = null;
      });
    };

    const handleWindowMouseUp = (_: MouseEvent) => {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      if (!dragStartPos.current) {
        clearDragPreview();
        return;
      }

      const currentRect = selectionRectRef.current;
      if (!currentRect || currentRect.width < 5 || currentRect.height < 5) {
        dragStartPos.current = null;
        selectionRectRef.current = null;
        setSelectionRect(null);
        clearDragPreview();
        return;
      }

      // mouseup 才提交到 store（最终一次命中测试，避免依赖陈旧的 dragPreviewIds）
      const finalIds = Array.from(hitTest(currentRect));
      clearDragPreview(); // 必须先清，否则 store 写入触发 .is-selected 后还有残留 .is-drag-preview

      if (finalIds.length > 0) {
        setSelectedIds(finalIds);
        showToast(`选中了 ${finalIds.length} 张图片`);
        // 标记框选刚结束，阻止紧随其后的 click 事件调用 handleBackgroundClick 清空选中
        rubberBandJustEndedRef.current = true;
        setTimeout(() => { rubberBandJustEndedRef.current = false; }, 100);
      }

      dragStartPos.current = null;
      selectionRectRef.current = null;
      setSelectionRect(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
      clearDragPreview();
    };
  }, [setSelectedIds, showToast]);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (canvasAttachmentPreview) {
        if (e.key === 'Escape') {
          handleBackFromAttachmentPreview();
        }
        return;
      }
      // 原地预览模式下的键盘控制
      if (viewMode === 'preview') {
        if (e.key === 'Escape') {
          handleBackToGrid();
        } else if (e.key === 'ArrowRight') {
          handleNext();
        } else if (e.key === 'ArrowLeft') {
          handlePrev();
        }
        return;
      }

      // Escape — 清除多选框选
      if (e.key === 'Escape') {
        deselectAll();
        return;
      }

      // Ctrl/Cmd + A 全选（input/textarea 获焦时跳过，让浏览器原生全选文字）
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
          return; // 输入框自己处理 Ctrl+A，不拦截
        }
        e.preventDefault();
        const currentPageFiles = files;
        if (currentPageFiles.length > 0) {
          selectFiles(currentPageFiles.map((f) => f.id));
          showToast(`全选了 ${currentPageFiles.length} 张图片`);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canvasAttachmentPreview, files, selectFiles, deselectAll, showToast, viewMode, handleBackFromAttachmentPreview, handleBackToGrid, handleNext, handlePrev]);

  // 搜索防抖逻辑
  useEffect(() => {
    const timer = setTimeout(() => {
      // 归一化比较：'' / null / undefined 视为相等，避免切换导航时
      // filter.keyword=undefined vs searchQuery='' 误判为变化触发二次 fetch
      const currentKw = filter.keyword ?? '';
      if (currentKw !== searchQuery) {
        setFilter({ keyword: searchQuery || null });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, filter.keyword, setFilter]);

  // 处理 Escape 清空搜索
  useEffect(() => {
    const handleEscSearch = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && searchQuery) {
        setSearchQuery('');
      }
    };
    window.addEventListener('keydown', handleEscSearch);
    return () => window.removeEventListener('keydown', handleEscSearch);
  }, [searchQuery]);

  // 点击背景关闭 Inspector（框选刚结束时跳过，避免 mouseup→click 立即清空选中）
  const handleBackgroundClick = useCallback(() => {
    if (rubberBandJustEndedRef.current) return;
    if (isAnyPreviewMode) return;
    deselectAll();
  }, [deselectAll, isAnyPreviewMode]);

  // 双击卡片原地预览
  const handleDoubleClick = useCallback(
    (file: MediaFile) => {
      void openPreviewForFile(file);
    },
    [openPreviewForFile]
  );

  const handleCardDragStart = useCallback(() => {
    isDraggingCard.current = true;
  }, []);

  const handleCardDragEnd = useCallback(() => {
    isDraggingCard.current = false;
  }, []);

  // 处理框选起点（绑定在 main 容器上）
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isAnyPreviewMode) return;

      // 如果点击在卡片上，不触发框选
      if ((e.target as Element).closest('[data-card-id]')) return;
      if ((e.target as Element).closest('.no-drag')) return;
      if ((e.target as Element).closest('input, button, select')) return;
      if (e.button !== 0) return;

      dragStartPos.current = { x: e.clientX, y: e.clientY };
      const initRect = { left: e.clientX, top: e.clientY, width: 0, height: 0 };
      selectionRectRef.current = initRect;
      setSelectionRect(initRect);
    },
    [isAnyPreviewMode]
  );

  return (
    <div
      data-canvas-container="true"
      style={canvasRootStyle}
    >
      {/* 框选矩形 - fixed 定位使用视口坐标，跟随鼠标不受滚动影响 */}
      {selectionRect && !isAnyPreviewMode && (
        <div
          style={{
            position: 'fixed',
            left: selectionRect.left,
            top: selectionRect.top,
            width: selectionRect.width,
            height: selectionRect.height,
            backgroundColor: 'var(--accent-dim)',
            boxShadow: 'inset 0 0 0 1px var(--accent)',
            borderRadius: 'var(--radius-control)',
            zIndex: 100,
            pointerEvents: 'none',
          }}
        />
      )}
      <main
        ref={mainRef}
        style={mainStyle}
        onClick={handleBackgroundClick}
        onDragOver={(e) => {
          if (isAnyPreviewMode) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          if (isAnyPreviewMode) return;
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(false);
        }}
        onDrop={async (e) => {
          if (isAnyPreviewMode) return;
          e.preventDefault();
          e.stopPropagation();
          setIsDragOver(false);
          await importWebDroppedContent(e.dataTransfer);
        }}
        onMouseDown={handleMouseDown}
      >
      {/* 拖入高亮遮罩 */}
      {isDragOver && (
        <div style={dragOverlayStyle}>
          <div style={dragOverlayContentStyle}>
            <Icon name="file_download" size={42} style={dragOverlayIconStyle} />
            <p style={dragOverlayTextStyle}>松开以导入</p>
          </div>
        </div>
      )}

      {/* 渲染预览模式 */}
      {canvasAttachmentPreview ? (
        <div style={previewWrapperStyle}>
          <div data-tauri-drag-region style={previewTopBarStyle}>
            <button onClick={handleBackFromAttachmentPreview} className="no-drag" style={previewBackBtnStyle}>
              <Icon name="arrow_back" size={18} style={previewBackIconStyle} />
              <span>返回{getNavDisplayName()}</span>
            </button>

            <span style={previewFilenameStyle}>{activeCanvasAttachmentItem?.filename ?? '附件内容'}</span>

            <div className="no-drag" style={previewWindowCtrlsStyle}>
              <WindowControls topOffset={0} rightOffset={0} />
            </div>
          </div>

          <div
            ref={previewContainerRef}
            style={previewContainerStyle}
            onMouseDown={(e) => {
              if (scale > 1 && e.button === 0) {
                setIsPreviewDragging(true);
                previewDragStart.current = {
                  x: e.clientX, y: e.clientY,
                  offsetX: offset.x, offsetY: offset.y,
                };
              }
            }}
            onMouseMove={(e) => {
              if (isPreviewDragging) {
                const dx = e.clientX - previewDragStart.current.x;
                const dy = e.clientY - previewDragStart.current.y;
                setOffset({
                  x: previewDragStart.current.offsetX + dx,
                  y: previewDragStart.current.offsetY + dy,
                });
              }
            }}
            onMouseUp={() => setIsPreviewDragging(false)}
            onMouseLeave={() => setIsPreviewDragging(false)}
            onDoubleClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}
          >
            {activeCanvasAttachmentItem?.src ? (
              <>
                <img
                  src={activeCanvasAttachmentItem.src}
                  alt={activeCanvasAttachmentItem.filename}
                  draggable={false}
                  style={previewImgStyle}
                />
                {scale !== 1 && (
                  <div style={scaleIndicatorStyle}>{Math.round(scale * 100)}%</div>
                )}
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', color: 'var(--text-secondary)' }}>
                <Icon name="description" size={40} color="var(--text-muted)" />
                <span style={{ fontSize: '13px' }}>当前附件暂无可用预览</span>
              </div>
            )}
          </div>

          <div style={{ padding: '0 24px 18px', display: 'flex', gap: '10px', overflowX: 'auto', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
            {canvasAttachmentPreview.items.map((item) => {
              const isActive = item.id === activeCanvasAttachmentItem?.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setCanvasAttachmentPreviewActive(item.id);
                    setScale(1);
                    setOffset({ x: 0, y: 0 });
                    setIsPreviewDragging(false);
                  }}
                  title={item.filename}
                  style={{
                    width: '88px',
                    height: '88px',
                    flexShrink: 0,
                    borderRadius: '12px',
                    overflow: 'hidden',
                    border: 'none',
                    padding: 0,
                    background: isActive ? 'var(--accent-dim)' : 'var(--bg-surface)',
                    boxShadow: isActive
                      ? 'inset 0 0 0 1px var(--accent-border)'
                      : 'inset 0 0 0 1px var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  {item.src ? (
                    <img
                      src={item.src}
                      alt={item.filename}
                      style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', background: 'var(--bg-primary)' }}
                    />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
                      <Icon name="description" size={24} />
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ) : viewMode === 'preview' && files[previewIndex] ? (
        <div style={previewWrapperStyle}>
          {/* 顶部栏 */}
          <div data-tauri-drag-region style={previewTopBarStyle}>
            <button onClick={handleBackToGrid} className="no-drag" style={previewBackBtnStyle}>
              <Icon name="arrow_back" size={18} style={previewBackIconStyle} />
              <span>返回{getNavDisplayName()}</span>
            </button>

            <span style={previewFilenameStyle}>{files[previewIndex].filename}</span>

            <div className="no-drag" style={previewWindowCtrlsStyle}>
              <WindowControls topOffset={0} rightOffset={0} />
            </div>
          </div>

          <div
            ref={previewContainerRef}
            style={previewContainerStyle}
            onMouseDown={(e) => {
              if (scale > 1 && e.button === 0) {
                setIsPreviewDragging(true);
                previewDragStart.current = {
                  x: e.clientX, y: e.clientY,
                  offsetX: offset.x, offsetY: offset.y,
                };
              }
            }}
            onMouseMove={(e) => {
              if (isPreviewDragging) {
                const dx = e.clientX - previewDragStart.current.x;
                const dy = e.clientY - previewDragStart.current.y;
                setOffset({
                  x: previewDragStart.current.offsetX + dx,
                  y: previewDragStart.current.offsetY + dy,
                });
              }
            }}
            onMouseUp={() => setIsPreviewDragging(false)}
            onMouseLeave={() => setIsPreviewDragging(false)}
            onDoubleClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }}
          >
            <img
              src={previewResolvedSrc}
              alt={files[previewIndex].filename}
              draggable={false}
              style={previewImgStyle}
            />

            {/* 缩放比例指示器 */}
            {scale !== 1 && (
              <div style={scaleIndicatorStyle}>{Math.round(scale * 100)}%</div>
            )}
            {isLoadingPreviewOriginal && (
              <div style={{
                position: 'absolute', bottom: '16px', right: '16px',
                display: 'flex', alignItems: 'center', gap: '8px',
                fontSize: '12px', color: 'var(--text-muted)',
                background: 'var(--bg-hover)', padding: '4px 8px',
                borderRadius: '999px',
              }}>
                <Icon name="progress_activity" size={14} style={{ animation: 'spin 1s linear infinite' }} />
                <span>加载原图中…</span>
              </div>
            )}
          </div>

          {/* 底部翻页栏 */}
          <div style={previewBottomBarStyle}>
            <button onClick={handlePrev} disabled={previewIndex === 0} style={prevBtnStyle}>
              <Icon name="chevron_left" size={18} style={previewNavIconStyle} />
            </button>

            <span style={previewPageCountStyle}>{previewIndex + 1} / {files.length}</span>

            <button onClick={handleNext} disabled={previewIndex === files.length - 1} style={nextBtnStyle}>
              <Icon name="chevron_right" size={18} style={previewNavIconStyle} />
            </button>
          </div>
        </div>
      ) : (
        /* 内容区（网格/瀑布流模式） */
        <div style={gridWrapperStyle}>
          <TopToolbar
            count={totalCount}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
          />

          {/* 独立滚动区域 */}
          <div
            ref={contentRef}
            className="canvas-content"
            style={contentScrollStyle}
            onClick={handleBackgroundClick}
          >
            {/* 空状态 */}
            {isEmpty && (
              <div style={emptyStateStyle}>
                <Icon name={isTrash ? 'delete_sweep' : 'folder_open'} size={42} style={emptyIconStyle} />
                <p style={emptyTextStyle}>{isEmptyStateText}</p>
              </div>
            )}

            {/* Masonry 瀑布流布局 - JS 绝对定位算法，彻底消除空位 */}
            {!isEmpty && (
              <div style={masonryContainerStyle}>
                {renderCards.map(({ file, pos }, index) => {
                  const wrapperStyle: React.CSSProperties = {
                    position: 'absolute',
                    left: pos.x,
                    top: pos.y,
                    width: pos.width,
                    height: pos.height,
                    contain: 'layout paint style',
                  };

                  if (USE_VIRTUAL) {
                    const isFarFromViewport = viewportHeight > 0
                      ? Math.abs((pos.y + pos.height / 2) - (scrollTop + viewportHeight / 2)) > viewportHeight * 1.25
                      : false;
                    if (isFarFromViewport) {
                      wrapperStyle.opacity = 0.999;
                      wrapperStyle.contentVisibility = 'auto';
                      wrapperStyle.containIntrinsicSize = `${pos.width}px ${pos.height}px`;
                    }
                  }

                  return (
                    <div
                      key={file.id}
                      style={wrapperStyle}
                    >
                      {/* 修复：[P2] data-card-id 只保留在 MediaCard 内层，
                          避免 querySelectorAll 扫到 2N 个节点（wrapper + card 各一个） */}
                      <MediaCard
                        file={file}
                        isInitiallyVisible={!USE_VIRTUAL ? true : index < EAGER_CARD_COUNT}
                        onDragStart={handleCardDragStart}
                        onDragEnd={handleCardDragEnd}
                        onDoubleClick={handleDoubleClick}
                        observe={observeElement}
                        unobserve={unobserveElement}
                      />
                    </div>
                  );
                })}
              </div>
            )}

            {/* 加载更多指示器（绝对布局容器外单独放置） */}
            {shouldShowLoadMoreDots && (
              <div style={loadingDotsWrapperStyle}>
                {[0, 1, 2].map(i => (
                  <div
                    key={i}
                    style={{
                      width: '8px', height: '8px', borderRadius: '50%',
                      backgroundColor: 'var(--accent)',
                      animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
                    }}
                  />
                ))}
              </div>
            )}

            {/* 空状态：无内容且非加载中 */}
            {!isLoading && files.length === 0 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '200px', color: 'var(--text-muted)', fontSize: '13px' }}>
                暂无素材
              </div>
            )}

            {/* IntersectionObserver 哨兵 */}
            <div ref={sentinelRef} style={sentinelStyle} />

            {/* 全部加载完成提示 */}
            {!isLoading && files.length > 0 && !hasMore && (
              <div style={footerTextStyle}>已显示全部 {totalCount} 项</div>
            )}
          </div>
        </div>
      )}

      {/* 右键菜单 */}
      <ContextMenu onAction={handleContextMenuAction} isTrash={isTrash} />

      {/* 重复文件确认弹窗 */}
      {duplicateInfo && (
        <DuplicateModal
          info={duplicateInfo}
          onAction={handleDuplicateAction}
        />
      )}
    </main>
    </div>
  );
};
