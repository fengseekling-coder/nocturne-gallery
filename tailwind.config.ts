import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}', './index.html'],
  theme: {
    extend: {
      colors: {
        // 背景
        primary: 'var(--color-bg-primary)',
        card: 'var(--color-bg-card)',
        sidebar: 'var(--color-bg-sidebar)',
        detail: 'var(--color-bg-detail)',
        hover: 'var(--color-bg-hover)',
        active: 'var(--color-bg-active)',
        input: 'var(--color-bg-input)',

        // 品牌色
        accent: {
          DEFAULT: 'var(--color-accent)',
          hover: 'var(--color-accent-hover)',
          active: 'var(--color-accent-active)',
          dim: 'var(--color-accent-dim)',
          glow: 'var(--color-accent-glow)',
        },

        // 文字
        txt: {
          primary: 'var(--color-text-primary)',
          secondary: 'var(--color-text-secondary)',
          muted: 'var(--color-text-muted)',
          disabled: 'var(--color-text-disabled)',
          inverse: 'var(--color-text-inverse)',
          accent: 'var(--color-text-accent)',
        },

        // 边框
        border: {
          DEFAULT: 'var(--color-border)',
          subtle: 'var(--color-border-subtle)',
          focus: 'var(--color-border-focus)',
          hover: 'var(--color-border-hover)',
        },

        // 状态色
        success: { DEFAULT: 'var(--color-success)', dim: 'var(--color-success-dim)' },
        warning: { DEFAULT: 'var(--color-warning)', dim: 'var(--color-warning-dim)' },
        error: { DEFAULT: 'var(--color-error)', dim: 'var(--color-error-dim)' },
        info: { DEFAULT: 'var(--color-info)', dim: 'var(--color-info-dim)' },

        // 标签色板
        tag: {
          red: 'var(--color-tag-red)',
          orange: 'var(--color-tag-orange)',
          yellow: 'var(--color-tag-yellow)',
          green: 'var(--color-tag-green)',
          teal: 'var(--color-tag-teal)',
          blue: 'var(--color-tag-blue)',
          purple: 'var(--color-tag-purple)',
          pink: 'var(--color-tag-pink)',
        },
      },

      fontFamily: {
        sans: ['Microsoft YaHei', '微软雅黑', 'PingFang SC', 'sans-serif'],
        mono: ['Microsoft YaHei', '微软雅黑', 'PingFang SC', 'sans-serif'],
      },

      fontSize: {
        xs: 'var(--font-size-xs)',
        sm: 'var(--font-size-sm)',
        base: 'var(--font-size-base)',
        md: 'var(--font-size-md)',
        lg: 'var(--font-size-lg)',
        xl: 'var(--font-size-xl)',
        '2xl': 'var(--font-size-2xl)',
        '3xl': 'var(--font-size-3xl)',
      },

      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-default)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },

      spacing: {
        sidebar: 'var(--sidebar-width)',
        detail: 'var(--detail-width)',
        toolbar: 'var(--toolbar-height)',
        'card-gap': 'var(--card-gap)',
      },

      boxShadow: {
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        'card-hover': 'var(--shadow-card-hover)',
        'glow-accent': 'var(--shadow-glow-accent)',
      },

      transitionDuration: {
        fast: '100ms',
        DEFAULT: '150ms',
        slow: '300ms',
      },

      zIndex: {
        card: '10',
        toolbar: '100',
        sidebar: '200',
        detail: '200',
        modal: '500',
        toast: '600',
        tooltip: '700',
      },
    },
  },
  plugins: [],
} satisfies Config;
