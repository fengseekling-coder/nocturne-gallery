/**
 * Nocturne Gallery — ContextMenu
 *
 * 右键上下文菜单，根据当前视图（回收站 / 普通）动态生成菜单项。
 * 非回收站：查看大图、在文件夹中显示、复制路径、另存为、移入回收站、永久删除
 * 回收站：查看大图、在文件夹中显示、复制路径、恢复文件、永久删除
 */

import React from 'react';
import { useContextMenuStore } from '@/stores/contextMenuStore';
import type { ContextMenuAction } from '@/types/context-menu';
import { Icon } from '../Icon';

// ----------------------------------------------------------------
// Menu Items Definition
// ----------------------------------------------------------------

interface MenuItemDef {
  id: ContextMenuAction | 'sep-1' | 'sep-2' | 'sep-3';
  label: string;
  icon: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
}

const MENU_NORMAL: MenuItemDef[] = [
  { id: 'view-full',        label: '查看大图',       icon: 'fullscreen',         shortcut: 'F' },
  { id: 'show-in-explorer', label: '在文件夹中显示', icon: 'folder_open' },
  { id: 'sep-1',            label: '',               icon: '' },
  { id: 'copy-path',        label: '复制路径',       icon: 'content_copy',       shortcut: '⌘C' },
  { id: 'save-as',          label: '另存为...',      icon: 'save_as',            shortcut: '⇧⌘S' },
  { id: 'sep-2',            label: '',               icon: '' },
  { id: 'move-to-trash',    label: '移入回收站',     icon: 'delete',             shortcut: '⌫' },
  { id: 'delete',           label: '永久删除',       icon: 'delete_forever',     shortcut: '⇧⌫', danger: true },
];

const MENU_TRASH: MenuItemDef[] = [
  { id: 'view-full',        label: '查看大图',       icon: 'fullscreen',         shortcut: 'F' },
  { id: 'show-in-explorer', label: '在文件夹中显示', icon: 'folder_open' },
  { id: 'sep-1',            label: '',               icon: '' },
  { id: 'copy-path',        label: '复制路径',       icon: 'content_copy',       shortcut: '⌘C' },
  { id: 'sep-2',            label: '',               icon: '' },
  { id: 'restore',          label: '恢复文件',       icon: 'restore_from_trash' },
  { id: 'delete',           label: '永久删除',       icon: 'delete_forever',     shortcut: '⇧⌫', danger: true },
];

const SEPARATOR_IDS = new Set(['sep-1', 'sep-2', 'sep-3']);

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface ContextMenuProps {
  onAction: (action: ContextMenuAction) => Promise<void>;
  isTrash?: boolean;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const ContextMenu: React.FC<ContextMenuProps> = ({ onAction, isTrash = false }) => {
  const { visible, position, hideMenu, targetFileId } = useContextMenuStore();
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!visible) return;
      if (menuRef.current?.contains(event.target as Node)) return;
      hideMenu();
    };
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape' && visible) hideMenu(); };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [visible, hideMenu]);

  if (!visible || !targetFileId) return null;

  const items = isTrash ? MENU_TRASH : MENU_NORMAL;

  const handleMenuItemClick = async (action: ContextMenuAction) => {
    await onAction(action);
    hideMenu();
  };

  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: position.x,
    top: position.y,
    zIndex: 9999,
    backgroundColor: 'var(--bg-elevated)',
    borderRadius: 'var(--radius-default)',
    padding: '4px',
    minWidth: '200px',
    boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  };

  return (
    <div ref={menuRef} style={menuStyle} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, idx) => {
        if (SEPARATOR_IDS.has(item.id)) {
          return (
            <div
              key={`${item.id}-${idx}`}
              style={{ height: '1px', backgroundColor: 'var(--border)', margin: '4px 0' }}
            />
          );
        }

        const isDisabled = item.disabled;

        return (
          <button
            key={item.id}
            disabled={isDisabled}
            onClick={() => handleMenuItemClick(item.id as ContextMenuAction)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '7px 10px',
              borderRadius: '6px',
              border: 'none',
              backgroundColor: 'transparent',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              opacity: isDisabled ? 0.4 : 1,
              transition: 'background-color 0.1s',
              textAlign: 'left',
              width: '100%',
              fontFamily: 'var(--font-family)',
            }}
            onMouseEnter={(e) => {
              if (!isDisabled) {
                const bg = item.danger
                  ? 'color-mix(in srgb, var(--error) 12%, transparent)'
                  : 'var(--bg-hover)';
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = bg;
              }
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent';
            }}
          >
            <Icon
              name={item.icon}
              size={15}
              color={item.danger ? 'var(--error)' : 'var(--text-secondary)'}
            />
            <span style={{ flex: 1, fontSize: '13px', color: item.danger ? 'var(--error)' : 'var(--text-primary)' }}>
              {item.label}
            </span>
            {item.shortcut && (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {item.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
