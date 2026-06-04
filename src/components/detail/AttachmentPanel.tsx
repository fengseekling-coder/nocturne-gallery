import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../common/Icon';
import type { MediaAttachment, MediaDetail } from '../../types/media';

const ATTACHMENT_GRID_COLUMNS = 3;
const ATTACHMENT_GRID_ROWS = 2;
const ATTACHMENT_GRID_GAP = 6;

export interface AttachmentPanelProps {
  detail: MediaDetail;
  attachmentPreviewMap: Record<string, string>;
  attachmentPreviewLoadingMap: Record<string, boolean>;
  selectedAttachmentId: string | null;
  setSelectedAttachmentId: (id: string | null) => void;
  previewAttachmentId: string | null;
  setPreviewAttachmentId: (id: string | null) => void;
  handleAddAttachment: () => Promise<void>;
  handleOpenAttachmentInCanvas: () => void;
  handleOpenAttachmentPreview: (attachment: MediaAttachment) => void;
  handleShowAttachmentInFolder: (attachment: MediaAttachment) => Promise<void>;
  handleAttachmentDrop: (event: React.DragEvent<HTMLDivElement>) => Promise<void>;
  handleAttachmentPaste: (event: React.ClipboardEvent<HTMLDivElement>) => Promise<void>;
  handleAttachmentKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => Promise<void>;
  getAttachmentPreviewSrc: (attachment: MediaAttachment) => string | null;
  isAttachmentDragOver: boolean;
  setIsAttachmentDragOver: (value: boolean) => void;
  attachmentSectionRef: React.RefObject<HTMLDivElement>;
}

export const AttachmentPanel: React.FC<AttachmentPanelProps> = React.memo(({
  detail,
  attachmentPreviewMap,
  attachmentPreviewLoadingMap,
  selectedAttachmentId,
  setSelectedAttachmentId,
  previewAttachmentId,
  setPreviewAttachmentId,
  handleAddAttachment,
  handleOpenAttachmentInCanvas,
  handleOpenAttachmentPreview,
  handleShowAttachmentInFolder,
  handleAttachmentDrop,
  handleAttachmentPaste,
  handleAttachmentKeyDown,
  getAttachmentPreviewSrc,
  isAttachmentDragOver,
  setIsAttachmentDragOver,
  attachmentSectionRef,
}) => {
  const [attachmentGridCellSize, setAttachmentGridCellSize] = useState<number | null>(null);
  const attachmentGridRef = useRef<HTMLDivElement>(null);
  const [activeAttachmentId, setActiveAttachmentId] = useState<string | null>(previewAttachmentId);

  useEffect(() => {
    setActiveAttachmentId(previewAttachmentId);
  }, [previewAttachmentId]);

  useEffect(() => {
    const grid = attachmentGridRef.current;
    if (!grid) return;
    const update = () => {
      const width = grid.clientWidth;
      if (width <= 0) return;
      const next = Math.floor((width - (ATTACHMENT_GRID_GAP * (ATTACHMENT_GRID_COLUMNS - 1))) / ATTACHMENT_GRID_COLUMNS);
      setAttachmentGridCellSize(next > 0 ? next : null);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [detail.attachments.length]);

  const attachmentGridViewportHeight = attachmentGridCellSize == null ? undefined : (attachmentGridCellSize * ATTACHMENT_GRID_ROWS) + (ATTACHMENT_GRID_GAP * (ATTACHMENT_GRID_ROWS - 1));
  const activePreviewAttachment = useMemo(() => detail.attachments.find((attachment) => attachment.id === activeAttachmentId) ?? null, [activeAttachmentId, detail.attachments]);
  const activePreviewAttachmentSrc = useMemo(() => {
    if (!activePreviewAttachment) return null;
    return attachmentPreviewMap[activePreviewAttachment.id] ?? null;
  }, [activePreviewAttachment, attachmentPreviewMap]);

  const attachmentItemsForCanvasPreview = useMemo(() => detail.attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    src: attachmentPreviewMap[attachment.id] ?? null,
  })), [attachmentPreviewMap, detail.attachments]);

  return (
    <div
      ref={attachmentSectionRef}
      tabIndex={0}
      onDragEnter={(event) => { event.preventDefault(); setIsAttachmentDragOver(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setIsAttachmentDragOver(true); }}
      onDragLeave={(event) => {
        event.preventDefault();
        const relatedTarget = event.relatedTarget as Node | null;
        if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) setIsAttachmentDragOver(false);
      }}
      onDrop={(event) => { void handleAttachmentDrop(event); }}
      onPaste={(event) => { void handleAttachmentPaste(event); }}
      onKeyDown={(event) => { void handleAttachmentKeyDown(event); }}
      style={{
        display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px', borderRadius: 'var(--radius-panel)',
        background: 'color-mix(in srgb, var(--bg-card) 84%, transparent)',
        boxShadow: isAttachmentDragOver ? 'inset 0 0 0 1px var(--accent-border), 0 0 0 1px var(--accent-border)' : 'inset 0 0 0 1px var(--border)',
        outline: 'none',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr) auto', alignItems: 'center', gap: '10px' }}>
        <button type="button" onClick={() => { attachmentSectionRef.current?.focus(); void handleAddAttachment(); }} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '32px', padding: '0 12px', borderRadius: 'var(--radius-small)', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-primary)', fontSize: '12px', fontWeight: 500, cursor: 'pointer', flexShrink: 0 }}>添加附件</button>
        {activePreviewAttachment && activePreviewAttachmentSrc && (<span style={{ minWidth: 0, fontSize: '10px', fontWeight: 500, color: 'var(--text-muted)', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={activePreviewAttachment.filename}>{activePreviewAttachment.filename}</span>)}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '8px' }}>
          <button type="button" onClick={handleOpenAttachmentInCanvas} disabled={attachmentItemsForCanvasPreview.length === 0} title="在内容区查看" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '32px', width: '32px', padding: 0, borderRadius: 'var(--radius-small)', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', color: attachmentItemsForCanvasPreview.length > 0 ? 'var(--text-primary)' : 'var(--text-muted)', cursor: attachmentItemsForCanvasPreview.length > 0 ? 'pointer' : 'default', opacity: attachmentItemsForCanvasPreview.length > 0 ? 1 : 0.45, flexShrink: 0 }}>
            <Icon name="open_in_full" size={16} />
          </button>
          {activePreviewAttachment && activePreviewAttachmentSrc && (<button type="button" onClick={() => setPreviewAttachmentId(null)} title="返回附件" style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: '32px', width: '32px', padding: 0, borderRadius: 'var(--radius-small)', border: 'none', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', color: 'var(--text-secondary)', cursor: 'pointer', flexShrink: 0 }}><Icon name="arrow_back" size={16} /></button>)}
        </div>
      </div>
      {detail.attachments.length === 0 ? (
        <div style={{ padding: '12px', borderRadius: 'var(--radius-xl)', background: 'var(--bg-surface)', boxShadow: 'inset 0 0 0 1px var(--border)', fontSize: '12px', lineHeight: 1.6, color: 'var(--text-muted)' }}>这里可以放源文件、工程文件或参考素材。</div>
      ) : activePreviewAttachment && activePreviewAttachmentSrc ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <img src={activePreviewAttachmentSrc} alt={activePreviewAttachment.filename} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 'var(--radius-xl)' }} />
        </div>
      ) : (
        <div ref={attachmentGridRef} style={{ display: 'grid', gridTemplateColumns: `repeat(${ATTACHMENT_GRID_COLUMNS}, minmax(0, 1fr))`, gridAutoRows: attachmentGridCellSize == null ? undefined : `${attachmentGridCellSize}px`, gap: `${ATTACHMENT_GRID_GAP}px`, height: attachmentGridViewportHeight == null ? undefined : `${attachmentGridViewportHeight}px`, maxHeight: attachmentGridViewportHeight == null ? undefined : `${attachmentGridViewportHeight}px`, overflowY: 'auto', overscrollBehavior: 'contain', paddingRight: '2px' }}>
          {detail.attachments.map((attachment) => (
            <div key={attachment.id} draggable onClick={() => { setSelectedAttachmentId(attachment.id); attachmentSectionRef.current?.focus(); }} onDoubleClick={() => handleOpenAttachmentPreview(attachment)} onContextMenu={(event) => { event.preventDefault(); setSelectedAttachmentId(attachment.id); attachmentSectionRef.current?.focus(); void handleShowAttachmentInFolder(attachment); }} onDragStart={() => {}} style={{ borderRadius: 'var(--radius-xl)', background: 'var(--bg-surface)', boxShadow: selectedAttachmentId === attachment.id ? 'inset 0 0 0 1px var(--accent-border)' : 'inset 0 0 0 1px var(--border)', overflow: 'hidden', cursor: 'grab', height: '100%', aspectRatio: attachmentGridCellSize == null ? '1 / 1' : undefined }} title={`${attachment.filename}\n双击在附件区查看大图，右键打开位置`}>
              <div style={{ position: 'relative', width: '100%', height: '100%', background: 'color-mix(in srgb, var(--bg-hover) 72%, transparent)' }}>
                {getAttachmentPreviewSrc(attachment) ? (
                  <img src={getAttachmentPreviewSrc(attachment)!} alt={attachment.filename} style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover', background: 'var(--bg-primary)' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
                    <div style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-lg)', background: 'color-mix(in srgb, var(--bg-primary) 72%, transparent)', boxShadow: 'inset 0 0 0 1px var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700 }}>{attachment.filename.split('.').pop()?.toUpperCase() || '文件'}</div>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{attachmentPreviewLoadingMap[attachment.id] ? '读取预览中...' : '暂无预览'}</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
