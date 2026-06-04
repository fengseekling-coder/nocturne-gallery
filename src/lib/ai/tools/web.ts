import { Tool } from '../types';

// Tavily API 响应类型
interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilySearchResponse {
  answer: string;
  results: TavilySearchResult[];
}

interface WebSearchResult {
  answer?: string;
  results?: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
  error?: string;
}

export const webTools: Tool[] = [
  {
    name: 'web_search',
    description: '联网搜索设计灵感、参考图片、风格趋势等信息',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，建议用英文' },
        search_depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description: 'basic=快速，advanced=深度，默认 basic'
        }
      },
      required: ['query']
    },
    execute: async (args): Promise<WebSearchResult> => {
      const { invoke } = await import('@tauri-apps/api/core');
      const apiKey = await invoke<string | null>('get_preference', { key: 'tavily_api_key' });

      if (!apiKey) {
        return { error: '未配置 Tavily API Key，请在设置中添加' };
      }

      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: apiKey,
          query: args.query,
          search_depth: args.search_depth || 'basic',
          max_results: 5,
          include_answer: true,
        })
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({})) as { detail?: string };
        return { error: `Tavily API Error: ${err.detail || response.statusText}` };
      }

      const data = (await response.json()) as TavilySearchResponse;
      return {
        answer: data.answer,
        results: data.results?.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content?.slice(0, 300),
        }))
      };
    }
  }
];
