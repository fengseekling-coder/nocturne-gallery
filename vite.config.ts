import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri devUrl is fixed to 1420; fail fast instead of silently serving a different port.
  server: {
    port: 1420,
    strictPort: true,
  },
  // 环境变量前缀
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Tauri 使用 Chromium，支持现代 JS
    target: ['es2021', 'chrome100', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
