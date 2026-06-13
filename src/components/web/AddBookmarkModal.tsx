/**
 * Gega Gallery — 添加网页书签弹窗
 */

import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUiStore } from '../../stores/uiStore';

interface AddBookmarkModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AddBookmarkModal: React.FC<AddBookmarkModalProps> = ({ isOpen, onClose }) => {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const showConfirm = useUiStore((s) => s.showConfirm);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    if (!url.trim()) {
      await showConfirm({
        title: '提示',
        message: '请输入网址',
        confirmText: '确定',
        cancelText: '',
      });
      return;
    }

    let validatedUrl = url.trim();
    if (!validatedUrl.startsWith('http://') && !validatedUrl.startsWith('https://')) {
      validatedUrl = 'https://' + validatedUrl;
    }

    try {
      await invoke('add_bookmark', {
        url: validatedUrl,
        title: title.trim() || null,
        description: null,
        tags: tags.trim() || null,
      });
      setUrl('');
      setTitle('');
      setTags('');
      onClose();
      // 触发页面刷新事件
      window.dispatchEvent(new CustomEvent('bookmarks-updated'));
    } catch (err) {
      console.error('[App] Failed to add bookmark:', err);
      await showConfirm({
        title: '添加失败',
        message: (err as Error).message,
        confirmText: '确定',
        cancelText: '',
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSubmit();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'var(--overlay-backdrop)',
          zIndex: 9998,
        }}
        onClick={onClose}
      />

      {/* Modal */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-card)',
          padding: '24px',
          minWidth: '400px',
          zIndex: 9999,
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-family)',
            fontSize: '20px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            margin: '0 0 20px 0',
          }}
        >
          收藏网页
        </h2>

        {/* URL 输入框 */}
        <div style={{ marginBottom: '16px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            网址 *
          </label>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="https://example.com"
            autoFocus
            style={{
              width: '100%',
              height: '40px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 标题输入框 */}
        <div style={{ marginBottom: '16px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            标题（可选）
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="自定义标题"
            style={{
              width: '100%',
              height: '40px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 标签输入框 */}
        <div style={{ marginBottom: '20px' }}>
          <label
            style={{
              display: 'block',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: '8px',
            }}
          >
            标签（可选）
          </label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="设计、灵感、工具"
            style={{
              width: '100%',
              height: '40px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'var(--bg-primary)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* 按钮组 */}
        <div
          style={{
            display: 'flex',
            gap: '12px',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={onClose}
            style={{
              height: '36px',
              padding: '0 16px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              backgroundColor: 'transparent',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              cursor: 'pointer',
            }}
          >
            取消
          </button>
          <button
            onClick={handleSubmit}
            style={{
              height: '36px',
              padding: '0 20px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            收藏
          </button>
        </div>
      </div>
    </>
  );
};