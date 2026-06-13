/**
 * AIChatPanel — AI 对话面板
 *
 * 从 DetailPanel 拆出：AI 对话完整 UI，包括消息列表、输入区、模型选择、历史管理。
 * 仅在 isAIMode 时挂载。
 */

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { useMediaStore } from '../../stores/mediaStore';
import { useUiStore } from '../../stores/uiStore';
import { Icon } from '../common/Icon';
import { getPreference, setPreference } from '../../utils/preferences';
import { ProviderType, ToolCall } from '../../lib/ai/types';
import {
  resolveMessageImagePreviewSources,
  type MessageImageMediaLookup,
} from '../../lib/ai/messageImages';
import { ChatMessageContent } from './ChatMessageContent';
import type { MediaAttachment, MediaDetail } from '../../types/media';
import type { ImageAttachment, Message } from '../../lib/ai/types';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

type ModelMode = 'chat' | 'image';
type ImageGenerationSize = '1024x1024' | '1024x1536' | '1536x1024';
const DEFAULT_OPENAI_CHAT_MODEL = 'gpt-5.5-high';
const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-2-high';

interface OpenAiGeneratedImage {
  model: string;
  quality: string;
  b64Json?: string;
  url?: string;
  revisedPrompt?: string;
}

interface OpenAiImageReference {
  fileName?: string;
  mimeType?: string;
  base64Data?: string;
  filePath?: string;
}

interface ImageRequestState {
  id: string;
  cancelled: boolean;
}

interface AIChatPanelProps {
  inspectorMediaId: string | null;
  detail: MediaDetail | null;
  hasSingleSelection: boolean;
  isAIMode: boolean;
  toggleAIMode: () => Promise<void>;
  inspectorWidth: number;
  pendingAnalysisTarget: { detail: MediaDetail; attachmentId?: string; attachment?: MediaAttachment } | null;
  onPendingAnalysisConsumed: () => void;
  // useAgentChat return values (passed from shell to preserve state across mode switches)
  messages: Message[];
  sessions: AiChatSession[];
  activeSessionId: string | null;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  sendMessage: (content: string, options: { images?: string[]; imageAttachments?: ImageAttachment[]; systemPrompt?: string }) => Promise<void>;
  stopGeneration: () => void;
  retryMessage: (assistantMessageId: string) => void;
  loadSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  clearHistory: () => void;
  isTyping: boolean;
  error: string | null;
}

interface AiChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

const isGeminiModel = (model: string): boolean => model.trim().toLowerCase().startsWith('gemini-');
const createMessageId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
const withoutGeminiModels = (models: string[]): string[] => models.filter((model) => !isGeminiModel(model));
const sanitizeOpenAiChatModel = (model: string): string => (
  isGeminiModel(model) ? DEFAULT_OPENAI_CHAT_MODEL : model
);
const sanitizeOpenAiImageModel = (model: string): string => (
  isGeminiModel(model) ? DEFAULT_OPENAI_IMAGE_MODEL : model
);

const resolveImageGenerationSize = (prompt: string): ImageGenerationSize => {
  const normalizedPrompt = prompt.toLowerCase().replace(/[：]/g, ':').replace(/[×＊]/g, 'x');
  const ratioMatch = normalizedPrompt.match(/(\d{1,2})\s*[:/x]\s*(\d{1,2})/);
  if (ratioMatch) {
    const widthRatio = Number(ratioMatch[1]), heightRatio = Number(ratioMatch[2]);
    if (widthRatio > 0 && heightRatio > 0) {
      if (widthRatio === heightRatio) return '1024x1024';
      return widthRatio > heightRatio ? '1536x1024' : '1024x1536';
    }
  }
  if (/(竖版|竖图|竖屏|海报|portrait|poster|vertical)/i.test(prompt)) return '1024x1536';
  if (/(横版|横图|横屏|landscape|wide|horizontal)/i.test(prompt)) return '1536x1024';
  if (/(正方形|方图|square|1\s*[:/x]\s*1)/i.test(prompt)) return '1024x1024';
  return '1024x1024';
};

const toolNameMap: Record<string, string> = {
  'search_library': '搜索素材库', 'add_tags': '添加标签', 'set_category': '设置分类',
  'update_prompt': '更新提示词', 'get_item_detail': '获取素材详情', 'reverse_prompt': '分析图片提示词',
  'analyze_and_tag': '自动打标签', 'get_library_stats': '统计库状态', 'web_search': '联网搜索',
  'generate_image': 'gpt-image-2 生图',
};

const toolRunningHint: Record<string, (args: Record<string, unknown>) => string> = {
  'search_library': (args) => `正在搜索「${args['query'] || '素材库'}」...`,
  'add_tags': (args) => `正在为素材添加标签：${(args['tags'] as string[])?.join('、') || ''}...`,
  'set_category': (args) => `正在设置分类为「${args['category'] || ''}」...`,
  'update_prompt': () => '正在更新 AI 提示词...',
  'get_item_detail': () => '正在读取素材详情...',
  'reverse_prompt': () => '正在读取图片，准备反推提示词...',
  'analyze_and_tag': () => '正在分析图片内容，自动打标签...',
  'get_library_stats': () => '正在统计素材库数据...',
  'web_search': (args) => `正在联网搜索「${args['query'] || ''}」...`,
  'generate_image': () => '正在使用 gpt-image-2 生成图片...',
};

const CHAT_RENDER_BATCH = 120;
const CHAT_LOAD_MORE_THRESHOLD = 96;
const COLLAPSED_MESSAGE_TEXT_LENGTH = 100;

const GEGA_MEDIA_POINTER_DRAG_EVENT = 'gega-media-pointer-drag';
type AnalysisAttachmentKind = 'image' | 'video' | 'pdf';
const MIME_BY_EXTENSION: Record<string, string> = {
  'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png', 'gif': 'image/gif',
  'webp': 'image/webp', 'bmp': 'image/bmp', 'svg': 'image/svg+xml', 'avif': 'image/avif',
  'mp4': 'video/mp4', 'mov': 'video/quicktime', 'avi': 'video/x-msvideo',
  'mkv': 'video/x-matroska', 'webm': 'video/webm',
  'pdf': 'application/pdf',
};
const AI_ANALYSIS_MAX_BYTES_BY_KIND: Record<AnalysisAttachmentKind, number> = {
  image: 25 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  pdf: 8 * 1024 * 1024,
};

// ----------------------------------------------------------------
// Sub-components
// ----------------------------------------------------------------

type ToolCallStatus = 'running' | 'done' | 'cancelled' | 'error';

type ToolResultState = {
  result?: unknown;
  error?: string;
};

const isCancellationError = (error: string): boolean => /cancelled|aborted|已取消|取消/i.test(error);
const isTimeoutError = (error: string): boolean => /timeout|超时/i.test(error);
const CHAT_TYPING_TIMEOUT_MS = 60000;

const shortenErrorMessage = (error: string): string => {
  const trimmed = error.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
};

const ToolCallCard: React.FC<{ toolCall: ToolCall; result?: unknown; error?: string; status: ToolCallStatus }> = React.memo(({ toolCall, result, error, status }) => {
  const [expanded, setExpanded] = useState(toolCall.name === 'generate_image');

  const formatResult = (res: unknown) => {
    if (!res) return null;
    const r = res as Record<string, unknown>;
    if (r['_requires_vision']) return { status: '正在调用视觉模型进行深度分析...', details: res };
    if (r['_batch_vision']) return { status: '已准备好批量分析任务', count: (r['items'] as unknown[])?.length };
    return res;
  };

  const displayResult = formatResult(result);
  const resultRecord = result && typeof result === 'object' ? result as Record<string, unknown> : null;
  const generatedPreviewUrl = resultRecord?.['_generated_image'] === true && typeof resultRecord['preview_url'] === 'string'
    ? resultRecord['preview_url'] : null;
  const isDone = status === 'done';
  const isCancelled = status === 'cancelled';
  const isError = status === 'error';
  const statusIcon = isError ? 'error' : isCancelled ? 'block' : isDone ? 'done_all' : 'settings';
  const statusLabel = isDone ? '已执行：' : isCancelled ? '已取消：' : isError ? '执行失败：' : '正在执行：';

  return (
    <div style={{ background: 'var(--bg-surface)', borderLeft: `2px solid ${isError ? 'var(--error)' : 'var(--accent)'}`, borderRadius: 'var(--radius-small)', padding: '8px 12px', margin: '4px 0', fontSize: '12px', color: 'var(--text-secondary)', cursor: isDone ? 'pointer' : 'default', width: '100%', boxSizing: 'border-box' }}
      onClick={() => isDone && setExpanded(!expanded)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Icon name={statusIcon} size={16} color={isError ? 'var(--error)' : undefined} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {statusLabel}
          <code style={{ background: 'var(--bg-hover)', padding: '2px 4px', borderRadius: 'var(--radius-control)', color: isError ? 'var(--error)' : 'var(--accent)' }}>
            {toolNameMap[toolCall.name] || toolCall.name}
          </code>
        </span>
      </div>
      {status === 'running' && (
        <div style={{ marginTop: '8px', color: 'var(--accent)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--accent)', animation: 'pulse 1.2s ease-in-out infinite' }} />
          {toolRunningHint[toolCall.name]?.(toolCall.arguments) ?? `正在执行 ${toolNameMap[toolCall.name] || toolCall.name}...`}
        </div>
      )}
      {isCancelled && (
        <div style={{ marginTop: '8px', color: 'var(--text-muted)', fontSize: '11px' }}>
          对话已结束，工具执行已取消。
        </div>
      )}
      {isError && (
        <div style={{ marginTop: '8px', color: 'var(--error)', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Icon name="error" size={13} color="var(--error)" />
          <span>执行失败</span>
          {error && <span style={{ color: 'var(--text-secondary)' }}>· {shortenErrorMessage(error)}</span>}
        </div>
      )}
      {isDone && expanded && result != null && (
        <>
          {generatedPreviewUrl && (
            <img src={generatedPreviewUrl} alt="generated" style={{ marginTop: '8px', width: '100%', maxHeight: '320px', objectFit: 'contain', borderRadius: 'var(--radius-small)', boxShadow: 'inset 0 0 0 1px var(--border)' }} />
          )}
          <pre style={{ marginTop: '8px', padding: '8px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-control)', overflowX: 'auto', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(displayResult, (key, value) => {
              if (key === 'image_base64' || key === 'b64_json') return '<IMAGE_DATA>';
              return value;
            }, 2)}
          </pre>
        </>
      )}
    </div>
  );
});

const revokePreviewUrl = (previewUrl: string) => {
  if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
};

const getMimeTypeFromFilename = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
};

const getAnalysisAttachmentKind = (filename: string, mimeType: string): AnalysisAttachmentKind | null => {
  const resolvedMimeType = mimeType || getMimeTypeFromFilename(filename);
  if (resolvedMimeType.startsWith('image/')) return 'image';
  if (resolvedMimeType.startsWith('video/')) return 'video';
  if (resolvedMimeType === 'application/pdf') return 'pdf';
  return null;
};

const formatFileSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

interface ChatAttachment {
  id: string;
  file: File;
  type: 'image' | 'video' | 'pdf';
  previewUrl: string;
  filePath?: string;
  sourceItemId?: string;
  base64?: string;
  extractedText?: string;
  status: 'ready' | 'preparing' | 'failed';
}

const AttachmentPreviewItem: React.FC<{ attachment: ChatAttachment; onRemove: (id: string) => void }> = React.memo(({ attachment, onRemove }) => {
  const hasPreview = (attachment.type === 'image' || attachment.type === 'video') && attachment.previewUrl.length > 0;
  const isPreparing = attachment.status === 'preparing';
  const isFailed = attachment.status === 'failed';
  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      {hasPreview ? (
        <div style={{ position: 'relative', width: '52px', height: '52px', borderRadius: 'var(--radius-small)', overflow: 'hidden', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
          <img src={attachment.previewUrl} alt="preview" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          {attachment.type === 'video' && (
            <div style={{ position: 'absolute', left: '4px', bottom: '4px', background: 'var(--overlay-backdrop)', borderRadius: 'var(--radius-control)', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="play_arrow" size={12} color="var(--text-primary)" fill={1} />
            </div>
          )}
          {(isPreparing || isFailed) && (
            <div style={{ position: 'absolute', inset: 0, background: 'color-mix(in srgb, var(--bg-primary) 72%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={isFailed ? 'error' : 'progress_activity'} size={16} color={isFailed ? 'var(--error)' : 'var(--text-primary)'} style={{ animation: isFailed ? undefined : 'spin 1s linear infinite' }} />
            </div>
          )}
        </div>
      ) : (
        <div style={{ width: '52px', height: '52px', borderRadius: 'var(--radius-small)', backgroundColor: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxShadow: 'inset 0 0 0 1px var(--border)', padding: '4px', gap: '2px' }}>
          <Icon name={attachment.type === 'video' ? 'movie' : 'description'} size={18} color={isFailed ? 'var(--error)' : 'var(--text-muted)'} />
          <span style={{ fontSize: '9px', color: 'var(--text-muted)', textAlign: 'center', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.file.name}</span>
          {isPreparing && <span style={{ fontSize: '9px', color: 'var(--accent)', lineHeight: 1 }}>处理中</span>}
          {isFailed && <span style={{ fontSize: '9px', color: 'var(--error)', lineHeight: 1 }}>失败</span>}
        </div>
      )}
      <button onClick={() => onRemove(attachment.id)} style={{ position: 'absolute', top: '-4px', right: '-4px', width: '16px', height: '16px', borderRadius: '50%', backgroundColor: 'var(--bg-card)', color: 'var(--text-muted)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, padding: 0 }}>
        <Icon name="close" size={10} />
      </button>
    </div>
  );
});

const AttachmentPreviewList: React.FC<{ attachments: ChatAttachment[]; onRemove: (id: string) => void }> = React.memo(({ attachments, onRemove }) => (
  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '6px', boxShadow: 'inset 0 -1px 0 var(--border)', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
    {attachments.map((attachment) => (
      <AttachmentPreviewItem key={attachment.id} attachment={attachment} onRemove={onRemove} />
    ))}
  </div>
));

const formatMessageTime = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const formatChatSessionTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  return isToday
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
};

const SafePreviewImage: React.FC<{
  src: string;
  alt: string;
  onClick?: () => void;
  style?: React.CSSProperties;
}> = React.memo(({ src, alt, onClick, style }) => {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    setHasError(false);
  }, [src]);

  if (hasError) {
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '72px', background: 'var(--bg-hover)', color: 'var(--text-muted)', fontSize: '12px', borderRadius: '6px' }}>
        图片不可用
      </div>
    );
  }

  return <img src={src} alt={alt} onClick={onClick} onError={() => setHasError(true)} style={style} />;
});

interface ChatMessageRowProps {
  msg: Message;
  messageImageLookup: MessageImageMediaLookup;
  onCopyMessage: (content: string) => Promise<boolean>;
  onImagePreview: (src: string, filename: string) => void;
  onEditUserMessage?: (message: Message) => void;
  onResendUserMessage?: (message: Message) => void;
  disabled?: boolean;
}

const UserChatMessageRow: React.FC<ChatMessageRowProps> = React.memo(({ msg, messageImageLookup, onCopyMessage, onImagePreview, onEditUserMessage, onResendUserMessage, disabled = false }) => {
  const [isHovering, setIsHovering] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isContentExpanded, setIsContentExpanded] = useState(false);
  const previewSources = useMemo(() => resolveMessageImagePreviewSources(msg, messageImageLookup), [msg, messageImageLookup]);
  const shouldCollapseContent = msg.content.length > COLLAPSED_MESSAGE_TEXT_LENGTH;
  const visibleContent = shouldCollapseContent && !isContentExpanded
    ? `${msg.content.slice(0, COLLAPSED_MESSAGE_TEXT_LENGTH)}...` : msg.content;

  const handleCopy = useCallback(async () => {
    if (!msg.content) return;
    const copied = await onCopyMessage(msg.content);
    if (!copied) return;
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1500);
  }, [msg.content, onCopyMessage]);

  return (
    <div onMouseEnter={() => setIsHovering(true)} onMouseLeave={() => setIsHovering(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '100%' }}>
      <div style={{ padding: '12px 16px', borderRadius: '12px', borderBottomRightRadius: '4px', backgroundColor: 'var(--accent-dim)', color: 'var(--text-primary)', wordBreak: 'break-word', display: 'flex', flexDirection: 'column', gap: '8px', width: 'fit-content', maxWidth: '85%', minWidth: '40px', boxSizing: 'border-box' }}>
        {previewSources.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {previewSources.map((src, idx) => (
              <SafePreviewImage key={idx} src={src} alt="upload" onClick={() => onImagePreview(src, msg.imageAttachments?.[idx]?.fileName || `image-${idx + 1}.png`)}
                style={{ maxWidth: '180px', maxHeight: '180px', borderRadius: '6px', objectFit: 'contain', cursor: 'zoom-in' }} />
            ))}
          </div>
        )}
        {msg.content && (
          <>
            <ChatMessageContent content={visibleContent} role={msg.role} />
            {shouldCollapseContent && (
              <button type="button" onClick={() => setIsContentExpanded((expanded) => !expanded)}
                style={{ alignSelf: 'flex-start', height: '26px', padding: '0 8px', borderRadius: '6px', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 60%, transparent)', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: '11px' }}>
                {isContentExpanded ? '收起' : '查看完整'}
              </button>
            )}
          </>
        )}
      </div>
      {/* Hover actions */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px',
        opacity: isHovering ? 1 : 0, transition: 'opacity 0.15s',
        pointerEvents: isHovering ? 'auto' : 'none',
      }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginRight: 'auto' }}>
          {formatMessageTime(msg.timestamp)}
        </span>
        {msg.content && (
          <button onClick={handleCopy} title={isCopied ? '已复制' : '复制'}
            style={{ height: '22px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '3px', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', border: 'none', borderRadius: '6px', cursor: 'pointer', color: isCopied ? 'var(--accent)' : 'var(--text-secondary)', padding: '0 6px', fontSize: '10px', fontFamily: 'var(--font-family)' }}>
            <Icon name={isCopied ? 'check' : 'content_copy'} size={11} />
          </button>
        )}
        {!disabled && onEditUserMessage && (
          <button onClick={() => onEditUserMessage(msg)} title="编辑"
            style={{ height: '22px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 6px', fontSize: '10px', fontFamily: 'var(--font-family)' }}>
            <Icon name="edit" size={11} />
          </button>
        )}
        {!disabled && onResendUserMessage && (
          <button onClick={() => onResendUserMessage(msg)} title="重新发送"
            style={{ height: '22px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 6px', fontSize: '10px', fontFamily: 'var(--font-family)' }}>
            <Icon name="refresh" size={11} />
          </button>
        )}
      </div>
    </div>
  );
});

interface AssistantChatMessageRowProps {
  msg: Message;
  messageImageLookup: MessageImageMediaLookup;
  isTyping: boolean;
  onCopyMessage: (content: string) => Promise<boolean>;
  onImagePreview: (src: string, filename: string) => void;
  onRetryMessage: (assistantMessageId: string) => void;
  toolStateByCallId: Record<string, { toolCall: ToolCall; result?: unknown; error?: string; status: ToolCallStatus }>;
}

const AssistantChatMessageRow: React.FC<AssistantChatMessageRowProps> = React.memo(({ msg, messageImageLookup, isTyping, onCopyMessage, onImagePreview, onRetryMessage, toolStateByCallId }) => {
  const [isHovering, setIsHovering] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [isGeneratedPromptExpanded, setIsGeneratedPromptExpanded] = useState(false);
  const previewSources = useMemo(() => resolveMessageImagePreviewSources(msg, messageImageLookup), [msg, messageImageLookup]);
  const isAssistant = msg.role === 'assistant';
  const isTool = msg.role === 'tool';
  const isImageGenerationError = isAssistant && msg.id.startsWith('assistant-image-error-');
  const generatedImageContent = useMemo(() => {
    if (!isAssistant || previewSources.length === 0 || !msg.content.trim()) return null;
    const trimmedContent = msg.content.trim();
    const paragraphs = trimmedContent.split(/\n\s*\n/);
    const firstParagraph = paragraphs[0]?.trim() ?? '';
    if (firstParagraph !== '已生成图片') return null;
    const returnedPrompt = paragraphs.slice(1).join('\n\n').trim();
    return { status: '已生成图片', returnedPrompt };
  }, [isAssistant, msg.content, previewSources.length]);

  const handleCopy = useCallback(async () => {
    if (!msg.content) return;
    const copied = await onCopyMessage(msg.content);
    if (!copied) return;
    setIsCopied(true);
    window.setTimeout(() => setIsCopied(false), 1500);
  }, [msg.content, onCopyMessage]);

  return (
    <div onMouseEnter={() => setIsHovering(true)} onMouseLeave={() => setIsHovering(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', maxWidth: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', height: '20px' }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)', flexShrink: 0, boxShadow: '0 0 8px var(--accent)' }} />
        <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.02em' }}>
          {isTool ? '工具' : 'Gega AI'}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', opacity: isHovering ? 1 : 0.5, transition: 'opacity 0.15s' }}>
          {formatMessageTime(msg.timestamp)}
        </span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: '6px', opacity: isHovering ? 1 : 0.72, transition: 'opacity 0.15s', pointerEvents: 'auto' }}>
          {msg.content && (
            <button onClick={handleCopy} title={isCopied ? '已复制' : '复制'}
              style={{ height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', border: 'none', borderRadius: 'var(--radius-default)', cursor: 'pointer', color: isCopied ? 'var(--accent)' : 'var(--text-secondary)', padding: '0 8px', fontSize: '12px', fontFamily: 'var(--font-family)' }}>
              <Icon name={isCopied ? 'check' : 'content_copy'} size={13} /> {isCopied ? '已复制' : '复制'}
            </button>
          )}
          {isAssistant && !isTyping && msg.content && (
            <button onClick={() => onRetryMessage(msg.id)} title="重新生成"
              style={{ height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', border: 'none', borderRadius: 'var(--radius-default)', cursor: 'pointer', color: 'var(--text-secondary)', padding: '0 8px', fontSize: '12px', fontFamily: 'var(--font-family)' }}>
              <Icon name="refresh" size={13} /> 重新生成
            </button>
          )}
        </div>
      </div>
      <div style={{ width: '100%', wordBreak: 'break-word', color: 'var(--text-primary)', display: 'flex', flexDirection: 'column', gap: '8px', paddingLeft: '12px' }}>
        {previewSources.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', paddingRight: '12px', boxSizing: 'border-box' }}>
            {previewSources.map((src, idx) => (
              <SafePreviewImage key={idx} src={src} alt="upload" onClick={() => onImagePreview(src, msg.imageAttachments?.[idx]?.fileName || `image-${idx + 1}.png`)}
                style={{ width: '100%', height: 'auto', display: 'block', borderRadius: '6px', objectFit: 'contain', cursor: 'zoom-in' }} />
            ))}
          </div>
        )}
        {msg.role === 'tool' ? null : msg.toolCalls?.map((toolCall) => {
          const toolState = toolStateByCallId[toolCall.id];
          return <ToolCallCard key={toolCall.id} toolCall={toolCall} result={toolState?.result} error={toolState?.error} status={toolState?.status ?? 'running'} />;
        })}
        {msg.role === 'tool' ? null : (generatedImageContent ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
            <div style={{ fontSize: '13px', lineHeight: 1.6, color: 'var(--text-primary)' }}>{generatedImageContent.status}</div>
            {generatedImageContent.returnedPrompt && (
              <>
                <button type="button" onClick={() => setIsGeneratedPromptExpanded((expanded) => !expanded)}
                  style={{ height: '28px', padding: '0 10px', borderRadius: 'var(--radius-default)', border: 'none', background: 'var(--bg-hover)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-secondary)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontFamily: 'var(--font-family)' }}>
                  <Icon name={isGeneratedPromptExpanded ? 'expand_less' : 'expand_more'} size={14} />
                  {isGeneratedPromptExpanded ? '收起返回提示词' : '查看返回提示词'}
                </button>
                {isGeneratedPromptExpanded && (
                  <div style={{ width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-default)', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
                    <ChatMessageContent content={generatedImageContent.returnedPrompt} role={msg.role} />
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          msg.content && <ChatMessageContent content={msg.content} role={msg.role} />
        ))}
        {isImageGenerationError && !isTyping && (
          <button type="button" onClick={() => onRetryMessage(msg.id)}
            style={{ alignSelf: 'flex-start', height: '30px', padding: '0 12px', borderRadius: 'var(--radius-default)', border: 'none', background: 'var(--accent-dim)', boxShadow: 'inset 0 0 0 1px var(--accent-border)', color: 'var(--accent)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontFamily: 'var(--font-family)', fontWeight: 500 }}>
            <Icon name="refresh" size={14} /> 重试
          </button>
        )}
      </div>
    </div>
  );
});

// ----------------------------------------------------------------
// AIChatPanel main component
// ----------------------------------------------------------------

export const AIChatPanel: React.FC<AIChatPanelProps> = React.memo(({
  detail: _detail,
  isAIMode,
  pendingAnalysisTarget,
  onPendingAnalysisConsumed,
  // useAgentChat values
  messages, sessions, activeSessionId, setMessages,
  sendMessage, stopGeneration, retryMessage, loadSession,
  deleteSession, clearHistory, isTyping, error,
}) => {
  const showToast = useUiStore((s) => s.showToast);
  const showConfirm = useUiStore((s) => s.showConfirm);
  const activeNav = useUiStore((s) => s.activeNav);
  const activeTab = useUiStore((s) => s.activeTab);
  const sourceFolder = useUiStore((s) => s.sourceFolder);
  const fetchFiles = useMediaStore((s) => s.fetchFiles);
  const refreshDetail = useMediaStore((s) => s.refreshDetail);
  const visibleCount = useMediaStore((s) => s.files.length);
  const totalCount = useMediaStore((s) => s.totalCount);
  const currentFilter = useMediaStore((s) => s.filter);
  const mediaFiles = useMediaStore((s) => s.files);
  const mediaDetailCache = useMediaStore((s) => s.detailCache);

  // AI-specific state
  const [chatInput, setChatInput] = useState('');
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [chatHistoryMenu, setChatHistoryMenu] = useState<{ sessionId: string; title: string; x: number; y: number } | null>(null);
  const [chatImagePreview, setChatImagePreview] = useState<{ src: string; filename: string } | null>(null);
  const [chatImagePreviewScale, setChatImagePreviewScale] = useState(1);
  const [chatImagePreviewOffset, setChatImagePreviewOffset] = useState({ x: 0, y: 0 });
  const [isChatImageDragging, setIsChatImageDragging] = useState(false);
  const [modelMode, setModelMode] = useState<ModelMode>('chat');
  const [currentProvider, setCurrentProvider] = useState<ProviderType>('openai');
  const [bailianModel, setBailianModel] = useState('qwen-plus');
  const [openAiModel, setOpenAiModel] = useState(DEFAULT_OPENAI_CHAT_MODEL);
  const [openAiImageModel, setOpenAiImageModel] = useState(DEFAULT_OPENAI_IMAGE_MODEL);
  const [hasClaudeKey, setHasClaudeKey] = useState(false);
  const [hasBailianKey, setHasBailianKey] = useState(false);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [claudeModels, setClaudeModels] = useState<string[]>([]);
  const [bailianModels, setBailianModels] = useState<string[]>([]);
  const [openAiModels, setOpenAiModels] = useState<string[]>([]);
  const [openAiImageModels, setOpenAiImageModels] = useState<string[]>([]);
  const [claudeModel, setClaudeModel] = useState('claude-haiku-4-5-20251001');
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  const [chatRenderCount, setChatRenderCount] = useState(CHAT_RENDER_BATCH);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isChatAttachmentDragOver, setIsChatAttachmentDragOver] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [typingTimeoutReached, setTypingTimeoutReached] = useState(false);
  const [libraryRoot, setLibraryRoot] = useState<string | null>(null);

  const currentLibraryContext = useMemo(() => {
    const activeGroupLabel = activeTab && activeTab !== '全部' ? activeTab : null;
    const currentFolderLabel = sourceFolder || (activeNav === 'library' ? '灵感库' : activeNav === 'ai-prompts' ? 'AI 提示词库' : activeNav === 'projects' ? '作品集' : activeNav === 'trash' ? '回收站' : '当前库');
    const totalInView = currentFilter.categoryName && totalCount > 0 ? totalCount : visibleCount;
    return {
      activeGroupLabel,
      currentFolderLabel,
      visibleCount,
      totalInView,
      currentGroupMode: activeGroupLabel ? '小分组' : '大分组',
    };
  }, [activeNav, activeTab, currentFilter.categoryName, sourceFolder, totalCount, visibleCount]);

  const messageImageLookup = useMemo<MessageImageMediaLookup>(() => ({
    findMediaById: (mediaId) => {
      const detail = mediaDetailCache[mediaId];
      if (detail) return detail;
      return mediaFiles.find((file) => file.id === mediaId) ?? null;
    },
    findMediaByPath: (filepath) => {
      const normalized = filepath.trim();
      if (!normalized) return null;
      const byFile = mediaFiles.find((file) => file.filepath === normalized || file.filename === normalized);
      if (byFile) return byFile;
      const byDetail = Object.values(mediaDetailCache).find((detail) => detail.file.filepath === normalized || detail.file.filename === normalized);
      return byDetail ?? null;
    },
    resolveLegacyPath: (filepath) => {
      const root = libraryRoot?.trim();
      if (!root) return undefined;

      const normalized = filepath.replace(/\\/g, '/');
      const rootPrefix = root.replace(/[\\/]+$/, '');
      const relativeMarkers = ['/灵感库/', '/AI 提示词库/', '/作品集/', '/回收站/'];
      for (const marker of relativeMarkers) {
        const markerIndex = normalized.indexOf(marker);
        if (markerIndex >= 0) {
          const relativePath = normalized.slice(markerIndex);
          if (marker === '/灵感库/') {
            const lastSlashIndex = relativePath.lastIndexOf('/');
            const parentPath = relativePath.slice(0, lastSlashIndex);
            const filename = relativePath.slice(lastSlashIndex + 1);
            if (filename) {
              return `${rootPrefix}${parentPath}/.nocturne_meta/${filename}_micro.webp`;
            }
          }
          return `${rootPrefix}${relativePath}`;
        }
      }

      return undefined;
    },
  }), [libraryRoot, mediaDetailCache, mediaFiles]);

  const buildLibraryContextPrompt = useCallback(() => {
    const groupLabel = currentLibraryContext.activeGroupLabel ? `当前分组：${currentLibraryContext.activeGroupLabel}（${currentLibraryContext.currentGroupMode}）` : `当前视图：${currentLibraryContext.currentFolderLabel}（大分组）`;
    return [
      '你正在回答一个素材库对话问题。',
      `当前导航：${activeNav}`,
      groupLabel,
      `当前前端已加载素材数：${currentLibraryContext.visibleCount}`,
      `当前视图统计可用数量：${currentLibraryContext.totalInView}`,
      '当前前端已有素材时，不得因为统计工具失败就断言“素材库为空”。',
      '如果统计接口失败，必须明确说明“统计失败/降级到前端可见素材”，并优先依据已加载素材作答。',
    ].join('\n');
  }, [activeNav, currentLibraryContext]);

  // Refs
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatComposerRef = useRef<HTMLDivElement>(null);
  const chatTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatImageDragStartRef = useRef<{ pointerX: number; pointerY: number; offsetX: number; offsetY: number } | null>(null);
  const pendingChatScrollAnchorRef = useRef<number | null>(null);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const imageRequestRef = useRef<ImageRequestState | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const requestedChatImageDetailIdsRef = useRef<Set<string>>(new Set());

  // Extract video frame (client-side)
  const extractVideoFrame = useCallback((source: File | string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const isObjectUrl = source instanceof File;
      const url = isObjectUrl ? URL.createObjectURL(source) : source;
      video.src = url;
      video.crossOrigin = 'anonymous';
      video.currentTime = 1;
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
      video.onerror = (err) => { if (isObjectUrl) URL.revokeObjectURL(url); reject(err); };
      video.load();
    });
  }, []);

  // Extract PDF text (client-side)
  const extractPdfText = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const pdfjsLib = await import('pdfjs-dist') as typeof import('pdfjs-dist');
          try { pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href; }
          catch (e) { console.warn('[Gega] PDF.js worker 加载失败', e); }
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
        } catch (err) { console.error('PDF extraction error:', err); resolve(`[PDF文件: ${file.name}，无法提取文字]`); }
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(file);
    });
  }, []);

  // Attachment management
  const updateAttachment = useCallback((id: string, updater: (attachment: ChatAttachment) => ChatAttachment) => {
    setAttachments((prev) => prev.map((attachment) => (attachment.id === id ? updater(attachment) : attachment)));
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    const nextAttachments: ChatAttachment[] = [];
    for (const file of files) {
      const nativeFile = file as File & { path?: string; sourceItemId?: string };
      const filePath = nativeFile.path;
      const sourceItemId = nativeFile.sourceItemId;
      const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type === 'application/pdf' || file.name.endsWith('.pdf') ? 'pdf' : null;
      if (kind === 'image') {
        nextAttachments.push({ id: crypto.randomUUID(), file, type: 'image', previewUrl: filePath ? convertFileSrc(filePath) : URL.createObjectURL(file), filePath, sourceItemId, status: 'ready' });
      } else if (kind === 'video') {
        nextAttachments.push({ id: crypto.randomUUID(), file, type: 'video', previewUrl: '', filePath, sourceItemId, status: 'preparing' });
      } else if (kind === 'pdf') {
        nextAttachments.push({ id: crypto.randomUUID(), file, type: 'pdf', previewUrl: '', filePath, sourceItemId, status: 'preparing' });
      } else {
        showToast('暂不支持该文件类型');
      }
    }
    if (nextAttachments.length === 0) return;
    setAttachments((prev) => [...prev, ...nextAttachments]);
    await Promise.all(nextAttachments.map(async (attachment) => {
      if (attachment.type === 'video') {
        try {
          const frameBase64 = await extractVideoFrame(attachment.filePath ? convertFileSrc(attachment.filePath) : attachment.file);
          updateAttachment(attachment.id, (current) => ({ ...current, previewUrl: `data:image/jpeg;base64,${frameBase64}`, base64: frameBase64, status: 'ready' }));
        } catch (err) { console.error('Failed to extract video frame for chat preview:', err); updateAttachment(attachment.id, (current) => ({ ...current, status: current.filePath ? 'ready' : 'failed' })); }
      }
      if (attachment.type === 'pdf') {
        try {
          const extractedText = await extractPdfText(attachment.file);
          updateAttachment(attachment.id, (current) => ({ ...current, extractedText, status: 'ready' }));
        } catch { updateAttachment(attachment.id, (current) => ({ ...current, extractedText: `[PDF文件: ${current.file.name}，无法提取文字]`, status: 'failed' })); }
      }
    }));
  }, [extractPdfText, extractVideoFrame, showToast, updateAttachment]);

  const clearAttachments = useCallback(() => {
    setAttachments((prev) => { prev.forEach((attachment) => revokePreviewUrl(attachment.previewUrl)); return []; });
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => { const target = prev.find((a) => a.id === id); if (target) revokePreviewUrl(target.previewUrl); return prev.filter(a => a.id !== id); });
  }, []);

  const focusChatComposer = useCallback(() => { setTimeout(() => { chatTextareaRef.current?.focus(); }, 0); }, []);
  const pendingAnalysisActionsRef = useRef({
    addFiles,
    focusChatComposer,
    onPendingAnalysisConsumed,
    showToast,
  });
  pendingAnalysisActionsRef.current = {
    addFiles,
    focusChatComposer,
    onPendingAnalysisConsumed,
    showToast,
  };

  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => { attachmentsRef.current.forEach((a) => revokePreviewUrl(a.previewUrl)); }, []);
  useEffect(() => {
    let cancelled = false;
    invoke<string | null>('get_library_root')
      .then((root) => {
        if (!cancelled) setLibraryRoot(root);
      })
      .catch((err) => {
        console.warn('[AIChatPanel] failed to resolve library root for chat images:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Computed values
  const visibleMessages = useMemo(() => messages.filter(msg => msg.role !== 'system'), [messages]);
  const systemPrompt = useMemo(() => buildLibraryContextPrompt(), [buildLibraryContextPrompt]);
  const renderedMessages = useMemo(() => {
    return visibleMessages.slice(Math.max(0, visibleMessages.length - chatRenderCount));
  }, [chatRenderCount, visibleMessages]);
  const hiddenMessageCount = visibleMessages.length - renderedMessages.length;
  const loadedMediaIds = useMemo(() => new Set(mediaFiles.map((file) => file.id)), [mediaFiles]);

  const hasPendingAttachments = useMemo(() => attachments.some((a) => a.status === 'preparing'), [attachments]);
  const toolStateByCallId = useMemo<Record<string, { toolCall: ToolCall; result?: unknown; error?: string; status: ToolCallStatus }>>(() => {
    const toolCallsById: Record<string, ToolCall> = {};
    const toolResultsByCallId: Record<string, ToolResultState> = {};

    for (const message of visibleMessages) {
      for (const toolCall of message.toolCalls || []) {
        toolCallsById[toolCall.id] = toolCall;
      }
      for (const toolResult of message.toolResults || []) {
        const error = typeof toolResult.error === 'string' ? toolResult.error : toolResult.error ? String(toolResult.error) : undefined;
        toolResultsByCallId[toolResult.toolCallId] = {
          result: toolResult.result,
          error,
        };
      }
    }

    const stateByCallId: Record<string, { toolCall: ToolCall; result?: unknown; error?: string; status: ToolCallStatus }> = {};
    for (const [toolCallId, toolCall] of Object.entries(toolCallsById)) {
      const matchedResult = toolResultsByCallId[toolCallId];
      if (!matchedResult) {
        stateByCallId[toolCallId] = {
          toolCall,
          status: isTyping ? 'running' : 'cancelled',
          error: isTyping ? undefined : '已中断',
        };
        continue;
      }
      const error = matchedResult.error?.trim();
      const status = error
        ? (isCancellationError(error) ? 'cancelled' : isTimeoutError(error) ? 'error' : 'error')
        : 'done';
      stateByCallId[toolCallId] = {
        toolCall,
        result: matchedResult.result,
        error,
        status,
      };
    }

    return stateByCallId;
  }, [isTyping, visibleMessages]);

  useEffect(() => {
    const missingIds = new Set<string>();
    for (const message of renderedMessages) {
      for (const attachment of message.imageAttachments ?? []) {
        const sourceItemId = attachment.sourceItemId?.trim();
        if (!sourceItemId) continue;
        if (mediaDetailCache[sourceItemId] || loadedMediaIds.has(sourceItemId)) continue;
        if (requestedChatImageDetailIdsRef.current.has(sourceItemId)) continue;
        missingIds.add(sourceItemId);
      }
    }

    for (const sourceItemId of missingIds) {
      requestedChatImageDetailIdsRef.current.add(sourceItemId);
      void refreshDetail(sourceItemId).catch((err) => {
        console.warn('[AIChatPanel] failed to hydrate chat image source detail:', err);
      });
    }
  }, [loadedMediaIds, mediaDetailCache, refreshDetail, renderedMessages]);

  // Auto-scroll chat
  useEffect(() => { if (!chatScrollRef.current || isScrolledUp) return; chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight; }, [messages, isTyping, isScrolledUp]);
  useEffect(() => {
    if (!isTyping) {
      if (typingTimeoutRef.current !== null) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      if (typingTimeoutReached) setTypingTimeoutReached(false);
      return;
    }
    if (typingTimeoutRef.current !== null) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      setTypingTimeoutReached(true);
      stopGeneration();
    }, CHAT_TYPING_TIMEOUT_MS);
    return () => {
      if (typingTimeoutRef.current !== null) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
    };
  }, [isTyping, stopGeneration, typingTimeoutReached]);
  useEffect(() => { if (isScrolledUp) return; setChatRenderCount(Math.max(CHAT_RENDER_BATCH, visibleMessages.length)); }, [isScrolledUp, visibleMessages.length]);

  // Scroll anchor after loading older messages
  useLayoutEffect(() => {
    if (!chatScrollRef.current || pendingChatScrollAnchorRef.current === null) return;
    const el = chatScrollRef.current;
    el.scrollTop = el.scrollHeight - pendingChatScrollAnchorRef.current;
    pendingChatScrollAnchorRef.current = null;
  }, [renderedMessages.length]);

  // Textarea auto-grow
  useLayoutEffect(() => {
    const el = chatTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(240, Math.max(80, el.scrollHeight))}px`;
  }, [chatInput]);

  // Load older messages
  const loadOlderMessages = useCallback(() => {
    if (hiddenMessageCount <= 0) return;
    const scrollEl = chatScrollRef.current;
    const prevHeight = scrollEl?.scrollHeight ?? 0;
    if (scrollEl) pendingChatScrollAnchorRef.current = prevHeight;
    setChatRenderCount((prev) => Math.min(visibleMessages.length, prev + CHAT_RENDER_BATCH));
  }, [hiddenMessageCount, visibleMessages.length]);

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const isAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    if (isAtBottom && isScrolledUp) setIsScrolledUp(false);
    if (!isAtBottom && !isScrolledUp) { setIsScrolledUp(true); }
    const nearTop = el.scrollTop < CHAT_LOAD_MORE_THRESHOLD;
    if (nearTop && hiddenMessageCount > 0) loadOlderMessages();
  }, [hiddenMessageCount, isScrolledUp, loadOlderMessages]);

  const scrollChatToBottom = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setIsScrolledUp(false);
    setChatRenderCount(Math.max(CHAT_RENDER_BATCH, visibleMessages.length));
  }, [visibleMessages.length]);

  const handleCopyMessage = useCallback(async (content: string) => {
    try { await navigator.clipboard.writeText(content); return true; }
    catch { showToast('复制失败'); return false; }
  }, [showToast]);

  // Image generation helpers
  const resolveImageReferences = async (imageAttachments: ImageAttachment[]): Promise<OpenAiImageReference[]> => {
    const references: OpenAiImageReference[] = [];
    for (const attachment of imageAttachments) {
      const fileName = attachment.fileName || attachment.file?.name || 'reference.png';
      const mimeType = attachment.mimeType || attachment.file?.type || getMimeTypeFromFilename(fileName);
      const sourceItemId = attachment.sourceItemId?.trim();
      if (attachment.filePath && sourceItemId) { references.push({ fileName, mimeType, filePath: attachment.filePath }); continue; }
      if (attachment.base64) { references.push({ fileName, mimeType, base64Data: attachment.base64 }); continue; }
      if (attachment.file) {
        const bytes = new Uint8Array(await attachment.file.arrayBuffer());
        references.push({ fileName, mimeType, base64Data: bytesToBase64(bytes) });
      }
    }
    return references;
  };

  const generateImageFromPrompt = useCallback(async (prompt: string, model: string, referenceImages: OpenAiImageReference[]): Promise<Message> => {
    const imageSize = resolveImageGenerationSize(prompt);
    const generated = await invoke<OpenAiGeneratedImage>('openai_generate_image', { prompt, size: imageSize, model, referenceImages: referenceImages.length > 0 ? referenceImages : undefined });
    if (generated.b64Json) {
      const dataUrl = `data:image/png;base64,${generated.b64Json}`;
      const filePath = await invoke<string>('write_temp_file', { base64Data: dataUrl });
      let savedFile: { id: string; filename: string; filepath: string } | null = null;
      try {
        savedFile = await invoke<{ id: string; filename: string; filepath: string }>('import_generated_image_to_ai_prompts', { sourcePath: filePath, prompt, model });
        void fetchFiles(1);
      } catch (err) { console.error('[AIChatPanel] Failed to save generated image:', err); showToast('图片已生成，但保存到 AI 提示词库失败'); }
      return {
        id: createMessageId('assistant-image'), role: 'assistant',
        content: generated.revisedPrompt ? `已生成图片\n\n${generated.revisedPrompt}` : '已生成图片',
        imageAttachments: savedFile
          ? [{ id: createMessageId('generated'), fileName: savedFile.filename ?? 'generated.png', mimeType: 'image/png', previewUrl: convertFileSrc(savedFile.filepath), filePath: savedFile.filepath, sourceItemId: savedFile.id }]
          : [{ id: createMessageId('generated'), fileName: 'generated.png', mimeType: 'image/png', previewUrl: `data:image/png;base64,${generated.b64Json}` }],
        timestamp: Date.now(),
      };
    }
    if (generated.url) return { id: createMessageId('assistant-image'), role: 'assistant', content: `![generated](${generated.url})`, timestamp: Date.now() };
    throw new Error('生图响应没有返回图片数据');
  }, [fetchFiles, showToast]);

  // Handle send
  const handleSendChat = async () => {
    if ((!chatInput.trim() && attachments.length === 0) || isTyping || isProcessing) return;
    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    setTypingTimeoutReached(false);
    if (hasPendingAttachments) { showToast('附件仍在处理中，请稍候再发送'); return; }
    setIsProcessing(true);
    try {
      const imageAttachments: ImageAttachment[] = [];
      let extraText = '';
      for (const att of attachments) {
        if (att.type === 'image') {
          const canUsePathReference = Boolean(att.filePath && att.sourceItemId?.trim());
          imageAttachments.push({ id: att.id, fileName: att.file.name, mimeType: att.file.type || getMimeTypeFromFilename(att.file.name), previewUrl: att.previewUrl, base64: att.base64, filePath: att.filePath, file: canUsePathReference || att.base64 ? undefined : att.file, sourceItemId: att.sourceItemId });
        } else if (att.type === 'video') {
          if (att.base64) { imageAttachments.push({ id: att.id, fileName: `${att.file.name}-frame.jpg`, mimeType: 'image/jpeg', previewUrl: att.previewUrl || `data:image/jpeg;base64,${att.base64}`, base64: att.base64, sourceItemId: att.sourceItemId }); extraText += ' [视频第一帧]'; }
          else { extraText += ` [视频文件: ${att.file.name}]`; }
        } else if (att.type === 'pdf') {
          const text = att.extractedText || `[PDF文件: ${att.file.name}，无法提取文字]`;
          extraText += `\n\n---\n📄 PDF内容（${att.file.name}）：\n${text}`;
        }
      }
      const userContent = chatInput + extraText;
      const trimmedUserContent = userContent.trim();
      if (modelMode === 'image' && !trimmedUserContent) { showToast('请输入图生图提示词'); return; }
      setChatInput('');
      if (modelMode === 'image') {
        const requestState: ImageRequestState = { id: crypto.randomUUID(), cancelled: false };
        imageRequestRef.current = requestState;
        const userMessage: Message = { id: createMessageId('user-image'), role: 'user', content: trimmedUserContent, imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined, timestamp: Date.now() };
        setMessages(prev => [...prev, userMessage]);
        const referenceImages = await resolveImageReferences(imageAttachments);
        const assistantMessage = await generateImageFromPrompt(trimmedUserContent, openAiImageModel, referenceImages);
        if (imageRequestRef.current?.id !== requestState.id || requestState.cancelled) return;
        setMessages(prev => [...prev, assistantMessage]);
        clearAttachments();
        return;
      }
      await sendMessage(userContent, { imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined, systemPrompt });
      clearAttachments();
    } catch (err) {
      console.error('[handleSendChat] Error:', err);
      if (modelMode === 'image' && imageRequestRef.current?.cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (modelMode === 'image') {
        setMessages(prev => [...prev, { id: createMessageId('assistant-image-error'), role: 'assistant', content: `生图失败：${msg}`, timestamp: Date.now() }]);
      } else { showToast(msg); }
    } finally {
      if (typingTimeoutRef.current !== null) {
        window.clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = null;
      }
      setTypingTimeoutReached(false);
      if (modelMode === 'image') imageRequestRef.current = null;
      setIsProcessing(false);
    }
  };

  const handleStopChat = () => {
    if (imageRequestRef.current) { imageRequestRef.current.cancelled = true; setIsProcessing(false); showToast('已停止生图请求'); return; }
    stopGeneration();
    if (typingTimeoutRef.current !== null) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
    setTypingTimeoutReached(false);
    if (isProcessing) setIsProcessing(false);
  };

  // Handle retry
  const handleRetryMessage = useCallback((assistantMessageId: string) => {
    const history = messages;
    const assistantIndex = history.findIndex((message) => message.id === assistantMessageId);
    if (assistantIndex < 0) return;
    const assistantMessage = history[assistantIndex];
    const isImageGenerationMessage = assistantMessage.id.startsWith('assistant-image-');
    if (!isImageGenerationMessage) { retryMessage(assistantMessageId); return; }
    if (isTyping || isProcessing) return;
    let userIndex = -1;
    for (let index = assistantIndex - 1; index >= 0; index -= 1) { if (history[index].role === 'user') { userIndex = index; break; } }
    if (userIndex < 0) return;
    const userMessage = history[userIndex];
    const prompt = userMessage.content.trim();
    if (!prompt) { showToast('无法重试：上一条生图提示词为空'); return; }
    const requestState: ImageRequestState = { id: crypto.randomUUID(), cancelled: false };
    imageRequestRef.current = requestState;
    setModelMode('image');
    setIsProcessing(true);
    setMessages(history.slice(0, assistantIndex));
    void (async () => {
      try {
        const referenceImages = await resolveImageReferences(userMessage.imageAttachments ?? []);
        const nextAssistantMessage = await generateImageFromPrompt(prompt, openAiImageModel, referenceImages);
        if (imageRequestRef.current?.id !== requestState.id || requestState.cancelled) return;
        setMessages((prev) => [...prev, nextAssistantMessage]);
      } catch (err) {
        if (imageRequestRef.current?.id !== requestState.id || requestState.cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [...prev, { id: createMessageId('assistant-image-error'), role: 'assistant', content: `生图失败：${msg}`, timestamp: Date.now() }]);
      } finally { if (imageRequestRef.current?.id === requestState.id) imageRequestRef.current = null; setIsProcessing(false); }
    })();
  }, [generateImageFromPrompt, isProcessing, isTyping, messages, openAiImageModel, retryMessage, setMessages, showToast]);

  const handleEditUserMessage = useCallback((message: Message) => {
    if (isTyping || isProcessing) return;
    const createChatAttachmentFromImageAttachment = (att: ImageAttachment): ChatAttachment | null => {
      const kind = att.mimeType?.startsWith('video/') ? 'video' : att.mimeType === 'application/pdf' || att.fileName?.endsWith('.pdf') ? 'pdf' : 'image';
      if (kind === 'image' && att.previewUrl) return { id: crypto.randomUUID(), file: new File([], att.fileName || 'image.png', { type: att.mimeType || 'image/png' }), type: 'image', previewUrl: att.previewUrl, filePath: att.filePath, sourceItemId: att.sourceItemId, base64: att.base64, status: 'ready' };
      return null;
    };
    const restoredAttachments = (message.imageAttachments ?? []).map(createChatAttachmentFromImageAttachment).filter((a): a is ChatAttachment => a !== null);
    clearAttachments();
    setAttachments(restoredAttachments);
    setChatInput(message.content);
    if (message.id.startsWith('user-image-')) setModelMode('image');
    focusChatComposer();
  }, [clearAttachments, focusChatComposer, isProcessing, isTyping]);

  const handleResendUserMessage = useCallback((message: Message) => {
    if (isTyping || isProcessing) return;
    const prompt = message.content.trim();
    const imageAttachments = message.imageAttachments && message.imageAttachments.length > 0 ? message.imageAttachments : undefined;
    if (!message.id.startsWith('user-image-')) { void sendMessage(message.content, { imageAttachments }).catch((err) => { showToast(err instanceof Error ? err.message : String(err)); }); return; }
    if (!prompt) { showToast('无法重发：生图提示词为空'); return; }
    const requestState: ImageRequestState = { id: crypto.randomUUID(), cancelled: false };
    imageRequestRef.current = requestState;
    setModelMode('image');
    setIsProcessing(true);
    setMessages((prev) => [...prev, { id: createMessageId('user-image'), role: 'user', content: prompt, imageAttachments, timestamp: Date.now() }]);
    void (async () => {
      try {
        const referenceImages = await resolveImageReferences(imageAttachments ?? []);
        const nextAssistantMessage = await generateImageFromPrompt(prompt, openAiImageModel, referenceImages);
        if (imageRequestRef.current?.id !== requestState.id || requestState.cancelled) return;
        setMessages((prev) => [...prev, nextAssistantMessage]);
      } catch (err) {
        if (imageRequestRef.current?.id !== requestState.id || requestState.cancelled) return;
        const errorMsg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [...prev, { id: createMessageId('assistant-image-error'), role: 'assistant', content: `生图失败：${errorMsg}`, timestamp: Date.now() }]);
      } finally { if (imageRequestRef.current?.id === requestState.id) imageRequestRef.current = null; setIsProcessing(false); }
    })();
  }, [generateImageFromPrompt, isProcessing, isTyping, openAiImageModel, sendMessage, setMessages, showToast]);

  // Model selection
  const handleSelectModel = async (provider: ProviderType, model: string) => {
    setModelMode('chat'); setCurrentProvider(provider);
    await setPreference('ai_provider', provider);
    if (provider === 'openai') {
      const nextModel = sanitizeOpenAiChatModel(model);
      setOpenAiModel(nextModel);
      await setPreference('openai_model', nextModel);
    }
    else if (provider === 'claude') { setClaudeModel(model); await setPreference('claude_model', model); }
    else if (provider === 'bailian') { setBailianModel(model); await setPreference('bailian_model', model); }
    setShowProviderMenu(false);
  };

  const handleSelectImageModel = async (model: string) => {
    const nextModel = sanitizeOpenAiImageModel(model);
    setModelMode('image'); setOpenAiImageModel(nextModel);
    await setPreference('openai_image_model', nextModel);
    setShowProviderMenu(false);
  };

  // Load preferences
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
    getPreference('openai_model', DEFAULT_OPENAI_CHAT_MODEL).then(async val => {
      const nextModel = sanitizeOpenAiChatModel(val);
      setOpenAiModel(nextModel);
      if (nextModel !== val) await setPreference('openai_model', nextModel);
    });
    getPreference('openai_image_model', DEFAULT_OPENAI_IMAGE_MODEL).then(async val => {
      const nextModel = sanitizeOpenAiImageModel(val);
      setOpenAiImageModel(nextModel);
      if (nextModel !== val) await setPreference('openai_image_model', nextModel);
    });
    invoke<{ hasApiKey: boolean; model: string }>('openai_get_config').then(async config => {
      const nextModel = sanitizeOpenAiChatModel(config.model || DEFAULT_OPENAI_CHAT_MODEL);
      setHasOpenAiKey(config.hasApiKey);
      setOpenAiModel(nextModel);
      if (config.model && nextModel !== config.model) await setPreference('openai_model', nextModel);
    }).catch(() => setHasOpenAiKey(false));
  }, []);

  // Fetch models when provider menu opens
  useEffect(() => {
    if (!showProviderMenu) return;
    setIsFetchingModels(true);
    const tasks: Promise<void>[] = [];
    if (hasOpenAiKey) {
      tasks.push(invoke<{ models: string[]; imageModels: string[] }>('openai_list_models').then(data => {
        const chatModels = withoutGeminiModels(data.models);
        const imageModels = withoutGeminiModels(data.imageModels || []);
        if (chatModels.length > 0) setOpenAiModels(chatModels);
        setOpenAiImageModels(imageModels);
      }).catch(() => {}));
    }
    if (hasClaudeKey) {
      tasks.push(getPreference('claude_api_key', '').then(key =>
        fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } })
          .then(r => r.json()).then(data => { const ids: string[] = (data.data ?? []).map((m: { id: string }) => m.id); if (ids.length > 0) setClaudeModels(ids); }).catch(() => {})
      ));
    }
    tasks.push(getPreference('model_configs', '[]').then(raw => {
      try {
        const configs = JSON.parse(raw) as Array<{ provider: string; model: string }>;
        const supportedConfigs = configs.filter(c => ['openai', 'claude', 'bailian', 'tavily'].includes(c.provider));
        if (supportedConfigs.length !== configs.length) { void setPreference('model_configs', JSON.stringify(supportedConfigs)); }
        const names = supportedConfigs.filter(c => c.provider === 'bailian').map(c => c.model).filter(Boolean);
        setBailianModels(names);
      } catch { setBailianModels([]); }
    }));
    Promise.all(tasks).finally(() => setIsFetchingModels(false));
  }, [showProviderMenu, hasClaudeKey, hasBailianKey, hasOpenAiKey]);

  // Chat image preview
  const closeChatImagePreview = useCallback(() => { setChatImagePreview(null); setIsChatImageDragging(false); chatImageDragStartRef.current = null; }, []);
  const openChatImagePreview = useCallback((src: string, filename: string) => { setChatImagePreview({ src, filename }); setChatImagePreviewScale(1); setChatImagePreviewOffset({ x: 0, y: 0 }); setIsChatImageDragging(false); chatImageDragStartRef.current = null; }, []);
  const handleChatImagePreviewWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation();
    setChatImagePreviewScale((current) => { const next = Math.min(6, Math.max(1, Number((current * (event.deltaY > 0 ? 0.88 : 1.12)).toFixed(2)))); if (next === 1) setChatImagePreviewOffset({ x: 0, y: 0 }); return next; });
  }, []);
  const handleChatImagePreviewPointerDown = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    event.stopPropagation(); if (chatImagePreviewScale <= 1) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    chatImageDragStartRef.current = { pointerX: event.clientX, pointerY: event.clientY, offsetX: chatImagePreviewOffset.x, offsetY: chatImagePreviewOffset.y };
    setIsChatImageDragging(true);
  }, [chatImagePreviewOffset.x, chatImagePreviewOffset.y, chatImagePreviewScale]);
  const handleChatImagePreviewPointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    if (!isChatImageDragging || !chatImageDragStartRef.current) return;
    event.preventDefault(); event.stopPropagation();
    const start = chatImageDragStartRef.current;
    setChatImagePreviewOffset({ x: start.offsetX + event.clientX - start.pointerX, y: start.offsetY + event.clientY - start.pointerY });
  }, [isChatImageDragging]);
  const handleChatImagePreviewPointerEnd = useCallback((event: React.PointerEvent<HTMLImageElement>) => { event.stopPropagation(); chatImageDragStartRef.current = null; setIsChatImageDragging(false); }, []);
  useEffect(() => { if (!chatImagePreview) return; const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeChatImagePreview(); }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler); }, [chatImagePreview, closeChatImagePreview]);

  // Delete session
  const handleDeleteChatSession = useCallback(async (sessionId: string, title: string) => {
    const confirmed = await showConfirm({ title: '删除对话记录', message: `确定要删除「${title}」这条 AI 对话历史吗？删除后无法恢复。`, confirmText: '删除', cancelText: '取消', danger: true });
    if (!confirmed) return;
    await deleteSession(sessionId);
    setChatHistoryMenu(null);
    showToast('对话记录已删除');
  }, [deleteSession, showConfirm, showToast]);

  // Paste handler for composer
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) { if (items[i].kind === 'file') { const file = items[i].getAsFile(); if (file) files.push(file); } }
    if (files.length > 0) { e.preventDefault(); void addFiles(files); }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    void addFiles(Array.from(files));
    e.target.value = '';
  };

  // Library drag items to chat
  const addLibraryDragItemsToChat = useCallback(async (items: Array<{ fileId: string; filePath: string; filename: string; mimeType: string }>) => {
    const files = items.map((item) => {
      const file = new File([], item.filename, { type: item.mimeType || 'application/octet-stream' });
      return Object.assign(file, { path: item.filePath, sourceItemId: item.fileId });
    });
    await addFiles(files);
  }, [addFiles]);

  // Pending analysis target (bridge from PropertyPanel)
  const pendingTargetRef = useRef(pendingAnalysisTarget);
  pendingTargetRef.current = pendingAnalysisTarget;
  useEffect(() => {
    if (!pendingAnalysisTarget) return;
    const targetDetail = pendingAnalysisTarget.detail;
    const {
      addFiles: addPendingAnalysisFiles,
      focusChatComposer: focusPendingAnalysisComposer,
      onPendingAnalysisConsumed: consumePendingAnalysis,
      showToast: showPendingAnalysisToast,
    } = pendingAnalysisActionsRef.current;
    void (async () => {
      const mimeType = targetDetail.file.mimeType || getMimeTypeFromFilename(targetDetail.file.filename);
      const kind = getAnalysisAttachmentKind(targetDetail.file.filename, mimeType);
      if (!kind) {
        showPendingAnalysisToast('AI 分析仅支持图片、视频或 PDF 文件');
        consumePendingAnalysis();
        return;
      }

      const maxBytes = AI_ANALYSIS_MAX_BYTES_BY_KIND[kind];
      if (targetDetail.file.fileSize > maxBytes) {
        showPendingAnalysisToast(`文件超过 ${formatFileSize(maxBytes)}，已取消 AI 分析`);
        consumePendingAnalysis();
        return;
      }

      if (kind === 'image' || kind === 'video') {
        const file = Object.assign(
          new File([], targetDetail.file.filename, { type: mimeType }),
          { path: targetDetail.file.filepath, sourceItemId: targetDetail.file.id },
        );
        await addPendingAnalysisFiles([file]);
        focusPendingAnalysisComposer();
        consumePendingAnalysis();
        return;
      }

      const base64 = await invoke<string>('read_media_file_as_base64', { mediaId: targetDetail.file.id });
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: mimeType });
      const file = new File([blob], targetDetail.file.filename, { type: mimeType });
      await addPendingAnalysisFiles([file]);
      focusPendingAnalysisComposer();
      consumePendingAnalysis();
    })();
  }, [pendingAnalysisTarget]);

  // Drag events for composer
  useEffect(() => {
    const isPointInsideChatComposer = (clientX: number, clientY: number) => {
      const composer = chatComposerRef.current;
      if (!composer) return false;
      const rect = composer.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    };
    const handleMediaPointerDrag = (event: Event) => {
      const { detail: dragDetail } = event as CustomEvent<{ phase: string; clientX: number; clientY: number; item: { fileId: string; filePath: string; filename: string; mimeType: string } }>;
      if (!dragDetail) return;
      const isOverComposer = isPointInsideChatComposer(dragDetail.clientX, dragDetail.clientY);
      if (dragDetail.phase === 'start' || dragDetail.phase === 'move') { setIsChatAttachmentDragOver(isOverComposer); return; }
      setIsChatAttachmentDragOver(false);
      if (dragDetail.phase !== 'end' || !isOverComposer) return;
      void addLibraryDragItemsToChat([{ fileId: dragDetail.item.fileId, filePath: dragDetail.item.filePath, filename: dragDetail.item.filename, mimeType: dragDetail.item.mimeType }]).then(() => { focusChatComposer(); });
    };
    window.addEventListener(GEGA_MEDIA_POINTER_DRAG_EVENT, handleMediaPointerDrag);
    return () => window.removeEventListener(GEGA_MEDIA_POINTER_DRAG_EVENT, handleMediaPointerDrag);
  }, [addLibraryDragItemsToChat, focusChatComposer]);

  const handleChatComposerDragEnter = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setIsChatAttachmentDragOver(true); }, []);
  const handleChatComposerDragOver = useCallback((e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; setIsChatAttachmentDragOver(true); }, []);
  const handleChatComposerDragLeave = useCallback((e: React.DragEvent) => { e.preventDefault(); const related = e.relatedTarget as Node | null; if (!related || !e.currentTarget.contains(related)) setIsChatAttachmentDragOver(false); }, []);
  const handleChatComposerDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsChatAttachmentDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length > 0) { await addFiles(files); focusChatComposer(); }
  }, [addFiles, focusChatComposer]);

  // Render
  if (!isAIMode) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
      {/* Top bar: new chat button */}
      {(visibleMessages.length > 0 || sessions.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 16px 6px', flexShrink: 0, minHeight: '36px' }}>
          <div style={{ flex: 1 }} />
          <button onClick={() => setShowChatHistory(prev => !prev)} title="历史记录"
            style={{ width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: showChatHistory ? 'var(--bg-hover)' : 'transparent', border: 'none', cursor: 'pointer', color: showChatHistory ? 'var(--text-primary)' : 'var(--text-muted)', borderRadius: 'var(--radius-small)', flexShrink: 0, transition: 'background 0.12s, color 0.12s' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = showChatHistory ? 'var(--bg-hover)' : 'transparent'; e.currentTarget.style.color = showChatHistory ? 'var(--text-primary)' : 'var(--text-muted)'; }}>
            <Icon name="history" size={17} />
          </button>
          <button onClick={() => { setShowChatHistory(false); clearHistory(); }} title="新对话"
            style={{ width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', borderRadius: 'var(--radius-small)', flexShrink: 0, transition: 'background 0.12s, color 0.12s' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}>
            <Icon name="add_comment" size={17} />
          </button>
        </div>
      )}

      {/* Chat history dropdown */}
      {showChatHistory && (
        <div onClick={() => setChatHistoryMenu(null)}
          style={{ position: 'absolute', top: '42px', right: '14px', zIndex: 40, width: '248px', maxHeight: '360px', overflowY: 'auto', padding: '8px', borderRadius: 'var(--radius-default)', background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {sessions.length === 0 ? (
            <div style={{ padding: '14px 12px', color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>暂无历史记录</div>
          ) : sessions.map((session) => (
            <div key={session.id} onContextMenu={(e) => { e.preventDefault(); setChatHistoryMenu({ sessionId: session.id, title: session.title, x: e.clientX, y: e.clientY }); }}
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 28px', alignItems: 'center', gap: '4px', borderRadius: 'var(--radius-small)', background: session.id === activeSessionId ? 'var(--bg-active)' : 'transparent' }}>
              <button type="button" onClick={() => { setShowChatHistory(false); setChatHistoryMenu(null); void loadSession(session.id); }}
                style={{ minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '4px', padding: '9px 10px', border: 'none', borderRadius: 'var(--radius-small)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', textAlign: 'left' }}>
                <span style={{ width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '12px', fontWeight: 600 }}>{session.title}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{formatChatSessionTime(session.updatedAt)} · {session.messageCount} 条</span>
              </button>
              <button type="button" title="删除记录" onClick={(e) => { e.stopPropagation(); void handleDeleteChatSession(session.id, session.title); }}
                style={{ width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 'var(--radius-small)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <Icon name="delete" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Chat history context menu */}
      {chatHistoryMenu && (
        <div onMouseDown={(e) => e.stopPropagation()}
          style={{ position: 'fixed', left: chatHistoryMenu.x, top: chatHistoryMenu.y, zIndex: 120, minWidth: '132px', padding: '6px', borderRadius: 'var(--radius-default)', background: 'var(--bg-card)', boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border)' }}>
          <button type="button" onClick={() => void handleDeleteChatSession(chatHistoryMenu.sessionId, chatHistoryMenu.title)}
            style={{ width: '100%', height: '32px', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px', border: 'none', borderRadius: 'var(--radius-small)', background: 'transparent', color: 'var(--error)', cursor: 'pointer', fontSize: '12px', fontFamily: 'var(--font-family)' }}>
            <Icon name="delete" size={14} /> 删除记录
          </button>
        </div>
      )}

      {/* Messages scroll area */}
      <div ref={chatScrollRef} onScroll={handleChatScroll}
        style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 16px', display: 'flex', flexDirection: 'column', gap: '20px', scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
        {visibleMessages.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: 0.6, paddingTop: '48px' }}>
            <Icon name="auto_awesome" size={32} color="var(--text-muted)" style={{ marginBottom: '12px' }} />
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>你好，我是 Gega AI</p>
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '8px 0 0', opacity: 0.7 }}>Shift+Enter 换行 · Enter 发送</p>
          </div>
        )}
        {hiddenMessageCount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <button onClick={loadOlderMessages}
              style={{ border: 'none', background: 'var(--bg-hover)', color: 'var(--text-secondary)', borderRadius: '999px', padding: '6px 12px', fontSize: '11px', cursor: 'pointer', boxShadow: 'inset 0 0 0 1px var(--border)' }}>
              查看更早的 {Math.min(CHAT_RENDER_BATCH, hiddenMessageCount)} 条消息
            </button>
          </div>
        )}
        {renderedMessages.map((msg) => (
          msg.role === 'user' ? (
            <UserChatMessageRow key={msg.id} msg={msg} messageImageLookup={messageImageLookup} onCopyMessage={handleCopyMessage} onImagePreview={openChatImagePreview}
              onEditUserMessage={handleEditUserMessage} onResendUserMessage={handleResendUserMessage} disabled={isTyping || isProcessing} />
          ) : (
            <AssistantChatMessageRow key={msg.id} msg={msg} isTyping={isTyping || isProcessing} onCopyMessage={handleCopyMessage}
              messageImageLookup={messageImageLookup}
              onImagePreview={openChatImagePreview} onRetryMessage={handleRetryMessage} toolStateByCallId={toolStateByCallId} />
          )
        ))}
        {(isTyping || isProcessing) && renderedMessages[renderedMessages.length - 1]?.role !== 'assistant' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', height: '18px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 8px var(--accent)', animation: 'pulse 1.2s ease-in-out infinite' }} />
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.02em' }}>Gega AI</span>
            </div>
            <div style={{ paddingLeft: '12px', fontSize: '13px', color: 'var(--text-muted)' }}>正在思考...</div>
          </div>
        )}
        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 'var(--radius-default)', backgroundColor: 'var(--error-dim)', color: 'var(--error)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Icon name="error" size={14} /><span style={{ flex: 1 }}>{error}</span>
          </div>
        )}
      </div>

      {/* Scroll to bottom FAB */}
      {isScrolledUp && (
        <button onClick={scrollChatToBottom} title="滚到底部"
          style={{ position: 'absolute', bottom: '176px', right: '20px', width: '32px', height: '32px', borderRadius: '50%', background: 'var(--bg-card)', color: 'var(--text-secondary)', border: 'none', boxShadow: 'var(--shadow-md), inset 0 0 0 1px var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
          <Icon name="keyboard_arrow_down" size={16} />
        </button>
      )}

      {/* Composer */}
      <div style={{ padding: '0 16px 10px', flexShrink: 0 }}>
        <div ref={chatComposerRef} onDragEnter={handleChatComposerDragEnter} onDragOver={handleChatComposerDragOver}
          onDragLeave={handleChatComposerDragLeave} onDrop={(e) => { void handleChatComposerDrop(e); }}
          style={{ background: 'color-mix(in srgb, var(--bg-card) 88%, transparent)', borderRadius: '18px',
            boxShadow: isChatAttachmentDragOver ? 'var(--shadow-sm), inset 0 0 0 1px var(--accent-border), 0 0 0 1px var(--accent-border)' : 'var(--shadow-sm), inset 0 0 0 1px var(--border)',
            padding: '12px 12px 10px 12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {attachments.length > 0 && <AttachmentPreviewList attachments={attachments} onRemove={removeAttachment} />}
          <textarea ref={chatTextareaRef} value={chatInput} onChange={(e) => setChatInput(e.target.value)}
            onPaste={handlePaste} onDragEnter={handleChatComposerDragEnter} onDragOver={handleChatComposerDragOver}
            onDragLeave={handleChatComposerDragLeave} onDrop={(e) => { void handleChatComposerDrop(e); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
            placeholder="问 Gega Gallery 任何关于这张素材的问题…" rows={1}
            style={{ width: '100%', minHeight: '80px', maxHeight: '240px', height: '80px', padding: '2px 2px 0',
              backgroundColor: 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '13px',
              outline: 'none', resize: 'none', display: 'block', fontFamily: 'var(--font-family)',
              lineHeight: 1.5, overflow: 'auto' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} multiple accept="image/*,video/*,.pdf" />
              <button onClick={() => fileInputRef.current?.click()} disabled={isProcessing || isTyping} title="添加附件"
                style={{ width: '28px', height: '28px', borderRadius: '6px', border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: (isProcessing || isTyping) ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: (isProcessing || isTyping) ? 0.4 : 1 }}>
                <Icon name="attach_file" size={18} />
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', position: 'relative' }}>
              <div onClick={() => !isProcessing && !isTyping && setShowProviderMenu(v => !v)}
                style={{ fontSize: '11px', color: 'var(--text-secondary)', cursor: (isProcessing || isTyping) ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '999px', background: showProviderMenu ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.15s', userSelect: 'none', opacity: (isProcessing || isTyping) ? 0.45 : 1 }}>
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent-border)' }} />
                {modelMode === 'image' ? openAiImageModel : currentProvider === 'openai' ? openAiModel : currentProvider === 'claude' ? claudeModel : bailianModel}
                <Icon name="expand_more" size={12} style={{ transition: 'transform 0.15s', transform: showProviderMenu ? 'rotate(180deg)' : 'none' }} />
              </div>
              {showProviderMenu && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 99 }} onMouseDown={() => setShowProviderMenu(false)} />
                  <div onMouseDown={e => e.preventDefault()}
                    style={{ position: 'absolute', bottom: 'calc(100% + 8px)', right: 0, background: 'var(--bg-surface)', borderRadius: 'var(--radius-default)', boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border)', zIndex: 100, minWidth: '200px', maxHeight: '280px', overflowY: 'auto', scrollbarWidth: 'none', padding: '4px' }}>
                    {/* Model menu items — same structure as original, condensed for space */}
                    {hasOpenAiKey && (
                      <>
                        <div style={{ padding: '8px 8px 4px', fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-family)' }}>OpenAI-compatible {isFetchingModels && '…'}</div>
                        {(openAiModels.length > 0 ? openAiModels : [openAiModel]).map(id => {
                          const isActive = currentProvider === 'openai' && openAiModel === id;
                          return <div key={id} onClick={() => handleSelectModel('openai', id)}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', fontSize: '12px', cursor: 'pointer', borderRadius: 'var(--radius-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-family)', background: isActive ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.1s' }}>
                            <span style={{ width: '4px', height: '4px', borderRadius: '50%', backgroundColor: isActive ? 'var(--accent)' : 'transparent', flexShrink: 0 }} />{id}
                          </div>;
                        })}
                        {openAiImageModels.length > 0 && (
                          <>
                            <div style={{ padding: '10px 8px 4px', fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-family)' }}>生图模型</div>
                            {openAiImageModels.map(id => {
                              const isActive = modelMode === 'image' && openAiImageModel === id;
                              return <div key={id} onClick={() => handleSelectImageModel(id)}
                                style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', fontSize: '12px', cursor: 'pointer', borderRadius: 'var(--radius-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-family)', background: isActive ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.1s' }}>
                                <span style={{ width: '4px', height: '4px', borderRadius: '50%', backgroundColor: isActive ? 'var(--accent)' : 'transparent', flexShrink: 0 }} />{id}
                              </div>;
                            })}
                          </>
                        )}
                      </>
                    )}
                    {hasClaudeKey && (
                      <>
                        <div style={{ padding: '8px 8px 4px', fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-family)' }}>Claude {isFetchingModels && '…'}</div>
                        {claudeModels.map(id => {
                          const isActive = currentProvider === 'claude' && claudeModel === id;
                          return <div key={id} onClick={() => handleSelectModel('claude', id)}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', fontSize: '12px', cursor: 'pointer', borderRadius: 'var(--radius-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-family)', background: isActive ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.1s' }}>
                            <span style={{ width: '4px', height: '4px', borderRadius: '50%', backgroundColor: isActive ? 'var(--accent)' : 'transparent', flexShrink: 0 }} />{id}
                          </div>;
                        })}
                        {!isFetchingModels && claudeModels.length === 0 && <div style={{ padding: '6px 10px', fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-family)', fontStyle: 'italic' }}>无法获取模型列表，请检查 API Key</div>}
                      </>
                    )}
                    {!isFetchingModels && bailianModels.length > 0 && (
                      <>
                        <div style={{ padding: '8px 8px 4px', fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontFamily: 'var(--font-family)' }}>配置的模型</div>
                        {bailianModels.map(id => {
                          const isActive = currentProvider === 'bailian' && bailianModel === id;
                          return <div key={id} onClick={() => handleSelectModel('bailian', id)}
                            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', fontSize: '12px', cursor: 'pointer', borderRadius: 'var(--radius-default)', color: 'var(--text-primary)', fontFamily: 'var(--font-family)', background: isActive ? 'var(--bg-hover)' : 'transparent', transition: 'background 0.1s' }}>
                            <span style={{ width: '4px', height: '4px', borderRadius: '50%', backgroundColor: isActive ? 'var(--accent)' : 'transparent', flexShrink: 0 }} />{id}
                          </div>;
                        })}
                      </>
                    )}
                  </div>
                </>
              )}
              {(isTyping || isProcessing) ? (
                <button onClick={handleStopChat} title="停止生成"
                  style={{ width: '28px', height: '28px', borderRadius: '6px', border: 'none', background: 'color-mix(in srgb, var(--error) 15%, transparent)', color: 'var(--error)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms ease' }}>
                  <Icon name="stop" size={17} />
                </button>
              ) : (
                <button onClick={handleSendChat} disabled={(!chatInput.trim() && attachments.length === 0) || hasPendingAttachments}
                  style={{ width: '30px', height: '30px', borderRadius: '50%', border: 'none',
                    background: (chatInput.trim() || attachments.length > 0) && !hasPendingAttachments ? 'var(--accent)' : 'var(--bg-hover)',
                    color: (chatInput.trim() || attachments.length > 0) && !hasPendingAttachments ? 'var(--text-on-accent)' : 'var(--text-muted)',
                    cursor: (chatInput.trim() || attachments.length > 0) && !hasPendingAttachments ? 'pointer' : 'default',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 150ms ease',
                    boxShadow: (chatInput.trim() || attachments.length > 0) && !hasPendingAttachments ? '0 8px 18px var(--accent-glow)' : 'none' }}>
                  <Icon name="arrow_upward" size={18} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Chat image preview overlay */}
      {chatImagePreview && (
        <div onClick={closeChatImagePreview} onWheelCapture={handleChatImagePreviewWheel}
          style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'var(--overlay-preview-backdrop)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px', cursor: 'zoom-out', overflow: 'hidden', overscrollBehavior: 'contain' }}>
          <button type="button" onClick={closeChatImagePreview} title="关闭"
            style={{ position: 'absolute', top: '18px', right: '18px', width: '34px', height: '34px', borderRadius: 'var(--radius-default)', border: 'none', background: 'var(--bg-card)', color: 'var(--text-primary)', boxShadow: 'inset 0 0 0 1px var(--border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={18} />
          </button>
          <img src={chatImagePreview.src} alt={chatImagePreview.filename}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={handleChatImagePreviewPointerDown} onPointerMove={handleChatImagePreviewPointerMove}
            onPointerUp={handleChatImagePreviewPointerEnd} onPointerCancel={handleChatImagePreviewPointerEnd}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 'var(--radius-default)', boxShadow: 'var(--shadow-lg)',
              cursor: chatImagePreviewScale > 1 ? (isChatImageDragging ? 'grabbing' : 'grab') : 'zoom-in',
              transform: `translate3d(${chatImagePreviewOffset.x}px, ${chatImagePreviewOffset.y}px, 0) scale(${chatImagePreviewScale})`,
              transformOrigin: 'center center', transition: isChatImageDragging ? 'none' : 'transform 120ms ease',
              userSelect: 'none', touchAction: 'none' }}
            draggable={false} />
        </div>
      )}
    </div>
  );
});
