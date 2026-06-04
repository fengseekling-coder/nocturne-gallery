/**
 * Nocturne Gallery — TagBadge
 *
 * 标签徽章组件。
 * 背景：tag.color 15% opacity（color-mix）。
 * 文字：tag.color 全色。
 * 圆角：9999px（pill）。
 * 可选 onRemove：显示 × 按钮。
 */

import React from 'react';
import type { Tag } from '../../types/media';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface TagBadgeProps {
  tag: Tag;
  onRemove?: (tag: Tag) => void;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const TagBadge: React.FC<TagBadgeProps> = ({ tag, onRemove }) => {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '40px',
        padding: '0 11px',
        /*
         * color-mix 在现代 Chromium 中受支持（Tauri WebView 使用 Chromium）。
         * 背景：tag.color 以 15% 不透明度与透明混合。
         */
        background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)',
        boxShadow: 'inset 0 0 0 1px var(--border)',
        borderRadius: 'var(--radius-small)',
        fontFamily: 'var(--font-family)',
        fontSize: '11px',
        fontWeight: 500,
        letterSpacing: '0.01em',
        color: 'var(--text-secondary)',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span style={{ color: 'var(--text-muted)', fontSize: '11px', lineHeight: 1 }}>#</span>
      <span>{tag.name}</span>
      {onRemove && (
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove(tag);
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
            padding: 0,
            lineHeight: 1,
            fontSize: '12px',
            opacity: 0.8,
            transition: 'opacity var(--transition-default)',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.8'; }}
          title={`移除标签 ${tag.name}`}
        >
          ×
        </button>
      )}
    </span>
  );
};
