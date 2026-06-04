/**
 * Gega Gallery — ThumbnailRebuildBanner
 *
 * 老库升级时的缩略图重建进度提示横幅。
 * 固定在画布底部，显示缺失缩略图数量并允许用户触发/取消重建。
 */

import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

interface ThumbnailRebuildBannerProps {
  count: number;
  onDismiss: () => void;
}

interface RebuildProgressPayload {
  current: number;
  total: number;
  current_file: string;
}

interface RebuildCompletePayload {
  total: number;
}

type Phase = 'idle' | 'running' | 'done';

// ----------------------------------------------------------------
// Styles
// ----------------------------------------------------------------

const viewportStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: '24px',
  left: 'var(--sidebar-width, 192px)',
  right: 'var(--detail-width, 256px)',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
  zIndex: 900,
  pointerEvents: 'none',
};

const bannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '12px 18px',
  background: 'var(--toast-bg)',
  boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border-hover)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
  borderRadius: 'var(--radius-pill)',
  fontFamily: 'var(--font-family)',
  fontSize: '12px',
  minWidth: '320px',
  maxWidth: 'min(720px, calc(100vw - var(--sidebar-width, 192px) - var(--detail-width, 256px) - 32px))',
  pointerEvents: 'auto',
};

const textStyle: React.CSSProperties = {
  flex: 1,
  color: 'var(--text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const baseBtnStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: '12px',
  padding: '6px 10px',
  borderRadius: 'var(--radius-pill)',
  fontFamily: 'var(--font-family)',
  transition: 'background 0.15s ease',
  flexShrink: 0,
};

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const ThumbnailRebuildBanner: React.FC<ThumbnailRebuildBannerProps> = ({
  count,
  onDismiss,
}) => {
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0, filename: '' });
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Listen for rebuild events
  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [];

    unlisteners.push(
      listen<RebuildProgressPayload>('thumbnail_rebuild_progress', (event) => {
        setProgress({
          current: event.payload.current,
          total: event.payload.total,
          filename: event.payload.current_file,
        });
      })
    );

    unlisteners.push(
      listen<RebuildCompletePayload>('thumbnail_rebuild_complete', () => {
        setPhase('done');
      })
    );

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()));
    };
  }, []);

  // Auto-dismiss after done
  useEffect(() => {
    if (phase === 'done') {
      doneTimerRef.current = setTimeout(() => {
        onDismiss();
      }, 1500);
    }
    return () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, [phase, onDismiss]);


  const handleFullRegenerate = () => {
    setPhase('running');
    invoke<string>('regenerate_all_thumbnails')
      .then((msg) => {
        console.info('[ThumbnailRebuildBanner]', msg);
        setPhase('done');
      })
      .catch((err) => {
        console.error('[ThumbnailRebuildBanner] full regenerate error:', err);
        setPhase('idle');
      });
  };

  const handleStart = () => {
    setPhase('running');
    invoke('rebuild_missing_thumbnails').catch((err) => {
      console.error('[ThumbnailRebuildBanner] rebuild error:', err);
    });
  };

  const handleCancel = () => {
    invoke('cancel_rebuild_thumbnails').catch((err) => {
      console.warn('[ThumbnailRebuildBanner] cancel error:', err);
    });
    onDismiss();
  };

  const handleBtnEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'var(--bg-hover)';
  };
  const handleBtnLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = 'transparent';
  };

  return (
    <div style={viewportStyle}>
      <div style={bannerStyle}>
        {phase === 'idle' && (
          <>
            <span style={textStyle}>
              发现 {count} 张图片缺少缩略图
            </span>
            <button
              onClick={handleStart}
              onMouseEnter={handleBtnEnter}
              onMouseLeave={handleBtnLeave}
              style={{ ...baseBtnStyle, color: 'var(--accent)' }}
            >
              补全缺失
            </button>
            <button
              onClick={handleFullRegenerate}
              onMouseEnter={handleBtnEnter}
              onMouseLeave={handleBtnLeave}
              style={{ ...baseBtnStyle, color: 'var(--warning, var(--text-secondary))' }}
              title="清空旧缩略图并按新画质参数（Micro 640 / Q84）全库重生成"
            >
              全量重建
            </button>
            <button
              onClick={onDismiss}
              onMouseEnter={handleBtnEnter}
              onMouseLeave={handleBtnLeave}
              style={{ ...baseBtnStyle, color: 'var(--text-muted)' }}
            >
              忽略
            </button>
          </>
        )}

        {phase === 'running' && (
          <>
            <span style={textStyle}>
              正在生成缩略图 {progress.current}/{progress.total}
              {progress.filename && (
                <span style={{
                  marginLeft: '8px',
                  color: 'var(--text-muted)',
                  maxWidth: '300px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: 'inline-block',
                  verticalAlign: 'bottom',
                }}>
                  · {progress.filename}
                </span>
              )}
            </span>
            <button
              onClick={handleCancel}
              onMouseEnter={handleBtnEnter}
              onMouseLeave={handleBtnLeave}
              style={{ ...baseBtnStyle, color: 'var(--text-muted)' }}
            >
              取消
            </button>
          </>
        )}

        {phase === 'done' && (
          <span style={{ ...textStyle, color: 'var(--success)' }}>
            ✓ 缩略图已全部生成
          </span>
        )}
      </div>
    </div>
  );
};
