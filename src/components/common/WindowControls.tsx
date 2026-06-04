/**
 * Nocturne Gallery — WindowControls
 *
 * 根据操作系统自动切换窗口控制按钮样式：
 * - macOS：红绿灯圆形按钮（保持现有）
 * - Windows：Windows 11 风格矩形按钮
 * - Linux：同 Windows 风格，关闭 hover 用 var(--error)
 */

import React, { useCallback, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WinClose, WinMax, WinMin } from './Icon';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface WindowControlsProps {
  /** 覆盖自动检测的平台（可选） */
  platform?: 'macos' | 'windows' | 'linux';
  /** 距离顶部的偏移（默认 16px） */
  topOffset?: number;
  /** 距离右侧的偏移（默认 16px） */
  rightOffset?: number;
}

// ----------------------------------------------------------------
// Windows 11 Style Buttons
// ----------------------------------------------------------------

interface WindowsButtonsProps {
  topOffset: number;
  rightOffset: number;
}

const WindowsButtons: React.FC<WindowsButtonsProps> = ({ topOffset, rightOffset }) => {
  const [hovered, setHovered] = useState<string | null>(null);

  const handleMinimize = useCallback(async () => {
    try { await getCurrentWindow().minimize(); } catch (err) { console.error('[WindowControls] Minimize failed:', err); }
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try { await getCurrentWindow().toggleMaximize(); } catch (err) { console.error('[WindowControls] ToggleMaximize failed:', err); }
  }, []);

  const handleClose = useCallback(async () => {
    try { await getCurrentWindow().close(); } catch (err) { console.error('[WindowControls] Close failed:', err); }
  }, []);

  const baseBtn: React.CSSProperties & { WebkitAppRegion?: 'no-drag' } = {
    width: 36,
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    backgroundColor: 'transparent',
    transition: 'background 0.12s',
    WebkitAppRegion: 'no-drag',
  };

  return (
    <div style={{ position: 'absolute', top: topOffset, right: rightOffset, display: 'flex', flexDirection: 'row', zIndex: 100 }}>
      {/* 最小化 */}
      <button
        onClick={handleMinimize}
        onMouseEnter={() => setHovered('minimize')}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...baseBtn,
          backgroundColor: hovered === 'minimize' ? 'var(--bg-hover)' : 'transparent',
        }}
        title="最小化"
      >
        <span style={{ color: hovered === 'minimize' ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 0 }}>
          <WinMin />
        </span>
      </button>

      {/* 最大化 */}
      <button
        onClick={handleToggleMaximize}
        onMouseEnter={() => setHovered('maximize')}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...baseBtn,
          backgroundColor: hovered === 'maximize' ? 'var(--bg-hover)' : 'transparent',
        }}
        title="最大化"
      >
        <span style={{ color: hovered === 'maximize' ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 0 }}>
          <WinMax />
        </span>
      </button>

      {/* 关闭 */}
      <button
        onClick={handleClose}
        onMouseEnter={() => setHovered('close')}
        onMouseLeave={() => setHovered(null)}
        style={{
          ...baseBtn,
          backgroundColor: hovered === 'close' ? 'var(--windows-close-hover)' : 'transparent',
        }}
        title="关闭"
      >
        <span style={{ color: hovered === 'close' ? 'var(--overlay-text-strong)' : 'var(--text-muted)', lineHeight: 0 }}>
          <WinClose />
        </span>
      </button>
    </div>
  );
};

// ----------------------------------------------------------------
// Main Component
// ----------------------------------------------------------------

export const WindowControls: React.FC<WindowControlsProps> = ({ topOffset = 0, rightOffset = 0 }) => {
  return <WindowsButtons topOffset={topOffset} rightOffset={rightOffset} />;
};
