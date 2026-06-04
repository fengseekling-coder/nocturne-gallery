import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { Tool } from '../types';
import { getPreference } from '../../../utils/preferences';

interface OpenAiGeneratedImage {
  model: string;
  quality: string;
  b64Json?: string;
  url?: string;
  revisedPrompt?: string;
}

interface GeneratedImageToolResult {
  _generated_image: true;
  model: string;
  quality: string;
  prompt: string;
  file_path?: string;
  preview_url: string;
  revised_prompt?: string;
}

const IMAGE_SIZES = ['1024x1024', '1024x1536', '1536x1024'];
const IMAGE_MODEL_BY_QUALITY: Record<string, string> = {
  low: 'gpt-image-2-fast',
  medium: 'gpt-image-2-standard',
  high: 'gpt-image-2-high',
};

const getStringArg = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
};

export const imageTools: Tool[] = [
  {
    name: 'generate_image',
    description: '使用本机 OpenAI-compatible API 的 gpt-image-2 根据文字提示生成图片。只在用户明确要求生成图片、海报、概念图、视觉草图或变体时使用。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '用于生成图片的详细提示词',
        },
        size: {
          type: 'string',
          enum: IMAGE_SIZES,
          description: '图片尺寸，默认 1024x1024',
        },
        quality: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: '生图质量档位：low 快速、medium 标准、high 高质量。默认 high。',
        },
      },
      required: ['prompt'],
    },
    execute: async (args): Promise<GeneratedImageToolResult> => {
      const prompt = getStringArg(args, 'prompt');
      if (!prompt) throw new Error('缺少生图提示词');

      const requestedSize = getStringArg(args, 'size');
      const size = requestedSize && IMAGE_SIZES.includes(requestedSize) ? requestedSize : '1024x1024';
      const savedModel = await getPreference('openai_image_model', IMAGE_MODEL_BY_QUALITY.high);
      const requestedQuality = getStringArg(args, 'quality');
      const model = requestedQuality ? IMAGE_MODEL_BY_QUALITY[requestedQuality] || savedModel : savedModel;
      const generated = await invoke<OpenAiGeneratedImage>('openai_generate_image', {
        prompt,
        size,
        model,
      });

      if (generated.b64Json) {
        const dataUrl = `data:image/png;base64,${generated.b64Json}`;
        const filePath = await invoke<string>('write_temp_file', { base64Data: dataUrl });
        return {
          _generated_image: true,
          model: generated.model,
          quality: generated.quality,
          prompt,
          file_path: filePath,
          preview_url: convertFileSrc(filePath),
          revised_prompt: generated.revisedPrompt,
        };
      }

      if (generated.url) {
        return {
          _generated_image: true,
          model: generated.model,
          quality: generated.quality,
          prompt,
          preview_url: generated.url,
          revised_prompt: generated.revisedPrompt,
        };
      }

      throw new Error('生图响应没有返回图片数据');
    },
  },
];
