import { AIProvider } from './providers/base';
import { ImageAttachment, Message, Tool, StreamChunk, ToolResult } from './types';

// 工具执行结果中的视觉分析标记
interface VisionToolResult {
  _requires_vision: true;
  _vision_prompt: string;
  image_path?: string;
  mime_type?: string;
  preview_url?: string;
  file_name?: string;
  item_id?: string;
}

interface BatchVisionToolResult {
  _batch_vision: true;
  items: Array<{
    item_id: string;
    file_name: string;
    image_path?: string;
    mime_type?: string;
    preview_url?: string;
    _vision_prompt: string;
  }>;
}

type ToolExecuteResult = VisionToolResult | BatchVisionToolResult | Record<string, unknown>;

const TOOL_EXECUTE_TIMEOUT_MS = 25000;
const TOOL_TIMEOUT_ERROR = '工具执行超时，请稍后重试';
const createMessageId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

function isVisionResult(result: unknown): result is VisionToolResult {
  return typeof result === 'object' && result !== null && '_requires_vision' in result;
}

function isBatchVisionResult(result: unknown): result is BatchVisionToolResult {
  return typeof result === 'object' && result !== null && '_batch_vision' in result;
}

function toVisionAttachment(
  id: string,
  fileName?: string,
  sourceItemId?: string,
  imagePath?: string,
  mimeType?: string,
  previewUrl?: string,
): ImageAttachment | null {
  if (!imagePath && !previewUrl) return null;

  return {
    id,
    fileName,
    sourceItemId,
    filePath: imagePath,
    mimeType,
    previewUrl,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
}

export class GegaAgent {
  private maxIterations = 5;

  constructor(
    private provider: AIProvider,
    private tools: Tool[]
  ) {}

  async run(
    messages: Message[],
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal
  ): Promise<void> {
    let iterations = 0;

    while (iterations < this.maxIterations) {
      if (signal?.aborted) return;
      iterations++;

      const currentAssistantMessage: Message = {
        id: createMessageId('asst'),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        toolCalls: []
      };

      await this.provider.chat(messages, this.tools, (chunk) => {
        if (signal?.aborted) return;
        if (chunk.type === 'text') {
          currentAssistantMessage.content += chunk.content;
        } else if (chunk.type === 'tool_call') {
          currentAssistantMessage.toolCalls?.push(chunk.toolCall!);
        }
        onChunk({ ...chunk, messageId: currentAssistantMessage.id });
      });

      if (signal?.aborted) return;

      if (!currentAssistantMessage.content.trim() && !currentAssistantMessage.toolCalls?.length) {
        break;
      }

      messages.push(currentAssistantMessage);

      if (!currentAssistantMessage.toolCalls?.length) {
        break;
      }

      const results: ToolResult[] = [];
      const toolMessageId = createMessageId('tool');
      for (const tc of currentAssistantMessage.toolCalls) {
        if (signal?.aborted) {
          const tr = { toolCallId: tc.id, result: null, error: 'cancelled' };
          results.push(tr);
          onChunk({ type: 'tool_result', toolResult: tr, messageId: toolMessageId });
          continue;
        }
        onChunk({ type: 'tool_call', toolCall: tc, messageId: currentAssistantMessage.id });
        try {
          const tool = this.tools.find(t => t.name === tc.name);
          if (!tool) throw new Error(`Tool ${tc.name} not found`);

          const result = await withTimeout(
            tool.execute(tc.arguments) as Promise<ToolExecuteResult>,
            TOOL_EXECUTE_TIMEOUT_MS,
            TOOL_TIMEOUT_ERROR,
          );
          const tr = { toolCallId: tc.id, result };
          results.push(tr);
          onChunk({ type: 'tool_result', toolResult: tr, messageId: toolMessageId });

          if (isVisionResult(result)) {
            const attachment = toVisionAttachment(
              createMessageId('vision-attachment'),
              result.file_name,
              result.item_id,
              result.image_path,
              result.mime_type,
              result.preview_url,
            );
            const visionMsg: Message = {
              id: createMessageId('vision'),
              role: 'user',
              content: result._vision_prompt || '分析这张图片',
              imageAttachments: attachment ? [attachment] : undefined,
              timestamp: Date.now()
            };
            messages.push(visionMsg);
            onChunk({ type: 'message', message: visionMsg });
          } else if (isBatchVisionResult(result)) {
            const imageAttachments = result.items
              .map((item, index) =>
                toVisionAttachment(
                  `${createMessageId('vision-batch-attachment')}-${index}`,
                  item.file_name,
                  item.item_id,
                  item.image_path,
                  item.mime_type,
                  item.preview_url,
                ),
              )
              .filter((attachment): attachment is ImageAttachment => attachment !== null);
            const batchMsg: Message = {
              id: createMessageId('vision-batch'),
              role: 'user',
              content: "请对以下多张图片分别进行分析：\n" + result.items.map((it, idx) => `图片 ${idx + 1} (${it.file_name}): ${it._vision_prompt}`).join('\n'),
              imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
              timestamp: Date.now()
            };
            messages.push(batchMsg);
            onChunk({ type: 'message', message: batchMsg });
          }
        } catch (e) {
          console.error(`Error executing tool ${tc.name}:`, e);
          const errorMessage = e instanceof Error ? e.message : String(e);
          const tr = { toolCallId: tc.id, result: null, error: errorMessage || TOOL_TIMEOUT_ERROR };
          results.push(tr);
          onChunk({ type: 'tool_result', toolResult: tr, messageId: toolMessageId });
        }
      }

      messages.push({
        id: toolMessageId,
        role: 'tool',
        content: JSON.stringify(results),
        toolResults: results,
        timestamp: Date.now()
      });
    }

    onChunk({ type: 'done' });
  }
}
