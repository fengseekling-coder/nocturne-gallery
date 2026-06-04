import { Message, Tool, StreamChunk, ProviderType } from '../types';

export interface AIProvider {
  name: string;
  type: ProviderType;
  chat(messages: Message[], tools: Tool[], onChunk: (chunk: StreamChunk) => void): Promise<void>;
  isAvailable(): Promise<boolean>;
}
