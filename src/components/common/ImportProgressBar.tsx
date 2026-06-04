import React, { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Icon } from './Icon';

interface ProgressPayload {
  current: number;
  total: number;
  filename: string;
}

interface CompletePayload {
  total: number;
}

const isValidProgress = (payload: ProgressPayload): boolean => payload.total > 0 && payload.current >= 0;

export const ImportProgressBar: React.FC = () => {
  const [visible, setVisible] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);
  const [current, setCurrent] = useState(0);
  const [total, setTotal] = useState(0);
  const [filename, setFilename] = useState('');

  useEffect(() => {
    let timer: ReturnType<typeof window.setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const resetState = () => {
      setVisible(false);
      setFadeOut(false);
      setCurrent(0);
      setTotal(0);
      setFilename('');
    };

    const hideProgress = () => {
      clearTimer();
      setFadeOut(true);
      timer = window.setTimeout(() => {
        resetState();
        timer = null;
      }, 400);
    };

    const unlistenProgress = listen<ProgressPayload>('import_progress', (event) => {
      const payload = event.payload;
      if (!isValidProgress(payload)) {
        if (import.meta.env.DEV) {
          console.warn('[ImportProgressBar] Ignoring invalid import progress:', payload);
        }
        return;
      }

      clearTimer();
      setVisible(true);
      setFadeOut(false);
      setCurrent(payload.current);
      setTotal(payload.total);
      setFilename(payload.filename);
    });

    const unlistenComplete = listen<CompletePayload>('import_complete', (event) => {
      clearTimer();

      const completedTotal = event.payload.total;
      if (completedTotal <= 0) {
        resetState();
        return;
      }

      setCurrent(completedTotal);
      setTotal(completedTotal);
      timer = window.setTimeout(() => {
        hideProgress();
      }, 1000);
    });

    return () => {
      unlistenProgress.then((u) => u());
      unlistenComplete.then((u) => u());
      clearTimer();
    };
  }, []);

  if (!visible) return null;

  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  const isPending = total > 0 && current === 0;
  const isDone = current > 0 && current === total;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: '24px',
        left: 'var(--sidebar-width, 192px)',
        right: 'var(--detail-width, 256px)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10000,
        pointerEvents: 'none',
        transition: 'opacity 0.4s ease',
        opacity: fadeOut ? 0 : 1,
      }}
    >
      <div
        style={{
          backgroundColor: 'var(--toast-bg)',
          borderRadius: 'var(--radius-pill)',
          boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border-hover)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          padding: '12px 18px',
          width: 'min(420px, calc(100vw - var(--sidebar-width, 192px) - var(--detail-width, 256px) - 32px))',
          fontFamily: 'var(--font-family)',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {!isDone && (
              <div style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                backgroundColor: 'var(--accent)',
                flexShrink: 0,
                animation: 'pulse 1.4s ease-in-out infinite',
              }} />
            )}
            {isDone && (
              <Icon name="check_circle" size={14} fill={1} color="var(--accent)" />
            )}
            <span style={{ color: 'var(--text-primary)', fontSize: '12px', fontWeight: 500 }}>
              {isDone ? '导入完成' : isPending ? '正在准备导入' : '正在导入素材'}
            </span>
          </div>
          <span style={{
            color: 'var(--accent)',
            fontSize: '12px',
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            fontFamily: 'var(--font-family)',
          }}>
            {current}/{total}
          </span>
        </div>

        {!isDone && (
          <span style={{
            color: 'var(--text-muted)',
            fontSize: '11px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {filename}
          </span>
        )}

        <div style={{
          height: '3px',
          borderRadius: 'var(--radius-pill)',
          backgroundColor: 'var(--bg-hover)',
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            borderRadius: 'var(--radius-pill)',
            backgroundColor: 'var(--accent)',
            width: `${percentage}%`,
            transition: 'width 0.25s ease',
            boxShadow: '0 0 8px var(--accent-glow)',
          }} />
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.85); }
        }
      `}</style>
    </div>
  );
};
