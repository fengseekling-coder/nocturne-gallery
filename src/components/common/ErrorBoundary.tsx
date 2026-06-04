/**
 * Nocturne Gallery — ErrorBoundary
 *
 * 全局错误边界，防止单个组件崩溃导致整个应用黑屏。
 * 捕获子组件渲染时的运行时错误，显示友好的错误提示。
 */

import React from 'react';
import { Icon } from './Icon';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 12,
          color: 'var(--text-secondary)',
          fontSize: 13,
          fontFamily: 'var(--font-family)',
        }}>
          <Icon name="error" size={32} color="var(--error)" />
          <span>组件加载失败</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {this.state.error?.message}
          </span>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: 8,
              padding: '8px 16px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--bg-hover)',
              color: 'var(--text-primary)',
              fontSize: 12,
              cursor: 'pointer',
              border: 'none',
              fontFamily: 'var(--font-family)',
            }}
          >
            重试
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
