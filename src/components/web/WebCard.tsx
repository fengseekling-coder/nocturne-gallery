/**
 * Nocturne Gallery — WebCard 网页卡片组件
 *
 * 双击或用默认浏览器打开网页
 * 右键显示上下文菜单
 */

import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Bookmark } from '../../types/bookmark';
import { useUiStore } from '../../stores/uiStore';
import { Icon } from '../common/Icon';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface WebCardProps {
  bookmark: Bookmark;
  onRefresh: () => void;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const WebCard: React.FC<WebCardProps> = ({ bookmark, onRefresh }) => {
  const [hovered, setHovered] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [faviconError, setFaviconError] = useState(false);
  const showConfirm = useUiStore((s) => s.showConfirm);

  // 从 URL 提取域名显示
  const getDomain = (url: string): string => {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace('www.', '');
    } catch {
      return url;
    }
  };

  const domain = getDomain(bookmark.url);

  // 双击打开浏览器
  const handleDoubleClick = async () => {
    try {
      await invoke('open_url_in_browser', { url: bookmark.url });
    } catch (err) {
      console.error('[WebCard] Failed to open URL:', err);
    }
  };

  // 右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleCloseMenu = () => {
    setContextMenu(null);
  };

  const handleOpenInBrowser = async () => {
    handleCloseMenu();
    try {
      await invoke('open_url_in_browser', { url: bookmark.url });
    } catch (err) {
      console.error('[WebCard] Failed to open URL:', err);
    }
  };

  const handleDelete = async () => {
    handleCloseMenu();
    const confirmed = await showConfirm({
      title: '确认删除',
      message: `确定要删除"${bookmark.title || domain}"吗？`,
      danger: true,
    });
    if (!confirmed) return;
    try {
      await invoke('delete_bookmark', { id: bookmark.id });
      onRefresh();
    } catch (err) {
      console.error('[WebCard] Failed to delete bookmark:', err);
    }
  };

  // 格式化日期
  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  return (
    <div
      data-bookmark-card
      draggable={false}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '200px',
        height: '200px',
        backgroundColor: 'var(--bg-card)',
        borderRadius: 'var(--radius-card)',
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: hovered
          ? 'var(--shadow-md)'
          : 'var(--shadow-sm)',
        transition: 'box-shadow var(--transition-default)',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        padding: '16px',
        border: hovered ? '1px solid var(--border-hover)' : '1px solid transparent',
      }}
    >
      {/* Favicon 图标 */}
      <div
        style={{
          width: '48px',
          height: '48px',
          borderRadius: 'var(--radius-card)',
          backgroundColor: 'var(--bg-hover)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: '12px',
          overflow: 'hidden',
        }}
      >
        {bookmark.faviconUrl && !faviconError ? (
          <img
            src={bookmark.faviconUrl}
            alt=""
            onError={() => setFaviconError(true)}
            style={{
              width: '32px',
              height: '32px',
              objectFit: 'contain',
            }}
          />
        ) : (
          <Icon name="language" size={28} color="var(--text-muted)" />
        )}
      </div>

      {/* 标题 */}
      <p
        style={{
          fontFamily: 'var(--font-family)',
          fontSize: '14px',
          fontWeight: 600,
          color: 'var(--text-primary)',
          margin: '0 0 4px 0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          flex: 1,
        }}
        title={bookmark.title || bookmark.url}
      >
        {bookmark.title || domain}
      </p>

      {/* 域名 */}
      <p
        style={{
          fontFamily: 'var(--font-family)',
          fontSize: '12px',
          fontWeight: 500,
          color: 'var(--text-secondary)',
          margin: '0 0 4px 0',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {domain}
      </p>

      {/* 收藏时间 */}
      <p
        style={{
          fontFamily: 'var(--font-family)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          margin: '0',
        }}
      >
        {formatDate(bookmark.createdAt)}
      </p>

      {/* 上下文菜单 */}
      {contextMenu && (
        <>
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9998,
            }}
            onClick={handleCloseMenu}
          />
          <div
            style={{
              position: 'fixed',
              top: contextMenu.y,
              left: contextMenu.x,
              backgroundColor: 'var(--bg-surface)',
              borderRadius: 'var(--radius-card)',
              boxShadow: 'var(--shadow-lg)',
              padding: '4px 0',
              minWidth: '160px',
              zIndex: 9999,
            }}
          >
            <button
              onClick={handleOpenInBrowser}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-family)',
                fontSize: '13px',
                color: 'var(--text-primary)',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <Icon name="open_in_new" size={16} />
              在浏览器中打开
            </button>
            <button
              onClick={handleDelete}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-family)',
                fontSize: '13px',
                color: 'var(--error)',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <Icon name="delete" size={16} />
              删除收藏
            </button>
          </div>
        </>
      )}
    </div>
  );
};
