import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Tool } from '../types';

// Rust ai_reverse_prompt 返回类型（与 models.rs ReversePromptData 对齐）
interface ReversePromptData {
  itemId: string;
  filename: string;
  filepath: string;
  thumbnailPath: string | null;
  existingPrompt: string | null;
  colorDominant: string | null;
  fileSize: number;
  mimeType: string | null;
}

// 视觉分析结果
interface VisionAnalysisResult {
  image_path: string;
  preview_url: string;
  mime_type: string;
  existing_prompt: string | null;
  dominant_colors: string | null;
  file_name: string;
  item_id: string;
  _requires_vision: true;
  _vision_prompt: string;
}

interface BatchVisionItem {
  item_id: string;
  file_name: string;
  image_path: string;
  preview_url: string;
  mime_type: string;
  _requires_vision: true;
  _vision_prompt: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

const getMimeTypeFromPath = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXTENSION[ext] ?? 'image/jpeg';
};

const TOOL_EXECUTE_TIMEOUT_MS = 25000;
const TOOL_TIMEOUT_ERROR = '工具执行超时，请稍后重试';

const withToolTimeout = async <T,>(promise: Promise<T>): Promise<T> => {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(TOOL_TIMEOUT_ERROR)), TOOL_EXECUTE_TIMEOUT_MS);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
};

export const visionTools: Tool[] = [
  {
    name: 'reverse_prompt',
    description: '分析当前选中的图片，反推出适合用于 AI 生图的详细提示词（Prompt），包括画面构成、风格、色调、细节描述',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '要分析的素材 ID' },
        style: {
          type: 'string',
          enum: ['midjourney', 'stable_diffusion', 'comfyui', 'general'],
          description: '目标提示词风格，默认 general'
        },
        language: {
          type: 'string',
          enum: ['en', 'zh', 'bilingual'],
          description: '输出语言，默认 bilingual（中英双语）'
        }
      },
      required: ['item_id']
    },
    execute: async (args): Promise<VisionAnalysisResult> => {
      const data = await withToolTimeout(
        invoke<ReversePromptData>('ai_reverse_prompt', { itemId: args.item_id }),
      );
      const imagePath = data.thumbnailPath || data.filepath;

      return {
        image_path: imagePath,
        preview_url: convertFileSrc(imagePath),
        mime_type: getMimeTypeFromPath(imagePath),
        existing_prompt: data.existingPrompt,
        dominant_colors: data.colorDominant,
        file_name: data.filename,
        item_id: data.itemId,
        _requires_vision: true,
        _vision_prompt: buildVisionPrompt(String(args.style || 'general'), String(args.language || 'bilingual')),
      };
    }
  },
  {
    name: 'analyze_and_tag',
    description: '分析指定素材的图片内容，自动识别主题、风格、颜色等特征并打上合适的标签',
    parameters: {
      type: 'object',
      properties: {
        item_ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要分析的素材 ID 列表，建议一次不超过 5 个'
        }
      },
      required: ['item_ids']
    },
    execute: async (args): Promise<{ items: BatchVisionItem[]; _batch_vision: true }> => {
      const itemIds = args.item_ids as string[];
      const results: BatchVisionItem[] = [];
      for (const item_id of itemIds.slice(0, 5)) {
        const data = await withToolTimeout(
          invoke<ReversePromptData>('ai_reverse_prompt', { itemId: item_id }),
        );
        const imagePath = data.thumbnailPath || data.filepath;
        results.push({
          item_id,
          file_name: data.filename,
          image_path: imagePath,
          preview_url: convertFileSrc(imagePath),
          mime_type: getMimeTypeFromPath(imagePath),
          _requires_vision: true,
          _vision_prompt: `分析这张图片，提取5-10个标签。
要求：标签用中文，简短精准（1-3个字），涵盖：风格/主体/色调/情绪/用途。
直接返回 JSON 数组格式：["标签1", "标签2", ...]，不要其他文字。`,
        });
      }
      return { items: results, _batch_vision: true };
    }
  },
  {
    name: 'get_library_stats',
    description: '获取灵感库的统计概览，包括素材总数、标签分布、最近导入等信息，帮助了解库的整体状态',
    parameters: { type: 'object', properties: {} },
    execute: async () => withToolTimeout(invoke('ai_get_library_stats', {}))
  }
];

function buildVisionPrompt(style: string, language: string): string {
  const styleGuides: Record<string, string> = {
    midjourney: '使用 Midjourney 风格，包含 --ar, --style, --q 等参数',
    stable_diffusion: '使用 Stable Diffusion 风格，包含正向和负向提示词',
    comfyui: '使用 ComfyUI 节点友好的提示词格式',
    general: '通用详细描述格式',
  };
  const langGuide = language === 'en' ? '仅用英文输出' 
    : language === 'zh' ? '仅用中文输出'
    : '中英双语输出，英文在前，中文在后';
  
  return `请详细分析这张图片，反推出用于 AI 生图的提示词。
风格要求：${styleGuides[style] || styleGuides.general}
语言要求：${langGuide}
分析维度：
1. 主体描述（人物/物体/场景）
2. 画面构图和视角
3. 光线和色调
4. 艺术风格和渲染质感
5. 氛围和情绪
6. 细节和材质
请直接输出提示词，不需要解释。`;
}
