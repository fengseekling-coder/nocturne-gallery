import { invoke } from '@tauri-apps/api/core';
import { AIProvider } from './base';
import { Message, Tool, StreamChunk, ProviderType } from '../types';
import {
  buildMessageContentForProvider,
  getLatestVisualMessageId,
  resolveMessageImages,
} from '../messageImages';
import { getPreference } from '../../../utils/preferences';

interface OpenAiTextContent {
  type: 'text';
  text: string;
}

interface OpenAiImageContent {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

type OpenAiContent = string | Array<OpenAiTextContent | OpenAiImageContent>;

interface OpenAiMessagePayload {
  role: Message['role'];
  content: OpenAiContent;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

interface OpenAiToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface OpenAiChatResult {
  content: string;
  toolCalls: OpenAiToolCallResult[];
}

export class OpenAiProvider implements AIProvider {
  name = 'OpenAI-compatible';
  type: ProviderType = 'openai';

  async isAvailable(): Promise<boolean> {
    try {
      const config = await invoke<{ hasApiKey: boolean }>('openai_get_config');
      return config.hasApiKey;
    } catch {
      return false;
    }
  }

  async chat(messages: Message[], tools: Tool[], onChunk: (chunk: StreamChunk) => void): Promise<void> {
    const model = await getPreference('openai_model', 'gpt-5.5-high');
    const latestVisualMessageId = getLatestVisualMessageId(messages);
    const formattedMessages: OpenAiMessagePayload[] = [];

    for (const message of messages) {
      if (message.role === 'tool' && message.toolResults) {
        for (const result of message.toolResults) {
          formattedMessages.push({
            role: 'tool',
            tool_call_id: result.toolCallId,
            content: result.error ? `Error: ${result.error}` : JSON.stringify(result.result),
          });
        }
        continue;
      }

      const includeImages = message.id === latestVisualMessageId;
      const resolvedImages = includeImages ? await resolveMessageImages(message) : [];
      const contentText = buildMessageContentForProvider(message, includeImages);
      const payload: OpenAiMessagePayload = {
        role: message.role,
        content: contentText,
      };

      if (resolvedImages.length > 0) {
        payload.content = [
          ...(contentText ? [{ type: 'text' as const, text: contentText }] : []),
          ...resolvedImages.map((image) => ({
            type: 'image_url' as const,
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          })),
        ];
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        payload.tool_calls = message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: 'function',
          function: {
            name: toolCall.name,
            arguments: JSON.stringify(toolCall.arguments),
          },
        }));
      }

      formattedMessages.push(payload);
    }

    const result = await invoke<OpenAiChatResult>('openai_chat_completion', {
      messages: formattedMessages,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      model,
    });

    if (result.content) {
      onChunk({ type: 'text', content: result.content });
    }

    for (const toolCall of result.toolCalls) {
      onChunk({
        type: 'tool_call',
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      });
    }

    onChunk({ type: 'done' });
  }
}
