import React, { useCallback, useRef, useState } from 'react';

const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}

const rootStyle: AppRegionStyle = {
  position: 'relative',
  width: '72px',
  height: '28px',
  flexShrink: 0,
  cursor: 'pointer',
  touchAction: 'none',
  WebkitAppRegion: 'no-drag',
};

const trackStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: '50%',
  height: '3px',
  marginTop: '-1.5px',
  borderRadius: '2px',
  background: 'var(--slider-track)',
  pointerEvents: 'none',
};

const thumbBaseStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  width: '10px',
  height: '10px',
  marginTop: '-5px',
  marginLeft: '-5px',
  borderRadius: '50%',
  background: 'var(--accent)',
  boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)',
  pointerEvents: 'none',
  transition: 'transform 0.12s ease, box-shadow 0.12s ease',
  willChange: 'left, transform',
};

function columnToRatio(columnCount: number): number {
  const clamped = Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, columnCount));
  return (MAX_COLUMNS - clamped) / (MAX_COLUMNS - MIN_COLUMNS);
}

function ratioToColumn(ratio: number): number {
  const clampedRatio = Math.max(0, Math.min(1, ratio));
  const raw = MAX_COLUMNS - clampedRatio * (MAX_COLUMNS - MIN_COLUMNS);
  return Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, Math.round(raw)));
}

export interface ColumnZoomSliderProps {
  columnCount: number;
  onCommit: (columnCount: number) => void;
}

export const ColumnZoomSlider: React.FC<ColumnZoomSliderProps> = ({
  columnCount,
  onCommit,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [previewColumn, setPreviewColumn] = useState<number | null>(null);
  const previewColumnRef = useRef<number | null>(null);
  /** 拖动时圆点连续跟随指针，不卡在 5 个档位上 */
  const [dragThumbRatio, setDragThumbRatio] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const draggingRef = useRef(false);

  const displayColumn = previewColumn ?? columnCount;
  const thumbRatio = dragThumbRatio ?? columnToRatio(displayColumn);

  const setPreview = useCallback((next: number) => {
    previewColumnRef.current = next;
    setPreviewColumn(next);
  }, []);

  const updateFromClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setDragThumbRatio(ratio);
    setPreview(ratioToColumn(ratio));
  }, [setPreview]);

  const finishDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setIsDragging(false);
    setDragThumbRatio(null);
    const toCommit = previewColumnRef.current ?? columnCount;
    previewColumnRef.current = null;
    setPreviewColumn(null);
    onCommit(toCommit);
  }, [columnCount, onCommit]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = true;
    setIsDragging(true);
    updateFromClientX(event.clientX);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    updateFromClientX(event.clientX);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishDrag();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = Math.min(MAX_COLUMNS, displayColumn + 1);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = Math.max(MIN_COLUMNS, displayColumn - 1);
    } else if (event.key === 'Home') {
      next = MAX_COLUMNS;
    } else if (event.key === 'End') {
      next = MIN_COLUMNS;
    }
    if (next === null || next === displayColumn) return;
    event.preventDefault();
    onCommit(next);
  };

  return (
    <div
      ref={trackRef}
      className={`column-zoom-slider no-drag${isDragging ? ' is-dragging' : ''}`}
      style={rootStyle}
      role="slider"
      tabIndex={0}
      aria-label="网格缩放"
      aria-valuemin={MIN_COLUMNS}
      aria-valuemax={MAX_COLUMNS}
      aria-valuenow={displayColumn}
      aria-valuetext={`${displayColumn} 列`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onLostPointerCapture={finishDrag}
      onKeyDown={handleKeyDown}
    >
      <div className="column-zoom-slider__track" style={trackStyle} aria-hidden />
      <div
        className={`column-zoom-slider__thumb${isDragging ? ' is-dragging' : ''}`}
        style={{
          ...thumbBaseStyle,
          left: `${thumbRatio * 100}%`,
          transform: isDragging ? 'scale(1.2)' : undefined,
        }}
        aria-hidden
      />
    </div>
  );
};