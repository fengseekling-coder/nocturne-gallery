/**
 * 桌面端 UI：当前阶段按 macOS 人机界面规范（红绿灯、标题栏拖拽区等）。
 */
import { invoke } from '@tauri-apps/api/core';

export type UiPlatform = 'macos';

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

export function readUiPlatformFromDom(): UiPlatform | null {
  if (typeof document === 'undefined') return null;
  const attr = document.documentElement.getAttribute('data-platform');
  if (attr === 'macos') return 'macos';
  return null;
}

export function applyUiPlatform(_platform: UiPlatform = 'macos'): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-platform', 'macos');
  }
}

/** 应用启动时调用一次（在 React 挂载前） */
export async function bootstrapUiPlatform(): Promise<UiPlatform> {
  if (isTauriRuntime()) {
    try {
      await invoke<string>('get_native_platform');
    } catch {
      // 仍按 macOS 样式渲染
    }
  }
  applyUiPlatform('macos');
  return 'macos';
}

export function detectUiPlatform(_override?: UiPlatform): UiPlatform {
  return 'macos';
}