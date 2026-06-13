import React from 'react';
import { isTauriRuntime } from '../../lib/platform';

/**
 * 开发时若用浏览器 / Cursor 内置预览打开 localhost:1420，不是桌面软件。
 */
export const DevBrowserNotice: React.FC = () => {
  if (!import.meta.env.DEV || isTauriRuntime()) {
    return null;
  }

  return (
    <div
      data-testid="dev-browser-notice"
      role="alertdialog"
      aria-labelledby="dev-browser-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'var(--overlay-preview-backdrop)',
        fontFamily: 'var(--font-family)',
      }}
    >
      <div
        style={{
          maxWidth: 520,
          padding: '28px 32px',
          borderRadius: 'var(--radius-card)',
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          color: 'var(--text-primary)',
          textAlign: 'left',
          lineHeight: 1.55,
          fontSize: 14,
        }}
      >
        <h1
          id="dev-browser-title"
          style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 600, color: 'var(--overlay-text-strong)' }}
        >
          这是网页预览，不是 Gega Gallery 软件
        </h1>
        <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)' }}>
          地址栏里的 <code style={{ color: 'var(--accent)' }}>localhost:1420</code> 仅供桌面程序内嵌加载界面。
          选文件夹、读写库等能力<strong style={{ color: 'var(--overlay-text-strong)' }}>只在桌面窗口</strong>里可用。
        </p>
        <p style={{ margin: '0 0 8px', fontWeight: 600 }}>请在本机终端执行：</p>
        <pre
          style={{
            margin: '0 0 16px',
            padding: '12px 14px',
            borderRadius: 'var(--radius-default)',
            background: 'var(--bg-mode-deep)',
            border: '1px solid var(--border)',
            fontSize: 13,
            overflow: 'auto',
            color: 'var(--accent)',
          }}
        >
          {`cd nocturne-gallery\nnpm run tauri:dev`}
        </pre>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
          等待<strong style={{ color: 'var(--text-primary)' }}>无浏览器地址栏</strong>的独立窗口（标题
          Gega Gallery）出现后再使用。不要运行 <code>npm run dev</code> 后手动打开浏览器。
        </p>
      </div>
    </div>
  );
};
