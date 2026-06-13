/**
 * 大图预览：解码完成前保留上一帧，避免 URL 切换时的空白/问号帧。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { markPreviewAssetDecoded } from '../../lib/previewImageReady';

interface PreviewCanvasImageProps {
  src: string;
  alt: string;
  style?: React.CSSProperties;
}

export const PreviewCanvasImage: React.FC<PreviewCanvasImageProps> = ({ src, alt, style }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const paintedSrcRef = useRef<string>('');
  const [frontVisible, setFrontVisible] = useState(false);
  const [hasBackdrop, setHasBackdrop] = useState(false);

  const paintFromImage = useCallback((img: HTMLImageElement, assetUrl: string) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (w <= 0 || h <= 0) return;

    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const cw = wrap.clientWidth;
    const ch = wrap.clientHeight;
    if (cw <= 0 || ch <= 0) return;

    const scale = Math.min(cw / w, ch / h, 1);
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));

    if (canvas.width !== dw || canvas.height !== dh) {
      canvas.width = dw;
      canvas.height = dh;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(img, 0, 0, dw, dh);
    paintedSrcRef.current = assetUrl;
    setHasBackdrop(true);
    markPreviewAssetDecoded(assetUrl);
  }, []);

  const revealFront = useCallback((assetUrl: string) => {
    const img = imgRef.current;
    if (img && img.naturalWidth > 0) {
      paintFromImage(img, assetUrl);
    }
    setFrontVisible(true);
  }, [paintFromImage]);

  useEffect(() => {
    const url = src.trim();
    if (!url) {
      setFrontVisible(false);
      return;
    }

    if (url === paintedSrcRef.current) {
      setFrontVisible(true);
      return;
    }

    setFrontVisible(false);
    const img = imgRef.current;
    if (!img) return;

    let cancelled = false;

    const onReady = () => {
      if (cancelled) return;
      if (typeof img.decode === 'function') {
        void img.decode().then(() => {
          if (!cancelled) revealFront(url);
        }).catch(() => {
          if (!cancelled) revealFront(url);
        });
      } else {
        revealFront(url);
      }
    };

    const onFail = () => {
      if (cancelled) return;
      setFrontVisible(true);
    };

    img.onload = onReady;
    img.onerror = onFail;

    if (img.src !== url) {
      img.src = url;
    } else if (img.complete && img.naturalWidth > 0) {
      onReady();
    }

    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [src, revealFront]);

  const { transform, transformOrigin, transition, userSelect, maxWidth, maxHeight } = style ?? {};
  const outerTransformStyle: React.CSSProperties = {
    position: 'relative',
    flex: 1,
    width: '100%',
    height: '100%',
    minHeight: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transform,
    transformOrigin,
    transition,
    userSelect,
    maxWidth,
    maxHeight,
  };

  return (
    <div ref={wrapRef} style={outerTransformStyle}>
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: 'absolute',
          maxWidth: '100%',
          maxHeight: '100%',
          display: hasBackdrop && !frontVisible ? 'block' : 'none',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
      <img
        ref={imgRef}
        alt={alt}
        decoding="async"
        draggable={false}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          display: 'block',
          opacity: frontVisible ? 1 : 0,
          transition: frontVisible ? 'opacity 80ms ease-out' : 'none',
        }}
      />
    </div>
  );
};