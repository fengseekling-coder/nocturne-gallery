/**
 * Gega Gallery — DuplicateModal
 *
 * 导入重复素材时的居中确认弹窗：
 * - 展示准备导入素材与库中已有素材
 * - 展示已有素材当前所在分区/分组
 * - 允许继续导入，或直接使用已有素材切换到当前分组
 */

import React, { useCallback, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { MediaFile } from '../../types/media';

export type DuplicateType = 'exact' | 'similar';

export interface DuplicatePlacement {
  sourceFolder: string | null;
  groupName: string | null;
}

export interface DuplicateInfo {
  type: DuplicateType;
  newFile: {
    path: string;
    name: string;
    size: number;
    previewSrc?: string | null;
  };
  existingFile: MediaFile;
  similarity: number;
  existingPlacement: DuplicatePlacement;
  targetPlacement: DuplicatePlacement;
  canUseExisting: boolean;
}

export type DuplicateAction = 'skip' | 'import' | 'use-existing';

interface DuplicateModalProps {
  info: DuplicateInfo;
  onAction: (action: DuplicateAction) => void;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function formatPlacement(placement: DuplicatePlacement): string {
  const source = placement.sourceFolder || '未知分区';
  const group = placement.groupName || '未归类';
  return `${source} / ${group}`;
}

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 600,
  marginBottom: '8px',
  textTransform: 'uppercase',
  letterSpacing: 'var(--tracking-wider)',
};

export const DuplicateModal: React.FC<DuplicateModalProps> = ({ info, onAction }) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const pendingPreviewSrc = info.newFile.previewSrc ?? null;

  const isExact = info.type === 'exact';
  const similarityPercent = Math.round(info.similarity * 100);
  const existingPlacementText = formatPlacement(info.existingPlacement);
  const targetPlacementText = formatPlacement(info.targetPlacement);
  const useExistingLabel = info.targetPlacement.groupName
    ? `使用已有素材并切换到「${info.targetPlacement.groupName}」`
    : '使用已有素材';

  const handleAction = useCallback(async (action: DuplicateAction) => {
    setIsProcessing(true);
    try {
      onAction(action);
    } finally {
      setIsProcessing(false);
    }
  }, [onAction]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        void handleAction('skip');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleAction]);

  const existingPreviewSource = info.existingFile.thumbnailPreviewPath || info.existingFile.thumbnailPath || info.existingFile.filepath;
  const existingPreviewSrc = convertFileSrc(existingPreviewSource);

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'var(--overlay-backdrop)',
          zIndex: 'var(--z-modal)' as React.CSSProperties['zIndex'],
        }}
        onClick={() => void handleAction('skip')}
      />

      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(720px, calc(100vw - 48px))',
          maxHeight: 'calc(100vh - 64px)',
          overflowY: 'auto',
          backgroundColor: 'var(--bg-elevated)',
          borderRadius: 'var(--radius-card)',
          padding: '24px',
          zIndex: 'calc(var(--z-modal) + 1)' as React.CSSProperties['zIndex'],
          boxShadow: 'var(--shadow-lg), inset 0 0 0 1px var(--border)',
          fontFamily: 'var(--font-family)',
          animation: 'modal-in var(--transition-default)',
        }}
      >
        <h2
          style={{
            margin: '0 0 6px 0',
            fontSize: '16px',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          {isExact ? '发现重复素材' : '发现高相似素材'}
        </h2>
        <p
          style={{
            margin: '0 0 8px 0',
            fontSize: '13px',
            color: isExact ? 'var(--error)' : 'var(--text-secondary)',
            lineHeight: 1.6,
          }}
        >
          {isExact
            ? '该素材与库中已有素材完全一致。'
            : `该素材与库中素材高度相似，相似度约 ${similarityPercent}%。`}
        </p>
        <p
          style={{
            margin: '0 0 20px 0',
            fontSize: '12px',
            color: 'var(--text-muted)',
            lineHeight: 1.7,
          }}
        >
          已有素材当前在：{existingPlacementText}
          <br />
          你当前打开的是：{targetPlacementText}
        </p>

        <div
          style={{
            display: 'flex',
            gap: '16px',
            marginBottom: '20px',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...sectionLabelStyle, color: 'var(--accent)' }}>准备导入</div>
            <div
              style={{
                backgroundColor: 'var(--bg-card)',
                borderRadius: 'var(--radius-small)',
                overflow: 'hidden',
                boxShadow: 'inset 0 0 0 1px var(--border)',
              }}
            >
              <div
                style={{
                  position: 'relative',
                  width: '100%',
                  aspectRatio: '1.6',
                  backgroundColor: 'var(--bg-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                {pendingPreviewSrc ? (
                  <img
                    src={pendingPreviewSrc}
                    alt={info.newFile.name}
                    style={{ width: '100%', display: 'block' }}
                  />
                ) : (
                  <div
                    style={{
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      opacity: 1,
                    }}
                  >
                    预览不可用
                  </div>
                )}
              </div>
              <div style={{ padding: '12px 16px' }}>
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={info.newFile.name}
                >
                  {info.newFile.name}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {formatFileSize(info.newFile.size)}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px', lineHeight: 1.6 }}>
                  导入目标：{targetPlacementText}
                </div>
              </div>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              minWidth: '40px',
            }}
          >
            <div
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                backgroundColor: isExact ? 'var(--error)' : 'var(--accent)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: 700,
                color: 'var(--text-on-accent)',
              }}
            >
              {isExact ? '!' : '~'}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
              {isExact ? '完全一致' : `${similarityPercent}%`}
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...sectionLabelStyle, color: 'var(--text-secondary)' }}>已有素材</div>
            <div
              style={{
                backgroundColor: 'var(--bg-card)',
                borderRadius: 'var(--radius-small)',
                overflow: 'hidden',
                boxShadow: 'inset 0 0 0 1px var(--border)',
              }}
            >
              <img
                src={existingPreviewSrc}
                alt={info.existingFile.filename}
                style={{ width: '100%', display: 'block' }}
              />
              <div style={{ padding: '12px 16px' }}>
                <div
                  style={{
                    fontSize: '13px',
                    fontWeight: 500,
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={info.existingFile.filename}
                >
                  {info.existingFile.filename}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  导入于 {formatTimestamp(info.existingFile.importedAt)}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '10px', lineHeight: 1.6 }}>
                  所在分组：{existingPlacementText}
                </div>
              </div>
            </div>
          </div>
        </div>

        {!info.canUseExisting && (
          <div
            style={{
              marginBottom: '20px',
              padding: '10px 12px',
              borderRadius: 'var(--radius-small)',
              backgroundColor: 'var(--bg-card)',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              color: 'var(--text-secondary)',
              fontSize: '12px',
              lineHeight: 1.6,
            }}
          >
            已有素材当前不在这个素材分区里，不能直接复用到这里。如果你想把它保留在当前分区，请继续导入一份。
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => void handleAction('skip')}
            disabled={isProcessing}
            style={{
              flex: 1,
              height: '36px',
              padding: '0 16px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              backgroundColor: 'transparent',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              opacity: isProcessing ? 0.6 : 1,
            }}
          >
            取消
          </button>
          <button
            onClick={() => void handleAction('import')}
            disabled={isProcessing}
            style={{
              flex: 1,
              height: '36px',
              padding: '0 16px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              backgroundColor: 'var(--bg-card)',
              boxShadow: 'inset 0 0 0 1px var(--border)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: isProcessing ? 'not-allowed' : 'pointer',
              opacity: isProcessing ? 0.6 : 1,
            }}
          >
            继续导入
          </button>
          <button
            onClick={() => void handleAction('use-existing')}
            disabled={isProcessing || !info.canUseExisting}
            style={{
              flex: 1.2,
              height: '36px',
              padding: '0 16px',
              borderRadius: 'var(--radius-default)',
              border: 'none',
              backgroundColor: 'var(--accent)',
              color: 'var(--text-on-accent)',
              fontFamily: 'var(--font-family)',
              fontSize: '13px',
              fontWeight: 600,
              cursor: isProcessing || !info.canUseExisting ? 'not-allowed' : 'pointer',
              opacity: isProcessing || !info.canUseExisting ? 0.5 : 1,
            }}
          >
            {useExistingLabel}
          </button>
        </div>
      </div>
    </>
  );
};
