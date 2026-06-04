import React, { useEffect, useRef, useState } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { Icon } from '../common/Icon';

interface AppRegionStyle extends React.CSSProperties {
  WebkitAppRegion?: 'drag' | 'no-drag';
}

export interface TopToolbarAction {
  icon: string;
  title: string;
  onClick: () => void;
}

interface TopToolbarProps {
  count: number;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  searchPlaceholder?: string;
  actions?: TopToolbarAction[];
  showUtilityButtons?: boolean;
  showZoomControls?: boolean;
}

const NAV_META: Record<string, { icon: string; label: string }> = {
  'library': { icon: 'grid_view', label: '灵感库' },
  'ai-prompts': { icon: 'auto_awesome', label: 'AI 提示词库' },
  'projects': { icon: 'folder_open', label: '作品集' },
  'web-pages': { icon: 'language', label: '网页管理' },
  'trash': { icon: 'delete', label: '回收站' },
};

const BUILTIN_TABS: Record<string, string[]> = {
  'library': ['全部', '图片', '视频'],
  'ai-prompts': ['全部', '已填写', '未填写'],
  'projects': ['全部'],
  'web-pages': ['全部'],
  'trash': ['全部'],
};

const toolbarStyle: AppRegionStyle = {
  height: '48px',
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  padding: '0 20px',
  zIndex: 10,
  background: 'var(--bg-primary)',
  borderBottom: '1px solid var(--border)',
  gap: '12px',
  WebkitAppRegion: 'drag',
};

const navTitleStyle: AppRegionStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '12px',
  color: 'var(--text-secondary)',
  minWidth: 0,
  WebkitAppRegion: 'no-drag',
};

const navLabelStyle: React.CSSProperties = {
  color: 'var(--text-primary)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  fontFamily: 'var(--font-family)',
};

const countBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '26px',
  height: '20px',
  padding: '0 8px',
  borderRadius: '999px',
  fontSize: '10px',
  color: 'var(--text-muted)',
  background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)',
  boxShadow: 'inset 0 0 0 1px var(--border)',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 500,
  whiteSpace: 'nowrap',
  fontFamily: 'var(--font-family)',
};

const searchBaseStyle: AppRegionStyle = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  border: '1px solid var(--border)',
  borderRadius: '24px',
  height: '32px',
  width: '260px',
  transition: 'border-color .15s ease, background .15s ease, box-shadow .15s ease',
  WebkitAppRegion: 'no-drag',
};

const searchInputStyle: AppRegionStyle = {
  background: 'transparent',
  border: 'none',
  padding: '0 48px 0 36px',
  color: 'var(--text-primary)',
  fontSize: '13px',
  width: '100%',
  height: '100%',
  outline: 'none',
  WebkitAppRegion: 'no-drag',
};

const searchIconStyle: React.CSSProperties = {
  position: 'absolute',
  left: '12px',
  fontSize: '14px',
  opacity: 0.45,
  color: 'var(--text-secondary)',
  pointerEvents: 'none',
};

const searchShortcutStyle: React.CSSProperties = {
  position: 'absolute',
  right: '10px',
  top: '50%',
  transform: 'translateY(-50%)',
  fontSize: '10px',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-family)',
  pointerEvents: 'none',
};

const pillStyle: AppRegionStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '2px',
  height: '32px',
  padding: '0 4px',
  borderRadius: '999px',
  background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)',
  boxShadow: 'inset 0 0 0 1px var(--border)',
  WebkitAppRegion: 'no-drag',
};

const separatorStyle: React.CSSProperties = {
  width: '1px',
  height: '20px',
  background: 'var(--border-strong)',
  margin: '0 6px',
  flexShrink: 0,
};

const sliderContainerStyle: AppRegionStyle = {
  display: 'flex',
  alignItems: 'center',
  width: '72px',
  WebkitAppRegion: 'no-drag',
};

const getIconButtonStyle = (active = false): AppRegionStyle => ({
  width: '28px',
  height: '28px',
  display: 'grid',
  placeItems: 'center',
  borderRadius: '999px',
  color: active ? 'var(--accent)' : 'var(--text-muted)',
  background: active ? 'var(--accent-soft)' : 'transparent',
  border: 'none',
  cursor: 'pointer',
  transition: 'background .15s, color .15s',
  WebkitAppRegion: 'no-drag',
});

export const TopToolbar: React.FC<TopToolbarProps> = ({
  count,
  searchQuery,
  onSearchQueryChange,
  searchPlaceholder = '搜索素材、标签、颜色…',
  actions = [],
  showUtilityButtons = true,
  showZoomControls = true,
}) => {
  const activeNav = useUiStore((s) => s.activeNav);
  const activeTab = useUiStore((s) => s.activeTab);
  const setActiveTab = useUiStore((s) => s.setActiveTab);
  const columnCount = useUiStore((s) => s.columnCount);
  const setColumnCount = useUiStore((s) => s.setColumnCount);

  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [sliderValue, setSliderValue] = useState(() => 8 - columnCount);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSliderValue(8 - columnCount);
  }, [columnCount]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') {
        return;
      }
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement?.closest('input, textarea, [contenteditable="true"]')) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const navMeta = NAV_META[activeNav] ?? { icon: 'grid_view', label: '全部' };
  const tabs = BUILTIN_TABS[activeNav] ?? ['全部'];
  const shouldShowTabs = tabs.length > 1;
  const shouldShowRightTools = actions.length > 0 || showUtilityButtons || showZoomControls;

  const searchContainerStyle: AppRegionStyle = {
    ...searchBaseStyle,
    background: isSearchFocused ? 'var(--bg-active)' : 'color-mix(in srgb, var(--bg-card) 84%, transparent)',
    borderColor: isSearchFocused ? 'var(--border-strong)' : 'var(--border)',
    boxShadow: isSearchFocused ? '0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent)' : 'inset 0 0 0 1px var(--border)',
  };

  const setToolbarColumnCount = (nextCount: number) => {
    const clampedCount = Math.max(2, Math.min(6, nextCount));
    setSliderValue(8 - clampedCount);
    void setColumnCount(clampedCount);
  };

  return (
    <div data-tauri-drag-region style={toolbarStyle}>
      <div className="no-drag" style={navTitleStyle}>
        <Icon name={navMeta.icon} size={15} color="var(--text-muted)" />
        <span style={navLabelStyle}>{navMeta.label}</span>
        {count > 0 && <span style={countBadgeStyle}>{count}</span>}
      </div>

      <div style={{ flex: 1 }} />

      <div className="no-drag" style={searchContainerStyle}>
        <Icon name="search" size={16} style={searchIconStyle} />
        <input
          ref={searchInputRef}
          type="text"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.target.value)}
          onFocus={() => setIsSearchFocused(true)}
          onBlur={() => setIsSearchFocused(false)}
          className="no-drag"
          style={searchInputStyle}
        />
        <span style={searchShortcutStyle}>Ctrl K</span>
      </div>

      {shouldShowTabs && (
        <div className="no-drag" style={pillStyle}>
          {tabs.map((tab) => {
            const isTabActive = (activeTab === tab) || (!activeTab && tab === '全部');
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  height: '28px',
                  padding: '0 10px',
                  borderRadius: '14px',
                  border: 'none',
                  fontSize: '11px',
                  color: isTabActive ? 'var(--accent)' : 'var(--text-secondary)',
                  background: isTabActive ? 'var(--accent-soft)' : 'transparent',
                  fontWeight: isTabActive ? 500 : 450,
                  transition: 'background .15s, color .15s',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-family)',
                  WebkitAppRegion: 'no-drag',
                } as AppRegionStyle}
                onMouseEnter={(event) => {
                  if (isTabActive) return;
                  event.currentTarget.style.background = 'var(--bg-hover)';
                  event.currentTarget.style.color = 'var(--text-primary)';
                }}
                onMouseLeave={(event) => {
                  if (isTabActive) return;
                  event.currentTarget.style.background = 'transparent';
                  event.currentTarget.style.color = 'var(--text-secondary)';
                }}
              >
                {tab}
                {isTabActive && (
                  <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>
      )}

      {actions.length > 0 && (
        <div className="no-drag" style={pillStyle}>
          {actions.map((action) => (
            <button
              key={action.title}
              className="no-drag"
              title={action.title}
              onClick={action.onClick}
              style={getIconButtonStyle(true)}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--accent-dim)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--accent-soft)'; }}
            >
              <Icon name={action.icon} size={18} />
            </button>
          ))}
        </div>
      )}

      {shouldShowRightTools && <div style={separatorStyle} />}

      {showUtilityButtons && (
        <div className="no-drag" style={pillStyle}>
          {[
            { icon: 'sort', title: '排序' },
            { icon: 'tune', title: '筛选' },
          ].map(({ icon, title }) => (
            <button
              key={icon}
              className="no-drag"
              title={title}
              style={getIconButtonStyle()}
              onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--bg-hover)'; event.currentTarget.style.color = 'var(--text-secondary)'; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; event.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <Icon name={icon} size={18} />
            </button>
          ))}
        </div>
      )}

      {showZoomControls && (
        <div className="no-drag" style={{ ...pillStyle, gap: '8px', padding: '0 8px' }}>
          <Icon
            name="grid_on"
            size={16}
            className="no-drag"
            style={{ color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setToolbarColumnCount(columnCount + 1)}
          />
          <div style={sliderContainerStyle}>
            <input
              type="range"
              min={2}
              max={6}
              value={sliderValue}
              onChange={(event) => {
                const value = Number(event.target.value);
                setSliderValue(value);
                void setColumnCount(8 - value);
              }}
              className="zoom-slider no-drag"
            />
          </div>
          <Icon
            name="window"
            size={16}
            className="no-drag"
            style={{ color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}
            onClick={() => setToolbarColumnCount(columnCount - 1)}
          />
        </div>
      )}
    </div>
  );
};
