import { AIProvider } from './base';
import { Message, Tool, StreamChunk, ProviderType } from '../types';
import {
  buildMessageContentForProvider,
  getLatestVisualMessageId,
  resolveMessageImages,
} from '../messageImages';
import { getPreference } from '../../../utils/preferences';

const BAILIAN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class BailianProvider implements AIProvider {
  name = '百炼';
  type: ProviderType = 'bailian';

  async isAvailable(): Promise<boolean> {
    const key = await getPreference('bailian_api_key', '');
    return key.length > 0;
  }

  async chat(messages: Message[], tools: Tool[], onChunk: (chunk: StreamChunk) => void): Promise<void> {
    const apiKey = await getPreference('bailian_api_key', '');
    if (!apiKey) throw new Error('百炼接口密钥未配置');
    const model = await getPreference('bailian_model', 'qwen-plus');
    const latestVisualMessageId = getLatestVisualMessageId(messages);

    // 格式化消息为 OpenAI 兼容格式
    const formattedMessages: unknown[] = [];
    for (const m of messages) {
      if (m.role === 'tool' && m.toolResults) {
        // 工具结果：每个 result 单独一条 tool 消息
        for (const tr of m.toolResults) {
          formattedMessages.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.error ? `Error: ${tr.error}` : JSON.stringify(tr.result),
          });
        }
        continue;
      }

      const msg: Record<string, unknown> = {
        role: m.role === 'tool' ? 'user' : m.role,
      };

      const includeImages = m.id === latestVisualMessageId;
      const resolvedImages = includeImages ? await resolveMessageImages(m) : [];
      const contentText = buildMessageContentForProvider(m, includeImages);

      // 图片消息用多模态格式
      if (resolvedImages.length > 0) {
        msg.content = [
          ...(contentText ? [{ type: 'text', text: contentText }] : []),
          ...resolvedImages.map((image) => ({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })),
        ];
      } else {
        msg.content = contentText;
      }

      // assistant 工具调用
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }

      formattedMessages.push(msg);
    }

    const body: Record<string, unknown> = {
      model,
      messages: formattedMessages,
      stream: true,
    };

    if (tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const response = await fetch(`${BAILIAN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`百炼 API ${response.status}: ${errorData.error?.message || response.statusText}`);
    }

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const pendingToolCalls = new Map<number, PendingToolCall>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          onChunk({ type: 'done' });
          return;
        }

        try {
          const json = JSON.parse(data);
          const choice = json.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;

          // 文本内容
          if (delta?.content) {
            onChunk({ type: 'text', content: delta.content });
          }

          // 工具调用（流式累积参数）
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx: number = tc.index ?? 0;
              if (!pendingToolCalls.has(idx)) {
                pendingToolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' });
              }
              const pending = pendingToolCalls.get(idx)!;
              if (tc.id) pending.id = tc.id;
              if (tc.function?.name) pending.name = tc.function.name;
              if (tc.function?.arguments) pending.arguments += tc.function.arguments;
            }
          }

          // 工具调用完成
          if (choice.finish_reason === 'tool_calls') {
            for (const tc of pendingToolCalls.values()) {
              try {
                onChunk({
                  type: 'tool_call',
                  toolCall: {
                    id: tc.id || crypto.randomUUID(),
                    name: tc.name,
                    arguments: JSON.parse(tc.arguments || '{}'),
                  },
                });
              } catch {
                console.error('[Bailian] 解析工具参数失败:', tc.arguments);
              }
            }
            pendingToolCalls.clear();
          }

          if (choice.finish_reason === 'stop') {
            onChunk({ type: 'done' });
            return;
          }
        } catch (e) {
          console.error('[Bailian] 解析 chunk 失败:', e);
        }
      }
    }

    onChunk({ type: 'done' });
  }
}
