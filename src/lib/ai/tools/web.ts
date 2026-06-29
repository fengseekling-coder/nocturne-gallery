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
      const result = await invoke<{ answer?: string; results?: TavilySearchResult[]; detail?: string }>('tavily_search', {
        query: args.query,
        searchDepth: args.search_depth || 'basic',
      }).catch((err: Error) => ({ detail: err.message }));

      if (result && 'detail' in result) {
        return { error: `Tavily 搜索失败: ${result.detail}` };
      }

      return {
        answer: result?.answer,
        results: result?.results?.map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.content?.slice(0, 300),
        }))
      };
    }
  }
];
