/**
 * Gega Gallery — ModelCombobox
 *
 * AI 模型选择器：手动输入 + 分类 Tab 下拉菜单 + 收藏/拖拽排序。
 *
 * 交互要点：
 *  - 三大类 Tab（图像 / 视频 / 音乐）切换显示当前类别模型
 *  - 每行右侧星标：点亮后该模型置顶（归入"已收藏"子组）
 *  - 已收藏模型支持 HTML5 拖拽重新排序（未收藏模型保持 catalog 原序）
 *  - 收藏及排序持久化到 user_preferences（key: model_combobox_favorites_v1）
 *  - 输入框敲字进入搜索模式，跨分类 includes 过滤；搜索模式下 Tab/拖拽隐藏
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPreference, setPreference } from '../../utils/preferences';
import { Icon } from '../common/Icon';

// ----------------------------------------------------------------
// 主流模型目录
// ----------------------------------------------------------------

type ModelCategory = '图像' | '视频' | '音乐';

const MODEL_CATALOG: { category: ModelCategory; models: string[] }[] = [
  {
    category: '图像',
    models: [
      'Midjourney V7',
      'Midjourney V6.1',
      'Niji V6',
      'DALL·E 3',
      'Stable Diffusion XL',
      'Stable Diffusion 3.5',
      'FLUX.1 [dev]',
      'FLUX.1 [pro]',
      'FLUX 1.1 [pro]',
      'FLUX Kontext',
      'Ideogram V3',
      'Recraft V3',
      'Imagen 3',
      'Imagen 4',
      'Nano Banana (Gemini 2.5)',
      'Adobe Firefly 3',
      '即梦 Jimeng',
      '通义万相 Wanxiang',
      '文心一格',
      '可灵 Image',
      '腾讯混元 Hunyuan',
      '豆包图像',
    ],
  },
  {
    category: '视频',
    models: [
      'Sora',
      'Runway Gen-4',
      'Runway Gen-3 Alpha',
      'Pika 2.2',
      'Pika 2.1',
      'Kling 2.0',
      'Kling 1.6',
      'Kling 1.5',
      'Hailuo 海螺',
      'Vidu 2.0',
      'Luma Ray 2',
      'Luma Dream Machine',
      'Veo 3',
      'Veo 2',
      '即梦 Jimeng Video',
      '腾讯混元 Video',
      'Wan 2.1',
      'CogVideoX',
      'LTX Video',
    ],
  },
  {
    category: '音乐',
    models: [
      'Suno V4.5',
      'Suno V4',
      'Suno V3.5',
      'Udio',
      'Stable Audio 2',
      'ElevenLabs Music',
      '海绵音乐',
      '天工 SkyMusic',
    ],
  },
];

const PREF_KEY = 'model_combobox_favorites_v1';
const EMPTY_FAVS: Record<ModelCategory, string[]> = { '图像': [], '视频': [], '音乐': [] };

// ----------------------------------------------------------------
// Props
// ----------------------------------------------------------------

interface ModelComboboxProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  tone?: 'default' | 'muted';
  chrome?: 'default' | 'inline';
  dropdownWidth?: number | string;
}

// ----------------------------------------------------------------
// Component
// ----------------------------------------------------------------

export const ModelCombobox: React.FC<ModelComboboxProps> = ({
  value,
  onChange,
  placeholder = '模型',
  tone = 'default',
  chrome = 'default',
  dropdownWidth,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<ModelCategory>('图像');
  const [favorites, setFavorites] = useState<Record<ModelCategory, string[]>>(EMPTY_FAVS);
  const [draggingModel, setDraggingModel] = useState<string | null>(null);
  const [dragOverModel, setDragOverModel] = useState<string | null>(null);
  // 仅在"用户本次打开后敲过键"时才把 value 当成搜索词，否则视为已选值，展示完整列表
  const [isUserFiltering, setIsUserFiltering] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // 从 user_preferences 加载收藏与排序
  useEffect(() => {
    getPreference(PREF_KEY, '{}').then((str) => {
      try {
        const parsed = JSON.parse(str);
        setFavorites({
          '图像': Array.isArray(parsed['图像']) ? parsed['图像'] : [],
          '视频': Array.isArray(parsed['视频']) ? parsed['视频'] : [],
          '音乐': Array.isArray(parsed['音乐']) ? parsed['音乐'] : [],
        });
      } catch {
        // ignore parse error, keep EMPTY_FAVS
      }
    });
  }, []);

  // 打开时若当前值属于某分类（含收藏自定义），自动切到该分类
  useEffect(() => {
    if (!isOpen || !value) return;
    const hit = MODEL_CATALOG.find((c) => c.models.includes(value));
    if (hit && hit.category !== activeCategory) setActiveCategory(hit.category);
  }, [activeCategory, isOpen, value]);

  // 点击外部关闭
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [isOpen]);

  // 下拉关闭时重置过滤态，下次打开默认显示完整列表
  useEffect(() => {
    if (!isOpen) setIsUserFiltering(false);
  }, [isOpen]);

  const persistFavorites = useCallback((next: Record<ModelCategory, string[]>) => {
    setFavorites(next);
    setPreference(PREF_KEY, JSON.stringify(next));
  }, []);

  const toggleFavorite = useCallback((category: ModelCategory, model: string) => {
    setFavorites((prev) => {
      const list = prev[category] || [];
      const isFav = list.includes(model);
      // 收藏：追加到末尾（在已有收藏之后）；取消收藏：从列表剔除
      const nextList = isFav ? list.filter((m) => m !== model) : [...list, model];
      const next = { ...prev, [category]: nextList };
      setPreference(PREF_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // 只有用户在本次打开期间敲过键，才把 value 当成过滤词；否则（刚打开 / 刚选完）展示完整列表
  const query = isUserFiltering ? value.trim().toLowerCase() : '';
  const isSearching = query.length > 0;

  // 当前 Tab 下的模型显示顺序：
  //  1) 当前选中模型永远置顶
  //  2) 收藏（按用户顺序）
  //  3) 未收藏（按 catalog 原序）
  const activeCategoryOrderedModels = useMemo(() => {
    const cat = MODEL_CATALOG.find((c) => c.category === activeCategory);
    if (!cat) return [];
    const favList = favorites[activeCategory] || [];
    const catalogSet = new Set(cat.models);
    // 过滤掉失效收藏（catalog 里已不存在），保留顺序
    const starred = favList.filter((m) => catalogSet.has(m));
    const starredSet = new Set(starred);
    const unstarred = cat.models.filter((m) => !starredSet.has(m));
    const combined = [...starred, ...unstarred];
    // 当前选中的模型永远排第一（若它属于当前分类）
    if (value && catalogSet.has(value)) {
      return [value, ...combined.filter((m) => m !== value)];
    }
    return combined;
  }, [activeCategory, favorites, value]);

  // 搜索模式：跨分类过滤
  const searchGroups = useMemo(() => {
    if (!isSearching) return [];
    return MODEL_CATALOG
      .map((c) => ({
        category: c.category,
        models: c.models.filter((m) => m.toLowerCase().includes(query)),
      }))
      .filter((c) => c.models.length > 0);
  }, [isSearching, query]);

  const handlePick = (model: string) => {
    onChange(model);
    setIsUserFiltering(false); // 选中后视为"已选值"，而非过滤关键词
    setIsOpen(false);
    inputRef.current?.blur();
  };

  // ───── 拖拽：仅已收藏（starred）行之间可重排 ─────
  const handleDragStart = (e: React.DragEvent, model: string) => {
    setDraggingModel(model);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', model); // Firefox 需要 payload
  };

  const handleDragOver = (e: React.DragEvent, model: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverModel !== model) setDragOverModel(model);
  };

  const handleDragLeave = () => {
    setDragOverModel(null);
  };

  const handleDrop = (e: React.DragEvent, targetModel: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingModel || draggingModel === targetModel) {
      setDraggingModel(null);
      setDragOverModel(null);
      return;
    }
    const list = favorites[activeCategory] || [];
    const from = list.indexOf(draggingModel);
    const to = list.indexOf(targetModel);
    if (from < 0 || to < 0) {
      setDraggingModel(null);
      setDragOverModel(null);
      return;
    }
    const next = [...list];
    next.splice(from, 1);
    next.splice(to, 0, draggingModel);
    persistFavorites({ ...favorites, [activeCategory]: next });
    setDraggingModel(null);
    setDragOverModel(null);
  };

  const handleDragEnd = () => {
    setDraggingModel(null);
    setDragOverModel(null);
  };

  // ───── 渲染单行 ─────
  const renderRow = (model: string, category: ModelCategory, draggable: boolean) => {
    const isActive = model === value;
    const favList = favorites[category] || [];
    const isFav = favList.includes(model);
    const isDragging = draggingModel === model;
    const isDragOver = dragOverModel === model && draggingModel !== model;

    return (
      <div
        key={model}
        draggable={draggable}
        onDragStart={draggable ? (e) => handleDragStart(e, model) : undefined}
        onDragOver={draggable ? (e) => handleDragOver(e, model) : undefined}
        onDragLeave={draggable ? handleDragLeave : undefined}
        onDrop={draggable ? (e) => handleDrop(e, model) : undefined}
        onDragEnd={draggable ? handleDragEnd : undefined}
        onClick={() => handlePick(model)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 8px 8px 12px',
          borderRadius: 'var(--radius-control)',
          background: isActive ? 'var(--bg-hover)' : 'transparent',
          color: isActive ? 'var(--accent)' : 'var(--on-surface)',
          cursor: draggable ? 'grab' : 'pointer',
          fontSize: '12px',
          fontFamily: 'var(--font-family)',
          opacity: isDragging ? 0.35 : 1,
          boxShadow: isDragOver ? 'inset 0 2px 0 var(--accent)' : 'none',
          transition: 'background 0.1s ease, color 0.1s ease',
          userSelect: 'none',
        }}
        onMouseEnter={(e) => {
          if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)';
        }}
        onMouseLeave={(e) => {
          if (!isActive) e.currentTarget.style.background = 'transparent';
        }}
      >
        <Icon
          name="check"
          size={14}
          color="var(--accent)"
          style={{ visibility: isActive ? 'visible' : 'hidden' }}
        />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model}
        </span>
        {/* 取消选择按钮：仅选中行显示，其余行用 visibility:hidden 占位保持对齐 */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange('');
            setIsUserFiltering(false);
          }}
          title="取消选择"
          tabIndex={isActive ? 0 : -1}
          style={{
            width: '22px',
            height: '22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            cursor: isActive ? 'pointer' : 'default',
            padding: 0,
            borderRadius: 'var(--radius-control)',
            flexShrink: 0,
            visibility: isActive ? 'visible' : 'hidden',
          }}
          onMouseEnter={(e) => {
            if (isActive) e.currentTarget.style.background = 'var(--bg-active)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <Icon name="close" size={14} color="var(--text-muted)" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(category, model);
          }}
          title={isFav ? '取消收藏' : '收藏并置顶'}
          style={{
            width: '22px',
            height: '22px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            borderRadius: 'var(--radius-control)',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--bg-active)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <Icon
            name="star"
            size={16}
            fill={isFav ? 1 : 0}
            color={isFav ? 'var(--accent)' : 'var(--text-muted)'}
          />
        </button>
      </div>
    );
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setIsUserFiltering(true); // 用户主动敲键 → 进入过滤模式
          if (!isOpen) setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        spellCheck={false}
        style={{
          width: '100%',
          padding: chrome === 'inline' ? '6px 30px 6px 8px' : '8px 34px 8px 12px',
          backgroundColor: chrome === 'inline' ? 'transparent' : 'var(--color-bg-card)',
          border: 'none',
          borderRadius: chrome === 'inline' ? '8px' : 'var(--radius-default)',
          fontSize: chrome === 'inline' ? '11px' : '12px',
          outline: 'none',
          boxSizing: 'border-box',
          color: tone === 'muted' ? 'var(--text-muted)' : 'var(--on-surface)',
          fontFamily: 'var(--font-family)',
        }}
      />
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          setIsOpen((v) => !v);
        }}
        tabIndex={-1}
        style={{
          position: 'absolute',
          right: chrome === 'inline' ? '2px' : '8px',
          top: '50%',
          transform: 'translateY(-50%)',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: tone === 'muted' ? 'var(--text-muted)' : 'var(--text-secondary)',
          padding: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '22px',
          width: '22px',
        }}
        aria-label={isOpen ? '收起' : '展开'}
      >
        <Icon name={isOpen ? 'expand_less' : 'expand_more'} size={16} />
      </button>

      {isOpen && (
        <>
          {/* 透明遮罩：点击空白处关闭下拉（不依赖事件冒泡，穿透问题最可靠的方式） */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 49 }}
            onMouseDown={() => setIsOpen(false)}
          />
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            width: dropdownWidth ?? '100%',
            maxHeight: '320px',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: 'var(--bg-card)',
            borderRadius: 'var(--radius-default)',
            boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border)',
            zIndex: 50,
            overflow: 'hidden',
          }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {/* 顶部 Tab 栏（搜索模式下隐藏）*/}
          {!isSearching && (
            <div
              style={{
                display: 'flex',
                padding: '4px',
                gap: '2px',
                backgroundColor: 'var(--bg-surface)',
                flexShrink: 0,
              }}
            >
              {MODEL_CATALOG.map((c) => {
                const isActive = c.category === activeCategory;
                return (
                  <button
                    key={c.category}
                    type="button"
                    onClick={() => setActiveCategory(c.category)}
                    style={{
                      flex: 1,
                      padding: '8px',
                      background: isActive ? 'var(--bg-card)' : 'transparent',
                      color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                      border: 'none',
                      borderRadius: 'var(--radius-control)',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: isActive ? 600 : 500,
                      fontFamily: 'var(--font-family)',
                      transition: 'background 0.12s ease, color 0.12s ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isActive) e.currentTarget.style.color = 'var(--text-primary)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive) e.currentTarget.style.color = 'var(--text-secondary)';
                    }}
                  >
                    {c.category}
                  </button>
                );
              })}
            </div>
          )}

          {/* 列表区域 */}
          <div style={{ overflowY: 'auto', padding: '4px', flex: 1, minHeight: 0 }}>
            {isSearching ? (
              searchGroups.length === 0 ? (
                <div style={{ padding: '8px 12px', fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-family)' }}>
                  无匹配模型（直接使用自定义名称）
                </div>
              ) : (
                searchGroups.map((group) => (
                  <div key={group.category}>
                    <div
                      style={{
                        padding: '8px 12px 4px',
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        fontWeight: 600,
                        fontFamily: 'var(--font-family)',
                      }}
                    >
                      {group.category}
                    </div>
                    {group.models.map((model) => renderRow(model, group.category, false))}
                  </div>
                ))
              )
            ) : (
              activeCategoryOrderedModels.map((model) => {
                const isFav = (favorites[activeCategory] || []).includes(model);
                return renderRow(model, activeCategory, isFav); // 仅已收藏项可拖拽
              })
            )}
          </div>
        </div>
        </>
      )}
    </div>
  );
};
