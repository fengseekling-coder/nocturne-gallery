/**
 * Nocturne Gallery — Preferences Utility
 *
 * 封装用户偏好设置的异步读写。
 * 所有持久化数据走 SQLite（通过 Tauri Command）。
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * 异步读取偏好设置，失败时返回默认值。
 */
export async function getPreference(key: string, defaultValue: string): Promise<string> {
  try {
    const value = await invoke<string | null>('get_preference', { key });
    return value ?? defaultValue;
  } catch (err) {
    console.warn(`[preferences] Failed to read "${key}", using default:`, err);
    return defaultValue;
  }
}

/**
 * 异步写入偏好设置。
 */
export async function setPreference(key: string, value: string): Promise<void> {
  try {
    await invoke('set_preference', { key, value });
  } catch (err) {
    console.error(`[preferences] Failed to write "${key}":`, err);
  }
}
