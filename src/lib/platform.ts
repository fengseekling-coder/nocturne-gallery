/**
 * 桌面端 UI 平台：优先 Rust `get_native_platform`，避免 WebView UA 误判为 Windows。
 */
import { invoke } from '@tauri-apps/api/core';

export type UiPlatform = 'macos' | 'windows' | 'linux';

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window;
}

function platformFromUserAgent(): UiPlatform {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

export function readUiPlatformFromDom(): UiPlatform | null {
  if (typeof document === 'undefined') return null;
  const attr = document.documentElement.getAttribute('data-platform');
  if (attr === 'macos' || attr === 'windows' || attr === 'linux') {
    return attr;
  }
  return null;
}

export function applyUiPlatform(platform: UiPlatform): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-platform', platform);
  }
}

/** 应用启动时调用一次（在 React 挂载前） */
export async function bootstrapUiPlatform(): Promise<UiPlatform> {
  // Tauri 桌面端：以 Rust 编译目标为准，不信任 WebView UA / index.html 内联脚本
  if (isTauriRuntime()) {
    try {
      const native = await invoke<string>('get_native_platform');
      const platform: UiPlatform =
        native === 'macos' || native === 'windows' || native === 'linux'
          ? native
          : platformFromUserAgent();
      applyUiPlatform(platform);
      return platform;
    } catch {
      const fallback = platformFromUserAgent();
      applyUiPlatform(fallback);
      return fallback;
    }
  }

  const existing = readUiPlatformFromDom();
  if (existing) return existing;

  const fallback = platformFromUserAgent();
  applyUiPlatform(fallback);
  return fallback;
}

export function detectUiPlatform(override?: UiPlatform): UiPlatform {
  if (override) return override;
  return readUiPlatformFromDom() ?? platformFromUserAgent();
}
