/**
 * Nocturne Gallery — FullScreenPreview
 *
 * 大图全屏预览组件
 */

import React, { useEffect, useState, useRef } from 'react';
import { loadFullResolution, resolveDisplaySrc } from '../../../lib/loadFullResolution';
import { Icon } from '../Icon';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface FullScreenPreviewProps {
  imageUrl: string;
  thumbnailPreviewPath?: string | null;
  filename: string;
  onClose: () => void;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const FullScreenPreview: React.FC<FullScreenPreviewProps> = ({
  imageUrl,
  thumbnailPreviewPath,
  filename,
  onClose,
}) => {
  const [displaySrc, setDisplaySrc] = useState<string>('');
  const [isLoadingOriginal, setIsLoadingOriginal] = useState(false);
  const originalAbortRef = useRef<AbortController | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (originalAbortRef.current) originalAbortRef.current.abort();

    const abortController = new AbortController();
    originalAbortRef.current = abortController;

    const cleanup = loadFullResolution({
      imagePath: imageUrl,
      thumbnailPreviewPath,
      originalDelayMs: 120,
      signal: abortController.signal,
      onDisplayPathChange: setDisplaySrc,
      onLoadingOriginalChange: setIsLoadingOriginal,
    });

    return () => {
      abortController.abort();
      cleanup();
    };
  }, [imageUrl, thumbnailPreviewPath]);

  return (
    <>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'var(--overlay-backdrop)',
          zIndex: 10000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        onClick={onClose}
      >
        <div
          style={{
            maxWidth: '90vw',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '16px',
            position: 'relative',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <img
            src={resolveDisplaySrc(displaySrc)}
            alt={filename}
            decoding="async"
            loading="eager"
            style={{
              maxWidth: '90vw',
              maxHeight: '80vh',
              objectFit: 'contain',
              display: 'block',
              borderRadius: 'var(--radius-default)',
              transform: `scale(${scale})`,
              transition: 'transform 0.15s ease-out',
            }}
            onWheel={(e) => {
              if (isLoadingOriginal && scale >= 1 && e.deltaY < 0) return;
              setScale((prev) => {
                 const newScale = e.deltaY < 0 ? prev * 1.1 : prev / 1.1;
                 return Math.max(0.2, Math.min(newScale, 5));
              });
            }}
            onDoubleClick={() => setScale(1)}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <p
              style={{
                fontFamily: 'var(--font-family)',
                fontSize: '13px',
                color: 'var(--text-secondary)',
                margin: 0,
              }}
            >
              {filename}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
              <span>{Math.round(scale * 100)}%</span>
              {isLoadingOriginal && scale > 1 && (
                <Icon name="progress_activity" size={12} style={{ animation: 'spin 1s linear infinite' }} />
              )}
            </div>
          </div>
        </div>

        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '24px',
            right: '24px',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            border: 'none',
            backgroundColor: 'var(--bg-hover)',
            color: 'var(--text-primary)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backdropFilter: 'blur(8px)',
            transition: 'background-color var(--transition-default)',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-card)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'var(--bg-hover)'; }}
        >
          <Icon name="close" size={20} />
        </button>
      </div>
    </>
  );
};
