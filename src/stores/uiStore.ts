/**
 * Gega Gallery — UI Store
 *
 * 管理界面布局状态（侧边栏、详情面板、导航、Toast）。
 * 主题状态使用 SQLite 持久化（user_preferences 表），启动时异步加载并应用到 document。
 */

import { create } from 'zustand';
import type { ToastState } from '../types/ui';
import { getPreference, setPreference } from '../utils/preferences';
import { notifyGridZoomActivity } from '../lib/gridZoomBus';

export interface CanvasAttachmentPreviewItem {
  id: string;
  filename: string;
  src: string | null;
}

export interface CanvasAttachmentPreviewState {
  items: CanvasAttachmentPreviewItem[];
  activeId: string | null;
  ownerMediaId: string | null;
}

// ----------------------------------------------------------------
// State shape
// ----------------------------------------------------------------

interface ConfirmModalState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  resolve: ((confirmed: boolean) => void) | null;
}

interface UiState {
  isSidebarCollapsed: boolean;
  isDetailPanelOpen: boolean;
  activeNav: string;
  sourceFolder: string | null;
  theme: 'dark' | 'light';
  toast: ToastState;
  columnCount: number; // 通用布局列数
  isAIMode: boolean; // AI 锁定模式
  metaMode: 'hover' | 'always' | 'off'; // 卡片元信息展示模式
  // 顶部标签 Tab 状态
  activeTab: string;
  canvasAttachmentPreview: CanvasAttachmentPreviewState | null;
  tabs: Record<string, string[]>; // 各页面对应的标签列表
  // 确认弹窗状态
  confirmModal: ConfirmModalState;
}

// ----------------------------------------------------------------
// Actions shape
// ----------------------------------------------------------------

interface UiActions {
  setActiveNav: (id: string) => void;
  setSourceFolder: (folder: string | null) => void;
  openDetailPanel: () => void;
  closeDetailPanel: () => void;
  toggleSidebar: () => void;
  setTheme: (theme: 'dark' | 'light') => Promise<void>;
  toggleTheme: () => Promise<void>;
  showToast: (message: string) => void;
  hideToast: () => void;
  setColumnCount: (count: number) => Promise<void>;
  toggleAIMode: () => Promise<void>;
  setMetaMode: (mode: 'hover' | 'always' | 'off') => void;
  // 标签 Tab 相关 action
  setActiveTab: (tab: string) => void;
  resetTabsForNav: (nav: string) => void;
  addTab: (nav: string, tabName: string) => void;
  removeTab: (nav: string, tabName: string) => void;
  renameTab: (nav: string, oldName: string, newName: string) => void;
  openCanvasAttachmentPreview: (preview: CanvasAttachmentPreviewState) => void;
  closeCanvasAttachmentPreview: () => void;
  setCanvasAttachmentPreviewActive: (id: string) => void;
  // 确认弹窗相关 action
  showConfirm: (options: {
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
  hideConfirm: () => void;
  resolveConfirm: (confirmed: boolean) => void;
}

// ----------------------------------------------------------------
// 初始值（同步默认值，异步加载后会覆盖）
// ----------------------------------------------------------------

const DEFAULT_THEME: 'dark' | 'light' = 'dark';
const DEFAULT_COLUMN_COUNT = 4;

// 模块级 toast 定时器，避免多条 toast 并发时 timer 相互干扰
let _toastTimer: ReturnType<typeof setTimeout> | null = null;

// 每个导航的内置（不可删除）Tab 列表
const BUILTIN_TABS: Record<string, string[]> = {
  'library':    ['全部', '图片', '视频'],
  'ai-prompts': ['全部', '已填写', '未填写'],
  'projects':   ['全部'],
  'web-pages':  ['全部'],
  'trash':      ['全部'],
};

// 将自定义分组（非内置、非 '+ 添加分组'）持久化到 SQLite
function _persistCustomGroups(tabsState: Record<string, string[]>): void {
  const customGroups: Record<string, string[]> = {};
  for (const [nav, navTabs] of Object.entries(tabsState)) {
    const builtin = BUILTIN_TABS[nav] || ['全部'];
    customGroups[nav] = navTabs.filter(t => !builtin.includes(t) && t !== '+ 添加分组');
  }
  setPreference('custom_groups', JSON.stringify(customGroups));
}

// ----------------------------------------------------------------
// Store
// ----------------------------------------------------------------

export const useUiStore = create<UiState & UiActions>()((set, get) => {
  // 各页面默认标签列表
  const defaultTabs: Record<string, string[]> = {
    'library': ['全部', '图片', '视频', '+ 添加分组'],
    'ai-prompts': ['全部', '已填写', '未填写', '+ 添加分组'],
    'projects': ['全部', '+ 添加分组'],
    'web-pages': ['全部', '+ 添加分组'],
    'trash': ['全部'],
  };

  return {
    // ---- initial state ----
    isSidebarCollapsed: false,
    isDetailPanelOpen: true,
    activeNav: 'library',
    sourceFolder: '灵感库',   // 与初始 activeNav: 'library' 保持一致，防止启动时无过滤条件导致跨文件夹串数据
    theme: DEFAULT_THEME,
    toast: { visible: false, message: '' },
    columnCount: DEFAULT_COLUMN_COUNT,
    isAIMode: false,
    metaMode: 'hover',
    activeTab: '全部',
    canvasAttachmentPreview: null,
    tabs: defaultTabs,
    // 确认弹窗初始状态
    confirmModal: {
      isOpen: false,
      title: '',
      message: '',
      confirmText: '确定',
      cancelText: '取消',
      danger: false,
      resolve: null,
    },

    // ----------------------------------------------------------------
    setActiveNav: (id) => {
      // 切换导航项时自动设置来源文件夹过滤
      // 导航名 → 本地文件夹名 映射:
      // - 灵感库 (library)     → 灵感库
      // - AI 提示词库 (ai-prompts) → AI 提示词库
      // - 作品集管理 (projects) → 作品集
      // - 回收站 (trash)       → 回收站
      // - 网页管理 (web-pages) → 无对应文件夹 (独立数据库表)
      const folderMap: Record<string, string | null> = {
        'library': '灵感库',
        'ai-prompts': null,
        'projects': '作品集',
        'trash': '回收站',
        'web-pages': null,
      };
      set({ activeNav: id, sourceFolder: folderMap[id] || null, activeTab: '全部', canvasAttachmentPreview: null });
    },

    // ----------------------------------------------------------------
    setSourceFolder: (folder) => set({ sourceFolder: folder }),

    // ----------------------------------------------------------------
    openDetailPanel: () => set({ isDetailPanelOpen: true }),

    // ----------------------------------------------------------------
    closeDetailPanel: () => set({ isDetailPanelOpen: false }),

    // ----------------------------------------------------------------
    toggleSidebar: () =>
      set((state) => ({ isSidebarCollapsed: !state.isSidebarCollapsed })),

    // ----------------------------------------------------------------
    setTheme: async (theme) => {
      if (typeof window !== 'undefined') {
        document.documentElement.setAttribute('data-theme', theme);
      }
      set({ theme }); // 立即更新 UI
      setPreference('theme', theme); // 异步持久化
    },

    // ----------------------------------------------------------------
    toggleTheme: async () => {
      const currentTheme = get().theme;
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      if (typeof window !== 'undefined') {
        document.documentElement.setAttribute('data-theme', newTheme);
      }
      await setPreference('theme', newTheme);
      set({ theme: newTheme });
    },

    // ----------------------------------------------------------------
    showToast: (message) => {
      // 修复：[P2] 清除上一条 toast 的残留 timer，防止后发 toast 被前一个 timer 提前隐藏
      if (_toastTimer !== null) clearTimeout(_toastTimer);
      set({ toast: { visible: true, message } });
      _toastTimer = setTimeout(() => {
        _toastTimer = null;
        useUiStore.getState().hideToast();
      }, 3000);
    },

    // ----------------------------------------------------------------
    hideToast: () => set({ toast: { visible: false, message: '' } }),

    // ----------------------------------------------------------------
    setColumnCount: async (count) => {
      const clampedCount = Math.max(2, Math.min(6, count));
      if (clampedCount === get().columnCount) return;
      notifyGridZoomActivity();
      set({ columnCount: clampedCount });
      setPreference('columnCount', clampedCount.toString());
    },

    // ----------------------------------------------------------------
    toggleAIMode: async () => {
      const newMode = !get().isAIMode;
      set({ isAIMode: newMode });
      await setPreference('is_ai_mode', String(newMode));
    },

    // ----------------------------------------------------------------
    setMetaMode: (mode) => set({ metaMode: mode }),

    // ----------------------------------------------------------------
    // 标签 Tab 相关 actions
    setActiveTab: (tab) => set({ activeTab: tab }),

    resetTabsForNav: (nav) => {
      const defaultTabs: Record<string, string[]> = {
        'library': ['全部', '图片', '视频', '+ 添加分组'],
        'ai-prompts': ['全部', '已填写', '未填写', '+ 添加分组'],
        'projects': ['全部', '+ 添加分组'],
        'web-pages': ['全部', '+ 添加分组'],
        'trash': ['全部'],
      };
      set({ tabs: { ...get().tabs, [nav]: defaultTabs[nav] || ['全部'] }, activeTab: '全部' });
    },

    addTab: (nav, tabName) => {
      const currentTabs = get().tabs[nav] || ['全部'];
      const newTabs = currentTabs.filter((t) => t !== '+ 添加分组');
      newTabs.push(tabName, '+ 添加分组');
      const newTabsState = { ...get().tabs, [nav]: newTabs };
      set({ tabs: newTabsState });
      _persistCustomGroups(newTabsState);
    },

    removeTab: (nav, tabName) => {
      const currentTabs = get().tabs[nav] || ['全部'];
      const newTabs = currentTabs.filter((t) => t !== tabName);
      const newTabsState = { ...get().tabs, [nav]: newTabs };
      // 如果删除的是当前激活的 Tab，回退到"全部"
      const newActiveTab = get().activeTab === tabName ? '全部' : get().activeTab;
      set({ tabs: newTabsState, activeTab: newActiveTab });
      _persistCustomGroups(newTabsState);
    },

    renameTab: (nav, oldName, newName) => {
      const currentTabs = get().tabs[nav] || ['全部'];
      if (!currentTabs.includes(oldName) || currentTabs.includes(newName)) return;
      const newTabs = currentTabs.map((t) => (t === oldName ? newName : t));
      const newTabsState = { ...get().tabs, [nav]: newTabs };
      // 如果重命名的是当前激活的 Tab，同步更新 activeTab
      const newActiveTab = get().activeTab === oldName ? newName : get().activeTab;
      set({ tabs: newTabsState, activeTab: newActiveTab });
      _persistCustomGroups(newTabsState);
    },

    openCanvasAttachmentPreview: (preview) => {
      set({ canvasAttachmentPreview: preview });
    },

    closeCanvasAttachmentPreview: () => {
      set({ canvasAttachmentPreview: null });
    },

    setCanvasAttachmentPreviewActive: (id) => {
      const current = get().canvasAttachmentPreview;
      if (!current) return;
      set({
        canvasAttachmentPreview: {
          ...current,
          activeId: id,
        },
      });
    },

    // ----------------------------------------------------------------
    // 确认弹窗相关 actions
    showConfirm: (options) => {
      return new Promise<boolean>((resolve) => {
        set({
          confirmModal: {
            isOpen: true,
            title: options.title,
            message: options.message,
            confirmText: options.confirmText ?? '确定',
            cancelText: options.cancelText ?? '取消',
            danger: options.danger ?? false,
            resolve,
          },
        });
      });
    },

    hideConfirm: () => {
      const { confirmModal } = get();
      // 如果关闭时没有调用 resolve，则视为取消
      if (confirmModal.resolve) {
        confirmModal.resolve(false);
      }
      set({
        confirmModal: {
          isOpen: false,
          title: '',
          message: '',
          confirmText: '确定',
          cancelText: '取消',
          danger: false,
          resolve: null,
        },
      });
    },

    resolveConfirm: (confirmed) => {
      const { confirmModal } = get();
      if (confirmModal.resolve) {
        confirmModal.resolve(confirmed);
      }
      set({
        confirmModal: {
          isOpen: false,
          title: '',
          message: '',
          confirmText: '确定',
          cancelText: '取消',
          danger: false,
          resolve: null,
        },
      });
    },
  };
});

// ----------------------------------------------------------------
// 异步初始化：从 SQLite 加载用户偏好，覆盖默认值
// ----------------------------------------------------------------

export async function initPreferences(): Promise<void> {
  try {
    const theme = await getPreference('theme', DEFAULT_THEME) as 'dark' | 'light';
    const columnCountStr = await getPreference('columnCount', String(DEFAULT_COLUMN_COUNT));
    const columnCount = parseInt(columnCountStr, 10) || DEFAULT_COLUMN_COUNT;
    const isAIModeStr = await getPreference('is_ai_mode', 'false');
    const isAIMode = isAIModeStr === 'true';

    // 加载持久化的自定义分组，合并到内置 Tab 列表
    const customGroupsStr = await getPreference('custom_groups', '{}');
    let customGroups: Record<string, string[]> = {};
    try { customGroups = JSON.parse(customGroupsStr); } catch { /* ignore */ }
    const mergedTabs: Record<string, string[]> = {};
    for (const [nav, builtinList] of Object.entries(BUILTIN_TABS)) {
      const custom = customGroups[nav] || [];
      mergedTabs[nav] = [...builtinList, ...custom];
    }

    if (typeof window !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    useUiStore.setState({ theme, columnCount: Math.max(2, Math.min(6, columnCount)), isAIMode, tabs: mergedTabs });
  } catch (err) {
    console.warn('[uiStore] initPreferences failed, using defaults:', err);
  }
}
