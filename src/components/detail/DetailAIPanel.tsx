import React from 'react';

export interface DetailAIPanelProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export const DetailAIPanel: React.FC<DetailAIPanelProps> = React.memo(({ children, style }) => {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', ...style }}>
      {children}
    </div>
  );
});
