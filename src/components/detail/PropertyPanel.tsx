/**
 * PropertyPanel — 右侧属性浏览面板
 *
 * 从 DetailPanel 拆出：单选详情 + 多选面板 + 标签/Prompt/附件编辑。
 * 仅在 !isAIMode 时挂载。
 */

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useMediaStore } from '../../stores/mediaStore';
import { useUiStore } from '../../stores/uiStore';
import { TagBadge } from '../common/TagBadge';
import { Icon } from '../common/Icon';
import { ModelCombobox } from './ModelCombobox';
import type { MediaAttachment, MediaDetail } from '../../types/media';
import { normalizeTransferredFilePath, pathToFileUri } from '../../utils/filePath';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

interface PropertyPanelProps {
  inspectorMediaId: string | null;
  detail: MediaDetail | null;
  hasSingleSelection: boolean;
  selectedIdsCount: number;
  selectedIdsRef: React.MutableRefObject<Set<string>>;
  inspectorWidth: number;
  isAIMode: boolean;
  toggleAIMode: () => Promise<void>;
  onAnalyzeCurrentItem: (detail: MediaDetail) => void;
}

interface MultiSelectPanelProps {
  count: number;
  onBatchTag: () => void;
  onBatchTrash: () => Promise<void>;
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm']);
const isVideoFile = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTENSIONS.has(ext);
};

const DIRECT_IMAGE_PREVIEW_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'avif']);
const canPreviewOriginalImage = (filename: string): boolean => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return DIRECT_IMAGE_PREVIEW_EXTENSIONS.has(ext);
};
const MAX_INLINE_ORIGINAL_PREVIEW_BYTES = 2 * 1024 * 1024;

const DIRECT_ATTACHMENT_PREVIEW_EXTENSIONS = DIRECT_IMAGE_PREVIEW_EXTENSIONS;

const MIME_BY_EXTENSION: Record<string, string> = {
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'svg': 'image/svg+xml',
  'avif': 'image/avif',
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
  'avi': 'video/x-msvideo',
  'mkv': 'video/x-matroska',
  'webm': 'video/webm',
};

const ATTACHMENT_GRID_COLUMNS = 3;
const ATTACHMENT_GRID_ROWS = 2;
const ATTACHMENT_GRID_GAP = 6;

// ----------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------

interface MetaRowProps {
  label: string;
  value: string;
  onClick?: () => void;
  title?: string;
}

const MetaRow: React.FC<MetaRowProps> = ({ label, value, onClick, title }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '8px' }}>
    <span style={{ fontFamily: 'var(--font-family)', fontSize: '11px', fontWeight: 400, color: 'var(--text-muted)' }}>
      {label}
    </span>
    <span
      onClick={onClick}
      title={title}
      style={{
        fontFamily: 'var(--font-family)', fontSize: '11px', color: 'var(--text-secondary)',
        cursor: onClick ? 'pointer' : 'default', overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', textDecoration: onClick ? 'underline dotted' : 'none',
      }}
    >
      {value}
    </span>
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <p style={{ fontFamily: 'var(--font-family)', fontSize: '11px', fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', margin: '0 0 8px', ...style }}>
    {children}
  </p>
);

const MultiSelectPanel: React.FC<MultiSelectPanelProps> = React.memo(({ count, onBatchTag, onBatchTrash }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <div style={{ width: 40, height: 40, borderRadius: '50%', backgroundColor: 'var(--accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <Icon name="photo_library" size={20} color="var(--accent)" />
      </div>
      <div>
        <div style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)' }}>已选择 {count} 张</div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>按 Esc 取消选择</div>
      </div>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>批量操作</div>
      <button onClick={onBatchTag} style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-surface)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--border)', borderRadius: 'var(--radius-default)', padding: '10px 14px', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
        <Icon name="label" size={16} /> 批量添加标签
      </button>
      <button onClick={onBatchTrash} style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-surface)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--border)', borderRadius: 'var(--radius-default)', padding: '10px 14px', color: 'var(--error)', fontSize: '13px', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
        <Icon name="delete" size={16} /> 移入回收站
      </button>
    </div>
  </div>
));

const ModeHintCard: React.FC<{ title: string; body: string }> = React.memo(({ title, body }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', borderRadius: '16px', background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
    <SectionLabel style={{ marginBottom: '2px' }}>{title}</SectionLabel>
    <div style={{ padding: '12px', borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
      {body}
    </div>
  </div>
));

const AttachmentNotice: React.FC = React.memo(() => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', borderRadius: '16px', background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
    <SectionLabel style={{ marginBottom: '2px' }}>附件说明</SectionLabel>
    <div style={{ padding: '12px', borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
      当前右侧面板显示的是附件文件信息。<br />附件是外部引用，不继承素材本体的标签、Prompt 和 AI 元数据。
    </div>
  </div>
));

// ----------------------------------------------------------------
// FileNameEditor
// ----------------------------------------------------------------

interface FileNameEditorProps {
  filename: string;
  fileId: string;
  showToast: (message: string) => void;
}

const FileNameEditorInternal: React.FC<FileNameEditorProps> = React.memo(({ filename, fileId, showToast }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(filename);
  const inputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);
  const updateFile = useMediaStore(state => state.updateFile);

  const getFileExtension = (fn: string) => { const i = fn.lastIndexOf('.'); return i > 0 ? fn.substring(i) : ''; };
  const getNameWithoutExtension = (fn: string) => { const i = fn.lastIndexOf('.'); return i > 0 ? fn.substring(0, i) : fn; };

  const handleDoubleClick = () => { setIsEditing(true); setTempName(getNameWithoutExtension(filename)); };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') saveFileName();
    else if (e.key === 'Escape') { setTempName(getNameWithoutExtension(filename)); setIsEditing(false); }
  };

  const saveFileName = async () => {
    if (isSavingRef.current) return;
    const trimmedName = tempName.trim();
    if (!trimmedName) { setTempName(getNameWithoutExtension(filename)); setIsEditing(false); return; }
    try {
      const ext = getFileExtension(filename);
      const newName = `${trimmedName}${ext}`;
      if (newName === filename) { setTempName(trimmedName); setIsEditing(false); return; }
      isSavingRef.current = true;
      await invoke('rename_file', { fileId, newName });
      updateFile(fileId, { filename: newName });
    } catch (err) {
      console.error('[FileNameEditor] rename failed:', err);
      showToast('重命名失败');
    } finally {
      isSavingRef.current = false;
    }
  };

  // ... remaining FileNameEditor JSX unchanged from original
  // See DetailPanel.tsx lines 4069-4200+ for full implementation
  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={tempName}
        onChange={(e) => setTempName(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={saveFileName}
        autoFocus
        style={{
          fontFamily: 'var(--font-family)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.015em',
          color: 'var(--text-primary)', background: 'transparent', border: 'none',
          borderBottom: '1px solid var(--accent)', outline: 'none', padding: 0, width: '100%',
        }}
      />
    );
  }

  return (
    <h2
      onDoubleClick={handleDoubleClick}
      style={{
        fontFamily: 'var(--font-family)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.015em',
        color: 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis',
        whiteSpace: 'nowrap', cursor: 'text',
      }}
    >
      {filename}
    </h2>
  );
});

// ----------------------------------------------------------------
// PropertyPanel main component
// ----------------------------------------------------------------

export const PropertyPanel: React.FC<PropertyPanelProps> = React.memo(({
  inspectorMediaId,
  detail,
  hasSingleSelection,
  selectedIdsCount,
  selectedIdsRef,
  inspectorWidth,
  isAIMode,
  toggleAIMode,
  onAnalyzeCurrentItem,
}) => {
  const showToast = useUiStore((s) => s.showToast);
  const showConfirm = useUiStore((s) => s.showConfirm);
  const updateTags = useMediaStore((s) => s.updateTags);
  const updateAiMetadata = useMediaStore((s) => s.updateAiMetadata);
  const addAttachments = useMediaStore((s) => s.addAttachments);
  const appendTagToCachedItems = useMediaStore((s) => s.appendTagToCachedItems);
  const fetchFiles = useMediaStore((s) => s.fetchFiles);
  const deselectAll = useMediaStore((s) => s.deselectAll);
  const openCanvasAttachmentPreview = useUiStore((s) => s.openCanvasAttachmentPreview);
  const canvasAttachmentPreview = useUiStore((s) => s.canvasAttachmentPreview);

  // Property-specific state
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [promptDraft, setPromptDraft] = useState<string>('');
  const [modelDraft, setModelDraft] = useState<string>('');
  const [platformDraft, setPlatformDraft] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [isPromptOverflow, setIsPromptOverflow] = useState(false);
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
  const [batchTagInput, setBatchTagInput] = useState('');
  const [isAddingBatchTag, setIsAddingBatchTag] = useState(false);
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const [attachmentPreviewMap, setAttachmentPreviewMap] = useState<Record<string, string>>({});
  const [attachmentPreviewLoadingMap, setAttachmentPreviewLoadingMap] = useState<Record<string, boolean>>({});
  const [attachmentGridCellSize, setAttachmentGridCellSize] = useState<number | null>(null);
  const attachmentPreviewCacheRef = useRef<Map<string, string>>(new Map());
  const attachmentPreviewRequestSeqRef = useRef(0);

  const newTagInputRef = useRef<HTMLInputElement>(null);
  const inspectorContentRef = useRef<HTMLDivElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentSectionRef = useRef<HTMLDivElement>(null);
  const attachmentGridRef = useRef<HTMLDivElement>(null);
  const pendingCursorPosRef = useRef<number | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailRef = useRef(detail);

  const COLLAPSED_PROMPT_HEIGHT = 160;

  useEffect(() => { detailRef.current = detail; }, [detail]);

  // Helper callbacks
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }, []);

  const formatTimestamp = useCallback((ts: number): string => {
    return new Date(ts * 1000).toLocaleString('zh-CN');
  }, []);

  const attachmentTypeLabel = useCallback((attachment: MediaAttachment): string => {
    const ext = attachment.filename.split('.').pop()?.toUpperCase();
    return ext || '文件';
  }, []);

  const isDirectAttachmentPreview = useCallback((attachment: MediaAttachment) => {
    const ext = attachment.filename.split('.').pop()?.toLowerCase() ?? '';
    return DIRECT_ATTACHMENT_PREVIEW_EXTENSIONS.has(ext);
  }, []);

  const fileToDataUrl = useCallback((file: File): Promise<string> => (
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
      reader.readAsDataURL(file);
    })
  ), []);

  const persistClipboardFileToTemp = useCallback(async (file: File) => {
    const dataUrl = await fileToDataUrl(file);
    return invoke<string>('write_temp_file', { base64Data: dataUrl });
  }, [fileToDataUrl]);

  const extractAttachmentPathsFromTransfer = useCallback(async (transfer: DataTransfer | null) => {
    if (!transfer) return [] as string[];
    const paths = new Set<string>();
    const addPath = (candidate: string | null | undefined) => {
      if (!candidate) return;
      const normalized = normalizeTransferredFilePath(candidate);
      if (normalized) paths.add(normalized);
    };
    try {
      const payload = transfer.getData('application/json');
      if (payload) {
        const parsed = JSON.parse(payload) as { files?: Array<{ filePath?: string }>; filePath?: string };
        parsed.files?.forEach((item) => addPath(item.filePath));
        addPath(parsed.filePath);
      }
    } catch { /* ignore */ }
    transfer.getData('text/uri-list').split(/\r?\n/).forEach((value: string) => addPath(value));
    transfer.getData('text/plain').split(/\r?\n/).forEach((value: string) => addPath(value));
    const nativeFiles = Array.from(transfer.files ?? []) as Array<File & { path?: string }>;
    for (const file of nativeFiles) {
      if (file.path) { addPath(file.path); }
      else if (file.type.startsWith('image/')) {
        try { const tempPath = await persistClipboardFileToTemp(file); addPath(tempPath); }
        catch (err) { console.error('[PropertyPanel] Failed to persist clipboard image:', err); }
      }
    }
    return Array.from(paths);
  }, [persistClipboardFileToTemp]);

  const handleAddAttachment = useCallback(async () => {
    if (!detail) return;
    try {
      const selected = await open({ multiple: true, directory: false, title: '选择附件文件' });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected.filter((item): item is string => typeof item === 'string') : [selected];
      if (paths.length === 0) return;
      await addAttachments(detail.file.id, paths);
      showToast(paths.length === 1 ? '附件已添加' : `已添加 ${paths.length} 个附件`);
    } catch (err) {
      console.error('[PropertyPanel] add attachment error:', err);
      showToast(err instanceof Error ? err.message : '添加附件失败');
    }
  }, [addAttachments, detail, showToast]);

  const handleOpenAttachment = useCallback(async (attachment: MediaAttachment) => {
    try { await invoke('open_path', { path: attachment.filepath }); }
    catch { showToast('打开附件失败'); }
  }, [showToast]);

  const handleOpenAttachmentPreview = useCallback((attachment: MediaAttachment) => {
    const previewSrc = isDirectAttachmentPreview(attachment)
      ? convertFileSrc(attachment.filepath)
      : (attachmentPreviewMap[attachment.id] ?? null);
    if (!previewSrc) { void handleOpenAttachment(attachment); return; }
    setPreviewAttachmentId(attachment.id);
  }, [attachmentPreviewMap, handleOpenAttachment, isDirectAttachmentPreview]);

  const handleShowAttachmentInFolder = useCallback(async (attachment: MediaAttachment) => {
    try { await invoke('show_in_folder', { path: attachment.filepath }); }
    catch { showToast('打开附件位置失败'); }
  }, [showToast]);

  const attachPathsToCurrentDetail = useCallback(async (paths: string[]) => {
    if (!detail) return;
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
    if (uniquePaths.length === 0) return;
    try {
      await addAttachments(detail.file.id, uniquePaths);
      showToast(uniquePaths.length === 1 ? '附件已添加' : `已添加 ${uniquePaths.length} 个附件`);
    } catch (err) {
      console.error('[PropertyPanel] attach paths failed:', err);
      showToast(err instanceof Error ? err.message : '添加附件失败');
    }
  }, [addAttachments, detail, showToast]);

  const handleAttachmentDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation();
    setIsAttachmentDragOver(false);
    const paths = await extractAttachmentPathsFromTransfer(event.dataTransfer);
    await attachPathsToCurrentDetail(paths);
  }, [attachPathsToCurrentDetail, extractAttachmentPathsFromTransfer]);

  const handleAttachmentPaste = useCallback(async (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!detail) return;
    const paths = await extractAttachmentPathsFromTransfer(event.clipboardData);
    if (paths.length === 0) return;
    event.preventDefault();
    await attachPathsToCurrentDetail(paths);
  }, [attachPathsToCurrentDetail, detail, extractAttachmentPathsFromTransfer]);

  const handleAttachmentKeyDown = useCallback(async (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!selectedAttachmentId || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || !detail) return;
    const attachment = detail.attachments.find((item) => item.id === selectedAttachmentId);
    if (!attachment) return;
    event.preventDefault();
    try { await navigator.clipboard.writeText(attachment.filepath); showToast('附件路径已复制'); }
    catch { showToast('复制附件路径失败'); }
  }, [detail, selectedAttachmentId, showToast]);

  const handleAttachmentDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, attachment: MediaAttachment) => {
    const ext = attachment.filename.split('.').pop()?.toLowerCase() ?? '';
    const fileUri = pathToFileUri(attachment.filepath);
    const mimeType = attachment.mimeType || MIME_BY_EXTENSION[ext] || 'application/octet-stream';
    event.dataTransfer.setData('application/json', JSON.stringify({
      filePath: attachment.filepath, filename: attachment.filename,
      files: [{ filePath: attachment.filepath, filename: attachment.filename }],
    }));
    event.dataTransfer.setData('text/plain', attachment.filepath);
    event.dataTransfer.setData('text/uri-list', `${fileUri}\r\n`);
    event.dataTransfer.setData('URL', fileUri);
    event.dataTransfer.setData('DownloadURL', `${mimeType}:${attachment.filename}:${fileUri}`);
    event.dataTransfer.effectAllowed = 'copyMove';
  }, []);

  // Debounced AI metadata save
  const debouncedSaveAi = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const currentDetail = detailRef.current;
      if (!currentDetail) return;
      updateAiMetadata(currentDetail.file.id, promptDraft || '', modelDraft || '', platformDraft || '');
    }, 800);
  }, [promptDraft, modelDraft, platformDraft, updateAiMetadata]);

  // Tag callbacks
  const commitDraftTags = useCallback(async () => {
    if (!detail) return false;
    const draftNames = newTagName.split(/[,\n，]+/).map((name) => name.trim()).filter(Boolean);
    if (draftNames.length === 0) { setNewTagName(''); return false; }
    const existingNames = new Set(detail.tags.map((tag) => tag.name.trim().toLowerCase()));
    const uniqueNames = draftNames.filter((name) => !existingNames.has(name.toLowerCase()));
    const duplicateCount = draftNames.length - uniqueNames.length;
    if (uniqueNames.length === 0) {
      showToast(draftNames.length === 1 ? '标签已存在' : '这些标签已存在');
      setNewTagName(''); return false;
    }
    await updateTags(detail.file.id, [
      ...detail.tags,
      ...uniqueNames.map((name) => ({ id: crypto.randomUUID(), name, color: 'var(--accent)' })),
    ]);
    setNewTagName('');
    if (duplicateCount > 0) showToast(`已添加 ${uniqueNames.length} 个标签，${duplicateCount} 个已存在`);
    return true;
  }, [detail, newTagName, showToast, updateTags]);

  const handleInlineRemoveTag = useCallback(async (tagId: string) => {
    if (!detail) return;
    const nextTags = detail.tags.filter((tag) => tag.id !== tagId);
    await updateTags(detail.file.id, nextTags);
  }, [detail, updateTags]);

  const handleCopyPrompt = useCallback(async () => {
    if (!promptDraft) return;
    try { await navigator.clipboard.writeText(promptDraft); setIsCopied(true); setTimeout(() => setIsCopied(false), 1500); }
    catch { showToast('复制失败'); }
  }, [promptDraft, showToast]);

  const handlePromptKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = el.selectionStart, end = el.selectionEnd;
      const INDENT = '  ';
      const next = promptDraft.slice(0, start) + INDENT + promptDraft.slice(end);
      pendingCursorPosRef.current = start + INDENT.length;
      setPromptDraft(next);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const start = el.selectionStart, end = el.selectionEnd;
      const lineStart = promptDraft.lastIndexOf('\n', start - 1) + 1;
      const currentLine = promptDraft.slice(lineStart, start);
      const match = currentLine.match(/^[ \t]*/);
      const indent = match ? match[0] : '';
      const lastChar = promptDraft[start - 1];
      const extra = lastChar === '{' || lastChar === '[' ? '  ' : '';
      if (!indent && !extra) return;
      e.preventDefault();
      const insert = '\n' + indent + extra;
      const next = promptDraft.slice(0, start) + insert + promptDraft.slice(end);
      pendingCursorPosRef.current = start + insert.length;
      setPromptDraft(next);
    }
  }, [promptDraft]);

  const handlePromptWheel = useCallback((event: React.WheelEvent<HTMLTextAreaElement>) => {
    const container = inspectorContentRef.current;
    const textarea = promptTextareaRef.current;
    if (!container) return;
    if (textarea && textarea.scrollHeight > textarea.clientHeight) {
      const isScrollingDown = event.deltaY > 0, isScrollingUp = event.deltaY < 0;
      const isAtTop = textarea.scrollTop <= 0;
      const isAtBottom = textarea.scrollTop + textarea.clientHeight >= textarea.scrollHeight - 1;
      if ((isScrollingDown && !isAtBottom) || (isScrollingUp && !isAtTop)) return;
    }
    if (container.scrollHeight <= container.clientHeight) return;
    event.preventDefault();
    container.scrollTop += event.deltaY;
  }, []);

  const startEditingTags = () => {
    if (!detail) return;
    setIsEditingTags(true);
    setTimeout(() => newTagInputRef.current?.focus(), 50);
  };

  const handleBlurAndEscape = async () => {
    if (!isEditingTags) return;
    await commitDraftTags();
    setNewTagName(''); setIsEditingTags(false);
  };

  const handleDraftAddTag = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); setNewTagName(''); setIsEditingTags(false); return; }
    if (e.key === 'Enter') { e.preventDefault(); await commitDraftTags(); setIsEditingTags(false); }
  };

  const getAttachmentPreviewSrc = useCallback((attachment: MediaAttachment) => {
    const ext = attachment.filename.split('.').pop()?.toLowerCase() ?? '';
    if (DIRECT_ATTACHMENT_PREVIEW_EXTENSIONS.has(ext)) return convertFileSrc(attachment.filepath);
    return attachmentPreviewMap[attachment.id] ?? null;
  }, [attachmentPreviewMap]);

  // Computed values
  const dominantColors = useMemo(() => {
    if (!detail?.file.colorDominant) return [] as string[];
    try { const parsed = JSON.parse(detail.file.colorDominant) as string[]; return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }, [detail?.file.colorDominant]);

  const detailPreviewSrc = useMemo(() => {
    if (!detail) return null;
    const previewPath = detail.file.thumbnailPreviewPath || detail.file.thumbnailPath;
    if (previewPath) return convertFileSrc(previewPath);
    if (detail.file.fileSize <= MAX_INLINE_ORIGINAL_PREVIEW_BYTES && canPreviewOriginalImage(detail.file.filename))
      return convertFileSrc(detail.file.filepath);
    return null;
  }, [detail]);

  const canvasActiveAttachmentId = useMemo(() => {
    if (!canvasAttachmentPreview || canvasAttachmentPreview.ownerMediaId !== inspectorMediaId) return null;
    return canvasAttachmentPreview.activeId ?? canvasAttachmentPreview.items[0]?.id ?? null;
  }, [canvasAttachmentPreview, inspectorMediaId]);

  const inspectorAttachment = useMemo(() => {
    const attachmentId = canvasActiveAttachmentId ?? previewAttachmentId;
    if (!attachmentId) return null;
    return detail?.attachments.find((attachment) => attachment.id === attachmentId) ?? null;
  }, [canvasActiveAttachmentId, detail?.attachments, previewAttachmentId]);

  const handleCopyPath = useCallback(async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(inspectorAttachment?.filepath ?? detail.file.filepath);
      showToast(inspectorAttachment ? '附件路径已复制' : '文件路径已复制');
    } catch { showToast(inspectorAttachment ? '复制附件路径失败' : '复制失败'); }
  }, [detail, inspectorAttachment, showToast]);

  const handleShowInFolder = useCallback(async () => {
    if (!detail) return;
    try { await invoke('show_in_folder', { path: inspectorAttachment?.filepath ?? detail.file.filepath }); }
    catch { showToast(inspectorAttachment ? '打开附件位置失败' : '打开所在位置失败'); }
  }, [detail, inspectorAttachment, showToast]);

  const inspectorAttachmentPreviewSrc = useMemo(() => {
    if (!inspectorAttachment) return null;
    return isDirectAttachmentPreview(inspectorAttachment)
      ? convertFileSrc(inspectorAttachment.filepath)
      : (attachmentPreviewMap[inspectorAttachment.id] ?? null);
  }, [attachmentPreviewMap, inspectorAttachment, isDirectAttachmentPreview]);

  const activePreviewAttachment = useMemo(
    () => detail?.attachments.find((attachment) => attachment.id === previewAttachmentId) ?? null,
    [detail?.attachments, previewAttachmentId],
  );

  const activePreviewAttachmentSrc = useMemo(() => {
    if (!activePreviewAttachment) return null;
    return isDirectAttachmentPreview(activePreviewAttachment)
      ? convertFileSrc(activePreviewAttachment.filepath)
      : (attachmentPreviewMap[activePreviewAttachment.id] ?? null);
  }, [activePreviewAttachment, attachmentPreviewMap, isDirectAttachmentPreview]);

  const attachmentItemsForCanvasPreview = useMemo(() => {
    if (!detail?.attachments.length) return [];
    return detail.attachments.map((attachment) => ({
      id: attachment.id, filename: attachment.filename,
      src: isDirectAttachmentPreview(attachment)
        ? convertFileSrc(attachment.filepath)
        : (attachmentPreviewMap[attachment.id] ?? null),
    }));
  }, [attachmentPreviewMap, detail?.attachments, isDirectAttachmentPreview]);

  const handleOpenAttachmentInCanvas = useCallback(() => {
    if (!attachmentItemsForCanvasPreview.length) { showToast('当前没有可显示的附件内容'); return; }
    openCanvasAttachmentPreview({
      items: attachmentItemsForCanvasPreview,
      activeId: activePreviewAttachment?.id ?? selectedAttachmentId ?? attachmentItemsForCanvasPreview[0]?.id ?? null,
      ownerMediaId: inspectorMediaId,
    });
  }, [activePreviewAttachment?.id, attachmentItemsForCanvasPreview, inspectorMediaId, openCanvasAttachmentPreview, selectedAttachmentId, showToast]);

  // Display values
  const inspectorDisplayName = inspectorAttachment?.filename ?? detail?.file.filename ?? '';
  const inspectorDisplayPreviewSrc = inspectorAttachmentPreviewSrc ?? detailPreviewSrc;
  const inspectorDisplayPath = inspectorAttachment?.filepath ?? detail?.file.filepath ?? '';
  const inspectorDisplayFormat = inspectorDisplayName.includes('.')
    ? inspectorDisplayName.split('.').pop()!.toUpperCase()
    : (inspectorAttachment?.mimeType?.split('/').pop()?.toUpperCase() ?? detail?.file.filetype.toUpperCase() ?? '—');
  const inspectorDisplayResolution = inspectorAttachment
    ? '—'
    : (detail?.file.width && detail?.file.height ? `${detail.file.width} × ${detail.file.height}` : '—');
  const inspectorDisplaySize = inspectorAttachment
    ? (inspectorAttachment.fileSize != null ? formatFileSize(inspectorAttachment.fileSize) : '—')
    : (detail ? formatFileSize(detail.file.fileSize) : '—');
  const inspectorSecondaryTimeLabel = inspectorAttachment ? '添加时间' : '最后修改';
  const inspectorSecondaryTimeValue = inspectorAttachment
    ? formatTimestamp(inspectorAttachment.createdAt)
    : (detail ? formatTimestamp(detail.file.modifiedAt) : '—');
  const inspectorTertiaryLabel = inspectorAttachment ? '所属素材' : '导入时间';
  const inspectorTertiaryValue = inspectorAttachment
    ? detail?.file.filename ?? '—'
    : (detail ? formatTimestamp(detail.file.importedAt) : '—');
  const inspectorIdLabel = inspectorAttachment ? '附件 ID' : '素材 ID';
  const inspectorIdValue = inspectorAttachment?.id.slice(0, 8) ?? detail?.file.id.slice(0, 8) ?? '—';

  const attachmentGridViewportHeight = attachmentGridCellSize == null
    ? undefined
    : (attachmentGridCellSize * ATTACHMENT_GRID_ROWS) + (ATTACHMENT_GRID_GAP * (ATTACHMENT_GRID_ROWS - 1));

  // Effects
  useEffect(() => {
    const attachments = detail?.attachments ?? [];
    const requestSeq = ++attachmentPreviewRequestSeqRef.current;
    if (attachments.length === 0) {
      setAttachmentPreviewMap({});
      setAttachmentPreviewLoadingMap({});
      attachmentPreviewCacheRef.current.forEach((previewUrl) => {
        if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
      });
      attachmentPreviewCacheRef.current.clear();
      return;
    }
    const nextMap: Record<string, string> = {};
    const nextLoadingMap: Record<string, boolean> = {};
    for (const attachment of attachments) {
      const ext = attachment.filename.split('.').pop()?.toLowerCase() ?? '';
      if (DIRECT_ATTACHMENT_PREVIEW_EXTENSIONS.has(ext)) {
        nextMap[attachment.id] = convertFileSrc(attachment.filepath);
        nextLoadingMap[attachment.id] = false; continue;
      }
      const cached = attachmentPreviewCacheRef.current.get(attachment.id);
      if (cached) { nextMap[attachment.id] = cached; nextLoadingMap[attachment.id] = false; continue; }
      nextLoadingMap[attachment.id] = true;
    }
    setAttachmentPreviewMap(nextMap);
    setAttachmentPreviewLoadingMap(nextLoadingMap);
    const loadPreviews = async () => {
      for (const attachment of attachments) {
        const ext = attachment.filename.split('.').pop()?.toLowerCase() ?? '';
        if (DIRECT_ATTACHMENT_PREVIEW_EXTENSIONS.has(ext)) continue;
        if (attachmentPreviewCacheRef.current.has(attachment.id)) continue;
        try {
          const preview = await invoke<string | null>('get_attachment_preview_data', { path: attachment.filepath, size: 360 });
          if (requestSeq !== attachmentPreviewRequestSeqRef.current) return;
          if (preview) {
            attachmentPreviewCacheRef.current.set(attachment.id, preview);
            setAttachmentPreviewMap((prev) => (prev[attachment.id] ? prev : { ...prev, [attachment.id]: preview }));
          }
        } catch (err) {
          console.warn('[PropertyPanel] attachment preview failed:', attachment.filepath, err);
        } finally {
          if (requestSeq === attachmentPreviewRequestSeqRef.current)
            setAttachmentPreviewLoadingMap((prev) => ({ ...prev, [attachment.id]: false }));
        }
      }
    };
    void loadPreviews();
  }, [detail?.attachments]);

  useEffect(() => {
    if (!detail?.attachments.some((attachment) => attachment.id === selectedAttachmentId)) setSelectedAttachmentId(null);
  }, [detail?.attachments, selectedAttachmentId]);

  useEffect(() => {
    if (!detail?.attachments.some((attachment) => attachment.id === previewAttachmentId)) setPreviewAttachmentId(null);
  }, [detail?.attachments, previewAttachmentId]);

  useEffect(() => {
    if (!previewAttachmentId) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreviewAttachmentId(null); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewAttachmentId]);

  useEffect(() => {
    if (!canvasActiveAttachmentId) return;
    setSelectedAttachmentId((current) => current === canvasActiveAttachmentId ? current : canvasActiveAttachmentId);
    setPreviewAttachmentId((current) => current === canvasActiveAttachmentId ? current : canvasActiveAttachmentId);
  }, [canvasActiveAttachmentId]);

  useLayoutEffect(() => {
    const grid = attachmentGridRef.current;
    if (!grid) return;
    const updateGridCellSize = () => {
      const width = grid.clientWidth;
      if (width <= 0) return;
      const nextSize = Math.floor((width - (ATTACHMENT_GRID_GAP * (ATTACHMENT_GRID_COLUMNS - 1))) / ATTACHMENT_GRID_COLUMNS);
      setAttachmentGridCellSize(nextSize > 0 ? nextSize : null);
    };
    updateGridCellSize();
    const observer = new ResizeObserver(() => { updateGridCellSize(); });
    observer.observe(grid);
    return () => { observer.disconnect(); };
  }, [inspectorWidth, detail?.attachments.length, previewAttachmentId]);

  useLayoutEffect(() => {
    const el = promptTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const contentHeight = el.scrollHeight;
    const overflow = contentHeight > COLLAPSED_PROMPT_HEIGHT;
    setIsPromptOverflow(overflow);
    if (isPromptExpanded || !overflow) el.style.height = `${contentHeight}px`;
    else el.style.height = `${COLLAPSED_PROMPT_HEIGHT}px`;
    el.style.overflowY = overflow ? 'auto' : 'hidden';
    if (pendingCursorPosRef.current !== null) {
      const pos = pendingCursorPosRef.current;
      el.setSelectionRange(pos, pos);
      pendingCursorPosRef.current = null;
    }
  }, [promptDraft, isPromptExpanded]);

  useEffect(() => {
    if (detailRef.current) debouncedSaveAi();
  }, [promptDraft, modelDraft, platformDraft, debouncedSaveAi]);

  useEffect(() => {
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, []);

  useEffect(() => {
    if (detail?.aiMetadata) {
      setPromptDraft(detail.aiMetadata.promptText ?? '');
      setModelDraft(detail.aiMetadata.modelName ?? '');
      setPlatformDraft(detail.aiMetadata.platform ?? '');
    } else {
      setPromptDraft(''); setModelDraft(''); setPlatformDraft('');
    }
    setIsPromptExpanded(false);
  }, [detail]);

  useEffect(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;
    requestAnimationFrame(() => { textarea.scrollTop = 0; });
  }, [detail?.file.id]);

  useEffect(() => {
    if (detail && isVideoFile(detail.file.filename) && ffmpegAvailable === null) {
      invoke<boolean>('check_ffmpeg_available').then(setFfmpegAvailable).catch(() => setFfmpegAvailable(false));
    }
  }, [detail, ffmpegAvailable]);

  // Batch tag handling
  const handleBatchTag = async () => {
    if (!batchTagInput.trim()) return;
    const tags = batchTagInput.split(/[,\n，]+/).map(t => t.trim()).filter(Boolean);
    if (tags.length === 0) return;
    const ids = Array.from(selectedIdsRef.current);
    try {
      await invoke('batch_add_tags', { ids, tags });
      tags.forEach(tag => appendTagToCachedItems(ids, tag));
      showToast(`已为 ${ids.length} 个素材添加 ${tags.length} 个标签`);
      setBatchTagInput(''); setIsAddingBatchTag(false);
    } catch { showToast('批量添加标签失败'); }
  };

  const handleBatchTrash = async () => {
    const confirmed = await showConfirm({
      title: '批量移入回收站', message: `确定要将已选择的 ${selectedIdsCount} 张图片移入回收站吗？`, danger: true,
    });
    if (!confirmed) return;
    const selectedIdsArray = Array.from(selectedIdsRef.current);
    try {
      const result = await invoke<{ succeeded: number; failed: number }>('batch_move_to_trash', { ids: selectedIdsArray });
      if (result.succeeded > 0) {
        showToast(result.failed > 0 ? `已将 ${result.succeeded} 张图片移入回收站，失败 ${result.failed} 张` : `已将 ${result.succeeded} 张图片移入回收站`);
        deselectAll(); fetchFiles(1);
        window.dispatchEvent(new CustomEvent('trash-updated'));
      } else { showToast('批量移入回收站失败'); }
    } catch { showToast('批量移入回收站失败'); }
  };

  // Render
  if (selectedIdsCount > 1) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <MultiSelectPanel count={selectedIdsCount} onBatchTag={() => setIsAddingBatchTag(true)} onBatchTrash={handleBatchTrash} />
        {isAddingBatchTag && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', borderRadius: '16px', background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
            <SectionLabel>批量添加标签</SectionLabel>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                autoFocus
                type="text"
                value={batchTagInput}
                onChange={(e) => setBatchTagInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleBatchTag(); } else if (e.key === 'Escape') { setIsAddingBatchTag(false); setBatchTagInput(''); } }}
                placeholder="输入标签，逗号分隔"
                style={{ flex: 1, height: '36px', padding: '0 12px', borderRadius: 'var(--radius-default)', border: 'none', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-primary)', fontSize: '12px', outline: 'none' }}
              />
              <button onClick={() => void handleBatchTag()} style={{ padding: '0 16px', height: '36px', borderRadius: 'var(--radius-default)', border: 'none', background: 'var(--accent)', color: 'var(--text-on-accent)', fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>添加</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  if (!inspectorMediaId || !detail) return null;

  return (
    <>
      <div style={{ position: 'relative', width: '100%', height: '228px', background: 'linear-gradient(180deg, color-mix(in srgb, var(--bg-card) 88%, transparent) 0%, color-mix(in srgb, var(--bg-primary) 84%, transparent) 100%)', borderRadius: '18px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: 'inset 0 0 0 1px var(--border)' }}>
        {inspectorDisplayPreviewSrc ? (
          <img src={inspectorDisplayPreviewSrc} alt={inspectorDisplayName} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : !inspectorAttachment && isVideoFile(detail.file.filename) ? (
          <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', backgroundColor: 'var(--bg-hover)' }}>
            <Icon name="play_circle" size={34} fill={1} color="var(--text-muted)" />
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>暂无预览</span>
          </div>
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="image" size={40} color="var(--text-muted)" /></div>
        )}
        <div onClickCapture={(e) => { e.preventDefault(); e.stopPropagation(); onAnalyzeCurrentItem(detail); }} style={{ position: 'absolute', right: '12px', bottom: '12px', pointerEvents: 'auto' }}>
          <button type="button" onClick={() => { if (!isAIMode) { void toggleAIMode(); } }} style={{ height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '0 12px', border: 'none', borderRadius: 'var(--radius-pill)', background: 'var(--overlay-action-bg)', boxShadow: 'var(--shadow-md), inset 0 0 0 1px var(--accent-border)', color: 'var(--accent)', cursor: 'pointer', backdropFilter: 'blur(16px)' }} title="切换到 AI">
            <Icon name="auto_awesome" size={15} />
            <span style={{ fontSize: '12px', fontWeight: 500, letterSpacing: 0 }}>AI 分析</span>
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '0 2px' }}>
        {inspectorAttachment ? (
          <h2 style={{ fontFamily: 'var(--font-family)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {inspectorDisplayName}
          </h2>
        ) : hasSingleSelection ? (
          <FileNameEditorInternal filename={detail.file.filename} fileId={detail.file.id} showToast={showToast} />
        ) : (
          <h2 style={{ fontFamily: 'var(--font-family)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {detail.file.filename}
          </h2>
        )}
      </div>

      {!inspectorAttachment && isVideoFile(detail.file.filename) && ffmpegAvailable === false && (
        <div style={{ backgroundColor: 'color-mix(in srgb, var(--error) 10%, transparent)', borderLeft: '2px solid var(--error)', borderRadius: '0 4px 4px 0', padding: '8px 12px', color: 'var(--error)', fontSize: '12px', lineHeight: 1.5 }}>
          未检测到 ffmpeg，视频缩略图不可用。安装后重启应用即可。
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '16px', background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
        <SectionLabel>文件信息</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <MetaRow label="格式" value={inspectorDisplayFormat} />
          <MetaRow label="分辨率" value={inspectorDisplayResolution} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <MetaRow label="大小" value={inspectorDisplaySize} />
          <MetaRow label={inspectorSecondaryTimeLabel} value={inspectorSecondaryTimeValue} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <MetaRow label={inspectorTertiaryLabel} value={inspectorTertiaryValue} />
          <MetaRow label={inspectorIdLabel} value={inspectorIdValue} />
        </div>
        {!inspectorAttachment && dominantColors.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', paddingTop: '2px' }}>
            {dominantColors.slice(0, 6).map((color, index) => (
              <button key={`${color}-${index}`} type="button" onClick={() => navigator.clipboard.writeText(color)}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '36px', height: '36px', padding: 0, border: 'none', borderRadius: 'var(--radius-default)', background: color, boxShadow: 'inset 0 0 0 1px var(--border)', cursor: 'pointer', flexShrink: 0 }}
              />
            ))}
          </div>
        )}
      </div>

      {inspectorAttachment ? (
        <AttachmentNotice />
      ) : !hasSingleSelection ? (
        <ModeHintCard title="单张模式" body="当前为浏览预览状态，已隐藏标签和 Prompt 编辑器，以减少翻页时的渲染负担。" />
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
            {detail.tags.map((tag) => (
              <TagBadge key={tag.id} tag={tag} onRemove={(targetTag) => { void handleInlineRemoveTag(targetTag.id); }} />
            ))}
            {isEditingTags ? (
              <input ref={newTagInputRef} type="text" placeholder="输入标签后回车" value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)} onKeyDown={handleDraftAddTag} onBlur={handleBlurAndEscape}
                style={{ width: `${Math.max(148, newTagName.length * 13 + 34)}px`, height: '40px', padding: '0 11px', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', color: 'var(--text-primary)', borderRadius: 'var(--radius-default)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '11px', fontWeight: 500, outline: 'none' }}
              />
            ) : (
              <button type="button" onClick={startEditingTags}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '40px', padding: '0 11px', borderRadius: 'var(--radius-default)', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-primary)', fontSize: '11px', fontWeight: 500, cursor: 'pointer' }}>
                添加标签
              </button>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', borderRadius: '16px', background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
            <SectionLabel style={{ marginBottom: '2px' }}>Prompt</SectionLabel>
            <textarea ref={promptTextareaRef} value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)}
              onKeyDown={handlePromptKeyDown} onWheel={handlePromptWheel} placeholder="在此记录提示词..." wrap="soft" spellCheck={false}
              style={{ width: '100%', padding: '12px', backgroundColor: 'var(--bg-surface)', borderRadius: 'var(--radius-default)', boxShadow: 'inset 0 0 0 1px var(--border)', border: 'none', fontFamily: 'var(--font-family)', fontSize: '12px', color: 'var(--text-primary)', resize: 'none', outline: 'none', lineHeight: 1.6, display: 'block', boxSizing: 'border-box', overflowX: 'hidden', overflowY: isPromptOverflow ? 'auto' : 'hidden', minHeight: `${COLLAPSED_PROMPT_HEIGHT}px`, transition: 'height 0.2s ease', whiteSpace: 'pre-wrap', tabSize: 2 }}
            />
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '2px', padding: '6px 8px', borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1 }}>
                <div style={{ width: '180px', minWidth: '180px', flexShrink: 0 }}>
                  <ModelCombobox value={modelDraft} onChange={setModelDraft} tone="muted" chrome="inline" dropdownWidth={280} />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', flexShrink: 0 }}>
                {isPromptOverflow && (
                  <button onClick={() => setIsPromptExpanded((value) => !value)}
                    style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '11px', padding: '2px 4px', borderRadius: 'var(--radius-control)', transition: 'color 0.15s ease' }}
                    title={isPromptExpanded ? '收起提示词内容' : '展开提示词内容'}>
                    {isPromptExpanded ? '收起' : '查看完整'}
                  </button>
                )}
                <button onClick={handleCopyPrompt} disabled={!promptDraft.trim()}
                  style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'transparent', border: 'none', cursor: promptDraft.trim() ? 'pointer' : 'not-allowed', color: 'var(--text-muted)', fontSize: '11px', padding: '2px 4px', borderRadius: 'var(--radius-control)', opacity: promptDraft.trim() ? 1 : 0.4, transition: 'color 0.15s ease' }}>
                  <Icon name={isCopied ? 'check' : 'content_copy'} size={14} />
                  {isCopied ? '已复制' : '复制'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Attachments section */}
      <div ref={attachmentSectionRef} tabIndex={0}
        onDragEnter={(event) => { event.preventDefault(); setIsAttachmentDragOver(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setIsAttachmentDragOver(true); }}
        onDragLeave={(event) => { event.preventDefault(); const relatedTarget = event.relatedTarget as Node | null; if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) setIsAttachmentDragOver(false); }}
        onDrop={(event) => { void handleAttachmentDrop(event); }}
        onPaste={(event) => { void handleAttachmentPaste(event); }}
        onKeyDown={(event) => { void handleAttachmentKeyDown(event); }}
        style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', borderRadius: '16px', background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)', boxShadow: isAttachmentDragOver ? 'inset 0 0 0 1px var(--accent-border), 0 0 0 1px var(--accent-border)' : 'inset 0 0 0 1px var(--border)', outline: 'none' }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: '10px' }}>
          <button type="button" onClick={() => { attachmentSectionRef.current?.focus(); void handleAddAttachment(); }}
            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '32px', padding: '0 12px', borderRadius: 'var(--radius-default)', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 500, cursor: 'pointer', flexShrink: 0 }}>
            添加附件
          </button>
          {activePreviewAttachment && activePreviewAttachmentSrc && (
            <span style={{ minWidth: 0, fontSize: '10px', fontWeight: 500, color: 'var(--text-muted)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={activePreviewAttachment.filename}>
              {activePreviewAttachment.filename}
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" onClick={handleOpenAttachmentInCanvas} disabled={attachmentItemsForCanvasPreview.length === 0} title="在内容区查看"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '32px', width: '32px', padding: 0, borderRadius: 'var(--radius-default)', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', color: attachmentItemsForCanvasPreview.length > 0 ? 'var(--text-primary)' : 'var(--text-muted)', cursor: attachmentItemsForCanvasPreview.length > 0 ? 'pointer' : 'default', opacity: attachmentItemsForCanvasPreview.length > 0 ? 1 : 0.45, flexShrink: 0 }}>
              <Icon name="open_in_full" size={16} />
            </button>
            {activePreviewAttachment && activePreviewAttachmentSrc && (
              <button type="button" onClick={() => setPreviewAttachmentId(null)} title="返回附件"
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '32px', width: '32px', padding: 0, borderRadius: 'var(--radius-default)', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}>
                <Icon name="arrow_back" size={16} />
              </button>
            )}
          </div>
        </div>

        {detail.attachments.length === 0 ? (
          <div style={{ padding: '12px', borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.6, color: 'var(--text-muted)' }}>
            这里可以放源文件、工程文件或参考素材。
          </div>
        ) : activePreviewAttachment && activePreviewAttachmentSrc ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <img src={activePreviewAttachmentSrc} alt={activePreviewAttachment.filename}
              style={{ width: '100%', height: 'auto', display: 'block', borderRadius: '12px' }} />
          </div>
        ) : (
          <div ref={attachmentGridRef}
            style={{ display: 'grid', gridTemplateColumns: `repeat(${ATTACHMENT_GRID_COLUMNS}, minmax(0, 1fr))`, gridAutoRows: attachmentGridCellSize == null ? undefined : `${attachmentGridCellSize}px`, gap: `${ATTACHMENT_GRID_GAP}px`, height: attachmentGridViewportHeight, maxHeight: attachmentGridViewportHeight, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: '2px' }}>
            {detail.attachments.map((attachment) => (
              <div key={attachment.id} draggable
                onClick={() => { setSelectedAttachmentId(attachment.id); attachmentSectionRef.current?.focus(); }}
                onDoubleClick={() => handleOpenAttachmentPreview(attachment)}
                onContextMenu={(event) => { event.preventDefault(); setSelectedAttachmentId(attachment.id); attachmentSectionRef.current?.focus(); void handleShowAttachmentInFolder(attachment); }}
                onDragStart={(event) => handleAttachmentDragStart(event, attachment)}
                style={{ borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: selectedAttachmentId === attachment.id ? 'inset 0 0 0 1px var(--accent-border)' : 'inset 0 0 0 1px var(--border)', overflow: 'hidden', cursor: 'grab', height: '100%', aspectRatio: attachmentGridCellSize == null ? '1 / 1' : undefined }}
                title={`${attachment.filename}\n双击在附件区查看大图，右键打开位置`}>
                <div style={{ position: 'relative', width: '100%', height: '100%', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)' }}>
                  {getAttachmentPreviewSrc(attachment) ? (
                    <img src={getAttachmentPreviewSrc(attachment)!} alt={attachment.filename}
                      style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', background: 'var(--bg-primary)' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                      <div style={{ width: '44px', height: '44px', borderRadius: '10px', background: 'color-mix(in srgb, var(--bg-primary) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700 }}>
                        {attachmentTypeLabel(attachment)}
                      </div>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {attachmentPreviewLoadingMap[attachment.id] ? '读取预览中...' : '暂无预览'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px', borderRadius: '16px', background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px 12px', borderRadius: '12px', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
          <span style={{ flexShrink: 0, fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
            {inspectorAttachment ? '附件路径：' : '路径：'}
          </span>
          <span style={{ minWidth: 0, wordBreak: 'break-all' }}>{inspectorDisplayPath}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button type="button" onClick={handleCopyPath}
            style={{ flex: 1, padding: '10px 12px', border: 'none', borderRadius: '12px', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer' }}>
            复制路径
          </button>
          <button type="button" onClick={handleShowInFolder}
            style={{ flex: 1, padding: '10px 12px', border: 'none', borderRadius: '12px', background: 'var(--accent-dim)', boxShadow: 'inset 0 0 0 1px var(--accent-border)', color: 'var(--accent)', fontSize: '12px', cursor: 'pointer' }}>
            打开位置
          </button>
        </div>
      </div>
    </>
  );
});
