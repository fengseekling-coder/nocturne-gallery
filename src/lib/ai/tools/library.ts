import { invoke } from '@tauri-apps/api/core';
import { Tool } from '../types';

export const libraryTools: Tool[] = [
  {
    name: 'search_library',
    description: '搜索灵感库中的素材，支持关键词、标签、分类过滤',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签过滤' },
        limit: { type: 'number', description: '返回数量，默认10' }
      },
      required: ['query']
    },
    execute: async (args) => invoke('ai_search_library', args)
  },
  {
    name: 'add_tags',
    description: '给指定素材添加标签',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '素材ID' },
        tags: { type: 'array', items: { type: 'string' }, description: '要添加的标签列表' }
      },
      required: ['item_id', 'tags']
    },
    execute: async (args) => invoke('ai_add_tags', args)
  },
  {
    name: 'set_category',
    description: '将素材移动到指定分类',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '素材ID' },
        category_name: { type: 'string', description: '分类名称，不存在会自动创建' }
      },
      required: ['item_id', 'category_name']
    },
    execute: async (args) => invoke('ai_set_category', args)
  },
  {
    name: 'update_prompt',
    description: '更新素材的 AI 提示词',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '素材ID' },
        prompt: { type: 'string', description: '新的提示词内容' }
      },
      required: ['item_id', 'prompt']
    },
    execute: async (args) => invoke('ai_update_prompt', args)
  },
  {
    name: 'get_item_detail',
    description: '获取素材的完整详情信息',
    parameters: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: '素材ID' }
      },
      required: ['item_id']
    },
    execute: async (args) => invoke('ai_get_item_detail', args)
  }
];
