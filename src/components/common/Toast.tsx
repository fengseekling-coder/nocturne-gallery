/**
 * Nocturne Gallery — Toast
 *
 * 全局 Toast 通知，固定底部居中。
 * 出入动画：translateY(16px) opacity 0 → translateY(0) opacity 1，150ms ease。
 * 使用 useUiStore。
 */

import React from 'react';
import { useUiStore } from '../../stores/uiStore';

export const Toast: React.FC = () => {
  const toast = useUiStore((s) => s.toast);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: '24px',
        left: 'var(--sidebar-width, 192px)',
        right: 'var(--detail-width, 256px)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        pointerEvents: 'none',
        zIndex: 'var(--z-toast)' as React.CSSProperties['zIndex'],
      }}
    >
      <div
        style={{
          transform: toast.visible ? 'translateY(0)' : 'translateY(16px)',
          opacity: toast.visible ? 1 : 0,
          pointerEvents: toast.visible ? 'auto' : 'none',
          transition: 'opacity var(--transition-default), transform var(--transition-default)',
          backgroundColor: 'var(--toast-bg)',
          boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border-hover)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          padding: '12px 20px',
          borderRadius: 'var(--radius-pill)',
          fontFamily: 'var(--font-family)',
          fontSize: '12px',
          fontWeight: 500,
          color: 'var(--text-primary)',
          whiteSpace: 'nowrap',
          maxWidth: 'min(560px, calc(100vw - var(--sidebar-width, 192px) - var(--detail-width, 256px) - 32px))',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {toast.message}
      </div>
    </div>
  );
};
