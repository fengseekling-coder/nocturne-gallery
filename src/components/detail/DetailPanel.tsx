/**
 * Nocturne Gallery — DetailPanel (Inspector)
 *
 * 右侧详情面板：大图预览、元数据、标签编辑、AI 提示词区。
 * 背景 var(--color-bg-structure)，padding 24px。
 * 元数据 Label-MD：uppercase，letter-spacing 0.05em，font-size 10px。
 */

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useMediaStore } from '../../stores/mediaStore';
import { useUiStore } from '../../stores/uiStore';
import { TagBadge } from '../common/TagBadge';
import { Icon } from '../common/Icon';
import { WindowControls } from '../common/WindowControls';
import { getPreference, setPreference } from '../../utils/preferences';
import { ModelCombobox } from './ModelCombobox';
import { AttachmentPanel } from './AttachmentPanel';
import { AIChatPanel } from './AIChatPanel';
import { useAgentChat } from '../../hooks/useAgentChat';
import { ProviderType } from '../../lib/ai/types';
import { MediaDetail, MediaFile, MediaAttachment } from '../../types/media';
import { normalizeTransferredFilePath } from '../../utils/filePath';

// ----------------------------------------------------------------
// MetaRow：Label-MD 样式的单行元数据
// ----------------------------------------------------------------

interface MetaRowProps {
  label: string;
  value: string;
  onClick?: () => void;
  title?: string;
}

const MetaRow: React.FC<MetaRowProps> = ({ label, value, onClick, title }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '8px' }}>
    <span
      style={{
        fontFamily: 'var(--font-family)',
        fontSize: '11px',
        fontWeight: 400,
        color: 'var(--text-muted)',
      }}
    >
      {label}
    </span>
    <span
      onClick={onClick}
      title={title}
      style={{
        fontFamily: 'var(--font-family)',
        fontSize: '11px',
        color: 'var(--text-secondary)',
        cursor: onClick ? 'pointer' : 'default',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        textDecoration: onClick ? 'underline dotted' : 'none',
      }}
    >
      {value}
    </span>
  </div>
);

// ----------------------------------------------------------------
// 视频文件判断
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

// ----------------------------------------------------------------
// SectionLabel
// ----------------------------------------------------------------

export const SectionLabel: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <p
    style={{
      fontFamily: 'var(--font-family)',
      fontSize: '11px',
      fontWeight: 500,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '1px',
      margin: '0 0 8px',
      ...style,
    }}
  >
    {children}
  </p>
);

const MultiSelectPanel: React.FC<{ onBatchTag: () => void; onBatchTrash: () => void; }> = React.memo(({ onBatchTag, onBatchTrash }) => {
  const count = useMediaStore((s) => s.selectedIds.size);

  return (
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
          <Icon name="label" size={16} />
          批量添加标签
        </button>
        <button onClick={onBatchTrash} style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--bg-surface)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--border)', borderRadius: 'var(--radius-default)', padding: '10px 14px', color: 'var(--error)', fontSize: '13px', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
          <Icon name="delete" size={16} />
          移入回收站
        </button>
      </div>
    </div>
  );
});

const ModeHintCard: React.FC<{ title: string; body: string }> = React.memo(({ title, body }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', borderRadius: '16px', background: 'var(--bg-card)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
    <SectionLabel style={{ marginBottom: '2px' }}>{title}</SectionLabel>
    <div style={{ padding: '12px', borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
      {body}
    </div>
  </div>
));

export const AttachmentNotice: React.FC = React.memo(() => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', borderRadius: '16px', background: 'var(--bg-card)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
    <SectionLabel style={{ marginBottom: '2px' }}>附件说明</SectionLabel>
    <div style={{ padding: '12px', borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.7, color: 'var(--text-secondary)' }}>
      当前右侧面板显示的是附件文件信息。
      <br />
      附件是外部引用，不继承素材本体的标签、Prompt 和 AI 元数据。
    </div>
  </div>
));

// AttachmentPanel moved to `./AttachmentPanel`

// ----------------------------------------------------------------
// DetailPanel
// ----------------------------------------------------------------

interface DetailPanelProps {
  inspectorWidth: number;
  setInspectorWidth: (width: number) => void;
}

type AttachmentKind = 'image' | 'video' | 'pdf';

type BatchFileOperationResult = {
  succeeded: number;
  failed: number;
};

interface NativePathFile extends File {
  path?: string;
  sourceItemId?: string;
}

interface ChatAttachment {
  id: string;
  file: File;
  type: AttachmentKind;
  previewUrl: string;
  base64?: string;
  extractedText?: string;
  filePath?: string;
  sourceItemId?: string;
  status: 'preparing' | 'ready' | 'failed';
}


const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  pdf: 'application/pdf',
};


const CHAT_RENDER_BATCH = 120;


const getMimeTypeFromFilename = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
};

const getAttachmentKindFromMimeType = (mimeType: string): AttachmentKind | null => {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return null;
};

const getAttachmentKindFromFile = (file: File): AttachmentKind | null => (
  getAttachmentKindFromMimeType(file.type || getMimeTypeFromFilename(file.name))
);

const AI_ANALYSIS_MAX_BYTES_BY_KIND: Record<AttachmentKind, number> = {
  image: 25 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  pdf: 8 * 1024 * 1024,
};

const formatAiAnalysisFileSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
};

const createNativePathFile = (
  filename: string,
  mimeType: string,
  filePath: string,
  sourceItemId?: string,
): NativePathFile => (
  Object.assign(new File([], filename, { type: mimeType }), { path: filePath, sourceItemId })
);

export const DetailPanel: React.FC<DetailPanelProps> = ({ inspectorWidth, setInspectorWidth }) => {
  const showToast = useUiStore((s) => s.showToast);
  const selectedId = useMediaStore((s) => s.selectedId);
  const updateTags = useMediaStore((s) => s.updateTags);
  const updateAiMetadata = useMediaStore((s) => s.updateAiMetadata);
  const addAttachments = useMediaStore((s) => s.addAttachments);
  const fetchFiles = useMediaStore((s) => s.fetchFiles);
  const deselectAll = useMediaStore((s) => s.deselectAll);
  const openCanvasAttachmentPreview = useUiStore((s) => s.openCanvasAttachmentPreview);
  const canvasAttachmentPreview = useUiStore((s) => s.canvasAttachmentPreview);

  // 从 uiStore 获取 AI 模式状态
  const isAIMode = useUiStore((s) => s.isAIMode);
  const toggleAIMode = useUiStore((s) => s.toggleAIMode);

  const inspectorMediaId = selectedId ?? canvasAttachmentPreview?.ownerMediaId ?? null;
  const detail = useMediaStore((s) => (inspectorMediaId ? s.detailCache[inspectorMediaId] ?? null : null));
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const isMultiSelectMode = useMediaStore((s) => s.selectedIds.size > 1);
  const hasSingleSelection = !isMultiSelectMode;

  // AI 对话 hook
  const {
    messages,
    sessions,
    activeSessionId,
    setMessages,
    sendMessage,
    stopGeneration,
    retryMessage,
    loadSession,
    deleteSession,
    isTyping,
    error: chatError,
    clearHistory,
  } = useAgentChat();

  // Alias for AIChatPanel compatibility
  const error = chatError;

  // AI 对话输入状态
  const [chatInput] = useState('');
  const [chatRenderCount, setChatRenderCount] = useState(0);

  // 模型选择状态
  const [_showProviderMenu, _setShowProviderMenu] = useState(false);

  useEffect(() => {
    const unsubscribe = useMediaStore.subscribe((state) => {
      selectedIdsRef.current = state.selectedIds;
    });
    return unsubscribe;
  }, []);

  // 对话交互增强
  const [isScrolledUp] = useState(false);
  const pendingChatScrollAnchorRef = useRef<number | null>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const focusChatComposer = useCallback(() => {
    chatTextareaRef.current?.focus();
  }, []);

  // AI 模型状态
  const [_currentProvider, setCurrentProvider] = useState<ProviderType>('openai');
  const [_isFetchingModels, setIsFetchingModels] = useState(false);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [hasClaudeKey, setHasClaudeKey] = useState(false);
  const [hasBailianKey, setHasBailianKey] = useState(false);
  const [_openAiModels, setOpenAiModels] = useState<string[]>([]);
  const [_claudeModels, setClaudeModels] = useState<string[]>([]);
  const [_bailianModels, setBailianModels] = useState<string[]>([]);
  const [_openAiModel, setOpenAiModel] = useState('gpt-5.5-high');
  const [_openAiImageModel, setOpenAiImageModel] = useState('gpt-image-2-high');
  const [_claudeModel, setClaudeModel] = useState('claude-haiku-4-5-20251001');
  const [_bailianModel, setBailianModel] = useState('qwen-plus');

  // 附件状态
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const [attachmentPreviewMap, setAttachmentPreviewMap] = useState<Record<string, string>>({});
  const [attachmentPreviewLoadingMap, setAttachmentPreviewLoadingMap] = useState<Record<string, boolean>>({});
  const attachmentPreviewCacheRef = useRef<Map<string, string>>(new Map());
  const attachmentPreviewRequestSeqRef = useRef(0);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [isAttachmentDragOver, setIsAttachmentDragOver] = useState(false);
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const [activePreviewAttachment, _setActivePreviewAttachment] = useState<MediaAttachment | null>(null);

  // 批量标签添加状态
  const [_isAddingBatchTag, setIsAddingBatchTag] = useState(false);

  // 聊天图片预览状态
  const [chatImagePreview, setChatImagePreview] = useState<{ src: string; filename: string } | null>(null);
  const [chatImagePreviewScale, setChatImagePreviewScale] = useState(1);
  const [chatImagePreviewOffset, setChatImagePreviewOffset] = useState({ x: 0, y: 0 });
  const [isChatImageDragging, setIsChatImageDragging] = useState(false);
  const chatImageDragStartRef = useRef<{ pointerX: number; pointerY: number; offsetX: number; offsetY: number } | null>(null);

  // 视频抽帧
  const extractVideoFrame = useCallback((source: File | string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const isObjectUrl = source instanceof File;
      const url = isObjectUrl ? URL.createObjectURL(source) : source;
      video.src = url;
      video.crossOrigin = 'anonymous';
      video.currentTime = 1; // 第1秒
      video.muted = true;
      video.playsInline = true;
      video.onseeked = () => {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d')?.drawImage(video, 0, 0);
        if (isObjectUrl) URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
      };
      video.onerror = (err) => {
        if (isObjectUrl) URL.revokeObjectURL(url);
        reject(err);
      };
      video.load();
    });
  }, []);

  // PDF 提字
  const extractPdfText = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {

          const pdfjsLib = await import('pdfjs-dist') as typeof import('pdfjs-dist');
          try {
            pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
              'pdfjs-dist/build/pdf.worker.min.mjs',
              import.meta.url
            ).href;
          } catch (e) {
            console.warn('[Gega] PDF.js worker 加载失败', e);
          }

          const data = e.target?.result;
          if (!data) throw new Error('Failed to read file');
          
          const pdf = await pdfjsLib.getDocument({ data }).promise;
          let text = '';
          const maxPages = Math.min(pdf.numPages, 10);
          for (let i = 1; i <= maxPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map((item) => ('str' in (item as object) ? (item as { str: string }).str : '')).join(' ') + '\n';
          }
          resolve(text.trim());
        } catch (err) {
          console.error('PDF extraction error:', err);
          resolve(`[PDF文件: ${file.name}，无法提取文字]`);
        }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }, []);

  const revokePreviewUrl = (url: string) => {
    if (url && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  };

  const updateAttachment = useCallback((id: string, updater: (attachment: ChatAttachment) => ChatAttachment) => {
    setAttachments((prev) => prev.map((attachment) => (
      attachment.id === id ? updater(attachment) : attachment
    )));
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    const nextAttachments: ChatAttachment[] = [];

    for (const file of files) {
      const nativeFile = file as NativePathFile;
      const filePath = nativeFile.path;
      const sourceItemId = nativeFile.sourceItemId;
      const kind = getAttachmentKindFromFile(file);

      if (kind === 'image') {
        nextAttachments.push({
          id: crypto.randomUUID(),
          file,
          type: 'image',
          previewUrl: filePath ? convertFileSrc(filePath) : URL.createObjectURL(file),
          filePath,
          sourceItemId,
          status: 'ready',
        });
        continue;
      }

      if (kind === 'video') {
        nextAttachments.push({
          id: crypto.randomUUID(),
          file,
          type: 'video',
          previewUrl: '',
          filePath,
          sourceItemId,
          status: 'preparing',
        });
        continue;
      }

      if (kind === 'pdf') {
        nextAttachments.push({
          id: crypto.randomUUID(),
          file,
          type: 'pdf',
          previewUrl: '',
          filePath,
          sourceItemId,
          status: 'preparing',
        });
        continue;
      }

      showToast('暂不支持该文件类型');
    }

    if (nextAttachments.length === 0) return;

    setAttachments((prev) => [...prev, ...nextAttachments]);

    await Promise.all(nextAttachments.map(async (attachment) => {
      if (attachment.type === 'video') {
        try {
          const frameBase64 = await extractVideoFrame(
            attachment.filePath ? convertFileSrc(attachment.filePath) : attachment.file
          );
          updateAttachment(attachment.id, (current) => ({
            ...current,
            previewUrl: `data:image/jpeg;base64,${frameBase64}`,
            base64: frameBase64,
            status: 'ready',
          }));
        } catch (err) {
          console.error('Failed to extract video frame for preview:', err);
          updateAttachment(attachment.id, (current) => ({
            ...current,
            status: current.filePath ? 'ready' : 'failed',
          }));
        }
      }

      if (attachment.type === 'pdf') {
        try {
          const extractedText = await extractPdfText(attachment.file);
          updateAttachment(attachment.id, (current) => ({
            ...current,
            extractedText,
            status: 'ready',
          }));
        } catch (err) {
          console.error('PDF extraction error:', err);
          updateAttachment(attachment.id, (current) => ({
            ...current,
            extractedText: `[PDF文件: ${current.file.name}，无法提取文字]`,
            status: 'failed',
          }));
        }
      }
    }));
  }, [extractPdfText, extractVideoFrame, showToast, updateAttachment]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    attachmentsRef.current.forEach((attachment) => revokePreviewUrl(attachment.previewUrl));
  }, []);

  const createFileFromMediaId = useCallback(async (
    mediaId: string,
    filename: string,
    mimeType: string | null,
  ): Promise<File> => {
    const base64 = await invoke<string>('read_media_file_as_base64', { mediaId });
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const resolvedMimeType = mimeType || getMimeTypeFromFilename(filename);
    const blob = new Blob([bytes], { type: resolvedMimeType });
    return new File([blob], filename, { type: resolvedMimeType });
  }, []);

  const createFileFromAttachmentId = useCallback(async (
    attachmentId: string,
    filename: string,
    mimeType: string | null,
    filePath: string,
  ): Promise<File> => {
    const resolvedMimeType = mimeType || getMimeTypeFromFilename(filename);
    const kind = getAttachmentKindFromMimeType(resolvedMimeType);
    if (kind === 'image' || kind === 'video') {
      return createNativePathFile(filename, resolvedMimeType, filePath);
    }

    const base64 = await invoke<string>('read_attachment_file_as_base64', { attachmentId });
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: resolvedMimeType });
    return new File([blob], filename, { type: resolvedMimeType });
  }, []);

  const createFileFromDetail = useCallback(async (currentDetail: MediaDetail): Promise<File> => {
    const resolvedMimeType = currentDetail.file.mimeType || getMimeTypeFromFilename(currentDetail.file.filename);
    const kind = getAttachmentKindFromMimeType(resolvedMimeType);
    if (kind === 'image' || kind === 'video') {
      return createNativePathFile(
        currentDetail.file.filename,
        resolvedMimeType,
        currentDetail.file.filepath,
        currentDetail.file.id,
      );
    }

    return createFileFromMediaId(
      currentDetail.file.id,
      currentDetail.file.filename,
      resolvedMimeType,
    );
  }, [createFileFromMediaId]);

  const handleAnalyzeCurrentItem = useCallback(async () => {
    if (!detail) return;

    const canvasAttachmentId =
      canvasAttachmentPreview && canvasAttachmentPreview.ownerMediaId === inspectorMediaId
        ? (canvasAttachmentPreview.activeId ?? canvasAttachmentPreview.items[0]?.id ?? null)
        : null;
    const currentInspectorAttachment = detail.attachments.find(
      (attachment) => attachment.id === (canvasAttachmentId ?? previewAttachmentId),
    ) ?? null;

    if (!isAIMode) {
      await toggleAIMode();
    }

    const currentFilename = currentInspectorAttachment?.filename ?? detail.file.filename;
    const currentFileSize = currentInspectorAttachment?.fileSize ?? detail.file.fileSize;
    const currentMimeType = currentInspectorAttachment?.mimeType
      || detail.file.mimeType
      || getMimeTypeFromFilename(currentFilename);
    const currentKind = getAttachmentKindFromMimeType(currentMimeType);
    const currentFilePath = currentInspectorAttachment?.filepath ?? detail.file.filepath;

    if (!currentKind) {
      showToast('AI 分析仅支持图片、视频或 PDF 文件');
      return;
    }

    if (currentFileSize == null) {
      showToast('无法确认文件大小，已取消 AI 分析');
      return;
    }

    const maxBytes = AI_ANALYSIS_MAX_BYTES_BY_KIND[currentKind];
    if (currentFileSize > maxBytes) {
      showToast(`文件超过 ${formatAiAnalysisFileSize(maxBytes)}，已取消 AI 分析`);
      return;
    }

    const alreadyAttached = attachments.some(
      (att) => att.filePath === currentFilePath
        || (att.file.name === currentFilename && att.file.size === currentFileSize)
    );
    if (alreadyAttached) {
      focusChatComposer();
      return;
    }

    try {
      const file = currentInspectorAttachment
        ? await createFileFromAttachmentId(
            currentInspectorAttachment.id,
            currentInspectorAttachment.filename,
            currentInspectorAttachment.mimeType,
            currentInspectorAttachment.filepath,
          )
        : await createFileFromDetail(detail);
      void addFiles([file]);
      focusChatComposer();
    } catch (err) {
      console.error('[DetailPanel] Failed to prepare AI attachment:', err);
      showToast('无法将当前素材加入 AI 输入区');
    }
  }, [addFiles, attachments, canvasAttachmentPreview, createFileFromAttachmentId, createFileFromDetail, detail, focusChatComposer, inspectorMediaId, isAIMode, previewAttachmentId, showToast, toggleAIMode]);

  // 自动滚动到底部（用户手动上滚时暂停，显示浮动按钮代替）
  useEffect(() => {
    if (!chatScrollRef.current || isScrolledUp) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [messages, isTyping, isScrolledUp]);

  const visibleMessages = useMemo(
    () => messages.filter((message) => message.role !== 'system'),
    [messages],
  );
  const renderedMessages = useMemo(
    () => visibleMessages.slice(Math.max(0, visibleMessages.length - chatRenderCount)),
    [chatRenderCount, visibleMessages],
  );
  useEffect(() => {
    if (visibleMessages.length === 0) {
      setChatRenderCount(CHAT_RENDER_BATCH);
      pendingChatScrollAnchorRef.current = null;
      return;
    }

    if (!isScrolledUp) {
      setChatRenderCount((prev) => {
        const next = Math.min(visibleMessages.length, CHAT_RENDER_BATCH);
        return prev === next ? prev : next;
      });
    }
  }, [isScrolledUp, visibleMessages.length]);

  useLayoutEffect(() => {
    const previousScrollHeight = pendingChatScrollAnchorRef.current;
    const el = chatScrollRef.current;
    if (previousScrollHeight === null || !el) return;

    const heightDelta = el.scrollHeight - previousScrollHeight;
    el.scrollTop += heightDelta;
    pendingChatScrollAnchorRef.current = null;
  }, [renderedMessages.length]);


  // textarea auto-grow（80 → 240，超过滚动）
  useLayoutEffect(() => {
    const ta = chatTextareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    const next = Math.min(240, Math.max(80, ta.scrollHeight));
    ta.style.height = next + 'px';
  }, [chatInput]);

  // 菜单打开时拉取所有 provider 的可用模型
  useEffect(() => {
    if (!_showProviderMenu) return;
    setIsFetchingModels(true);

    const tasks: Promise<void>[] = [];

    // OpenAI-compatible
    if (hasOpenAiKey) {
      tasks.push(
        invoke<{ models: string[]; imageModels: string[] }>('openai_list_models')
          .then(data => {
            if (data.models.length > 0) setOpenAiModels(data.models);
            setOpenAiImageModel(data.imageModels?.[0] || 'dall-e-3');
          })
          .catch(() => {})
      );
    }

    if (hasClaudeKey) {
      tasks.push(
        getPreference('claude_api_key', '').then(key =>
          fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true',
            },
          })
            .then(r => r.json())
            .then(data => {
              const ids: string[] = (data.data ?? []).map((m: { id: string }) => m.id);
              if (ids.length > 0) setClaudeModels(ids);
            })
            .catch(() => {})
        )
      );
    }

    // 只读取百炼配置，避免历史本地模型记录继续出现在菜单里
    tasks.push(
      getPreference('model_configs', '[]').then(raw => {
        try {
          const configs = JSON.parse(raw) as Array<{ provider: string; model: string }>;
          const supportedConfigs = configs.filter(c => ['openai', 'claude', 'bailian', 'tavily'].includes(c.provider));
          if (supportedConfigs.length !== configs.length) {
            void setPreference('model_configs', JSON.stringify(supportedConfigs));
          }
          const names = supportedConfigs
            .filter(c => c.provider === 'bailian')
            .map(c => c.model)
            .filter(Boolean);
          setBailianModels(names);
        } catch {
          setBailianModels([]);
        }
      })
    );

    Promise.all(tasks).finally(() => setIsFetchingModels(false));
  }, [_showProviderMenu, hasClaudeKey, hasBailianKey, hasOpenAiKey]);

  useEffect(() => {
    getPreference('ai_provider', 'openai').then(async val => {
      const nextProvider: ProviderType = val === 'claude' || val === 'bailian' || val === 'openai' ? val : 'openai';
      setCurrentProvider(nextProvider);
      if (nextProvider !== val) await setPreference('ai_provider', nextProvider);
    });
    getPreference('bailian_model', 'qwen-plus').then(val => setBailianModel(val));
    getPreference('claude_api_key', '').then(val => setHasClaudeKey(val.length > 0));
    getPreference('bailian_api_key', '').then(val => setHasBailianKey(val.length > 0));
    getPreference('claude_model', 'claude-haiku-4-5-20251001').then(val => setClaudeModel(val));
    getPreference('openai_model', 'gpt-5.5-high').then(val => setOpenAiModel(val));
    getPreference('openai_image_model', 'gpt-image-2-high').then(val => setOpenAiImageModel(val));
    invoke<{ hasApiKey: boolean; model: string }>('openai_get_config')
      .then(config => {
        setHasOpenAiKey(config.hasApiKey);
        setOpenAiModel(config.model || 'gpt-5.5-high');
      })
      .catch(() => setHasOpenAiKey(false));
  }, []);

  // 格式化文件大小
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }, []);

  // 格式化时间戳
  const formatTimestamp = useCallback((timestamp: number | string | null | undefined): string => {
    if (!timestamp) return '—';
    const date = new Date(typeof timestamp === 'string' ? timestamp : timestamp * 1000);
    if (isNaN(date.getTime())) return '—';
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
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
        const parsed = JSON.parse(payload) as {
          files?: Array<{ filePath?: string }>;
          filePath?: string;
        };
        parsed.files?.forEach((item) => addPath(item.filePath));
        addPath(parsed.filePath);
      }
    } catch {
      // ignore malformed payload
    }

    transfer.getData('text/uri-list')
      .split(/\r?\n/)
      .forEach((value: string) => addPath(value));

    transfer.getData('text/plain')
      .split(/\r?\n/)
      .forEach((value: string) => addPath(value));

    const nativeFiles = Array.from(transfer.files ?? []) as NativePathFile[];
    for (const file of nativeFiles) {
      if (file.path) {
        addPath(file.path);
      } else if (file.type.startsWith('image/')) {
        try {
          const tempPath = await persistClipboardFileToTemp(file);
          addPath(tempPath);
        } catch (err) {
          console.error('[DetailPanel] Failed to persist clipboard image:', err);
        }
      }
    }

    return Array.from(paths);
  }, [persistClipboardFileToTemp]);

  const handleAddAttachment = useCallback(async () => {
    if (!detail) return;
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        title: '选择附件文件',
      });
      if (!selected) return;

      const paths = Array.isArray(selected)
        ? selected.filter((item): item is string => typeof item === 'string')
        : [selected];
      if (paths.length === 0) return;

      await addAttachments(detail.file.id, paths);
      showToast(paths.length === 1 ? '附件已添加' : `已添加 ${paths.length} 个附件`);
    } catch (err) {
      console.error('[DetailPanel] add attachment error:', err);
      showToast(err instanceof Error ? err.message : '添加附件失败');
    }
  }, [addAttachments, detail, showToast]);

  const handleOpenAttachment = useCallback(async (attachment: MediaAttachment) => {
    try {
      await invoke('open_path', { path: attachment.filepath });
    } catch {
      showToast('打开附件失败');
    }
  }, [showToast]);

  const handleOpenAttachmentPreview = useCallback((attachment: MediaAttachment) => {
    const previewSrc = attachmentPreviewMap[attachment.id] ?? null;

    if (!previewSrc) {
      void handleOpenAttachment(attachment);
      return;
    }

    setPreviewAttachmentId(attachment.id);
  }, [attachmentPreviewMap, handleOpenAttachment]);

  const handleShowAttachmentInFolder = useCallback(async (attachment: MediaAttachment) => {
    try {
      await invoke('show_in_folder', { path: attachment.filepath });
    } catch {
      showToast('打开附件位置失败');
    }
  }, [showToast]);

  const attachPathsToCurrentDetail = useCallback(async (paths: string[]) => {
    if (!detail) return;
    const uniquePaths = Array.from(new Set(paths.filter(Boolean)));
    if (uniquePaths.length === 0) return;

    try {
      await addAttachments(detail.file.id, uniquePaths);
      showToast(uniquePaths.length === 1 ? '附件已添加' : `已添加 ${uniquePaths.length} 个附件`);
    } catch (err) {
      console.error('[DetailPanel] attach paths failed:', err);
      showToast(err instanceof Error ? err.message : '添加附件失败');
    }
  }, [addAttachments, detail, showToast]);

  const handleAttachmentDrop = useCallback(async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
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
    if (!selectedAttachmentId || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c' || !detail) {
      return;
    }

    const attachment = detail.attachments.find((item) => item.id === selectedAttachmentId);
    if (!attachment) return;

    event.preventDefault();
    try {
      await navigator.clipboard.writeText(attachment.filepath);
      showToast('附件路径已复制');
    } catch {
      showToast('复制附件路径失败');
    }
  }, [detail, selectedAttachmentId, showToast]);


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
      const cached = attachmentPreviewCacheRef.current.get(attachment.id);
      if (cached) {
        nextMap[attachment.id] = cached;
        nextLoadingMap[attachment.id] = false;
        continue;
      }

      nextLoadingMap[attachment.id] = true;
    }

    setAttachmentPreviewMap(nextMap);
    setAttachmentPreviewLoadingMap(nextLoadingMap);

    const loadPreviews = async () => {
      for (const attachment of attachments) {
        if (attachmentPreviewCacheRef.current.has(attachment.id)) continue;

        try {
          const preview = await invoke<string>('read_attachment_preview', {
            attachmentId: attachment.id,
          });
          if (requestSeq !== attachmentPreviewRequestSeqRef.current) return;
          if (preview) {
            attachmentPreviewCacheRef.current.set(attachment.id, preview);
            setAttachmentPreviewMap((prev) => (prev[attachment.id] ? prev : { ...prev, [attachment.id]: preview }));
          }
        } catch (err) {
          console.warn('[DetailPanel] attachment preview failed:', attachment.id, err);
        } finally {
          if (requestSeq === attachmentPreviewRequestSeqRef.current) {
            setAttachmentPreviewLoadingMap((prev) => ({ ...prev, [attachment.id]: false }));
          }
        }
      }
    };

    void loadPreviews();
  }, [detail?.attachments]);

  useEffect(() => {
    if (!detail?.attachments.some((attachment) => attachment.id === selectedAttachmentId)) {
      setSelectedAttachmentId(null);
    }
  }, [detail?.attachments, selectedAttachmentId]);

  useEffect(() => {
    if (!detail?.attachments.some((attachment) => attachment.id === previewAttachmentId)) {
      setPreviewAttachmentId(null);
    }
  }, [detail?.attachments, previewAttachmentId]);

  useEffect(() => {
    if (!previewAttachmentId) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewAttachmentId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [previewAttachmentId]);

  const closeChatImagePreview = useCallback(() => {
    setChatImagePreview(null);
    setIsChatImageDragging(false);
    chatImageDragStartRef.current = null;
  }, []);

  const handleChatImagePreviewWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    setChatImagePreviewScale((currentScale) => {
      const factor = event.deltaY > 0 ? 0.88 : 1.12;
      const nextScale = Math.min(6, Math.max(1, Number((currentScale * factor).toFixed(2))));
      if (nextScale === 1) {
        setChatImagePreviewOffset({ x: 0, y: 0 });
      }
      return nextScale;
    });
  }, []);

  const handleChatImagePreviewPointerDown = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (chatImagePreviewScale <= 1) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    chatImageDragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      offsetX: chatImagePreviewOffset.x,
      offsetY: chatImagePreviewOffset.y,
    };
    setIsChatImageDragging(true);
  }, [chatImagePreviewOffset.x, chatImagePreviewOffset.y, chatImagePreviewScale]);

  const handleChatImagePreviewPointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (!isChatImageDragging || !chatImageDragStartRef.current) return;

    event.preventDefault();
    event.stopPropagation();
    const start = chatImageDragStartRef.current;
    setChatImagePreviewOffset({
      x: start.offsetX + event.clientX - start.pointerX,
      y: start.offsetY + event.clientY - start.pointerY,
    });
  }, [isChatImageDragging]);

  const handleChatImagePreviewPointerEnd = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    event.stopPropagation();
    chatImageDragStartRef.current = null;
    setIsChatImageDragging(false);
  }, []);

  useEffect(() => {
    if (!chatImagePreview) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeChatImagePreview();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [chatImagePreview, closeChatImagePreview]);


  const canvasActiveAttachmentId = useMemo(() => {
    if (!canvasAttachmentPreview || canvasAttachmentPreview.ownerMediaId !== inspectorMediaId) {
      return null;
    }
    return canvasAttachmentPreview.activeId ?? canvasAttachmentPreview.items[0]?.id ?? null;
  }, [canvasAttachmentPreview, inspectorMediaId]);

  useEffect(() => {
    if (!canvasActiveAttachmentId) return;
    setSelectedAttachmentId((current) => current === canvasActiveAttachmentId ? current : canvasActiveAttachmentId);
    setPreviewAttachmentId((current) => current === canvasActiveAttachmentId ? current : canvasActiveAttachmentId);
  }, [canvasActiveAttachmentId]);

  const attachmentItemsForCanvasPreview = useMemo(() => {
    if (!detail?.attachments.length) return [];
    return detail.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      src: attachmentPreviewMap[attachment.id] ?? null,
    }));
  }, [attachmentPreviewMap, detail?.attachments]);

  const handleOpenAttachmentInCanvas = useCallback(() => {
    if (!attachmentItemsForCanvasPreview.length) {
      showToast('当前没有可显示的附件内容');
      return;
    }

    openCanvasAttachmentPreview({
      items: attachmentItemsForCanvasPreview,
      activeId: activePreviewAttachment?.id
        ?? selectedAttachmentId
        ?? attachmentItemsForCanvasPreview[0]?.id
        ?? null,
      ownerMediaId: inspectorMediaId,
    });
  }, [activePreviewAttachment?.id, attachmentItemsForCanvasPreview, inspectorMediaId, openCanvasAttachmentPreview, selectedAttachmentId, showToast]);

  const dominantColors = useMemo(() => {
    if (!detail?.file.colorDominant) return [] as string[];
    try {
      const parsed = JSON.parse(detail.file.colorDominant) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [detail?.file.colorDominant]);

  const detailPreviewSrc = useMemo(() => {
    if (!detail) return null;
    const previewPath = detail.file.thumbnailPreviewPath || detail.file.thumbnailPath;
    if (previewPath) {
      return convertFileSrc(previewPath);
    }
    if (
      detail.file.fileSize <= MAX_INLINE_ORIGINAL_PREVIEW_BYTES
      && canPreviewOriginalImage(detail.file.filename)
    ) {
      return convertFileSrc(detail.file.filepath);
    }
    return null;
  }, [detail]);

  const inspectorAttachment = useMemo(() => {
    const attachmentId = canvasActiveAttachmentId ?? previewAttachmentId;
    if (!attachmentId) return null;
    return detail?.attachments.find((attachment) => attachment.id === attachmentId) ?? null;
  }, [canvasActiveAttachmentId, detail?.attachments, previewAttachmentId]);

  const inspectorAttachmentPreviewSrc = useMemo(() => {
    if (!inspectorAttachment) return null;
    return attachmentPreviewMap[inspectorAttachment.id] ?? null;
  }, [attachmentPreviewMap, inspectorAttachment]);

  const inspectorDisplayName = inspectorAttachment?.filename ?? detail?.file.filename ?? '';
  const inspectorDisplayPreviewSrc = inspectorAttachmentPreviewSrc ?? detailPreviewSrc;
  const inspectorDisplayPath = inspectorAttachment?.filepath ?? detail?.file.filepath ?? '';
  const inspectorDisplayFormat = inspectorDisplayName.includes('.')
    ? inspectorDisplayName.split('.').pop()!.toUpperCase()
    : (inspectorAttachment?.mimeType?.split('/').pop()?.toUpperCase()
      ?? detail?.file.filetype.toUpperCase()
      ?? '—');
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
  const isResizingRef = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const handleResizeStart = (e: React.MouseEvent) => {
    isResizingRef.current = true;
    startX.current = e.clientX;
    startWidth.current = inspectorWidth;
    document.body.style.userSelect = 'none';
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isResizingRef.current) return;
      const delta = startX.current - e.clientX;
      const newWidth = Math.min(600, Math.max(240, startWidth.current + delta));
      setInspectorWidth(newWidth);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (isResizingRef.current) {
        // 只在松手时写一次 SQLite，而不是每帧都写
        const delta = startX.current - e.clientX;
        const finalWidth = Math.min(600, Math.max(240, startWidth.current + delta));
        setPreference('inspector-width', String(finalWidth));
      }
      isResizingRef.current = false;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [setInspectorWidth]);

  // ffmpeg 可用性检测（仅在选中视频时触发一次，结果缓存到 state）
  const [ffmpegAvailable, setFfmpegAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (detail && isVideoFile(detail.file.filename) && ffmpegAvailable === null) {
      invoke<boolean>('check_ffmpeg_available')
        .then(setFfmpegAvailable)
        .catch(() => setFfmpegAvailable(false));
    }
  }, [detail, ffmpegAvailable]);

  // 多选批量操作状态
  const showConfirm = useUiStore((s) => s.showConfirm);

  // Tag 编辑状态
  const [isEditingTags, setIsEditingTags] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const newTagInputRef = useRef<HTMLInputElement>(null);



  // AI 表单状态（本地草稿）
  const [promptDraft, setPromptDraft] = useState<string>('');
  const [modelDraft, setModelDraft] = useState<string>('');
  const [platformDraft, setPlatformDraft] = useState<string>('');
  const [isCopied, setIsCopied] = useState(false);
  const [isPromptExpanded, setIsPromptExpanded] = useState(false);
  const [isPromptOverflow, setIsPromptOverflow] = useState(false);
  const getAttachmentPreviewSrc = useCallback((attachment: MediaAttachment) => (
    attachmentPreviewMap[attachment.id] ?? null
  ), [attachmentPreviewMap]);
  const inspectorContentRef = useRef<HTMLDivElement>(null);
  const promptTextareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentSectionRef = useRef<HTMLDivElement>(null);
  // 受控 textarea 的光标位置恢复：setState 后 DOM 被 React 重写，这里用 ref 暂存期望位置
  const pendingCursorPosRef = useRef<number | null>(null);
  const COLLAPSED_PROMPT_HEIGHT = 160; // px, 默认折叠态显示更多内容

  // 自动根据内容高度调整 textarea（展开态）或限制到折叠高度；
  // 同时若有 pendingCursorPosRef，在 layout effect 阶段恢复光标（避免跳到末尾）
  useLayoutEffect(() => {
    const el = promptTextareaRef.current;
    if (!el) return;
    // 先重置以获取真实 scrollHeight
    el.style.height = 'auto';
    const contentHeight = el.scrollHeight;
    const overflow = contentHeight > COLLAPSED_PROMPT_HEIGHT;
    setIsPromptOverflow(overflow);
    if (isPromptExpanded || !overflow) {
      el.style.height = `${contentHeight}px`;
    } else {
      el.style.height = `${COLLAPSED_PROMPT_HEIGHT}px`;
    }
    el.style.overflowY = overflow ? 'auto' : 'hidden';
    if (pendingCursorPosRef.current !== null) {
      const pos = pendingCursorPosRef.current;
      el.setSelectionRange(pos, pos);
      pendingCursorPosRef.current = null;
    }
  }, [promptDraft, isPromptExpanded]);

  // JSON/代码友好的键盘处理：Tab 插入 2 空格、Enter 保留当前行缩进、{ / [ 后按 Enter 多缩进一级
  const handlePromptKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const INDENT = '  ';
      const next = promptDraft.slice(0, start) + INDENT + promptDraft.slice(end);
      pendingCursorPosRef.current = start + INDENT.length;
      setPromptDraft(next);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const lineStart = promptDraft.lastIndexOf('\n', start - 1) + 1;
      const currentLine = promptDraft.slice(lineStart, start);
      const match = currentLine.match(/^[ \t]*/);
      const indent = match ? match[0] : '';
      const lastChar = promptDraft[start - 1];
      const extra = lastChar === '{' || lastChar === '[' ? '  ' : '';
      if (!indent && !extra) return; // 无需处理，走浏览器默认行为
      e.preventDefault();
      const insert = '\n' + indent + extra;
      const next = promptDraft.slice(0, start) + insert + promptDraft.slice(end);
      pendingCursorPosRef.current = start + insert.length;
      setPromptDraft(next);
    }
  }, [promptDraft]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 使用 ref 持有最新 detail，让 debounce 定时器触发时读取最新值，避免闭包陷阱
  const detailRef = useRef(detail);
  useEffect(() => { detailRef.current = detail; }, [detail]);

  const debouncedSaveAi = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const currentDetail = detailRef.current;
      if (!currentDetail) return;
      updateAiMetadata(currentDetail.file.id, promptDraft || '', modelDraft || '', platformDraft || '');
    }, 800);
  }, [promptDraft, modelDraft, platformDraft, updateAiMetadata]);

  useEffect(() => {
    if (detailRef.current) debouncedSaveAi();
  }, [promptDraft, modelDraft, platformDraft, debouncedSaveAi]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (detail?.aiMetadata) {
      setPromptDraft(detail.aiMetadata.promptText ?? '');
      setModelDraft(detail.aiMetadata.modelName ?? '');
      setPlatformDraft(detail.aiMetadata.platform ?? '');
    } else {
      setPromptDraft('');
      setModelDraft('');
      setPlatformDraft('');
    }
    setIsPromptExpanded(false);
  }, [detail]);

  useEffect(() => {
    const textarea = promptTextareaRef.current;
    if (!textarea) return;

    requestAnimationFrame(() => {
      textarea.scrollTop = 0;
    });
  }, [detail?.file.id]);



  const handleCopyPath = useCallback(async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(inspectorAttachment?.filepath ?? detail.file.filepath);
      showToast(inspectorAttachment ? '附件路径已复制' : '文件路径已复制');
    } catch {
      showToast(inspectorAttachment ? '复制附件路径失败' : '复制失败');
    }
  }, [detail, inspectorAttachment, showToast]);

  const handleShowInFolder = useCallback(async () => {
    if (!detail) return;
    try {
      await invoke('show_in_folder', { path: inspectorAttachment?.filepath ?? detail.file.filepath });
    } catch {
      showToast(inspectorAttachment ? '打开附件位置失败' : '打开所在位置失败');
    }
  }, [detail, inspectorAttachment, showToast]);

  const startEditingTags = () => {
    if (!detail) return;
    setIsEditingTags(true);
    setTimeout(() => newTagInputRef.current?.focus(), 50);
  };

  const commitDraftTags = useCallback(async () => {
    if (!detail) return false;

    const draftNames = newTagName
      .split(/[,\n，]+/)
      .map((name) => name.trim())
      .filter(Boolean);

    if (draftNames.length === 0) {
      setNewTagName('');
      return false;
    }

    const existingNames = new Set(detail.tags.map((tag) => tag.name.trim().toLowerCase()));
    const uniqueNames = draftNames.filter((name) => !existingNames.has(name.toLowerCase()));
    const duplicateCount = draftNames.length - uniqueNames.length;

    if (uniqueNames.length === 0) {
      showToast(draftNames.length === 1 ? '标签已存在' : '这些标签已存在');
      setNewTagName('');
      return false;
    }

    await updateTags(detail.file.id, [
      ...detail.tags,
      ...uniqueNames.map((name) => ({
        id: crypto.randomUUID(),
        name,
        color: 'var(--accent)',
      })),
    ]);

    setNewTagName('');

    if (duplicateCount > 0) {
      showToast(`已添加 ${uniqueNames.length} 个标签，${duplicateCount} 个已存在`);
    }

    return true;
  }, [detail, newTagName, showToast, updateTags]);

  const handleBlurAndEscape = async () => {
    if (!isEditingTags) return;
    await commitDraftTags();
    setNewTagName('');
    setIsEditingTags(false);
  };

  const handleDraftAddTag = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setNewTagName('');
      setIsEditingTags(false);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      await commitDraftTags();
      setIsEditingTags(false);
    }
  };

  const handleInlineRemoveTag = useCallback(async (tagId: string) => {
    if (!detail) return;
    const nextTags = detail.tags.filter((tag) => tag.id !== tagId);
    await updateTags(detail.file.id, nextTags);
  }, [detail, updateTags]);

  const handleCopyPrompt = useCallback(async () => {
    if (!promptDraft) return;
    try {
      await navigator.clipboard.writeText(promptDraft);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 1500);
    } catch {
      showToast('复制失败');
    }
  }, [promptDraft, showToast]);

  const handlePromptWheel = useCallback((event: React.WheelEvent<HTMLTextAreaElement>) => {
    const container = inspectorContentRef.current;
    const textarea = promptTextareaRef.current;

    if (!container) {
      return;
    }

    if (textarea && textarea.scrollHeight > textarea.clientHeight) {
      const isScrollingDown = event.deltaY > 0;
      const isScrollingUp = event.deltaY < 0;
      const isAtTop = textarea.scrollTop <= 0;
      const isAtBottom = textarea.scrollTop + textarea.clientHeight >= textarea.scrollHeight - 1;

      if ((isScrollingDown && !isAtBottom) || (isScrollingUp && !isAtTop)) {
        return;
      }
    }

    if (container.scrollHeight <= container.clientHeight) {
      return;
    }

    event.preventDefault();
    container.scrollTop += event.deltaY;
  }, []);



  return (
    <>
    <div
      style={{
        width: inspectorWidth,
        height: '100%',
        backgroundColor: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        boxShadow: 'inset 1px 0 0 var(--border)',
      }}
    >
      {/* Inspector 顶部标题栏 - 48px，与左侧 Logo 和 topbar 严格对齐 */}
      <div
        data-tauri-drag-region
        style={{
          height: '48px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px 0 10px',
          boxShadow: 'inset 0 -1px 0 var(--border)',
          backgroundColor: 'var(--bg-surface)',
          gap: '8px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flex: 1, minWidth: 0 }}>
          <button
            className="no-drag"
            onClick={() => {
              if (isAIMode) {
                void toggleAIMode();
              }
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              fontSize: '12px',
              fontWeight: !isAIMode ? 600 : 500,
              color: !isAIMode ? 'var(--accent)' : 'var(--text-secondary)',
              background: !isAIMode ? 'var(--accent-soft)' : 'transparent',
              transition: 'background .15s, color .15s',
            }}
          >
            <Icon name="info" size={15} fill={!isAIMode ? 1 : 0} opacity={!isAIMode ? 1 : 0.7} />
            <span>属性</span>
          </button>
          <button
            className="no-drag"
            onClick={() => {
              if (!isAIMode) {
                void toggleAIMode();
              }
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 12px',
              borderRadius: 'var(--radius-default)',
              fontSize: '12px',
              fontWeight: isAIMode ? 600 : 500,
              color: isAIMode ? 'var(--accent)' : 'var(--text-secondary)',
              background: isAIMode ? 'var(--accent-soft)' : 'transparent',
              transition: 'background .15s, color .15s',
            }}
          >
            <Icon name="auto_awesome" size={15} fill={isAIMode ? 1 : 0} opacity={isAIMode ? 1 : 0.7} />
            <span>AI</span>
          </button>
        </div>

        {/* 右侧窗口控制按钮 */}
        <div className="no-drag" style={{ position: 'relative', width: '108px', height: '48px', flexShrink: 0 }}>
          <WindowControls topOffset={0} rightOffset={0} />
        </div>
      </div>

      {/* 拖拽条 */}
      <div
        style={{ position: 'absolute', left: 0, top: 0, width: '4px', height: '100%', cursor: 'col-resize', background: 'transparent', zIndex: 20 }}
        onMouseDown={handleResizeStart}
      />

      {/* 内容区域 */}
      <div
        ref={inspectorContentRef}
        className="inspector-content"
        style={{
          flex: 1,
          overflowY: 'auto',
            padding: !isAIMode ? '18px 16px 24px' : '0',
            display: 'flex',
            flexDirection: 'column',
            gap: !isAIMode ? '14px' : '0',
            scrollbarWidth: 'none',
          msOverflowStyle: 'none',
        }}
      >
        {isAIMode ? (
          <AIChatPanel
            inspectorMediaId={inspectorMediaId}
            detail={detail}
            hasSingleSelection={hasSingleSelection}
            isAIMode={isAIMode}
            toggleAIMode={toggleAIMode}
            inspectorWidth={inspectorWidth}
            pendingAnalysisTarget={null}
            onPendingAnalysisConsumed={() => {}}
            messages={messages}
            sessions={sessions}
            activeSessionId={activeSessionId}
            setMessages={setMessages}
            sendMessage={sendMessage}
            stopGeneration={stopGeneration}
            retryMessage={retryMessage}
            loadSession={loadSession}
            deleteSession={deleteSession}
            clearHistory={clearHistory}
            isTyping={isTyping}
            error={error} />
        ) : (
          /* 信息模式界面 */
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {isMultiSelectMode ? (
              <MultiSelectPanel
                onBatchTag={() => setIsAddingBatchTag(true)}
                onBatchTrash={async () => {
                  const selectedIdsCount = useMediaStore.getState().selectedIds.size;
                  const confirmed = await showConfirm({
                    title: '批量移入回收站',
                    message: `确定要将已选择的 ${selectedIdsCount} 张图片移入回收站吗？`,
                    danger: true,
                  });
                  if (!confirmed) return;
                  const selectedIdsArray = Array.from(selectedIdsRef.current);
                  try {
                    const result = await invoke<BatchFileOperationResult>('batch_move_to_trash', { ids: selectedIdsArray });
                    if (result.succeeded > 0) {
                      showToast(
                        result.failed > 0
                          ? `已将 ${result.succeeded} 张图片移入回收站，失败 ${result.failed} 张`
                          : `已将 ${result.succeeded} 张图片移入回收站`
                      );
                      deselectAll();
                      fetchFiles(1);
                      window.dispatchEvent(new CustomEvent('trash-updated'));
                    } else {
                      showToast('批量移入回收站失败');
                    }
                  } catch {
                    showToast('批量移入回收站失败');
                  }
                }}
              />
            ) : !inspectorMediaId ? null : detail && (
              /* 素材详情 */
              <>
                <div style={{ position: 'relative', width: '100%', height: '228px', background: 'var(--bg-card)', borderRadius: '18px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                  {inspectorDisplayPreviewSrc ? (
                    <img src={inspectorDisplayPreviewSrc} alt={inspectorDisplayName} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  ) : !inspectorAttachment && isVideoFile(detail.file.filename) ? (
                    /* 视频文件无缩略图时的占位块 */
                    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', backgroundColor: 'var(--bg-hover)' }}>
                      <Icon name="play_circle" size={34} fill={1} color="var(--text-muted)" />
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>暂无预览</span>
                    </div>
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon name="image" size={40} color="var(--text-muted)" /></div>
                  )}
                  <div
                    onClickCapture={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleAnalyzeCurrentItem();
                    }}
                    style={{ position: 'absolute', right: '12px', bottom: '12px', pointerEvents: 'auto' }}
                  >
                    <button type="button" onClick={() => { if (!isAIMode) { void toggleAIMode(); } }} style={{ height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '0 12px', border: 'none', borderRadius: '999px', background: 'var(--bg-surface)', boxShadow: '0 8px 24px var(--border), inset 0 0 0 1px var(--accent-border)', color: 'var(--accent)', cursor: 'pointer', backdropFilter: 'blur(16px)' }} title="切换到 AI">
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
                    <FileNameEditor filename={detail.file.filename} fileId={detail.file.id} showToast={showToast} />
                  ) : (
                    <h2 style={{ fontFamily: 'var(--font-family)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.015em', color: 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {detail.file.filename}
                    </h2>
                  )}
                </div>
                {/* ffmpeg 缺失提示条：仅视频 && ffmpeg 不可用时显示 */}
                {!inspectorAttachment && isVideoFile(detail.file.filename) && ffmpegAvailable === false && (
                  <div style={{
                    backgroundColor: 'var(--bg-hover)',
                    borderLeft: '2px solid var(--error)',
                    borderRadius: '0 4px 4px 0',
                    padding: '8px 12px',
                    color: 'var(--error)',
                    fontSize: '12px',
                    lineHeight: 1.5,
                  }}>
                    未检测到 ffmpeg，视频缩略图不可用。安装后重启应用即可。
                  </div>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', borderRadius: '16px', background: 'var(--bg-card)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
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
                        <button
                          key={`${color}-${index}`}
                          type="button"
                          onClick={() => navigator.clipboard.writeText(color)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: '36px',
                            height: '36px',
                            padding: 0,
                            border: 'none',
                            borderRadius: 'var(--radius-default)',
                            background: color,
                            boxShadow: 'inset 0 0 0 1px var(--border)',
                            cursor: 'pointer',
                            flexShrink: 0,
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
                {inspectorAttachment ? (
                  <AttachmentNotice />
                ) : !hasSingleSelection ? (
                  <ModeHintCard
                    title="单张模式"
                    body="当前为浏览预览状态，已隐藏标签和 Prompt 编辑器，以减少翻页时的渲染负担。"
                  />
                ) : (
                  <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
                  {detail.tags.map((tag) => (
                    <TagBadge
                      key={tag.id}
                      tag={tag}
                      onRemove={(targetTag) => {
                        void handleInlineRemoveTag(targetTag.id);
                      }}
                    />
                  ))}

                  {isEditingTags ? (
                    <input
                      ref={newTagInputRef}
                      type="text"
                      placeholder="输入标签后回车"
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onKeyDown={handleDraftAddTag}
                      onBlur={handleBlurAndEscape}
                      style={{
                        width: `${Math.max(148, newTagName.length * 13 + 34)}px`,
                        height: '40px',
                        padding: '0 11px',
                        background: 'var(--bg-hover)',
                        color: 'var(--text-primary)',
                        borderRadius: 'var(--radius-default)',
                        border: 'none',
                        boxShadow: 'inset 0 0 0 1px var(--border)',
                        fontSize: '11px',
                        fontWeight: 500,
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={startEditingTags}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        height: '40px',
                        padding: '0 11px',
                        borderRadius: 'var(--radius-default)',
                        border: 'none',
                        background: 'var(--bg-active)',
                        boxShadow: 'inset 0 0 0 1px var(--border)',
                        color: 'var(--text-primary)',
                        fontSize: '11px',
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}
                    >
                      添加标签
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '14px', borderRadius: '16px', background: 'var(--bg-card)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                  {/* 提示词文本框 */}
                  <SectionLabel style={{ marginBottom: '2px' }}>Prompt</SectionLabel>
                  <textarea
                    ref={promptTextareaRef}
                    value={promptDraft}
                    onChange={(e) => setPromptDraft(e.target.value)}
                    onKeyDown={handlePromptKeyDown}
                    onWheel={handlePromptWheel}
                    placeholder="在此记录提示词..."
                    wrap="soft"
                    spellCheck={false}
                    style={{
                      width: '100%',
                      padding: '12px',
                      backgroundColor: 'var(--bg-surface)',
                      borderRadius: 'var(--radius-default)',
                      boxShadow: 'inset 0 0 0 1px var(--border)',
                      border: 'none',
                        fontFamily: 'var(--font-family)',
                      fontSize: '12px',
                      color: 'var(--text-primary)',
                      resize: 'none',
                      outline: 'none',
                      lineHeight: 1.6,
                      display: 'block',
                      boxSizing: 'border-box',
                      overflowX: 'hidden',
                      overflowY: isPromptOverflow ? 'auto' : 'hidden',
                      minHeight: `${COLLAPSED_PROMPT_HEIGHT}px`,
                      transition: 'height 0.2s ease',
                      whiteSpace: 'pre-wrap',
                      tabSize: 2,
                    }}
                  />
                  {/* 底部工具栏：统一容器，左侧模型选择，右侧展开/复制 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginTop: '2px', padding: '6px 8px', borderRadius: '12px', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0, flex: 1 }}>
                      <div style={{ width: '180px', minWidth: '180px', flexShrink: 0 }}>
                        <ModelCombobox value={modelDraft} onChange={setModelDraft} tone="muted" chrome="inline" dropdownWidth={280} />
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '6px', flexShrink: 0 }}>
                      {isPromptOverflow && (
                        <button
                          onClick={() => setIsPromptExpanded((value) => !value)}
                          style={{
                            display: 'flex', alignItems: 'center',
                            background: 'transparent', border: 'none',
                            cursor: 'pointer',
                            color: 'var(--text-muted)',
                            fontSize: '11px', padding: '2px 4px',
                            borderRadius: 'var(--radius-control)',
                            transition: 'color 0.15s ease',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                          title={isPromptExpanded ? '收起提示词内容' : '展开提示词内容'}
                        >
                          {isPromptExpanded ? '收起' : '查看完整'}
                        </button>
                      )}
                      <button
                        onClick={handleCopyPrompt}
                        disabled={!promptDraft.trim()}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '4px',
                          background: 'transparent', border: 'none',
                          cursor: promptDraft.trim() ? 'pointer' : 'not-allowed',
                          color: isCopied ? 'var(--text-muted)' : 'var(--text-muted)',
                          fontSize: '11px', padding: '2px 4px',
                          borderRadius: 'var(--radius-control)',
                          opacity: promptDraft.trim() ? 1 : 0.4,
                          transition: 'color 0.15s ease',
                        }}
                        onMouseEnter={(e) => { if (!promptDraft.trim()) return; e.currentTarget.style.color = 'var(--text-muted)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
                      >
                        <Icon name={isCopied ? 'check' : 'content_copy'} size={14} />
                        {isCopied ? '已复制' : '复制'}
                      </button>
                    </div>
                  </div>
                </div>
                  </>
                )}
                <AttachmentPanel
                  detail={detail}
                  attachmentPreviewMap={attachmentPreviewMap}
                  attachmentPreviewLoadingMap={attachmentPreviewLoadingMap}
                  selectedAttachmentId={selectedAttachmentId}
                  setSelectedAttachmentId={setSelectedAttachmentId}
                  previewAttachmentId={previewAttachmentId}
                  setPreviewAttachmentId={setPreviewAttachmentId}
                  handleAddAttachment={handleAddAttachment}
                  handleOpenAttachmentInCanvas={handleOpenAttachmentInCanvas}
                  handleOpenAttachmentPreview={handleOpenAttachmentPreview}
                  handleShowAttachmentInFolder={handleShowAttachmentInFolder}
                  handleAttachmentDrop={handleAttachmentDrop}
                  handleAttachmentPaste={handleAttachmentPaste}
                  handleAttachmentKeyDown={handleAttachmentKeyDown}
                  getAttachmentPreviewSrc={getAttachmentPreviewSrc}
                  isAttachmentDragOver={isAttachmentDragOver}
                  setIsAttachmentDragOver={setIsAttachmentDragOver}
                  attachmentSectionRef={attachmentSectionRef}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '14px', borderRadius: '16px', background: 'var(--bg-card)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px 12px', borderRadius: '12px', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                    <span style={{ flexShrink: 0, fontSize: '11px', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                      {inspectorAttachment ? '附件路径：' : '路径：'}
                    </span>
                    <span style={{ minWidth: 0, wordBreak: 'break-all' }}>
                      {inspectorDisplayPath}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <button type="button" onClick={handleCopyPath} style={{ flex: 1, padding: '10px 12px', border: 'none', borderRadius: '12px', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-primary)', fontSize: '12px', cursor: 'pointer' }}>
                      复制路径
                    </button>
                    <button type="button" onClick={handleShowInFolder} style={{ flex: 1, padding: '10px 12px', border: 'none', borderRadius: '12px', background: 'var(--accent-dim)', boxShadow: 'inset 0 0 0 1px var(--accent-border)', color: 'var(--accent)', fontSize: '12px', cursor: 'pointer' }}>
                      打开位置
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
    {chatImagePreview && (
      <div
        onClick={closeChatImagePreview}
        onWheelCapture={handleChatImagePreviewWheel}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 300,
          background: 'var(--overlay-preview-backdrop)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '32px',
          cursor: 'zoom-out',
          overflow: 'hidden',
          overscrollBehavior: 'contain',
        }}
      >
        <button
          type="button"
          onClick={closeChatImagePreview}
          title="关闭"
          style={{
            position: 'absolute',
            top: '18px',
            right: '18px',
            width: '34px',
            height: '34px',
            borderRadius: 'var(--radius-default)',
            border: 'none',
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            boxShadow: 'inset 0 0 0 1px var(--border)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name="close" size={18} />
        </button>
        <img
          src={chatImagePreview.src}
          alt={chatImagePreview.filename}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={handleChatImagePreviewPointerDown}
          onPointerMove={handleChatImagePreviewPointerMove}
          onPointerUp={handleChatImagePreviewPointerEnd}
          onPointerCancel={handleChatImagePreviewPointerEnd}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            borderRadius: 'var(--radius-default)',
            boxShadow: 'var(--shadow-lg)',
            cursor: chatImagePreviewScale > 1 ? (isChatImageDragging ? 'grabbing' : 'grab') : 'zoom-in',
            transform: `translate3d(${chatImagePreviewOffset.x}px, ${chatImagePreviewOffset.y}px, 0) scale(${chatImagePreviewScale})`,
            transformOrigin: 'center center',
            transition: isChatImageDragging ? 'none' : 'transform 120ms ease',
            userSelect: 'none',
            touchAction: 'none',
          }}
          draggable={false}
        />
      </div>
    )}
    </>
  );
};

// ----------------------------------------------------------------
// FileNameEditor Component
// ----------------------------------------------------------------

interface FileNameEditorProps {
  filename: string;
  fileId: string;
  showToast: (message: string) => void;
}

const FileNameEditor: React.FC<FileNameEditorProps> = React.memo(({ filename, fileId, showToast }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(filename);
  const [status, setStatus] = useState<'normal' | 'success' | 'error'>('normal');
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);
  const updateFile = useMediaStore(state => state.updateFile);

  const getFileExtension = (fn: string) => { const i = fn.lastIndexOf('.'); return i > 0 ? fn.substring(i) : ''; };
  const getNameWithoutExtension = (fn: string) => { const i = fn.lastIndexOf('.'); return i > 0 ? fn.substring(0, i) : fn; };

  const handleDoubleClick = () => { setIsEditing(true); setTempName(getNameWithoutExtension(filename)); };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') saveFileName(); else if (e.key === 'Escape') { setTempName(getNameWithoutExtension(filename)); setIsEditing(false); } };

  const saveFileName = async () => {
    if (isSavingRef.current) return;
    const trimmedName = tempName.trim();
    if (!trimmedName) { setTempName(getNameWithoutExtension(filename)); setIsEditing(false); return; }
    try {
      const ext = getFileExtension(filename);
      const newName = `${trimmedName}${ext}`;
      if (newName === filename) {
        setTempName(trimmedName);
        setIsEditing(false);
        return;
      }

      isSavingRef.current = true;
      setIsSaving(true);
      const updatedFile = await invoke<MediaFile>('rename_file', { id: fileId, newName });
      updateFile(fileId, {
        filename: updatedFile.filename,
        filepath: updatedFile.filepath,
        modifiedAt: updatedFile.modifiedAt,
        thumbnailPath: updatedFile.thumbnailPath,
        thumbnailMicroPath: updatedFile.thumbnailMicroPath,
        thumbnailPreviewPath: updatedFile.thumbnailPreviewPath,
      });
      setTempName(getNameWithoutExtension(updatedFile.filename));
      setStatus('success');
      setTimeout(() => setStatus('normal'), 1000);
      setIsEditing(false);
      showToast('文件名已更新');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setTempName(getNameWithoutExtension(filename));
      setStatus('error');
      setTimeout(() => { setStatus('normal'); setIsEditing(false); }, 2000);
      showToast(`重命名失败：${message}`);
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  };

  useEffect(() => { if (isEditing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [isEditing]);
  useEffect(() => { setTempName(getNameWithoutExtension(filename)); }, [filename]);

  return isEditing ? (
    <input ref={inputRef} type="text" value={tempName} disabled={isSaving} onChange={(e) => setTempName(e.target.value)} onKeyDown={handleKeyDown} onBlur={saveFileName} style={{ fontFamily: 'var(--font-family)', fontSize: '14px', fontWeight: 600, backgroundColor: 'var(--bg-hover)', border: 'none', borderRadius: '10px', padding: '6px 10px', color: 'var(--text-primary)', width: '100%', opacity: isSaving ? 0.7 : 1 }} onClick={(e) => e.stopPropagation()} />
  ) : (
    <h2 onClick={handleDoubleClick} style={{ fontFamily: 'var(--font-family)', fontSize: '14px', fontWeight: 600, letterSpacing: '-0.015em', color: status === 'error' ? 'var(--error)' : 'var(--text-primary)', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }} title="双击编辑文件名">
      {status === 'success' ? '✓ ' : ''}{filename}
    </h2>
  );
});
