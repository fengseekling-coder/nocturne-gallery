/**
 * Gega Gallery — ContextMenu Store
 *
 * 管理右键菜单的显示状态和目标文件
 */

import { create } from 'zustand';

interface ContextMenuState {
  visible: boolean;
  position: { x: number; y: number };
  targetFileId: string | null;
}

interface ContextMenuActions {
  showMenu: (x: number, y: number, fileId: string) => void;
  hideMenu: () => void;
  setTargetFile: (fileId: string | null) => void;
}

export const useContextMenuStore = create<ContextMenuState & ContextMenuActions>()((set) => ({
  visible: false,
  position: { x: 0, y: 0 },
  targetFileId: null,

  showMenu: (x, y, fileId) => set({
    visible: true,
    position: { x, y },
    targetFileId: fileId,
  }),

  hideMenu: () => set({ visible: false, targetFileId: null }),

  setTargetFile: (fileId) => set({ targetFileId: fileId }),
}));
