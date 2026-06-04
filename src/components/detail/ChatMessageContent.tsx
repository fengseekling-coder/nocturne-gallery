/**
 * Gega Gallery — ChatMessageContent
 *
 * 对话消息内容渲染：
 *  - 用户消息保留原始换行（pre-wrap），不做 Markdown 解析
 *  - 助手/工具消息走 Markdown：GFM 表格/列表/删除线 + 代码高亮 + 代码块复制按钮
 *  - 链接用 Tauri opener 打开外部浏览器（避免直接在 app 内跳转）
 *  - 表格、代码块样式与 Gega 暗色主题对齐
 */

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark.css';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from '../common/Icon';


interface Props {
  content: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
}

const toSafeHttpHref = (href?: string): string | null => {
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

// ----------------------------------------------------------------
// 代码块：带复制按钮的 <pre>
// ----------------------------------------------------------------

const CodeBlock: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    // children 是 <code> 元素，提取文本
    const text = extractText(children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  };

  return (
    <div style={{ position: 'relative', margin: '8px 0' }}>
      <pre
        style={{
          margin: 0,
          padding: '12px',
          borderRadius: 'var(--radius-small)',
          backgroundColor: 'var(--bg-primary)',
          boxShadow: 'inset 0 0 0 1px var(--border)',
          overflow: 'auto',
          fontSize: '12px',
          lineHeight: 1.5,
          fontFamily: 'var(--font-family)',
        }}
      >
        {children}
      </pre>
      <button
        onClick={handleCopy}
        title={copied ? '已复制' : '复制'}
        style={{
          position: 'absolute',
          top: '8px',
          right: '8px',
          width: '24px',
          height: '24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-card)',
          color: copied ? 'var(--accent)' : 'var(--text-muted)',
          border: 'none',
          borderRadius: 'var(--radius-control)',
          boxShadow: 'inset 0 0 0 1px var(--border)',
          cursor: 'pointer',
          opacity: 0.85,
          transition: 'opacity 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = '1';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = '0.85';
        }}
      >
        <Icon name={copied ? 'check' : 'content_copy'} size={12} />
      </button>
    </div>
  );
};

function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) {
    const props = node.props as { children?: React.ReactNode };
    return extractText(props.children);
  }
  return '';
}

// ----------------------------------------------------------------
// 主组件
// ----------------------------------------------------------------

export const ChatMessageContent: React.FC<Props> = ({ content, role }) => {
  // 用户消息保留原始格式（换行、空格），不解析 Markdown
  if (role === 'user') {
    return (
      <div
        style={{
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: '13px',
          lineHeight: 1.6,
        }}
      >
        {content}
      </div>
    );
  }

  return (
    <div
      className="chat-markdown"
      style={{
        fontSize: '13px',
        lineHeight: 1.6,
        wordBreak: 'break-word',
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          code: ({ className, children, ...props }) => {
            const isBlock = className?.startsWith('language-');
            if (isBlock) {
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                style={{
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-control)',
                  backgroundColor: 'var(--bg-primary)',
                  boxShadow: 'inset 0 0 0 1px var(--border)',
                  fontSize: '12px',
          fontFamily: 'var(--font-family)',
                  color: 'var(--accent)',
                }}
                {...props}
              >
                {children}
              </code>
            );
          },
          a: ({ children, href }) => {
            const safeHref = toSafeHttpHref(href);
            if (!safeHref) {
              return <span style={{ color: 'var(--text-secondary)' }}>{children}</span>;
            }
            return (
              <a
                href={safeHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void invoke('open_url_in_browser', { url: safeHref });
                }}
                style={{ color: 'var(--accent)', textDecoration: 'underline' }}
              >
                {children}
              </a>
            );
          },
          p: ({ children }) => <p style={{ margin: '8px 0' }}>{children}</p>,
          ul: ({ children }) => (
            <ul style={{ margin: '8px 0', paddingLeft: '20px' }}>{children}</ul>
          ),
          ol: ({ children }) => (
            <ol style={{ margin: '8px 0', paddingLeft: '20px' }}>{children}</ol>
          ),
          li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote
              style={{
                margin: '8px 0',
                padding: '8px 12px',
                borderLeft: '2px solid var(--accent)',
                color: 'var(--text-secondary)',
                backgroundColor: 'var(--bg-hover)',
                borderRadius: '0 4px 4px 0',
              }}
            >
              {children}
            </blockquote>
          ),
          h1: ({ children }) => (
            <h1 style={{ fontSize: '20px', fontWeight: 600, margin: '8px 0 8px' }}>{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 style={{ fontSize: '16px', fontWeight: 600, margin: '8px 0 8px' }}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 style={{ fontSize: '13px', fontWeight: 600, margin: '8px 0 4px' }}>{children}</h3>
          ),
          hr: () => (
            <hr
              style={{
                border: 'none',
                height: '1px',
                backgroundColor: 'var(--border)',
                margin: '12px 0',
              }}
            />
          ),
          table: ({ children }) => (
            <div style={{ overflowX: 'auto', margin: '8px 0' }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  width: '100%',
                  fontSize: '12px',
                }}
              >
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th
              style={{
                padding: '8px 12px',
                boxShadow: 'inset 0 -1px 0 0 var(--border)',
              }}
            >
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td
              style={{
                padding: '8px 12px',
                boxShadow: 'inset 0 -1px 0 0 var(--border)',
              }}
            >
              {children}
            </td>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
