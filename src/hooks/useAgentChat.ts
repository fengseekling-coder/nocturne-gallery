import { startTransition, useState, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Message, ProviderType, ImageAttachment, StreamChunk } from '../lib/ai/types';
import { AIProvider } from '../lib/ai/providers/base';
import { ClaudeProvider } from '../lib/ai/providers/claude';
import { BailianProvider } from '../lib/ai/providers/bailian';
import { OpenAiProvider } from '../lib/ai/providers/openai';
import { GegaAgent } from '../lib/ai/agent';
import { allTools } from '../lib/ai/tools';
import {
  hasInvalidImageAttachments,
  normalizeImageAttachments,
  resolveStoredImageAttachments,
  revokeMessagePreviewUrls,
} from '../lib/ai/messageImages';
import { useMediaStore } from '../stores/mediaStore';
import type { MediaDetail, MediaFile } from '../types/media';
import { getPreference } from '../utils/preferences';

const CHAT_SAVE_DEBOUNCE_MS = 450;
const CHAT_SAVE_RETRY_DELAYS_MS = [800, 1600, 3200];

export interface AiChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

interface AiChatLoadResult {
  activeSessionId: string | null;
  sessions: AiChatSession[];
  messages: Message[];
}

interface SaveAiChatSessionParams {
  sessionId: string;
  title: string;
  messages: Message[];
}

const createChatSessionId = (): string => `chat-${Date.now()}-${crypto.randomUUID()}`;
const createMessageId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

const getMediaLookup = (): MessageMediaLookup => {
  const mediaState = useMediaStore.getState();
  return {
    findMediaById: (mediaId) => mediaState.detailCache[mediaId] ?? mediaState.files.find((file) => file.id === mediaId) ?? null,
    findMediaByPath: (filepath) => mediaState.files.find((file) => file.filepath === filepath || file.filename === filepath) ?? Object.values(mediaState.detailCache).find((detail) => detail.file.filepath === filepath || detail.file.filename === filepath) ?? null,
  };
};

const getSessionTitle = (messages: Message[]): string => {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content.trim().length > 0);
  const rawTitle = firstUserMessage?.content.trim().replace(/\s+/g, ' ') || '新对话';
  return rawTitle.length > 32 ? `${rawTitle.slice(0, 32)}...` : rawTitle;
};

type MessageMediaLookup = {
  findMediaById: (mediaId: string) => MediaFile | MediaDetail | null | undefined;
  findMediaByPath: (filepath: string) => MediaFile | MediaDetail | null | undefined;
};

const hydrateStoredMessages = (
  messages: Message[],
  mediaLookup?: MessageMediaLookup,
): Message[] =>
  messages.map((message) => ({
    ...message,
    imageAttachments: resolveStoredImageAttachments(message.imageAttachments, mediaLookup),
  }));

const sanitizeMessagesForStorage = (messages: Message[]): Message[] =>
  messages.map((message) => ({
    ...message,
    imageAttachments: message.imageAttachments?.map((attachment) => {
      const storedAttachment: ImageAttachment = {
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        previewUrl: attachment.previewUrl?.startsWith('blob:') ? undefined : attachment.previewUrl,
        base64: attachment.base64,
        filePath: attachment.filePath,
        sourceItemId: attachment.sourceItemId,
      };
      return storedAttachment;
    }),
  }));

const IMAGE_UPLOAD_FAILED_MESSAGE = '图片上传失败，需要重新上传';

const normalizeImages = (images?: string[]): string[] | undefined => {
  const sanitized = images?.filter((img) => typeof img === 'string' && img.trim().length > 0);
  return sanitized && sanitized.length > 0 ? sanitized : undefined;
};

const hasInvalidImages = (images?: string[]): boolean =>
  !!images?.some((img) => typeof img !== 'string' || img.trim().length === 0);

const isDatabaseLockedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|database table is locked|sqlite_busy/i.test(message);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const saveAiChatSessionWithRetry = async (params: SaveAiChatSessionParams): Promise<AiChatSession> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= CHAT_SAVE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await invoke<AiChatSession>('save_ai_chat_session', {
        sessionId: params.sessionId,
        title: params.title,
        messages: params.messages,
      });
    } catch (error) {
      lastError = error;
      if (!isDatabaseLockedError(error) || attempt >= CHAT_SAVE_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await delay(CHAT_SAVE_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const applyChunkToMessages = (messages: Message[], chunk: StreamChunk): Message[] => {
  const msgId = chunk.messageId;
  const updated = [...messages];

  switch (chunk.type) {
    case 'text': {
      if (!msgId) return messages;
      const idx = updated.findIndex((message) => message.id === msgId);
      if (idx >= 0) {
        updated[idx] = {
          ...updated[idx],
          content: updated[idx].content === chunk.content || !chunk.content
            ? updated[idx].content
            : `${updated[idx].content || ''}${chunk.content}`,
        };
      } else {
        updated.push({
          id: msgId,
          role: 'assistant',
          content: chunk.content || '',
          timestamp: Date.now(),
        });
      }
      return updated;
    }
    case 'tool_call': {
      if (!msgId || !chunk.toolCall) return messages;
      const idx = updated.findIndex((message) => message.id === msgId);
      if (idx >= 0) {
        const toolCalls = updated[idx].toolCalls || [];
        if (!toolCalls.some((toolCall) => toolCall.id === chunk.toolCall!.id)) {
          updated[idx] = {
            ...updated[idx],
            toolCalls: [...toolCalls, chunk.toolCall],
          };
        }
      } else {
        updated.push({
          id: msgId,
          role: 'assistant',
          content: '',
          toolCalls: [chunk.toolCall],
          timestamp: Date.now(),
        });
      }
      return updated;
    }
    case 'tool_result': {
      if (!msgId || !chunk.toolResult) return messages;
      const toolResult = chunk.toolResult;
      const idx = updated.findIndex((message) => message.id === msgId);
      if (idx >= 0) {
        const toolResults = updated[idx].toolResults || [];
        if (!toolResults.some((tr) => tr.toolCallId === toolResult.toolCallId)) {
          updated[idx] = {
            ...updated[idx],
            toolResults: [...toolResults, toolResult],
          };
        }
      } else {
        updated.push({
          id: msgId,
          role: 'tool',
          content: '',
          toolResults: [toolResult],
          timestamp: Date.now(),
        });
      }
      return updated;
    }
    case 'message': {
      if (!chunk.message) return messages;
      const idx = updated.findIndex((message) => message.id === chunk.message!.id);
      if (idx >= 0) {
        updated[idx] = {
          ...updated[idx],
          ...chunk.message,
          content: chunk.message.content || updated[idx].content,
          toolCalls: chunk.message.toolCalls ?? updated[idx].toolCalls,
          toolResults: chunk.message.toolResults ?? updated[idx].toolResults,
        };
      } else {
        updated.push(chunk.message);
      }
      return updated;
    }
    default:
      return messages;
  }
};

export const useAgentChat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // messagesRef 镜像 messages 最新值，供异步 Agent 回调读取。
  // 直接读 messages 会因闭包捕获旧值而导致消息丢失（stale closure 问题）。
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;
  const hasLoadedSessionsRef = useRef(false);
  const isHydratingSessionRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const chatBlobPreviewCacheRef = useRef<Map<string, string>>(new Map());
  const chatBlobPreviewOrderRef = useRef<string[]>([]);

  // abortRef 用于中断当前 Agent 运行（用户点击"停止生成"）
  const abortRef = useRef<AbortController | null>(null);
  const pendingChunksRef = useRef<StreamChunk[]>([]);
  const flushFrameRef = useRef<number | null>(null);

  const cancelPendingChunkFlush = useCallback(() => {
    if (flushFrameRef.current !== null) {
      window.cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }
    pendingChunksRef.current = [];
  }, []);

  const flushPendingChunks = useCallback(() => {
    if (flushFrameRef.current !== null) {
      window.cancelAnimationFrame(flushFrameRef.current);
      flushFrameRef.current = null;
    }

    const pendingChunks = pendingChunksRef.current;
    if (pendingChunks.length === 0) return;

    pendingChunksRef.current = [];

    startTransition(() => {
      setMessages((prevMessages) => {
        let updatedMessages = prevMessages;
        for (const chunk of pendingChunks) {
          updatedMessages = applyChunkToMessages(updatedMessages, chunk);
        }
        messagesRef.current = updatedMessages;
        return updatedMessages;
      });
    });
  }, []);

  const schedulePendingChunkFlush = useCallback(() => {
    if (flushFrameRef.current !== null) return;

    flushFrameRef.current = window.requestAnimationFrame(() => {
      flushFrameRef.current = null;
      flushPendingChunks();
    });
  }, [flushPendingChunks]);

  useEffect(() => {
    let cancelled = false;

    invoke<AiChatLoadResult>('load_ai_chat_session', { sessionId: null })
      .then((result) => {
        if (cancelled) return;
        isHydratingSessionRef.current = true;
        const hydratedMessages = hydrateStoredMessages(result.messages || [], getMediaLookup());
        messagesRef.current = hydratedMessages;
        setMessages(hydratedMessages);
        setSessions(result.sessions || []);
        setActiveSessionId(result.activeSessionId || null);
        window.setTimeout(() => {
          isHydratingSessionRef.current = false;
          hasLoadedSessionsRef.current = true;
        }, 0);
      })
      .catch((err) => {
        if (cancelled) return;
        hasLoadedSessionsRef.current = true;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedSessionsRef.current || isHydratingSessionRef.current) return;
    if (messages.length === 0) return;

    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }

    const sessionId = activeSessionIdRef.current || createChatSessionId();
    if (!activeSessionIdRef.current) {
      activeSessionIdRef.current = sessionId;
      setActiveSessionId(sessionId);
    }

    const title = getSessionTitle(messages);
    const storedMessages = sanitizeMessagesForStorage(messages);
    saveTimerRef.current = window.setTimeout(() => {
      void saveAiChatSessionWithRetry({
        sessionId,
        title,
        messages: storedMessages,
      }).then((savedSession) => {
        setError(null);
        setSessions((prevSessions) => {
          const withoutSaved = prevSessions.filter((session) => session.id !== savedSession.id);
          return [savedSession, ...withoutSaved].sort((a, b) => b.updatedAt - a.updatedAt);
        });
      }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
    }, CHAT_SAVE_DEBOUNCE_MS);
  }, [messages]);

  const loadSession = useCallback(async (sessionId: string) => {
    flushPendingChunks();
    abortRef.current?.abort();
    abortRef.current = null;
    cancelPendingChunkFlush();
    revokeMessagePreviewUrls(messagesRef.current);
    isHydratingSessionRef.current = true;
    const result = await invoke<AiChatLoadResult>('load_ai_chat_session', { sessionId });
    const hydratedMessages = hydrateStoredMessages(result.messages || [], getMediaLookup());
    const nextActiveSessionId = result.activeSessionId || sessionId;
    messagesRef.current = hydratedMessages;
    setMessages(hydratedMessages);
    setSessions(result.sessions || []);
    activeSessionIdRef.current = nextActiveSessionId;
    setActiveSessionId(nextActiveSessionId);
    setError(null);
    setIsTyping(false);
    window.setTimeout(() => {
      isHydratingSessionRef.current = false;
      hasLoadedSessionsRef.current = true;
    }, 0);
  }, [cancelPendingChunkFlush, flushPendingChunks]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const result = await invoke<AiChatLoadResult>('delete_ai_chat_session', { sessionId });
    revokeMessagePreviewUrls(messagesRef.current);
    isHydratingSessionRef.current = true;
    const hydratedMessages = hydrateStoredMessages(result.messages || [], getMediaLookup());
    messagesRef.current = hydratedMessages;
    setMessages(hydratedMessages);
    setSessions(result.sessions || []);
    setActiveSessionId(result.activeSessionId || null);
    window.setTimeout(() => {
      isHydratingSessionRef.current = false;
      hasLoadedSessionsRef.current = true;
    }, 0);
  }, []);

  const sendMessage = useCallback(async (content: string, options: { images?: string[], imageAttachments?: ImageAttachment[], systemPrompt?: string }) => {
    if (!content.trim() && (!options.images || options.images.length === 0) && (!options.imageAttachments || options.imageAttachments.length === 0)) return;

    setError(null);
    if (hasInvalidImages(options.images)) {
      setError(IMAGE_UPLOAD_FAILED_MESSAGE);
      throw new Error(IMAGE_UPLOAD_FAILED_MESSAGE);
    }
    if (hasInvalidImageAttachments(options.imageAttachments)) {
      setError(IMAGE_UPLOAD_FAILED_MESSAGE);
      throw new Error(IMAGE_UPLOAD_FAILED_MESSAGE);
    }

    // 创建新的 AbortController，上一次的会被覆盖（正常情况上一次已结束）
    const userMessage: Message = {
      id: createMessageId('user'),
      role: 'user',
      content,
      images: normalizeImages(options.images),
      imageAttachments: normalizeImageAttachments(options.imageAttachments),
      timestamp: Date.now(),
    };

    const currentMessages: Message[] = messagesRef.current.map((message) => ({
        ...message,
        images: hasInvalidImages(message.images) ? normalizeImages(message.images) : message.images,
        imageAttachments: hasInvalidImageAttachments(message.imageAttachments)
          ? normalizeImageAttachments(message.imageAttachments)
          : message.imageAttachments,
      }),
    );
    if (options.systemPrompt) {
      const systemMsg: Message = {
        id: createMessageId('system'),
        role: 'system',
        content: options.systemPrompt,
        timestamp: Date.now(),
      };
      const existingSystemIdx = currentMessages.findIndex((m) => m.role === 'system');
      if (existingSystemIdx >= 0) {
        // 切换选中素材后，用新上下文替换旧的 system 消息，避免 AI 仍以旧文件作答
        currentMessages[existingSystemIdx] = systemMsg;
      } else {
        currentMessages.unshift(systemMsg);
      }
    }
    
    const newMessages = [...currentMessages, userMessage];

    setIsTyping(true);
    abortRef.current?.abort();
    cancelPendingChunkFlush();
    const controller = new AbortController();
    abortRef.current = controller;

    messagesRef.current = newMessages;
    setMessages(newMessages);

    try {
      const savedProvider = await getPreference('ai_provider', 'openai');
      const providerType: ProviderType = savedProvider === 'claude' || savedProvider === 'bailian'
        ? savedProvider
        : 'openai';
      console.log('[AgentChat] provider:', providerType);
      const provider: AIProvider = providerType === 'claude'
        ? new ClaudeProvider()
        : providerType === 'bailian'
        ? new BailianProvider()
        : new OpenAiProvider();
      const agent = new GegaAgent(provider, allTools);

      await agent.run(newMessages, (chunk) => {
        // 用户中断后，忽略后续 chunk，避免 UI 继续被填充
        if (controller.signal.aborted) return;

        switch (chunk.type) {
          case 'text':
          case 'tool_call':
          case 'tool_result':
          case 'message':
            pendingChunksRef.current.push(chunk);
            schedulePendingChunkFlush();
            break;
          case 'error':
            flushPendingChunks();
            setError(chunk.error || 'Unknown error');
            break;
        }
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        flushPendingChunks();
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    } finally {
      flushPendingChunks();
      pendingChunksRef.current = [];
      setIsTyping(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [cancelPendingChunkFlush, flushPendingChunks, schedulePendingChunkFlush]);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    cancelPendingChunkFlush();
    setIsTyping(false);
  }, [cancelPendingChunkFlush]);

  /**
   * 重新生成：定位到指定 assistant 消息之前最近的 user 消息，
   * 截断历史，从该 user 消息重新运行。
   */
  const retryMessage = useCallback((assistantMessageId: string) => {
    const history = messagesRef.current;
    const asstIdx = history.findIndex(m => m.id === assistantMessageId);
    if (asstIdx < 0) return;

    // 向前找最近的 user 消息
    let userIdx = -1;
    for (let i = asstIdx - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;

    const userMsg = history[userIdx];
    const systemMsg = history.find(m => m.role === 'system');

    // 截断历史：保留到 user 消息之前（sendMessage 会重新 push user 消息）
    const truncated = history.slice(0, userIdx);
    cancelPendingChunkFlush();
    revokeMessagePreviewUrls(history.slice(userIdx + 1));
    chatBlobPreviewCacheRef.current.forEach((url) => {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    });
    chatBlobPreviewCacheRef.current.clear();
    chatBlobPreviewOrderRef.current.length = 0;
    messagesRef.current = truncated;
    setMessages(truncated);

    // 下一个 tick 重发
    setTimeout(() => {
      void sendMessage(userMsg.content, {
        images: userMsg.images,
        imageAttachments: userMsg.imageAttachments,
        systemPrompt: systemMsg?.content,
      }).catch(() => {});
    }, 0);
  }, [cancelPendingChunkFlush, sendMessage]);

  const clearHistory = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    cancelPendingChunkFlush();
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    revokeMessagePreviewUrls(messagesRef.current);
    chatBlobPreviewCacheRef.current.forEach((url) => {
      if (url.startsWith('blob:')) URL.revokeObjectURL(url);
    });
    chatBlobPreviewCacheRef.current.clear();
    chatBlobPreviewOrderRef.current.length = 0;
    messagesRef.current = [];
    setMessages([]);
    const nextSessionId = createChatSessionId();
    activeSessionIdRef.current = nextSessionId;
    setActiveSessionId(nextSessionId);
    setError(null);
    setIsTyping(false);
  }, [cancelPendingChunkFlush]);

  useEffect(() => {
    const blobCache = chatBlobPreviewCacheRef.current;
    const blobOrder = chatBlobPreviewOrderRef.current;
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (flushFrameRef.current !== null) {
        window.cancelAnimationFrame(flushFrameRef.current);
      }
      abortRef.current?.abort();
      abortRef.current = null;
      revokeMessagePreviewUrls(messagesRef.current);
      blobCache.forEach((url) => {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      });
      blobCache.clear();
      blobOrder.length = 0;
    };
  }, []);

  return {
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
    error,
    clearHistory,
  };
};
