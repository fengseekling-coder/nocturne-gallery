/**
 * Gega Gallery — WindowControls
 *
 * 根据操作系统自动切换窗口控制按钮样式：
 * - macOS：左侧红绿灯圆形按钮
 * - Windows / Linux：右侧 Windows 11 风格矩形按钮
 */

import React, { useCallback, useMemo, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { detectUiPlatform } from '../../lib/platform';
import { WinClose, WinMax, WinMin } from './Icon';

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface WindowControlsProps {
  /** 覆盖自动检测的平台（可选） */
  platform?: 'macos' | 'windows' | 'linux';
  /** 距离顶部的偏移（默认 0） */
  topOffset?: number;
  /** 距离右侧的偏移（Windows，默认 0） */
  rightOffset?: number;
  /** 距离左侧的偏移（macOS，默认 0） */
  leftOffset?: number;
  /** macOS 红绿灯嵌入 flex 行（如侧栏顶栏），非 absolute */
  inline?: boolean;
}

// ----------------------------------------------------------------
// macOS traffic lights
// ----------------------------------------------------------------

interface MacButtonsProps {
  topOffset: number;
  leftOffset: number;
  /** 嵌入侧栏标题栏时使用，不用 absolute */
  inline?: boolean;
}

const MacButtons: React.FC<MacButtonsProps> = ({ topOffset, leftOffset, inline = false }) => {
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

  const circleBase: React.CSSProperties & { WebkitAppRegion?: 'no-drag' } = {
    width: 12,
    height: 12,
    borderRadius: '50%',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    WebkitAppRegion: 'no-drag',
    opacity: hovered ? 1 : 0.85,
    transition: 'opacity 0.12s',
  };

  return (
    <div
      style={inline ? {
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexShrink: 0,
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties & { WebkitAppRegion?: string } : {
        position: 'absolute',
        top: topOffset,
        left: leftOffset,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        zIndex: 100,
        padding: '12px 16px',
      }}
    >
      <button
        type="button"
        onClick={handleClose}
        onMouseEnter={() => setHovered('close')}
        onMouseLeave={() => setHovered(null)}
        title="关闭"
        style={{
          ...circleBase,
          backgroundColor: 'var(--traffic-light-close)',
          boxShadow: hovered === 'close' ? 'var(--shadow-sm)' : undefined,
        }}
      />
      <button
        type="button"
        onClick={handleMinimize}
        onMouseEnter={() => setHovered('minimize')}
        onMouseLeave={() => setHovered(null)}
        title="最小化"
        style={{
          ...circleBase,
          backgroundColor: 'var(--traffic-light-minimize)',
          boxShadow: hovered === 'minimize' ? 'var(--shadow-sm)' : undefined,
        }}
      />
      <button
        type="button"
        onClick={handleToggleMaximize}
        onMouseEnter={() => setHovered('maximize')}
        onMouseLeave={() => setHovered(null)}
        title="全屏"
        style={{
          ...circleBase,
          backgroundColor: 'var(--traffic-light-maximize)',
          boxShadow: hovered === 'maximize' ? 'var(--shadow-sm)' : undefined,
        }}
      />
    </div>
  );
};

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

export const WindowControls: React.FC<WindowControlsProps> = ({
  platform: platformOverride,
  topOffset = 0,
  rightOffset = 0,
  leftOffset = 0,
  inline = false,
}) => {
  const platform = useMemo(() => detectUiPlatform(platformOverride), [platformOverride]);

  if (platform === 'macos') {
    return <MacButtons topOffset={topOffset} leftOffset={leftOffset} inline={inline} />;
  }

  return <WindowsButtons topOffset={topOffset} rightOffset={rightOffset} />;
};
