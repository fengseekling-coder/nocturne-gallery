import { invoke } from '@tauri-apps/api/core';
import { getPreference } from '../../utils/preferences';

export interface BatchTagItem {
  item_id: string;
  file_name: string;
  thumbnail_path: string | null;
}

export interface BatchTagResult {
  success: number;
  failed: number;
  total: number;
}

export interface BatchProgress {
  current: number;
  total: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  message: string;
  lastItem?: { fileName: string; tags: string[]; failed?: boolean; errorMsg?: string };
}

interface OpenAiChatResult {
  content: string;
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
}

const CONCURRENCY = 2;
const TIMEOUT_MS = 30000;

async function thumbnailToBase64(thumbnailPath: string): Promise<string | null> {
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const url = convertFileSrc(thumbnailPath);
    const response = await fetch(url);
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        resolve(result.split(',')[1]);
      };
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const BATCH_TAG_PROMPT = (fileName: string) =>
  `分析这张图片（文件名：${fileName}），输出5-8个中文标签，用逗号分隔，只输出标签不要其他内容。标签要具体：描述内容、风格、色调、用途等。`;

async function analyzeImage(fileName: string, base64: string, signal?: AbortSignal): Promise<string[]> {
  const savedProvider = await getPreference('ai_provider', 'openai');
  const providerType = savedProvider === 'claude' || savedProvider === 'bailian' || savedProvider === 'openai'
    ? savedProvider
    : 'openai';
  const prompt = BATCH_TAG_PROMPT(fileName);

  if (providerType === 'openai') {
    if (signal?.aborted) throw new Error('已取消');
    const model = await getPreference('openai_model', 'gpt-5.5-high');
    const data = await invoke<OpenAiChatResult>('openai_chat_completion', {
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
          { type: 'text', text: prompt },
        ],
      }],
      tools: [],
      model,
    });
    return data.content.split(/[,，]/).map((t: string) => t.trim()).filter(Boolean);
  } else if (providerType === 'claude') {
    const apiKey = await getPreference('claude_api_key', '');
    if (!apiKey) throw new Error('Claude API Key 未配置');
    const model = await getPreference('claude_model', 'claude-sonnet-4-5');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 200,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: prompt }
        ]}]
      })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`Claude API ${response.status}: ${errData.error?.message || response.statusText}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    return text.split(/[,，]/).map((t: string) => t.trim()).filter(Boolean);
  } else if (providerType === 'bailian') {
    const apiKey = await getPreference('bailian_api_key', '');
    if (!apiKey) throw new Error('百炼 API Key 未配置');
    const model = await getPreference('bailian_model', 'qwen-vl-plus');
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
            { type: 'text', text: prompt },
          ]
        }],
        max_tokens: 200,
      })
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(`百炼 API ${response.status}: ${errData.error?.message || response.statusText}`);
    }
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    return text.split(/[,，]/).map((t: string) => t.trim()).filter(Boolean);
  }

  throw new Error('未支持的 AI provider');
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`分析超时（>${ms / 1000}s）`)), ms)
  );
  return Promise.race([promise, timeout]);
}

export async function batchTagItems(
  items: BatchTagItem[],
  onProgress: (progress: BatchProgress) => void,
  signal?: AbortSignal
): Promise<BatchTagResult> {
  const updates: Array<{ item_id: string; tags: string[] }> = [];
  let completed = 0;
  let failed = 0;

  // 按 CONCURRENCY 分批并发处理
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    if (signal?.aborted) {
      onProgress({ current: completed, total: items.length, status: 'cancelled', message: '已取消' });
      return { success: 0, failed, total: items.length };
    }

    const chunk = items.slice(i, i + CONCURRENCY);

    await Promise.allSettled(chunk.map(async (item) => {
      if (signal?.aborted) return;

      try {
        if (!item.thumbnail_path) {
          onProgress({
            current: ++completed, total: items.length, status: 'running',
            message: `跳过：${item.file_name}（无缩略图）`,
            lastItem: { fileName: item.file_name, tags: [], failed: true }
          });
          failed++;
          return;
        }

        const base64 = await thumbnailToBase64(item.thumbnail_path);
        if (!base64) {
          onProgress({
            current: ++completed, total: items.length, status: 'running',
            message: `跳过：${item.file_name}（读取失败）`,
            lastItem: { fileName: item.file_name, tags: [], failed: true }
          });
          failed++;
          return;
        }

        const tags = await withTimeout(analyzeImage(item.file_name, base64, signal), TIMEOUT_MS);
        if (tags.length > 0) updates.push({ item_id: item.item_id, tags });

        onProgress({
          current: ++completed, total: items.length, status: 'running',
          message: `完成：${item.file_name}`,
          lastItem: { fileName: item.file_name, tags }
        });
      } catch (e) {
        if (signal?.aborted) return;
        const errMsg = e instanceof Error ? e.message : String(e);
        console.warn(`[batchTag] ${item.file_name} 分析失败:`, errMsg);
        onProgress({
          current: ++completed, total: items.length, status: 'running',
          message: `失败：${item.file_name} — ${errMsg}`,
          lastItem: { fileName: item.file_name, tags: [], failed: true, errorMsg: errMsg }
        });
        failed++;
      }
    }));
  }

  if (signal?.aborted) {
    onProgress({ current: completed, total: items.length, status: 'cancelled', message: '已取消' });
    return { success: updates.length, failed, total: items.length };
  }

  onProgress({ current: items.length, total: items.length, status: 'running', message: '正在写入标签...' });
  const result = await invoke<BatchTagResult>('batch_add_tags', { updates });
  onProgress({ current: items.length, total: items.length, status: 'done', message: `完成！成功处理 ${result.success} 个素材` });
  return result;
}
