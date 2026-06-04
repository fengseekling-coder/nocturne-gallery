/**
 * Nocturne Gallery — WebPage 网页管理页面
 *
 * 收藏网页链接，右键空白处或点击顶部「+」按钮添加
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Bookmark } from '../../types/bookmark';
import { TopToolbar, type TopToolbarAction } from '../canvas/TopToolbar';
import { WebCard } from './WebCard';
import { Icon } from '../common/Icon';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface WebPageProps {
  onAddBookmark: () => void;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const WebPage: React.FC<WebPageProps> = ({ onAddBookmark }) => {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');


  const toolbarActions = useMemo<TopToolbarAction[]>(() => [
    { icon: 'add', title: '收藏网页', onClick: onAddBookmark },
  ], [onAddBookmark]);

  const visibleBookmarks = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    if (!keyword) {
      return bookmarks;
    }
    return bookmarks.filter((bookmark) => (
      [
        bookmark.title,
        bookmark.url,
        bookmark.description,
        bookmark.tags,
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(keyword))
    ));
  }, [bookmarks, searchQuery]);

  // 加载书签列表
  const fetchBookmarks = useCallback(async () => {
    setIsLoading(true);
    try {
      const result = await invoke<Bookmark[]>('get_bookmarks');
      setBookmarks(result);
    } catch (err) {
      console.error('[WebPage] Failed to fetch bookmarks:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBookmarks();
  }, [fetchBookmarks]);

  // 监听书签添加事件
  useEffect(() => {
    const handleBookmarksUpdated = () => {
      fetchBookmarks();
    };

    window.addEventListener('bookmarks-updated', handleBookmarksUpdated);
    return () => {
      window.removeEventListener('bookmarks-updated', handleBookmarksUpdated);
    };
  }, [fetchBookmarks]);

  // 右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.target as HTMLElement;
    // 只在空白处触发（不是卡片上）
    if (!target.closest('[data-bookmark-card]')) {
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
  };

  const handleCloseMenu = () => {
    setContextMenu(null);
  };

  const handleAddFromMenu = () => {
    handleCloseMenu();
    onAddBookmark();
  };

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: 'var(--bg-primary)',
      }}
      onContextMenu={handleContextMenu}
    >
      <TopToolbar
        count={visibleBookmarks.length}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        searchPlaceholder="搜索网页、标签…"
        actions={toolbarActions}
        showZoomControls={false}
      />

      {/* 内容区 */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px',
        }}
      >
        {isLoading && bookmarks.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '200px',
            }}
          >
            <Icon
              name="progress_activity"
              size={48}
              color="var(--text-muted)"
              style={{ animation: 'spin 2s linear infinite' }}
            />
          </div>
        ) : visibleBookmarks.length === 0 ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '300px',
              gap: '16px',
            }}
          >
            <Icon name="language" size={64} color="var(--text-muted)" />
            <p
              style={{
                fontFamily: 'var(--font-family)',
                fontSize: '15px',
                color: 'var(--text-muted)',
                margin: 0,
              }}
            >
              {searchQuery.trim() ? '没有匹配的网页' : '还没有收藏的网页'}
            </p>
            <p
              style={{
                fontFamily: 'var(--font-family)',
                fontSize: '13px',
                color: 'var(--text-secondary)',
                margin: 0,
              }}
            >
              {searchQuery.trim() ? '换个关键词试试' : '右键空白处或点击顶部「+」按钮添加'}
            </p>
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, 200px)',
              gap: 'var(--card-gap)',
              justifyContent: 'start',
              alignContent: 'start',
            }}
          >
            {visibleBookmarks.map((bookmark) => (
              <WebCard key={bookmark.id} bookmark={bookmark} onRefresh={fetchBookmarks} />
            ))}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
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
              minWidth: '140px',
              zIndex: 9999,
            }}
          >
            <button
              onClick={handleAddFromMenu}
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
              <Icon name="add" size={16} />
              收藏网页
            </button>
          </div>
        </>
      )}
    </div>
  );
};
