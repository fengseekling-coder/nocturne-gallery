import React, { useEffect, useCallback } from 'react';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
}) => {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    },
    [onCancel]
  );

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [isOpen, handleKeyDown]);

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onCancel();
    }
  };

  if (!isOpen) {
    return null;
  }

  const showCancelButton = cancelText.trim().length > 0;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        animation: 'fadeIn 150ms ease-out',
      }}
      onClick={handleOverlayClick}
    >
      {/* Overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: 'var(--overlay-backdrop)',
        }}
      />

      {/* Modal Content */}
      <div
        style={{
          position: 'relative',
          backgroundColor: 'var(--bg-surface)',
          borderRadius: 'var(--radius-small, 8px)',
          padding: '24px',
          minWidth: '360px',
          maxWidth: '480px',
        fontFamily: 'var(--font-family)',
        }}
      >
        {/* Title */}
        <h2
          style={{
            margin: 0,
            marginBottom: '12px',
            fontSize: '15px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            lineHeight: 1.4,
          }}
        >
          {title}
        </h2>

        {/* Message */}
        <p
          style={{
            margin: 0,
            marginBottom: '24px',
            fontSize: '13px',
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
          }}
        >
          {message}
        </p>

        {/* Button Area */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
          }}
        >
          {showCancelButton && (
            <button
              onClick={onCancel}
              style={{
                padding: '8px 16px',
                borderRadius: 'var(--radius-small, 8px)',
                backgroundColor: 'transparent',
                boxShadow: 'inset 0 0 0 1px var(--border)',
                border: 'none',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
                color: 'var(--text-secondary)',
                fontFamily: 'var(--font-family)',
                transition: 'background-color 150ms ease-out',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {cancelText}
            </button>
          )}

          {/* Confirm Button */}
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 16px',
              borderRadius: 'var(--radius-small, 8px)',
              backgroundColor: danger ? 'var(--error)' : 'var(--accent)',
              border: 'none',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
              color: danger ? 'var(--text-primary)' : 'var(--text-on-accent)',
              fontFamily: 'var(--font-family)',
              transition: 'opacity 150ms ease-out',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '0.9';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '1';
            }}
          >
            {confirmText}
          </button>
        </div>
      </div>

      {/* Keyframes */}
      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
};

export default ConfirmModal;
