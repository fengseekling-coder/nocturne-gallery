/**
 * Nocturne Gallery — Sidebar 导航栏
 *
 * 简洁扁平结构：4 个主导航项 + 底部 2 个功能按钮
 * 布局：顶部 Logo 固定，中间导航 flex:1，底部按钮区固定
 * 背景 var(--bg-surface)，与 Canvas 的 var(--bg-primary) 形成色差
 * 激活状态：胶囊样式 (var(--accent) 背景 + 白色文字)
 */

import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useUiStore } from '../../stores/uiStore';
import { useMediaStore } from '../../stores/mediaStore';
import { GegaLogo } from '../common/GegaLogo';
import { Icon } from '../common/Icon';

// Tweaks 色板是用户可选的品牌色配置值，不是组件样式色。
const ACCENT_SWATCHES = [
  { color: '#90FF21', label: '荧光绿（默认）' },
  { color: '#00E5B0', label: '青绿' },
  { color: '#FFB800', label: '琥珀' },
  { color: '#FF4D6A', label: '玫红' },
  { color: '#7B8CFF', label: '薰衣草' },
  { color: '#F8F8F5', label: '月白' },
];
const DEFAULT_ACCENT_SWATCH = ACCENT_SWATCHES[0].color;
const BG_MODE_TOKEN_VALUES = {
  deep: 'var(--bg-mode-deep)',
  default: 'var(--bg-mode-default)',
  light: 'var(--bg-mode-light)',
} as const;
const BG_MODE_LABELS = {
  deep: '更深',
  default: '默认',
  light: '浅黑',
} as const;

const GROUP_DOT_COLORS = [
  'var(--tag-red)',
  'var(--tag-yellow)',
  'var(--tag-green)',
  'var(--tag-purple)',
  'var(--tag-blue)',
  'var(--tag-orange)',
];

// 支持分组的导航页面
const GROUP_NAVS = ['library', 'ai-prompts', 'projects'];
// 每个导航的内置（不可删除）Tab
const BUILTIN_TABS: Record<string, string[]> = {
  'library':    ['全部', '图片', '视频'],
  'ai-prompts': ['全部', '已填写', '未填写'],
  'projects':   ['全部'],
};

// ----------------------------------------------------------------
// 导航项定义（扁平结构，无子菜单）
// ----------------------------------------------------------------

interface NavItem {
  id: string;
  label: string;
  icon: string;
  targetFolder?: string; // 拖放目标文件夹名
  acceptsDrop: boolean;  // 是否接受拖放
}

const NAV_ITEMS: NavItem[] = [
  { id: 'library', label: '灵感库', icon: 'grid_view', targetFolder: '灵感库', acceptsDrop: true },
  { id: 'ai-prompts', label: 'AI 提示词库', icon: 'auto_awesome', acceptsDrop: false }, // 筛选视图，不接受拖放
  { id: 'projects', label: '作品集管理', icon: 'folder_open', targetFolder: '作品集', acceptsDrop: true },
  { id: 'web-pages', label: '网页管理', icon: 'language', acceptsDrop: false },
  { id: 'trash', label: '回收站', icon: 'delete', targetFolder: '回收站', acceptsDrop: true },
];

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface SidebarProps {
  onOpenPreferences: () => void;
  libraryRoot: string | null;
}

interface DragPayloadFile {
  fileId: string;
  filePath: string;
  filename: string;
}

interface DragPayload {
  files?: DragPayloadFile[];
  fileId?: string;
  filePath?: string;
  filename?: string;
}

interface GroupItemCount {
  name: string;
  count: number;
}

interface NavItemCount {
  navId: string;
  count: number;
}

const getDraggedFiles = (dataStr: string): DragPayloadFile[] => {
  if (!dataStr) {
    return [];
  }

  const data = JSON.parse(dataStr) as DragPayload;
  return data.files?.length
    ? data.files
    : data.fileId && data.filePath && data.filename
      ? [{ fileId: data.fileId, filePath: data.filePath, filename: data.filename }]
      : [];
};

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const Sidebar: React.FC<SidebarProps> = ({ onOpenPreferences, libraryRoot }) => {
  const activeNav = useUiStore((s) => s.activeNav);
  const setActiveNav = useUiStore((s) => s.setActiveNav);
  const sourceFolder = useUiStore((s) => s.sourceFolder);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const fetchFiles = useMediaStore((s) => s.fetchFiles);
  const showToast = useUiStore((s) => s.showToast);
  const showConfirm = useUiStore((s) => s.showConfirm);
  const activeTab = useUiStore((s) => s.activeTab);
  const tabs = useUiStore((s) => s.tabs);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const addTab = useUiStore((s) => s.addTab);
  const removeTab = useUiStore((s) => s.removeTab);
  const renameTab = useUiStore((s) => s.renameTab);
  const columnCount = useUiStore((s) => s.columnCount);
  const setColumnCount = useUiStore((s) => s.setColumnCount);
  const metaMode = useUiStore((s) => s.metaMode);
  const setMetaMode = useUiStore((s) => s.setMetaMode);

  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [isAddingGroup, setIsAddingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [groupContextMenu, setGroupContextMenu] = useState<{ x: number; y: number; group: string } | null>(null);
  const [groupCounts, setGroupCounts] = useState<Record<string, number>>({});
  const [navCounts, setNavCounts] = useState<Record<string, number>>({});
  const groupInputRef = useRef<HTMLInputElement>(null);
  // 重命名状态
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Tweaks 状态（metaMode 在 uiStore，其余本地）
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT_SWATCH);
  const [bgMode, setBgMode] = useState<'deep' | 'default' | 'light'>('default');
  const tweaksBtnRef = useRef<HTMLButtonElement>(null);
  const tweaksPanelRef = useRef<HTMLDivElement>(null);
  const [tweaksPanelPosition, setTweaksPanelPosition] = useState({
    left: 202,
    bottom: 58,
    arrowBottom: 20,
  });

  // 应用 accent 颜色到 CSS 变量（rgba 派生）
  const applyAccent = useCallback((hex: string) => {
    setAccentColor(hex);
    const root = document.documentElement;
    // 解析 #RRGGBB 为 r,g,b
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const rgb = `${r},${g},${b}`;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-soft',   `rgba(${rgb},0.10)`);
    root.style.setProperty('--accent-softer', `rgba(${rgb},0.06)`);
    root.style.setProperty('--accent-dim',    `rgba(${rgb},0.10)`);
    root.style.setProperty('--accent-active', `rgba(${rgb},0.16)`);
    root.style.setProperty('--accent-border', `rgba(${rgb},0.22)`);
    root.style.setProperty('--accent-glow',   `rgba(${rgb},0.18)`);
    root.style.setProperty('--accent-text',   `rgba(${rgb},0.92)`);
  }, []);

  // 应用背景明度
  const applyBg = useCallback((mode: 'deep' | 'default' | 'light') => {
    setBgMode(mode);
    const root = document.documentElement;
    root.style.setProperty('--bg-primary', BG_MODE_TOKEN_VALUES[mode]);
  }, []);

  // 点击外部关闭 Tweaks
  useEffect(() => {
    if (!tweaksOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (tweaksBtnRef.current && tweaksBtnRef.current.contains(target)) return;
      const panel = document.getElementById('tweaks-panel');
      if (panel && panel.contains(target)) return;
      setTweaksOpen(false);
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [tweaksOpen]);

  const updateTweaksPosition = useCallback(() => {
    const button = tweaksBtnRef.current;
    const panel = tweaksPanelRef.current;
    if (!button || !panel) return;

    const buttonRect = button.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const gap = 10;
    const margin = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = buttonRect.right + gap;
    if (left + panelRect.width + margin > viewportWidth) {
      left = viewportWidth - panelRect.width - margin;
    }

    let bottom = Math.max(margin, viewportHeight - buttonRect.bottom);
    if (bottom + panelRect.height + margin > viewportHeight) {
      bottom = viewportHeight - panelRect.height - margin;
    }

    const buttonCenterFromBottom = viewportHeight - (buttonRect.top + buttonRect.height / 2);
    const arrowBottom = Math.max(14, Math.min(panelRect.height - 22, buttonCenterFromBottom - bottom - 5));

    setTweaksPanelPosition({ left, bottom, arrowBottom });
  }, []);

  useEffect(() => {
    if (!tweaksOpen) return;
    const frame = window.requestAnimationFrame(updateTweaksPosition);
    const handleResize = () => updateTweaksPosition();
    window.addEventListener('resize', handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, [tweaksOpen, updateTweaksPosition]);

  // 键盘快捷键 T：切换 Tweaks 面板（非输入框焦点时）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 't' && e.key !== 'T') return;
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      setTweaksOpen(o => !o);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // 当前导航是否支持分组
  const supportsGroups = GROUP_NAVS.includes(activeNav);
  // 只显示用户自定义分组（过滤掉内置 Tab 和占位符）
  const customGroups = useMemo(() => {
    if (!supportsGroups) return [];
    const builtin = BUILTIN_TABS[activeNav] || [];
    return (tabs[activeNav] || []).filter(t => !builtin.includes(t) && t !== '+ 添加分组');
  }, [supportsGroups, tabs, activeNav]);
  const hasActiveCustomGroup = supportsGroups && customGroups.includes(activeTab);
  const activeTargetFolder = NAV_ITEMS.find((item) => item.id === activeNav)?.targetFolder ?? '灵感库';

  const loadGroupCounts = useCallback(async () => {
    if (!supportsGroups || customGroups.length === 0) {
      setGroupCounts({});
      return;
    }

    try {
      const counts = await invoke<GroupItemCount[]>('get_group_item_counts', {
        filter: {
          tagIds: null,
          categoryId: null,
          categoryName: null,
          onlyTrashed: activeNav === 'trash',
          fileTypes: null,
          hasAiMetadata: activeNav === 'ai-prompts',
          sourceFolder: (activeNav === 'trash' || activeNav === 'ai-prompts')
            ? null
            : (sourceFolder ?? null),
          libraryRootPath: null,
          keyword: null,
        },
        groupNames: customGroups,
      });

      const nextCounts = customGroups.reduce<Record<string, number>>((acc, group) => {
        acc[group] = 0;
        return acc;
      }, {});

      counts.forEach((item) => {
        nextCounts[item.name] = item.count;
      });

      setGroupCounts(nextCounts);
    } catch (error) {
      console.error('[Sidebar] Failed to load group counts:', error);
      setGroupCounts({});
    }
  }, [activeNav, customGroups, sourceFolder, supportsGroups]);

  const loadNavCounts = useCallback(async () => {
    const navIds = ['library', 'ai-prompts', 'projects'];

    try {
      const counts = await invoke<NavItemCount[]>('get_nav_item_counts', {
        navIds,
        libraryRoot,
      });

      const nextCounts = navIds.reduce<Record<string, number>>((acc, navId) => {
        acc[navId] = 0;
        return acc;
      }, {});

      counts.forEach((item) => {
        nextCounts[item.navId] = item.count;
      });

      setNavCounts(nextCounts);
    } catch (error) {
      console.error('[Sidebar] Failed to load nav counts:', error);
      setNavCounts({});
    }
  }, [libraryRoot]);

  useEffect(() => {
    void loadGroupCounts();
  }, [loadGroupCounts]);

  useEffect(() => {
    void loadNavCounts();
  }, [loadNavCounts]);

  useEffect(() => {
    const refresh = () => {
      void loadGroupCounts();
      void loadNavCounts();
    };
    window.addEventListener('group-counts-updated', refresh);
    window.addEventListener('trash-updated', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('group-counts-updated', refresh);
      window.removeEventListener('trash-updated', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [loadGroupCounts, loadNavCounts]);

  const handleAddGroup = useCallback(() => {
    let name = newGroupName.trim();

    if (!name) {
      // 未填写名称：自动生成"未命名分组"，重复时加数字后缀
      const base = '未命名分组';
      if (!customGroups.includes(base)) {
        name = base;
      } else {
        let i = 2;
        while (customGroups.includes(`${base} ${i}`)) i++;
        name = `${base} ${i}`;
      }
    }

    if (!customGroups.includes(name)) {
      addTab(activeNav, name);
      setActiveTab(name);
    }
    setNewGroupName('');
    setIsAddingGroup(false);
  }, [newGroupName, customGroups, addTab, activeNav, setActiveTab]);

  // 输入框处于编辑状态时，捕获阶段监听 mousedown
  // 使用 capture=true 确保在 data-tauri-drag-region 拦截事件之前触发
  useEffect(() => {
    if (!isAddingGroup) return;
    const handler = (e: MouseEvent) => {
      if (groupInputRef.current && !groupInputRef.current.contains(e.target as Node)) {
        handleAddGroup();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [isAddingGroup, handleAddGroup]);

  // 右键菜单 — 打开
  const handleGroupContextMenu = useCallback((e: React.MouseEvent, group: string) => {
    e.preventDefault();
    e.stopPropagation();
    setGroupContextMenu({ x: e.clientX, y: e.clientY, group });
  }, []);

  // 右键菜单 — 删除分组（弹窗确认）
  const handleDeleteGroup = useCallback(async (group: string) => {
    setGroupContextMenu(null);
    const confirmed = await showConfirm({
      title: '删除分组',
      message: `确定要删除分组"${group}"吗？\n\n分组内的素材不会被删除，只移除分组标记。`,
      confirmText: '删除',
      danger: true,
    });
    if (confirmed) {
      removeTab(activeNav, group);
    }
  }, [showConfirm, removeTab, activeNav]);

  // 右键菜单 — 重命名分组（进入内联编辑模式）
  const handleStartRename = useCallback((group: string) => {
    setGroupContextMenu(null);
    setRenamingGroup(group);
    setRenameValue(group);
    requestAnimationFrame(() => {
      renameInputRef.current?.select();
    });
  }, []);

  // 重命名提交
  const handleRenameSubmit = useCallback(() => {
    if (!renamingGroup) return;
    const newName = renameValue.trim();
    if (newName && newName !== renamingGroup) {
      renameTab(activeNav, renamingGroup, newName);
    }
    setRenamingGroup(null);
    setRenameValue('');
  }, [renamingGroup, renameValue, renameTab, activeNav]);

  // 重命名输入框：捕获阶段监听点击外部
  useEffect(() => {
    if (!renamingGroup) return;
    const handler = (e: MouseEvent) => {
      if (renameInputRef.current && !renameInputRef.current.contains(e.target as Node)) {
        handleRenameSubmit();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [renamingGroup, handleRenameSubmit]);

  // 处理文件拖放移动
  const handleDrop = useCallback(async (targetFolder: string, e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOverId(null);

    try {
      const dataStr = e.dataTransfer.getData('application/json');
      const filesToMove = getDraggedFiles(dataStr);

      if (filesToMove.length === 0) {
        throw new Error('未识别到可移动的素材');
      }

      if (filesToMove.length > 1) {
        console.log('[Sidebar] Dropping files:', filesToMove.map((item) => item.filename), 'to folder:', targetFolder);

        const results = await Promise.allSettled(
          filesToMove.map((item) => invoke('move_file_to_folder', {
            fileId: item.fileId,
            sourcePath: item.filePath,
            targetFolder: targetFolder,
          })),
        );

        const successCount = results.filter((result) => result.status === 'fulfilled').length;
        const failedCount = results.length - successCount;

        if (successCount === 0) {
          const firstFailure = results.find((result) => result.status === 'rejected');
          throw new Error(firstFailure?.status === 'rejected' ? String(firstFailure.reason) : '移动失败');
        }

        if (failedCount === 0) {
          showToast(`已移动 ${successCount} 个素材到"${targetFolder}"`);
        } else {
          showToast(`已移动 ${successCount} 个素材，${failedCount} 个失败`);
        }
        fetchFiles(1); // åˆ·æ–°åˆ—è¡¨
        void loadGroupCounts();
        void loadNavCounts();
        return;
      }

      const fileToMove = filesToMove[0];
      console.log('[Sidebar] Dropping file:', fileToMove.filename, 'to folder:', targetFolder);

      await invoke('move_file_to_folder', {
        fileId: fileToMove.fileId,
        sourcePath: fileToMove.filePath,
        targetFolder: targetFolder,
      });

      showToast(`已移动到"${targetFolder}"`);
      fetchFiles(1); // 刷新列表
      void loadGroupCounts();
      void loadNavCounts();
    } catch (err) {
      console.error('[Sidebar] Drop failed:', err);
      showToast('移动失败：' + (err as Error).message);
    }
  }, [fetchFiles, loadGroupCounts, loadNavCounts, showToast]);

  const handleGroupDrop = useCallback(async (targetGroup: string, e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOverId(null);

    try {
      const filesToMove = getDraggedFiles(e.dataTransfer.getData('application/json'));
      if (filesToMove.length === 0) {
        return;
      }

      const results = await Promise.allSettled(
        filesToMove.map((item) => invoke('ai_set_category', {
          itemId: item.fileId,
          categoryName: targetGroup,
        })),
      );

      const successCount = results.filter((result) => result.status === 'fulfilled').length;
      const failedCount = results.length - successCount;

      if (successCount === 0) {
        const firstFailure = results.find((result) => result.status === 'rejected');
        throw new Error(firstFailure?.status === 'rejected' ? String(firstFailure.reason) : '添加到分组失败');
      }

      setActiveTab(targetGroup);
      fetchFiles(1);
      void loadGroupCounts();
      void loadNavCounts();
      window.dispatchEvent(new CustomEvent('group-counts-updated'));

      if (failedCount === 0) {
        showToast(`已添加 ${successCount} 个素材到"${targetGroup}"`);
      } else {
        showToast(`已添加 ${successCount} 个素材，${failedCount} 个失败`);
      }
    } catch (err) {
      console.error('[Sidebar] Group drop failed:', err);
      showToast('添加到分组失败：' + (err as Error).message);
    }
  }, [fetchFiles, loadGroupCounts, loadNavCounts, setActiveTab, showToast]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDragEnter = useCallback((id: string, e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setDragOverId(null);
  }, []);

  return (
    <aside
      style={{
        width: 'var(--sidebar-width)',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'var(--bg-primary)',
        borderRight: '1px solid var(--border)',
        fontFamily: 'var(--font-family)',
      }}
    >
      {/* Logo 区域 */}
      <div
        data-tauri-drag-region
        style={{
          height: '48px',
          padding: '0 16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <GegaLogo width={22} height={22} />
        <span style={{
          fontFamily: 'var(--font-family)',
          fontSize: '15px',
          fontWeight: 700,
          color: 'var(--accent)',
          letterSpacing: '-0.02em',
        }}>
          Gega
        </span>
      </div>

      {/* 主导航区 - 扁平列表，无子菜单 */}
      <nav
        style={{
          flex: 1,
          minHeight: 0,
          padding: '12px 10px 8px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties & { WebkitAppRegion?: string }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', flexShrink: 0 }}>
          {NAV_ITEMS.map((item) => {
            const isActive = activeNav === item.id && !hasActiveCustomGroup;
            const isDragOver = dragOverId === item.id;

            return (
              <button
                key={item.id}
                className="no-drag"
                data-drop-target-nav={item.id}
                data-drop-target-folder={item.acceptsDrop ? item.targetFolder : undefined}
                onClick={() => setActiveNav(item.id)}
                onDragOver={item.acceptsDrop ? handleDragOver : undefined}
                onDragEnter={item.acceptsDrop ? (e) => handleDragEnter(item.id, e) : undefined}
                onDragLeave={item.acceptsDrop ? handleDragLeave : undefined}
                onDrop={item.acceptsDrop ? (e) => item.targetFolder && handleDrop(item.targetFolder, e) : undefined}
                style={{
                  position: 'relative',
                  overflow: 'hidden', // 让子元素绝对定位的竖条跟随圆角，且不溢出到 nav 容器外
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  width: '100%',
                  padding: '7px 10px',
                  background: (isActive || isDragOver) ? 'var(--accent-soft)' : 'transparent',
                  borderRadius: 'var(--radius-default)',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-family)',
                  fontSize: '13px',
                  fontWeight: (isActive || isDragOver) ? 500 : 450,
                  color: (isActive || isDragOver) ? 'var(--accent)' : 'var(--text-secondary)',
                  transition: 'background .15s ease, color .15s ease',
                  textAlign: 'left',
                  WebkitAppRegion: 'no-drag',
                } as React.CSSProperties & { WebkitAppRegion?: string }}
                onMouseEnter={(e) => {
                  if (!isActive && !isDragOver) {
                    const el = e.currentTarget as HTMLButtonElement;
                    el.style.background = 'var(--bg-hover)';
                    el.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive && !isDragOver) {
                    const el = e.currentTarget as HTMLButtonElement;
                    el.style.background = 'transparent';
                    el.style.color = 'var(--text-secondary)';
                  }
                }}
              >
                {/* 激活态左侧竖线 — position:absolute 在 overflow:hidden 的父按钮内，不受 nav 裁剪 */}
                {isActive && (
                  <span style={{
                    position: 'absolute',
                    left: 0,
                    top: '8px',
                    bottom: '8px',
                    width: '2px',
                    background: 'var(--accent)',
                    borderRadius: '2px',
                    pointerEvents: 'none',
                  }} />
                )}
                <Icon
                  name={item.icon}
                  size={18}
                  fill={isActive ? 1 : 0}
                  style={{
                    opacity: isActive ? 1 : 0.55,
                    color: isActive ? 'var(--accent)' : 'inherit',
                  }}
                />
                <span style={{ flex: 1 }}>{item.label}</span>
                {(['library', 'ai-prompts', 'projects'] as const).includes(item.id as 'library' | 'ai-prompts' | 'projects') && (
                  <span style={{
                    flexShrink: 0,
                    fontSize: '11px',
                    color: (isActive || isDragOver) ? 'var(--accent)' : 'var(--text-muted)',
                    opacity: (isActive || isDragOver) ? 0.95 : 0.8,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {navCounts[item.id] ?? 0}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── 分组区域：紧接在导航按钮之后，仅灵感库 / AI提示词库 / 作品集管理 ── */}
        {supportsGroups && (
          <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column', flex: 1, WebkitAppRegion: 'no-drag' } as React.CSSProperties & { WebkitAppRegion?: string }}>
            {/* 分割线 */}
            <div style={{ height: '1px', backgroundColor: 'var(--border)', margin: '0 6px 10px', flexShrink: 0 }} />

            {/* 分组标题（原型 nav-section-title 风格） */}
            <div style={{
              fontSize: '10px', fontWeight: 600, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--text-faint)',
              padding: '0 8px 6px',
              fontFamily: 'var(--font-family)',
              flexShrink: 0,
            }}>
              智能分组
            </div>

            <div
              style={{
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                paddingRight: '2px',
                WebkitAppRegion: 'no-drag',
              } as React.CSSProperties & { WebkitAppRegion?: string }}
            >
              {/* 自定义分组列表 */}
              {customGroups.map(group => {
                const isActive = activeTab === group;
                const groupDragId = `group:${group}`;
                const isDragOver = dragOverId === groupDragId;
                const isRenaming = renamingGroup === group;
                // 根据分组顺序循环取 token 色板，保持小分组可扫描且不硬编码组件颜色。
                const colorIndex = customGroups.indexOf(group) % GROUP_DOT_COLORS.length;
                const dotColor = GROUP_DOT_COLORS[colorIndex];

                if (isRenaming) {
                  return (
                    <input
                      key={`rename-${group}`}
                      ref={renameInputRef}
                      autoFocus
                      value={renameValue}
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleRenameSubmit();
                        if (e.key === 'Escape') { setRenamingGroup(null); setRenameValue(''); }
                      }}
                      style={{
                        width: '100%', height: '28px', padding: '0 8px', marginBottom: '2px',
                        backgroundColor: 'var(--bg-primary)', border: 'none',
                        boxShadow: 'inset 0 0 0 1px var(--accent)',
                        borderRadius: '6px', fontSize: '12px',
                        color: 'var(--text-primary)', outline: 'none',
                        fontFamily: 'var(--font-family)',
                        boxSizing: 'border-box',
                      }}
                    />
                  );
                }

                return (
                  <button
                    key={group}
                    className="no-drag"
                    data-drop-target-nav={activeNav}
                    data-drop-target-folder={activeTargetFolder}
                    data-drop-target-category={group}
                    onClick={() => setActiveTab(group)}
                    onContextMenu={(e) => handleGroupContextMenu(e, group)}
                    onDragOver={handleDragOver}
                    onDragEnter={(e) => handleDragEnter(groupDragId, e)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleGroupDrop(group, e)}
                    style={{
                      position: 'relative',
                      overflow: 'hidden',
                      display: 'flex', alignItems: 'center', gap: '8px',
                      width: '100%', padding: '6px 10px',
                      background: (isActive || isDragOver) ? 'var(--accent-soft)' : 'transparent',
                      borderRadius: 'var(--radius-default)', border: 'none', cursor: 'pointer',
                        fontFamily: 'var(--font-family)', fontSize: '12px',
                      fontWeight: (isActive || isDragOver) ? 500 : 400,
                      color: (isActive || isDragOver) ? 'var(--accent)' : 'var(--text-secondary)',
                      transition: 'background .15s ease, color .15s ease', textAlign: 'left',
                      WebkitAppRegion: 'no-drag',
                    } as React.CSSProperties & { WebkitAppRegion?: string }}
                    onMouseEnter={(e) => {
                      if (!isActive && !isDragOver) e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive && !isDragOver) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    {(isActive || isDragOver) && (
                      <span
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: '6px',
                          bottom: '6px',
                          width: '2px',
                          background: 'var(--accent)',
                          borderRadius: '0 2px 2px 0',
                          pointerEvents: 'none',
                        }}
                      />
                    )}
                    <span style={{
                      width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                      backgroundColor: (isActive || isDragOver) ? 'var(--accent)' : dotColor,
                      opacity: (isActive || isDragOver) ? 1 : 0.6,
                    }} />
                    <span style={{
                      flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {group}
                    </span>
                    <span style={{
                      flexShrink: 0,
                      fontSize: '11px',
                      color: (isActive || isDragOver) ? 'var(--accent)' : 'var(--text-muted)',
                      opacity: (isActive || isDragOver) ? 0.92 : 0.78,
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {groupCounts[group] ?? 0}
                    </span>
                  </button>
                );
              })}

              {/* 添加分组 */}
              {isAddingGroup ? (
                <input
                  ref={groupInputRef}
                  autoFocus
                  value={newGroupName}
                  onChange={e => setNewGroupName(e.target.value)}
                  placeholder="分组名称…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleAddGroup();
                    if (e.key === 'Escape') { setIsAddingGroup(false); setNewGroupName(''); }
                  }}
                  style={{
                    width: '100%', height: '28px', padding: '0 8px',
                    backgroundColor: 'var(--bg-primary)', border: 'none',
                    boxShadow: 'inset 0 0 0 1px var(--border)',
                    borderRadius: '6px', fontSize: '12px',
                    color: 'var(--text-primary)', outline: 'none',
                    boxSizing: 'border-box', fontFamily: 'var(--font-family)',
                  }}
                />
              ) : (
                <button
                  className="no-drag"
                  onClick={() => setIsAddingGroup(true)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    width: '100%', padding: '6px 8px',
                    background: 'transparent', borderRadius: '6px', border: 'none',
                    cursor: 'pointer', fontSize: '12px',
                    color: 'var(--text-muted)', opacity: 0.5,
                    transition: 'opacity 0.15s ease', fontFamily: 'var(--font-family)',
                    WebkitAppRegion: 'no-drag',
                  } as React.CSSProperties & { WebkitAppRegion?: string }}
                  onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.5'; }}
                >
                  <Icon name="add" size={14} />
                  添加分组
                </button>
              )}
            </div>
          </div>
        )}
      </nav>

      {/* 底部区域 */}
      <div
        data-tauri-drag-region
        style={{
          flexShrink: 0,
          padding: '8px 10px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          gap: '1px',
        }}
      >
        {/* 外观调整按钮 */}
        <button
          ref={tweaksBtnRef}
          onClick={() => setTweaksOpen(o => !o)}
          className="no-drag"
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            width: '100%', padding: '7px 10px',
            background: tweaksOpen ? 'var(--accent-soft)' : 'transparent',
            borderRadius: 'var(--radius-default)', border: 'none',
            cursor: 'pointer', fontFamily: 'var(--font-family)',
            fontSize: '12px', fontWeight: 400,
            color: tweaksOpen ? 'var(--accent)' : 'var(--text-secondary)',
            transition: 'background .15s, color .15s',
            textAlign: 'left', WebkitAppRegion: 'no-drag',
          } as React.CSSProperties & { WebkitAppRegion?: string }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = tweaksOpen ? 'var(--accent-soft)' : 'transparent'; e.currentTarget.style.color = tweaksOpen ? 'var(--accent)' : 'var(--text-secondary)'; }}
        >
          <Icon name="tune" size={16} style={{ opacity: tweaksOpen ? 1 : 0.65, color: tweaksOpen ? 'var(--accent)' : 'inherit' }} />
          <span style={{ flex: 1 }}>外观调整</span>
          <span style={{ fontSize: '10px', color: tweaksOpen ? 'var(--accent)' : 'var(--text-faint)', fontFamily: 'var(--font-family)' }}>T</span>
        </button>

        {/* 分割线 */}
        <div style={{ height: '1px', background: 'var(--border)', margin: '6px 2px' }} />

        {/* 设置按钮 */}
        <button
          onClick={onOpenPreferences}
          className="no-drag"
          style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            width: '100%', padding: '7px 10px',
            background: 'transparent', borderRadius: 'var(--radius-default)', border: 'none',
            cursor: 'pointer', fontFamily: 'var(--font-family)',
            fontSize: '12px', fontWeight: 400,
            color: 'var(--text-secondary)', transition: 'background .15s, color .15s',
            textAlign: 'left', WebkitAppRegion: 'no-drag',
          } as React.CSSProperties & { WebkitAppRegion?: string }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
        >
          <Icon name="settings" size={16} opacity={0.65} />
          <span style={{ flex: 1 }}>设置</span>
          <span style={{ fontSize: '10px', color: 'var(--text-faint)', fontFamily: 'var(--font-family)' }}>Ctrl ,</span>
        </button>
      </div>

      {/* Tweaks 浮窗 */}
        {tweaksOpen && (
          <div
            ref={tweaksPanelRef}
            id="tweaks-panel"
          style={{
            position: 'fixed',
            left: `${tweaksPanelPosition.left}px`,
            bottom: `${tweaksPanelPosition.bottom}px`,
            width: '280px',
            background: 'color-mix(in srgb, var(--bg-surface) 94%, var(--bg-card) 6%)',
            border: '1px solid var(--border-strong)',
            borderRadius: '14px',
            padding: '12px 14px 14px',
            boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border)',
            zIndex: 999,
            fontFamily: 'var(--font-family)',
            backdropFilter: 'blur(20px)',
            ['--arrow-bottom' as string]: `${tweaksPanelPosition.arrowBottom}px`,
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: '-6px',
              bottom: 'var(--arrow-bottom)',
              width: '10px',
              height: '10px',
              background: 'color-mix(in srgb, var(--bg-surface) 94%, var(--bg-card) 6%)',
              borderLeft: '1px solid var(--border-strong)',
              borderBottom: '1px solid var(--border-strong)',
              transform: 'rotate(45deg)',
            }}
          />
          {/* 标题行 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{
              fontSize: '10px', letterSpacing: '0.14em', textTransform: 'uppercase',
              color: 'var(--accent)', fontWeight: 700,
            }}>
              Tweaks
            </span>
            <button
              onClick={() => setTweaksOpen(false)}
              style={{
                width: '28px', height: '28px', borderRadius: '7px',
                display: 'grid', placeItems: 'center',
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', transition: 'background .15s, color .15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>

          {/* 主题模式 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>
              <span>主题模式</span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-family)', fontSize: '10px' }}>
                {theme === 'dark' ? '深色' : '浅色'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '2px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-default)' }}>
              {(['dark', 'light'] as const).map(mode => {
                const active = theme === mode;
                const label = mode === 'dark' ? '深色' : '浅色';
                return (
                  <button
                    key={mode}
                    onClick={() => { if (!active) void setTheme(mode); }}
                    style={{
                      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                      padding: '5px 8px', fontSize: '11px',
                      borderRadius: '6px', fontWeight: 500,
                      background: active ? 'var(--accent)' : 'transparent',
                      color: active ? 'var(--text-on-accent)' : 'var(--text-muted)',
                      border: 'none', cursor: active ? 'default' : 'pointer',
                      transition: 'background .15s, color .15s',
                      fontFamily: 'var(--font-family)',
                    }}
                    onMouseEnter={(e) => { if (!active) { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--bg-hover)'; } }}
                    onMouseLeave={(e) => { if (!active) { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; } }}
                  >
                    <Icon name={mode === 'dark' ? 'dark_mode' : 'light_mode'} size={13} opacity={active ? 1 : 0.65} />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 网格列数 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>
              <span>网格列数</span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-family)', fontSize: '10px' }}>{columnCount}</span>
            </div>
            <div style={{ display: 'flex', gap: '2px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-default)' }}>
              {[3, 4, 5, 6].map(n => (
                <button
                  key={n}
                  onClick={() => setColumnCount(n)}
                  style={{
                    flex: 1, padding: '5px 8px', fontSize: '11px',
                    borderRadius: '6px', fontWeight: 500,
                    background: columnCount === n ? 'var(--accent)' : 'transparent',
                    color: columnCount === n ? 'var(--text-on-accent)' : 'var(--text-muted)',
                    border: 'none', cursor: 'pointer',
                    transition: 'background .15s, color .15s',
                    fontFamily: 'var(--font-family)',
                  }}
                  onMouseEnter={(e) => { if (columnCount !== n) { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--bg-hover)'; } }}
                  onMouseLeave={(e) => { if (columnCount !== n) { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; } }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* 品牌主色 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>
              <span>品牌主色</span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-family)', fontSize: '10px' }}>{accentColor}</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {ACCENT_SWATCHES.map(({ color }) => (
                <div
                  key={color}
                  title={color}
                  onClick={() => applyAccent(color)}
                  style={{
                    width: '22px', height: '22px', borderRadius: '6px',
                    background: color, cursor: 'pointer',
                    border: '1px solid var(--border)',
                    outline: accentColor === color ? '2px solid var(--text-primary)' : 'none',
                    outlineOffset: '2px',
                    transition: 'transform .15s, outline .1s',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1.1)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.transform = 'scale(1)'; }}
                />
              ))}
            </div>
          </div>

          {/* 卡片元信息 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>
              <span>卡片元信息</span>
              <span style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                {metaMode === 'hover' ? '悬停' : metaMode === 'always' ? '常显' : '隐藏'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '2px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-default)' }}>
              {(['hover', 'always', 'off'] as const).map(mode => {
                const label = mode === 'hover' ? '悬停' : mode === 'always' ? '常显' : '隐藏';
                return (
                  <button
                    key={mode}
                    onClick={() => setMetaMode(mode)}
                    style={{
                      flex: 1, padding: '5px 8px', fontSize: '11px',
                      borderRadius: '6px', fontWeight: 500,
                      background: metaMode === mode ? 'var(--accent)' : 'transparent',
                      color: metaMode === mode ? 'var(--text-on-accent)' : 'var(--text-muted)',
                      border: 'none', cursor: 'pointer',
                      transition: 'background .15s, color .15s',
                      fontFamily: 'var(--font-family)',
                    }}
                    onMouseEnter={(e) => { if (metaMode !== mode) { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--bg-hover)'; } }}
                    onMouseLeave={(e) => { if (metaMode !== mode) { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; } }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 背景明度 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500 }}>
              <span>背景明度</span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-family)', fontSize: '10px' }}>
                {BG_MODE_LABELS[bgMode]}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '2px', background: 'var(--bg-primary)', padding: '2px', borderRadius: 'var(--radius-small)' }}>
              {(['deep', 'default', 'light'] as const).map(mode => {
                const label = mode === 'deep' ? '深' : mode === 'default' ? '默认' : '浅';
                return (
                  <button
                    key={mode}
                    onClick={() => applyBg(mode)}
                    style={{
                      flex: 1, padding: '5px 8px', fontSize: '11px',
                      borderRadius: '6px', fontWeight: 500,
                      background: bgMode === mode ? 'var(--accent)' : 'transparent',
                      color: bgMode === mode ? 'var(--text-on-accent)' : 'var(--text-muted)',
                      border: 'none', cursor: 'pointer',
                      transition: 'background .15s, color .15s',
                      fontFamily: 'var(--font-family)',
                    }}
                    onMouseEnter={(e) => { if (bgMode !== mode) { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--bg-hover)'; } }}
                    onMouseLeave={(e) => { if (bgMode !== mode) { e.currentTarget.style.color = 'var(--text-muted)'; e.currentTarget.style.background = 'transparent'; } }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {/* 分组右键菜单 */}
      {groupContextMenu && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onMouseDown={() => setGroupContextMenu(null)}
          />
          <div
            style={{
              position: 'fixed',
              left: groupContextMenu.x,
              top: groupContextMenu.y,
              zIndex: 200,
              backgroundColor: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-small)',
              boxShadow: 'var(--shadow-md), inset 0 0 0 1px var(--border)',
              padding: '4px',
              minWidth: '148px',
              fontFamily: 'var(--font-family)',
            }}
          >
            {/* 重命名分组 */}
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => handleStartRename(groupContextMenu.group)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                width: '100%', padding: '7px 10px',
                background: 'transparent', border: 'none', cursor: 'pointer',
                borderRadius: 'var(--radius-xs)', fontSize: '13px',
                color: 'var(--text-primary)', textAlign: 'left',
                fontFamily: 'var(--font-family)', transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'var(--bg-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <Icon name="drive_file_rename_outline" size={14} color="var(--text-secondary)" />
              重命名
            </button>

            {/* 分割线 */}
            <div style={{ height: '1px', backgroundColor: 'var(--border)', margin: '4px 0' }} />

            {/* 删除分组 */}
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => handleDeleteGroup(groupContextMenu.group)}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                width: '100%', padding: '7px 10px',
                background: 'transparent', border: 'none', cursor: 'pointer',
                borderRadius: '6px', fontSize: '13px',
                color: 'var(--error)', textAlign: 'left',
                fontFamily: 'var(--font-family)', transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'color-mix(in srgb, var(--error) 12%, transparent)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <Icon name="delete" size={14} />
              删除分组
            </button>
          </div>
        </>
      )}
    </aside>
  );
};
