import React from 'react';

interface GegaLogoProps {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

export const GegaLogo: React.FC<GegaLogoProps> = ({ 
  width = 48, 
  height = 48, 
  className,
  style 
}) => {
  return (
    <svg 
      viewBox="0 0 1080 1080" 
      width={width} 
      height={height} 
      className={className}
      style={style}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <style>{`.gega-logo-fill { fill: var(--accent); }`}</style>
      </defs>
      <rect className="gega-logo-fill" x="590" y="690" width="100" height="100" transform="translate(1280 1480) rotate(180)"/>
      <rect className="gega-logo-fill" x="490" y="690" width="100" height="100" transform="translate(1080 1480) rotate(180)"/>
      <rect className="gega-logo-fill" x="390" y="690" width="100" height="100" transform="translate(880 1480) rotate(180)"/>
      <rect className="gega-logo-fill" x="690" y="590" width="100" height="100" transform="translate(1480 1280) rotate(180)"/>
      <rect className="gega-logo-fill" x="290" y="590" width="100" height="100" transform="translate(680 1280) rotate(180)"/>
      <rect className="gega-logo-fill" x="290" y="690" width="100" height="100" transform="translate(680 1480) rotate(180)"/>
      <rect className="gega-logo-fill" x="690" y="690" width="100" height="100" transform="translate(1480 1480) rotate(180)"/>
      <rect className="gega-logo-fill" x="690" y="690" width="100" height="100" transform="translate(1480 1480) rotate(180)"/>
      <rect className="gega-logo-fill" x="690" y="490" width="100" height="100" transform="translate(1480 1080) rotate(180)"/>
      <rect className="gega-logo-fill" x="690" y="390" width="100" height="100" transform="translate(1480 880) rotate(180)"/>
      <rect className="gega-logo-fill" x="290" y="490" width="100" height="100" transform="translate(680 1080) rotate(180)"/>
      <rect className="gega-logo-fill" x="290" y="390" width="100" height="100" transform="translate(680 880) rotate(180)"/>
      <rect className="gega-logo-fill" x="290" y="290" width="100" height="100" transform="translate(680 680) rotate(180)"/>
      <rect className="gega-logo-fill" x="590" y="390" width="100" height="100" transform="translate(1280 880) rotate(180)"/>
      <rect className="gega-logo-fill" x="490" y="390" width="100" height="100" transform="translate(1080 880) rotate(180)"/>
      <rect className="gega-logo-fill" x="390" y="290" width="100" height="100" transform="translate(880 680) rotate(180)"/>
    </svg>
  );
};
