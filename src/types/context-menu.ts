/**
 * Gega Gallery — ContextMenu 类型定义
 */

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  icon: string;
  disabled?: boolean;
  shortcut?: string;
  danger?: boolean;
}

export type ContextMenuAction =
  | 'view-full'
  | 'show-in-explorer'
  | 'copy-path'
  | 'paste'
  | 'save-as'
  | 'move-to-trash'
  | 'restore'
  | 'delete';
