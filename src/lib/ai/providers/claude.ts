import { AIProvider } from './base';
import { Message, Tool, StreamChunk, ProviderType } from '../types';
import {
  buildMessageContentForProvider,
  getLatestVisualMessageId,
  resolveMessageImages,
} from '../messageImages';
import { getPreference } from '../../../utils/preferences';

// Claude API content block types
interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

interface ClaudeImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

type ClaudeContentBlock = ClaudeTextBlock | ClaudeImageBlock | ClaudeToolUseBlock | ClaudeToolResultBlock;

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class ClaudeProvider implements AIProvider {
  name = 'Claude';
  type: ProviderType = 'claude';

  async isAvailable(): Promise<boolean> {
    const key = await getPreference('claude_api_key', '');
    return key.length > 0;
  }

  async chat(messages: Message[], tools: Tool[], onChunk: (chunk: StreamChunk) => void): Promise<void> {
    const apiKey = await getPreference('claude_api_key', '');
    if (!apiKey) throw new Error('Claude 接口密钥未配置');

    // 修复：[P1] 从用户配置读取模型名，不再硬编码
    // 用户在首选项中配置的 claude 模型 id 存于 'claude_model'
    const claudeModel = await getPreference('claude_model', 'claude-sonnet-4-5');
    const latestVisualMessageId = getLatestVisualMessageId(messages);

    const formattedMessages = [];
    for (const m of messages) {
      const content: ClaudeContentBlock[] = [];
      const includeImages = m.id === latestVisualMessageId;
      const resolvedImages = includeImages ? await resolveMessageImages(m) : [];
      const contentText = buildMessageContentForProvider(m, includeImages);

      // 只有 content 非空才加 text block
      if (contentText) {
        content.push({ type: 'text', text: contentText });
      }

      if (resolvedImages.length > 0) {
        for (const image of resolvedImages) {
          content.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mimeType,
              data: image.data
            }
          });
        }
      }

      if (m.role === 'tool' && m.toolResults) {
        // Claude handles tool results in a separate message after tool_use
        // But for simplicity in this common format, we'll map them carefully.
        // Actually, Claude expects tool_result messages to have a specific role.
        formattedMessages.push({
          role: 'user', // In Anthropic API, tool results are sent by user role or specialized block
          content: m.toolResults.map(tr => ({
            type: 'tool_result' as const,
            tool_use_id: tr.toolCallId,
            content: JSON.stringify(tr.result),
            is_error: !!tr.error
          }))
        });
        continue;
      }

      if (m.toolCalls) {
        content.push(...m.toolCalls.map(tc => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: tc.arguments
        })));
      }

      formattedMessages.push({
        role: m.role === 'tool' ? 'user' : m.role,
        content
      });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true' // For client-side fetch
      },
      body: JSON.stringify({
        model: claudeModel,
        max_tokens: 4096,
        messages: formattedMessages.filter(m => m.role !== 'system'),
        system: messages.find(m => m.role === 'system')?.content
          ? [
              {
                type: 'text',
                text: messages.find(m => m.role === 'system')!.content,
                cache_control: { type: 'ephemeral' }
              }
            ]
          : undefined,
        tools: tools.map((t, index) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
          ...(index === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
        })),
        stream: true
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`Claude API Error ${response.status}: ${errorData.error?.message || response.statusText}`);
    }

    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolCall: PendingToolCall | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;

        try {
          const json = JSON.parse(data);
          switch (json.type) {
            case 'content_block_start':
              if (json.content_block?.type === 'tool_use') {
                currentToolCall = {
                  id: json.content_block.id,
                  name: json.content_block.name,
                  arguments: ''
                };
              }
              break;
            case 'content_block_delta':
              if (json.delta?.type === 'text_delta') {
                onChunk({ type: 'text', content: json.delta.text });
              } else if (json.delta?.type === 'input_json_delta') {
                if (currentToolCall) {
                  currentToolCall.arguments += json.delta.partial_json;
                }
              }
              break;
            case 'content_block_stop':
              if (currentToolCall) {
                try {
                  const args = JSON.parse(currentToolCall.arguments || '{}');
                  onChunk({
                    type: 'tool_call',
                    toolCall: {
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      arguments: args
                    }
                  });
                } catch (e) {
                  console.error('Error parsing tool arguments:', e);
                }
                currentToolCall = null;
              }
              break;
            case 'message_stop':
              onChunk({ type: 'done' });
              break;
          }
        } catch (e) {
          console.error('Error parsing Claude chunk:', e);
        }
      }
    }
  }
}
