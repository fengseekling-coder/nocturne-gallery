/**
 * Gega Gallery — Media Store
 *
 * 管理媒体文件列表、选中状态、分页、过滤及详情缓存。
 * 通过 Tauri invoke 调用 Rust 后端 Commands。
 */

import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { MediaFile, MediaDetail, MediaFilter, MediaPage, MediaCursor, Tag, AiMetadata } from '../types/media';

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

/** detailCache 最大条目数，超出时淘汰最久未访问的条目 */
const MAX_DETAIL_CACHE = 50;
/** 与 Rust `get_media_files` 的 `per_page.clamp(1, 200)` 一致 */
const MEDIA_PAGE_SIZE = 200;

let latestMediaListRequestToken = 0;
let latestSelectFileRequestToken = 0;
let inflightMediaPageRequest: { key: string; promise: Promise<MediaPage> } | null = null;
const hydratedDetailIds = new Set<string>();
const inflightDetailRequests = new Map<string, Promise<MediaDetail | null>>();

function buildMediaPageRequestKey(
  page: number,
  filter: MediaFilter,
  cursor: MediaCursor | null,
): string {
  return JSON.stringify({ page, filter, cursor });
}

function requestMediaPage(
  page: number,
  filter: MediaFilter,
  cursor: MediaCursor | null,
): Promise<MediaPage> {
  const requestKey = buildMediaPageRequestKey(page, filter, cursor);
  if (inflightMediaPageRequest?.key === requestKey) {
    return inflightMediaPageRequest.promise;
  }

  const args = {
    page,
    perPage: MEDIA_PAGE_SIZE,
    filter: filter || null,
    cursor,
  };

  if (isDev) {
    console.debug('[mediaStore] get_media_files args', args);
  }

  const promise = invoke<MediaPage>('get_media_files', args);

  inflightMediaPageRequest = { key: requestKey, promise };
  promise.finally(() => {
    if (inflightMediaPageRequest?.key === requestKey) {
      inflightMediaPageRequest = null;
    }
  });

  return promise;
}

function requestMediaDetail(id: string): Promise<MediaDetail | null> {
  const existing = inflightDetailRequests.get(id);
  if (existing) {
    return existing;
  }

  const promise = invoke<MediaDetail | null>('get_media_detail', { id });
  inflightDetailRequests.set(id, promise);
  promise.finally(() => {
    if (inflightDetailRequests.get(id) === promise) {
      inflightDetailRequests.delete(id);
    }
  });

  return promise;
}

function buildPlaceholderDetail(file: MediaFile): MediaDetail {
  return {
    file,
    tags: [],
    aiMetadata: null,
    categoryId: null,
    attachments: [],
  };
}

// ----------------------------------------------------------------
// State shape
// ----------------------------------------------------------------

interface MediaState {
  files: MediaFile[];
  selectedId: string | null;
  selectedIds: Set<string>;
  isLoading: boolean;
  currentPage: number;
  totalCount: number;
  filter: MediaFilter;
  /** Keyset 分页游标，null 表示已到末尾或尚未加载过 */
  nextCursor: MediaCursor | null;
  /** 详情缓存：mediaId → MediaDetail */
  detailCache: Record<string, MediaDetail>;
  /** LRU 访问顺序追踪，最新访问的在末尾 */
  detailAccessOrder: string[];
}

// ----------------------------------------------------------------
// Actions shape
// ----------------------------------------------------------------

interface MediaActions {
  /** 拉取文件列表（支持翻页） */
  fetchFiles: (page?: number) => Promise<void>;
  /** 选中某个文件（同时触发详情加载） */
  selectFile: (id: string | null) => Promise<void>;
  /** 原子地切换为单选某个文件，避免多次 store 写入导致卡顿 */
  focusFile: (id: string) => Promise<void>;
  /** 多选：选中多个文件 */
  selectFiles: (ids: string[]) => void;
  /** 重置选中列表：设为指定的文件列表 */
  setSelectedIds: (ids: string[]) => void;
  /** 取消全部选中 */
  deselectAll: () => void;
  /** 切换单个文件选中状态（用于 Shift/Ctrl 点击） */
  toggleFileSelection: (id: string) => void;
  /** 更新标签（乐观更新 + 后端写入） */
  updateTags: (mediaId: string, tags: Tag[]) => Promise<void>;
  /** 更新 AI 元数据（参数与 Rust command 对齐） */
  updateAiMetadata: (mediaId: string, prompt: string, model: string, platform: string) => Promise<void>;
  /** 强制刷新单个素材详情 */
  refreshDetail: (mediaId: string) => Promise<void>;
  /** 添加附件 */
  addAttachments: (mediaId: string, paths: string[]) => Promise<void>;
  /** 移除附件 */
  removeAttachment: (mediaId: string, attachmentId: string) => Promise<void>;
  /** 移至回收站 */
  moveToTrash: (mediaId: string) => Promise<void>;
  /** 将标签追加到已缓存的详情项（用于批量操作后的本地同步） */
  appendTagToCachedItems: (mediaIds: string[], tagName: string) => void;
  /** 更新过滤条件，重置到第 1 页并重新拉取 */
  setFilter: (filter: Partial<MediaFilter>) => Promise<void>;
  /** 根据导航项切换过滤条件 */
  filterByNav: (activeNav: string, sourceFolder: string | null) => Promise<void>;
  /** 根据顶部 Tab 切换过滤条件 */
  setFilterByTab: (tab: string) => Promise<void>;
  /** 综合过滤：nav + tab 同时应用，只发一次 fetch（防止切换导航时双重请求引发闪烁） */
  applyFilters: (activeNav: string, sourceFolder: string | null, activeTab: string) => Promise<void>;
  /** 更新单个文件信息（乐观更新） */
  updateFile: (mediaId: string, updates: Partial<MediaFile>) => void;
  /** 网格解码后补全宽高，用于 Masonry 按原图比例排布 */
  applyLayoutDimensions: (mediaId: string, width: number, height: number) => void;
  /** 刷新单个文件记录（通常用于后台处理完成后补全元数据） */
  refreshFileById: (mediaId: string) => Promise<void>;
}

// ----------------------------------------------------------------
// Default filter
// ----------------------------------------------------------------

const defaultFilter: MediaFilter = {
  tagIds: null,
  categoryId: null,
  categoryName: null,
  onlyTrashed: false,
  fileTypes: null,
  hasAiMetadata: false,
  aiMetadataStatus: null,
};

const isDev = import.meta.env.DEV;

type PendingLayoutDim = { width: number; height: number };
const pendingLayoutDims = new Map<string, PendingLayoutDim>();
let layoutDimFlushTimer: ReturnType<typeof setTimeout> | null = null;
const LAYOUT_DIM_FLUSH_MS = 120;

type MediaStoreSet = (
  partial:
    | Partial<MediaState>
    | ((state: MediaState & MediaActions) => Partial<MediaState & MediaActions>),
) => void;

function flushPendingLayoutDimensions(set: MediaStoreSet): void {
  layoutDimFlushTimer = null;
  if (pendingLayoutDims.size === 0) return;

  const batch = new Map(pendingLayoutDims);
  pendingLayoutDims.clear();

  set((state) => {
    let changed = false;
    const nextFiles = state.files.map((file) => {
      const patch = batch.get(file.id);
      if (!patch) return file;
      if (file.width === patch.width && file.height === patch.height) return file;
      changed = true;
      return { ...file, width: patch.width, height: patch.height };
    });
    if (!changed) return state;

    const nextFileById = new Map(nextFiles.map((f) => [f.id, f] as const));
    let nextDetailCache = state.detailCache;
    for (const mediaId of batch.keys()) {
      const existingDetail = nextDetailCache[mediaId];
      const file = nextFileById.get(mediaId);
      if (!existingDetail || !file) continue;
      if (existingDetail.file.width === file.width && existingDetail.file.height === file.height) continue;
      if (nextDetailCache === state.detailCache) {
        nextDetailCache = { ...state.detailCache };
      }
      nextDetailCache[mediaId] = { ...existingDetail, file };
    }

    for (const [mediaId, patch] of batch) {
      const file = nextFileById.get(mediaId);
      if (!file || file.width !== patch.width || file.height !== patch.height) continue;
      void invoke('update_media_dimensions', { id: mediaId, width: patch.width, height: patch.height }).catch((err) => {
        console.warn('[mediaStore] update_media_dimensions failed:', err);
      });
    }

    return nextDetailCache === state.detailCache
      ? { files: nextFiles }
      : { files: nextFiles, detailCache: nextDetailCache };
  });
}

function scheduleLayoutDimensionsFlush(set: MediaStoreSet): void {
  if (layoutDimFlushTimer !== null) return;
  layoutDimFlushTimer = setTimeout(() => {
    flushPendingLayoutDimensions(set);
  }, LAYOUT_DIM_FLUSH_MS);
}

function reconcileFiles(prevFiles: MediaFile[], incomingFiles: MediaFile[]): MediaFile[] {
  const prevById = new Map(prevFiles.map((file) => [file.id, file] as const));
  return incomingFiles.map((file) => {
    const previous = prevById.get(file.id);
    if (!previous) return file;
    const same = Object.keys(file).every((key) => {
      const typedKey = key as keyof MediaFile;
      return previous[typedKey] === file[typedKey];
    });
    return same ? previous : file;
  });
}

function computeFilesUpdateStats(prevFiles: MediaFile[], nextFiles: MediaFile[], mode: 'replace' | 'append'): void {
  if (!isDev) return;
  const prevById = new Map(prevFiles.map((file) => [file.id, file] as const));
  let reused = 0;
  let replaced = 0;
  for (const file of nextFiles) {
    const previous = prevById.get(file.id);
    if (!previous) continue;
    if (previous === file) reused += 1;
    else replaced += 1;
  }
  const appended = mode === 'append' ? Math.max(0, nextFiles.length - prevFiles.length) : 0;
  console.log(`[Perf][mediaStore] ${mode} prev=${prevFiles.length} next=${nextFiles.length} reused=${reused} replaced=${replaced} appended=${appended}`);
}

function buildFilterSignature(filter: MediaFilter): string {
  return JSON.stringify({
    tagIds: filter.tagIds ? [...filter.tagIds].sort() : [],
    categoryId: filter.categoryId ?? '',
    categoryName: filter.categoryName ?? '',
    onlyTrashed: !!filter.onlyTrashed,
    fileTypes: filter.fileTypes ? [...filter.fileTypes].sort() : [],
    hasAiMetadata: !!filter.hasAiMetadata,
    aiMetadataStatus: filter.aiMetadataStatus ?? '',
    sourceFolder: filter.sourceFolder ?? '',
    keyword: filter.keyword ?? '',
    virtualAiPromptsView: !!filter.virtualAiPromptsView,
  });
}

// ----------------------------------------------------------------
// LRU Helpers (纯函数，避免在 set 回调里写重复逻辑)
// ----------------------------------------------------------------

/**
 * 写入/更新详情缓存并维护 LRU 顺序，超过上限则淘汰最久未访问的条目。
 * 注意：必须返回新的 detailCache 和 detailAccessOrder 对象以保证 zustand 触发订阅。
 */
function writeDetailCache(
  cache: Record<string, MediaDetail>,
  order: string[],
  id: string,
  detail: MediaDetail,
): { detailCache: Record<string, MediaDetail>; detailAccessOrder: string[] } {
  const nextOrder = order.filter((k) => k !== id);
  nextOrder.push(id);
  const nextCache: Record<string, MediaDetail> = { ...cache, [id]: detail };

  // 超过上限时淘汰最旧（数组头部）
  while (nextOrder.length > MAX_DETAIL_CACHE) {
    const evictKey = nextOrder.shift();
    if (evictKey !== undefined && evictKey !== id) {
      delete nextCache[evictKey];
    }
  }

  return { detailCache: nextCache, detailAccessOrder: nextOrder };
}

/**
 * 仅刷新 LRU 访问顺序（命中缓存时调用），不修改 cache 内容。
 */
function touchDetailCache(order: string[], id: string): string[] {
  if (!order.includes(id)) return order;
  const next = order.filter((k) => k !== id);
  next.push(id);
  return next;
}

// ----------------------------------------------------------------
// Store
// ----------------------------------------------------------------

export const useMediaStore = create<MediaState & MediaActions>((set, get) => ({
  // ---- initial state ----
  files: [],
  selectedId: null,
  selectedIds: new Set<string>(),
  isLoading: false,
  currentPage: 1,
  totalCount: 0,
  filter: defaultFilter,
  nextCursor: null,
  detailCache: {},
  detailAccessOrder: [],

  // ----------------------------------------------------------------
  fetchFiles: async (page = 1) => {
    const requestToken = ++latestMediaListRequestToken;
    set({ isLoading: true });
    try {
      const { filter, nextCursor } = get();
      const cursor = page === 1 ? null : (nextCursor ?? null);
      const result = await requestMediaPage(page, filter, cursor);
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      set((state) => {
        const incoming = reconcileFiles(page === 1 ? [] : state.files, result.items);
        const existingIds = page === 1 ? null : new Set(state.files.map((file) => file.id));
        const nextFiles = page === 1
          ? incoming
          : [...state.files, ...incoming.filter((file) => !existingIds?.has(file.id))];
        computeFilesUpdateStats(state.files, nextFiles, page === 1 ? 'replace' : 'append');
        return {
          files: nextFiles,
          currentPage: result.page,
          totalCount: result.total >= 0 ? result.total : state.totalCount,
          nextCursor: result.nextCursor ?? null,
          isLoading: false,
        };
      });
    } catch (err) {
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      console.error('[mediaStore] fetchFiles error:', err);
      set({ isLoading: false });
    }
  },

  // ----------------------------------------------------------------
  selectFile: async (id) => {
    const requestToken = ++latestSelectFileRequestToken;
    const currentSelectedId = get().selectedId;
    if (currentSelectedId === id) {
      return;
    }
    set({
      selectedId: id,
    });
    if (id === null) {
      set({ selectedIds: new Set<string>() });
      return;
    }

    const state = get();
    const cached = state.detailCache[id];

    // 命中缓存：刷新 LRU 顺序后返回，不再重复请求完整详情
    if (cached) {
      set((state) => ({ detailAccessOrder: touchDetailCache(state.detailAccessOrder, id) }));
      if (hydratedDetailIds.has(id) || inflightDetailRequests.has(id)) {
        return;
      }
    } else {
      const fileSummary = state.files.find((file) => file.id === id);
      if (fileSummary) {
        set((state) => writeDetailCache(
          state.detailCache,
          state.detailAccessOrder,
          id,
          buildPlaceholderDetail(fileSummary),
        ));
      }
    }

    // 详情请求放到微任务/异步链路中，避免阻塞翻页/选中交互帧
    queueMicrotask(() => {
      if (requestToken !== latestSelectFileRequestToken || get().selectedId !== id) {
        return;
      }

      void requestMediaDetail(id)
        .then((detail) => {
          if (!detail) return;
          if (requestToken !== latestSelectFileRequestToken || get().selectedId !== id) return;
          hydratedDetailIds.add(id);
          set((state) => writeDetailCache(state.detailCache, state.detailAccessOrder, id, detail));
        })
        .catch((err) => {
          console.error('[mediaStore] selectFile error:', err);
        });
    });

  },

  focusFile: async (id) => {
    const requestToken = ++latestSelectFileRequestToken;
    set((state) => ({
      selectedId: id,
      selectedIds: state.selectedIds.size > 0 ? new Set<string>() : state.selectedIds,
    }));

    const state = get();
    const cached = state.detailCache[id];
    if (cached) {
      set((state) => ({ detailAccessOrder: touchDetailCache(state.detailAccessOrder, id) }));
      if (hydratedDetailIds.has(id) || inflightDetailRequests.has(id)) {
        return;
      }
    } else {
      const fileSummary = state.files.find((file) => file.id === id);
      if (fileSummary) {
        set((state) => writeDetailCache(state.detailCache, state.detailAccessOrder, id, buildPlaceholderDetail(fileSummary)));
      }
    }

    queueMicrotask(() => {
      if (requestToken !== latestSelectFileRequestToken || get().selectedId !== id) return;
      void requestMediaDetail(id)
        .then((detail) => {
          if (!detail) return;
          if (requestToken !== latestSelectFileRequestToken || get().selectedId !== id) return;
          hydratedDetailIds.add(id);
          set((state) => writeDetailCache(state.detailCache, state.detailAccessOrder, id, detail));
        })
        .catch((err) => {
          console.error('[mediaStore] focusFile error:', err);
        });
    });
  },
  // ----------------------------------------------------------------
  selectFiles: (ids) => {
    set((state) => {
      const newSelectedIds = new Set(state.selectedIds);
      ids.forEach((id) => newSelectedIds.add(id));
      return { selectedIds: newSelectedIds };
    });
  },
  // ----------------------------------------------------------------
  setSelectedIds: (ids: string[]) => {
    set({ selectedIds: new Set(ids) });
  },
  // ----------------------------------------------------------------
  deselectAll: () => {
    set({ selectedId: null, selectedIds: new Set<string>() });
  },
  // ----------------------------------------------------------------
  toggleFileSelection: (id) => {
    set((state) => {
      const newSelectedIds = new Set(state.selectedIds);
      if (newSelectedIds.has(id)) {
        newSelectedIds.delete(id);
      } else {
        newSelectedIds.add(id);
      }
      return { selectedIds: newSelectedIds };
    });
  },

  // ----------------------------------------------------------------
  updateTags: async (mediaId, tags) => {
    // 乐观更新缓存（就地 merge，不触发 LRU 顺序变化）
    set((state) => {
      const existing = state.detailCache[mediaId];
      if (!existing) return state;
      return {
        detailCache: {
          ...state.detailCache,
          [mediaId]: { ...existing, tags },
        },
      };
    });

    try {
      await invoke('update_tags', {
        id: mediaId,
        tags: tags.map((t) => t.name),
      });
    } catch (err) {
      console.error('[mediaStore] updateTags error:', err);
      // 回滚：重新拉取详情
      try {
        const detail = await invoke<MediaDetail>('get_media_detail', { id: mediaId });
        set((state) => writeDetailCache(state.detailCache, state.detailAccessOrder, mediaId, detail));
      } catch {
        // 静默失败
      }
    }
  },

  // ----------------------------------------------------------------
  updateAiMetadata: async (mediaId, prompt, model, platform) => {
    // 乐观更新缓存
    set((state) => {
      const existing = state.detailCache[mediaId];
      if (!existing) return state;
      const merged: AiMetadata = existing.aiMetadata
        ? { ...existing.aiMetadata, promptText: prompt, modelName: model, platform }
        : {
            id: '',
            mediaId,
            promptText: prompt,
            modelName: model,
            platform,
            createdAt: Date.now(),
          };
      return {
        detailCache: {
          ...state.detailCache,
          [mediaId]: { ...existing, aiMetadata: merged },
        },
      };
    });

    try {
      await invoke('update_ai_metadata', { id: mediaId, prompt, model, platform });
    } catch (err) {
      console.error('[mediaStore] updateAiMetadata error:', err);
    }
  },

  // ----------------------------------------------------------------
  refreshDetail: async (mediaId) => {
    try {
      const detail = await requestMediaDetail(mediaId);
      if (detail) {
        hydratedDetailIds.add(mediaId);
        set((state) => writeDetailCache(state.detailCache, state.detailAccessOrder, mediaId, detail));
      }
    } catch (err) {
      console.error('[mediaStore] refreshDetail error:', err);
    }
  },

  // ----------------------------------------------------------------
  addAttachments: async (mediaId, paths) => {
    try {
      await invoke('add_media_attachments', { media_id: mediaId, paths });
      await get().refreshDetail(mediaId);
      window.dispatchEvent(new CustomEvent('group-counts-updated'));
    } catch (err) {
      console.error('[mediaStore] addAttachments error:', err);
      throw err;
    }
  },

  // ----------------------------------------------------------------
  removeAttachment: async (mediaId, attachmentId) => {
    try {
      await invoke('remove_media_attachment', { attachmentId });
      await get().refreshDetail(mediaId);
      window.dispatchEvent(new CustomEvent('group-counts-updated'));
    } catch (err) {
      console.error('[mediaStore] removeAttachment error:', err);
      throw err;
    }
  },

  // ----------------------------------------------------------------
  moveToTrash: async (mediaId) => {
    try {
      await invoke('move_to_trash', { id: mediaId });
      // 从列表中移除，同步清理详情缓存
      set((state) => {
        const { [mediaId]: _removed, ...rest } = state.detailCache;
        return {
          files: state.files.filter((f) => f.id !== mediaId),
          selectedId: state.selectedId === mediaId ? null : state.selectedId,
          totalCount: Math.max(0, state.totalCount - 1),
          detailCache: rest,
          detailAccessOrder: state.detailAccessOrder.filter((k) => k !== mediaId),
        };
      });
    } catch (err) {
      console.error('[mediaStore] moveToTrash error:', err);
    }
  },

  // ----------------------------------------------------------------
  appendTagToCachedItems: (mediaIds, tagName) => {
    set((state) => {
      let changed = false;
      const nextDetailCache = { ...state.detailCache };

      for (const mediaId of mediaIds) {
        const existing = nextDetailCache[mediaId];
        if (!existing || existing.tags.some((tag) => tag.name === tagName)) {
          continue;
        }

        changed = true;
        nextDetailCache[mediaId] = {
          ...existing,
          tags: [
            ...existing.tags,
            {
              id: crypto.randomUUID(),
              name: tagName,
              color: 'var(--accent)',
            },
          ],
        };
      }

      if (!changed) {
        return state;
      }

      return {
        detailCache: nextDetailCache,
      };
    });
  },

  // ----------------------------------------------------------------
  setFilter: async (partial) => {
    const current = get().filter;
    const newFilter: MediaFilter = { ...current, ...partial };
    if (buildFilterSignature(current) === buildFilterSignature(newFilter)) {
      return;
    }
    // 不清空 files：让 fetchFiles 返回时自然替换，避免 [] → new 的空白闪烁
    set({ filter: newFilter, currentPage: 1, nextCursor: null });
    await get().fetchFiles(1);
  },

  // ----------------------------------------------------------------
  /** 根据导航项切换过滤条件 */
  filterByNav: async (activeNav: string, sourceFolder: string | null) => {
    const requestToken = ++latestMediaListRequestToken;
    const isAiPromptsNav = activeNav === 'ai-prompts';
    const filter: MediaFilter = {
      tagIds: null,
      categoryId: null,
      categoryName: null,
      onlyTrashed: activeNav === 'trash',
      fileTypes: null,
      hasAiMetadata: false,
      aiMetadataStatus: null,
      sourceFolder: isAiPromptsNav ? undefined : (sourceFolder || undefined),
      virtualAiPromptsView: isAiPromptsNav,
    };
    // 先设置 isLoading，不提前清空 files（避免闪烁空状态）
    set({ filter, isLoading: true, nextCursor: null });
    try {
      const result = await requestMediaPage(1, filter, null);
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      set((state) => {
        const nextFiles = reconcileFiles([], result.items);
        computeFilesUpdateStats(state.files, nextFiles, 'replace');
        return {
          files: nextFiles,
          currentPage: result.page,
          totalCount: result.total,
          nextCursor: result.nextCursor ?? null,
          isLoading: false,
        };
      });
    } catch (err) {
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      console.error('[mediaStore] filterByNav error:', err);
      set({ isLoading: false });
    }
  },

  // ----------------------------------------------------------------
  /** 根据顶部 Tab 切换过滤条件 */
  setFilterByTab: async (tab: string) => {
    const requestToken = ++latestMediaListRequestToken;
    const { filter: currentFilter } = get();
    const newFilter: MediaFilter = {
      ...currentFilter,
      fileTypes: null,
      aiMetadataStatus: null,
    };

    // 根据 Tab 名称设置过滤条件
    if (tab === '图片') {
      newFilter.fileTypes = ['image'];
    } else if (tab === '视频') {
      newFilter.fileTypes = ['video'];
    } else if (tab === '已填写') {
      newFilter.aiMetadataStatus = 'filled';
    } else if (tab === '未填写') {
      newFilter.aiMetadataStatus = 'empty';
    }
    // 「全部」保持 null，不过滤

    // 先设置 isLoading，不提前清空 files
    set({ filter: newFilter, isLoading: true, nextCursor: null });
    try {
      const result = await requestMediaPage(1, newFilter, null);
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      set((state) => {
        const nextFiles = reconcileFiles([], result.items);
        computeFilesUpdateStats(state.files, nextFiles, 'replace');
        return {
          files: nextFiles,
          currentPage: 1,
          totalCount: result.total,
          nextCursor: result.nextCursor ?? null,
          isLoading: false,
        };
      });
    } catch (err) {
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      console.error('[mediaStore] setFilterByTab error:', err);
      set({ isLoading: false });
    }
  },

  // ----------------------------------------------------------------
  /** 综合过滤：一次 fetch 同时应用 nav + tab，解决切换导航时双重请求闪烁问题 */
  applyFilters: async (activeNav: string, sourceFolder: string | null, activeTab: string) => {
    const requestToken = ++latestMediaListRequestToken;
    const { filter: currentFilter } = get();
    const isAiPromptsNav = activeNav === 'ai-prompts';
    const filter: MediaFilter = {
      tagIds: currentFilter.tagIds,
      categoryId: currentFilter.categoryId,
      categoryName: null,
      onlyTrashed: activeNav === 'trash',
      fileTypes: null,
      hasAiMetadata: false,
      aiMetadataStatus: null,
      sourceFolder: isAiPromptsNav ? undefined : (sourceFolder || undefined),
      keyword: currentFilter.keyword ?? null,
      virtualAiPromptsView: isAiPromptsNav,
    };

    if (activeTab === '图片') {
      filter.fileTypes = ['image'];
      filter.aiMetadataStatus = null;
    } else if (activeTab === '视频') {
      filter.fileTypes = ['video'];
      filter.aiMetadataStatus = null;
    } else if (activeTab === '已填写') {
      filter.fileTypes = null;
      filter.aiMetadataStatus = 'filled';
    } else if (activeTab === '未填写') {
      filter.fileTypes = null;
      filter.aiMetadataStatus = 'empty';
    } else if (activeTab && activeTab !== '全部') {
      filter.categoryName = activeTab;
    }

    set({ filter, isLoading: true, nextCursor: null });
    try {
      const result = await requestMediaPage(1, filter, null);
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      set((state) => {
        const nextFiles = reconcileFiles([], result.items);
        computeFilesUpdateStats(state.files, nextFiles, 'replace');
        return {
          files: nextFiles,
          currentPage: result.page,
          totalCount: result.total,
          nextCursor: result.nextCursor ?? null,
          isLoading: false,
        };
      });
    } catch (err) {
      if (requestToken !== latestMediaListRequestToken) {
        return;
      }
      console.error('[mediaStore] applyFilters error:', err);
      set({ isLoading: false });
    }
  },

  // ----------------------------------------------------------------
  /** 更新单个文件信息（乐观更新，单次 set 避免触发两次 React 渲染） */
  updateFile: (mediaId, updates) => {
    set((state) => {
      const updatedFiles = state.files.map((file) =>
        file.id === mediaId ? { ...file, ...updates } : file
      );
      const existingDetail = state.detailCache[mediaId];
      if (!existingDetail) {
        return { files: updatedFiles };
      }
      return {
        files: updatedFiles,
        detailCache: {
          ...state.detailCache,
          [mediaId]: { ...existingDetail, file: { ...existingDetail.file, ...updates } },
        },
      };
    });
  },

  // ----------------------------------------------------------------
  applyLayoutDimensions: (mediaId, width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return;
    }
    const file = get().files.find((f) => f.id === mediaId);
    if (file && file.width === width && file.height === height) {
      return;
    }
    pendingLayoutDims.set(mediaId, { width, height });
    scheduleLayoutDimensionsFlush(set);
  },

  // ----------------------------------------------------------------
  refreshFileById: async (mediaId) => {
    try {
      const detail = await invoke<MediaDetail | null>('get_media_detail', { id: mediaId });
      if (!detail) return;

      set((state) => {
        const updatedFiles = state.files.map((file) =>
          file.id === mediaId ? detail.file : file
        );

        const existingDetail = state.detailCache[mediaId];
        if (!existingDetail) {
          return { files: updatedFiles };
        }

        return {
          files: updatedFiles,
          detailCache: {
            ...state.detailCache,
            [mediaId]: detail,
          },
        };
      });
    } catch (err) {
      console.warn('[mediaStore] refreshFileById failed:', err);
    }
  },
}));
