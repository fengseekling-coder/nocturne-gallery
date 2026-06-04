/**
 * Nocturne Gallery — MediaCard
 *
 * 瀑布流卡片：纯图片/视频预览，无任何文字信息和按钮
 * 只保留：图片/视频/占位图 + 选中态 accent 边框
 */

import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getAssetUrl } from '../../lib/thumbnailCache';
import { pickGridThumbnailPath, pickGridUpgradePath } from '../../lib/gridThumbnail';
import { runWithImageDecodeSlot } from '../../lib/imageDecodeLimiter';
import { waitForCanvasScrollIdle } from '../../lib/scrollActivityBus';
import type { MediaFile } from '../../types/media';
import { useMediaStore } from '../../stores/mediaStore';
import { useUiStore } from '../../stores/uiStore';
import { useContextMenuStore } from '../../stores/contextMenuStore';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: 'no-drag';
  WebkitUserDrag?: 'none';
};

type GegaMediaPointerDragPhase = 'start' | 'move' | 'end' | 'cancel';

interface GegaMediaPointerDragDetail {
  phase: GegaMediaPointerDragPhase;
  clientX: number;
  clientY: number;
  item: {
    fileId: string;
    filePath: string;
    filename: string;
    mimeType?: string;
    filetype: string;
  };
}

const GEGA_MEDIA_POINTER_DRAG_EVENT = 'gega-media-pointer-drag';
const POINTER_DRAG_THRESHOLD = 6;
const EXTERNAL_DRAG_EDGE_SIZE = 2;

const NO_DRAG_STYLE: AppRegionStyle = { WebkitAppRegion: 'no-drag' };

interface MediaCardProps {
  file: MediaFile;
  isInitiallyVisible?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDoubleClick?: (file: MediaFile) => void;
  observe: (el: Element, onVisible: () => void) => void;
  unobserve: (el: Element) => void;
}

export const MediaCard = React.memo<MediaCardProps>(({ file, isInitiallyVisible = false, onDragStart, onDragEnd, onDoubleClick, observe, unobserve }) => {
  const [isDragging, setIsDragging] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const suppressNextClickRef = useRef(false);
  const nativeDragStartedRef = useRef(false);

  const isSelected = useMediaStore((s) => s.selectedIds.has(file.id));
  const isActive = useMediaStore((s) => s.selectedId === file.id);
  const focusFile = useMediaStore((s) => s.focusFile);
  const openDetailPanel = useUiStore((s) => s.openDetailPanel);
  const showMenu = useContextMenuStore((s) => s.showMenu);
  const toggleFileSelection = useMediaStore((s) => s.toggleFileSelection);

  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const [displayDiskPath, setDisplayDiskPath] = useState<string | null>(() => pickGridThumbnailPath(file));
  const [, setIsInView] = useState(isInitiallyVisible);
  const upgradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upgradeGenRef = useRef(0);

  const currentThumbnailSrc = displayDiskPath ? getAssetUrl(displayDiskPath) : '';
  const hasStableThumbnail = !!currentThumbnailSrc && !thumbnailFailed;

  useEffect(() => {
    setThumbnailFailed(false);
    setDisplayDiskPath(pickGridThumbnailPath(file));
    setIsInView(isInitiallyVisible);
    upgradeGenRef.current += 1;
    if (upgradeTimerRef.current) {
      clearTimeout(upgradeTimerRef.current);
      upgradeTimerRef.current = null;
    }
  }, [file.id, file.thumbnailMicroPath, file.thumbnailPath, file.thumbnailPreviewPath, isInitiallyVisible]);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const onVisible = () => {
      setIsInView(true);
      const base = pickGridThumbnailPath(file);
      if (base) {
        void runWithImageDecodeSlot(async () => {
          setDisplayDiskPath((prev) => prev ?? base);
        });
      }

      if (upgradeTimerRef.current) clearTimeout(upgradeTimerRef.current);
      const gen = ++upgradeGenRef.current;
      upgradeTimerRef.current = setTimeout(() => {
        if (gen !== upgradeGenRef.current) return;
        const upgrade = pickGridUpgradePath(file, base);
        if (!upgrade) return;
        void runWithImageDecodeSlot(async () => {
          await waitForCanvasScrollIdle();
          if (gen !== upgradeGenRef.current) return;
          const probe = new Image();
          probe.decoding = 'async';
          probe.src = getAssetUrl(upgrade);
          await new Promise<void>((resolve, reject) => {
            probe.onload = () => resolve();
            probe.onerror = () => reject(new Error('upgrade load failed'));
          });
          if (gen !== upgradeGenRef.current) return;
          setDisplayDiskPath(upgrade);
        }).catch(() => undefined);
      }, 280);
    };

    observe(el, onVisible);
    return () => {
      unobserve(el);
      if (upgradeTimerRef.current) {
        clearTimeout(upgradeTimerRef.current);
        upgradeTimerRef.current = null;
      }
    };
  }, [observe, unobserve, file]);


  const toFileUri = (filePath: string) => (
    /^file:\/\//i.test(filePath)
      ? filePath
      : encodeURI(`file:///${filePath.replace(/\\/g, '/')}`)
  );

  const createPointerDragDetail = (
    phase: GegaMediaPointerDragPhase,
    clientX: number,
    clientY: number,
  ): GegaMediaPointerDragDetail => ({
    phase,
    clientX,
    clientY,
    item: {
      fileId: file.id,
      filePath: file.filepath,
      filename: file.filename,
      mimeType: file.mimeType ?? undefined,
      filetype: file.filetype,
    },
  });

  const dispatchPointerDrag = (
    phase: GegaMediaPointerDragPhase,
    clientX: number,
    clientY: number,
  ) => {
    window.dispatchEvent(new CustomEvent<GegaMediaPointerDragDetail>(
      GEGA_MEDIA_POINTER_DRAG_EVENT,
      { detail: createPointerDragDetail(phase, clientX, clientY) },
    ));
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const fileUri = toFileUri(file.filepath);
    const mimeType = file.mimeType || 'application/octet-stream';
    const payload = JSON.stringify({
      fileId: file.id,
      filePath: file.filepath,
      filename: file.filename,
      mimeType,
      filetype: file.filetype,
    });
    e.dataTransfer.setData('application/x-gega-media', payload);
    e.dataTransfer.setData('application/json', payload);
    e.dataTransfer.setData('text/plain', file.filepath);
    e.dataTransfer.setData('text/uri-list', `${fileUri}\r\n`);
    e.dataTransfer.setData('URL', fileUri);
    e.dataTransfer.setData('DownloadURL', `${mimeType}:${file.filename}:${fileUri}`);
    e.dataTransfer.effectAllowed = 'copy';

    if (cardRef.current) {
      e.dataTransfer.setDragImage(cardRef.current, Math.min(32, cardRef.current.clientWidth / 2), 24);
    }

    setIsDragging(true);
    onDragStart?.();
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let didDrag = false;

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    const beginDrag = (clientX: number, clientY: number) => {
      didDrag = true;
      nativeDragStartedRef.current = false;
      suppressNextClickRef.current = true;
      setIsDragging(true);
      onDragStart?.();
      document.body.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      dispatchPointerDrag('start', clientX, clientY);
    };

    const isOutsideWindow = (clientX: number, clientY: number) => (
      clientX <= EXTERNAL_DRAG_EDGE_SIZE
      || clientY <= EXTERNAL_DRAG_EDGE_SIZE
      || clientX >= window.innerWidth - EXTERNAL_DRAG_EDGE_SIZE
      || clientY >= window.innerHeight - EXTERNAL_DRAG_EDGE_SIZE
    );

    const startNativeFileDrag = (clientX: number, clientY: number) => {
      if (nativeDragStartedRef.current) return;
      nativeDragStartedRef.current = true;
      dispatchPointerDrag('cancel', clientX, clientY);
      setIsDragging(false);
      onDragEnd?.();
      cleanup();
      void invoke('start_file_drag', { paths: [file.filepath] }).catch((error: unknown) => {
        console.error('[MediaCard] Native file drag failed:', error);
      });
    };

    function handlePointerMove(pointerEvent: PointerEvent) {
      const deltaX = pointerEvent.clientX - startX;
      const deltaY = pointerEvent.clientY - startY;
      const distance = Math.hypot(deltaX, deltaY);
      if (!didDrag && distance < POINTER_DRAG_THRESHOLD) return;
      pointerEvent.preventDefault();
      if (!didDrag) {
        beginDrag(pointerEvent.clientX, pointerEvent.clientY);
        return;
      }
      if (isOutsideWindow(pointerEvent.clientX, pointerEvent.clientY)) {
        startNativeFileDrag(pointerEvent.clientX, pointerEvent.clientY);
        return;
      }
      dispatchPointerDrag('move', pointerEvent.clientX, pointerEvent.clientY);
    }

    function handlePointerUp(pointerEvent: PointerEvent) {
      cleanup();
      if (!didDrag || nativeDragStartedRef.current) return;
      pointerEvent.preventDefault();
      dispatchPointerDrag('end', pointerEvent.clientX, pointerEvent.clientY);
      setIsDragging(false);
      onDragEnd?.();
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    }

    function handlePointerCancel(pointerEvent: PointerEvent) {
      cleanup();
      if (!didDrag || nativeDragStartedRef.current) return;
      dispatchPointerDrag('cancel', pointerEvent.clientX, pointerEvent.clientY);
      setIsDragging(false);
      onDragEnd?.();
      window.setTimeout(() => {
        suppressNextClickRef.current = false;
      }, 0);
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    onDragEnd?.();
  };

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      toggleFileSelection(file.id);
      return;
    }

    void focusFile(file.id);
    openDetailPanel();
  };

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, file.id);
  };

  const handleDoubleClick = React.useCallback(() => {
    onDoubleClick?.(file);
  }, [onDoubleClick, file]);

  const className = 'media-card no-drag' + (isSelected ? ' is-selected' : '') + (isActive ? ' is-active' : '') + (isDragging ? ' is-dragging' : '');

  return (
    <div
      ref={cardRef}
      data-card-id={file.id}
      draggable={false}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className={className}
      style={NO_DRAG_STYLE}
    >
      <div style={{ width: '100%', position: 'relative' }}>
        {hasStableThumbnail ? (
          <img
            key={currentThumbnailSrc}
            src={currentThumbnailSrc}
            alt={file.filename}
            draggable={false}
            decoding="async"
            loading={isInitiallyVisible ? 'eager' : 'lazy'}
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain', objectPosition: 'center center', WebkitUserDrag: 'none' } as AppRegionStyle}
            onDragStart={(event) => event.preventDefault()}
            onError={() => setThumbnailFailed(true)}
            onDoubleClick={handleDoubleClick}
          />
        ) : (
          <div style={{ width: '100%', aspectRatio: '4 / 3', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', backgroundColor: 'var(--bg-hover)' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '40px', color: 'var(--text-muted)' }}>
              {file.filetype === 'video' ? 'movie' : file.filetype === 'design' ? 'brush' : file.filetype === '3d' ? 'view_in_ar' : 'description'}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', letterSpacing: '0.05em' }}>
              {file.filename.split('.').pop()?.toUpperCase() ?? file.filetype.toUpperCase()}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});
