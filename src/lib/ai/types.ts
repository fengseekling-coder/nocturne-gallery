export type ProviderType = 'claude' | 'bailian' | 'openai';

export interface ImageAttachment {
  id: string;
  fileName?: string;
  mimeType?: string;
  previewUrl?: string;
  base64?: string;
  filePath?: string;
  file?: File;
  sourceItemId?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  images?: string[];       // base64
  imageAttachments?: ImageAttachment[];
  timestamp: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: unknown;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface StreamChunk {
  type: 'text' | 'tool_call' | 'tool_result' | 'message' | 'done' | 'error';
  messageId?: string;
  content?: string;
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  message?: Message;
  error?: string;
}
