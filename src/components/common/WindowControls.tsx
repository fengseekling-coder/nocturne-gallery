/**
 * Gega Gallery — WindowControls（macOS 红绿灯）
 */

import React, { useCallback, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

interface WindowControlsProps {
  /** 距离顶部的偏移（默认 0） */
  topOffset?: number;
  /** 距离左侧的偏移（默认 0） */
  leftOffset?: number;
  /** 嵌入 flex 行（如侧栏顶栏），非 absolute */
  inline?: boolean;
}

export const WindowControls: React.FC<WindowControlsProps> = ({
  topOffset = 0,
  leftOffset = 0,
  inline = false,
}) => {
  const [hovered, setHovered] = useState<string | null>(null);

  const handleMinimize = useCallback(async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error('[WindowControls] Minimize failed:', err);
    }
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch (err) {
      console.error('[WindowControls] ToggleMaximize failed:', err);
    }
  }, []);

  const handleClose = useCallback(async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.error('[WindowControls] Close failed:', err);
    }
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
      style={
        inline
          ? ({
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              flexShrink: 0,
              WebkitAppRegion: 'no-drag',
            } as React.CSSProperties & { WebkitAppRegion?: string })
          : {
              position: 'absolute',
              top: topOffset,
              left: leftOffset,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              zIndex: 100,
              padding: '12px 16px',
            }
      }
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