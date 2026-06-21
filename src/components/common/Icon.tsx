import React from 'react';

interface IconRenderOptions {
  fill: number;
}

type IconRenderer = (options: IconRenderOptions) => React.ReactNode;

const ICON_PATHS = {
  grid_view: ({ fill }) => fill
    ? (
        <g fill="currentColor">
          <rect x="4" y="4" width="7" height="7" rx="0.5" />
          <rect x="13" y="4" width="7" height="7" rx="0.5" />
          <rect x="4" y="13" width="7" height="7" rx="0.5" />
          <rect x="13" y="13" width="7" height="7" rx="0.5" />
        </g>
      )
    : (
        <g>
          <rect x="4" y="4" width="7" height="7" />
          <rect x="13" y="4" width="7" height="7" />
          <rect x="4" y="13" width="7" height="7" />
          <rect x="13" y="13" width="7" height="7" />
        </g>
      ),
  grid_on: ({ fill }) => fill
    ? (
        <g fill="currentColor">
          <rect x="4" y="4" width="7" height="7" rx="0.5" />
          <rect x="13" y="4" width="7" height="7" rx="0.5" />
          <rect x="4" y="13" width="7" height="7" rx="0.5" />
          <rect x="13" y="13" width="7" height="7" rx="0.5" />
        </g>
      )
    : (
        <g>
          <rect x="4" y="4" width="7" height="7" />
          <rect x="13" y="4" width="7" height="7" />
          <rect x="4" y="13" width="7" height="7" />
          <rect x="13" y="13" width="7" height="7" />
        </g>
      ),
  view_list: () => <g><path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" /></g>,
  folder: ({ fill }) => fill
    ? <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="currentColor" />
    : <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  folder_open: () => <g><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3V7z" /><path d="M3 9h18l-2 8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9z" /></g>,
  create_new_folder: () => <g><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /><path d="M12 11v6" /><path d="M9 14h6" /></g>,
  photo_library: () => <g><rect x="6" y="3" width="15" height="13" rx="1" /><path d="M3 7v13a1 1 0 0 0 1 1h13" /><circle cx="11" cy="8" r="1.4" /><path d="M21 13l-4-4-7 7" /></g>,
  image: () => <g><rect x="4" y="5" width="16" height="14" rx="1.5" /><circle cx="9" cy="10" r="1.4" /><path d="M20 16l-5-5-8 8" /></g>,
  movie: () => <g><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M8 5l2 4" /><path d="M14 5l2 4" /><path d="M4 9h16" /></g>,
  description: () => <g><path d="M6 3h8l4 4v14H6V3z" /><path d="M14 3v5h4" /><path d="M9 13h6" /><path d="M9 17h5" /></g>,
  bookmark: () => <path d="M6 4h12v17l-6-4-6 4V4z" />,
  language: () => <g><circle cx="12" cy="12" r="8" /><path d="M4 12h16" /><path d="M12 4c2.5 2.5 3.5 5 3.5 8s-1 5.5-3.5 8c-2.5-2.5-3.5-5-3.5-8s1-5.5 3.5-8z" /></g>,
  filter_alt: () => <path d="M4 5h16l-6 8v6l-4 2v-8L4 5z" />,
  sort: () => <g><path d="M5 7h14" /><path d="M8 12h8" /><path d="M10 17h4" /></g>,
  tune: () => <g><path d="M4 7h10" /><path d="M18 7h2" /><circle cx="16" cy="7" r="2" /><path d="M4 17h4" /><path d="M12 17h8" /><circle cx="10" cy="17" r="2" /></g>,
  window: () => <g><rect x="4" y="5" width="16" height="14" rx="1" /><path d="M4 9h16" /></g>,

  add: () => <g><path d="M12 5v14" /><path d="M5 12h14" /></g>,
  remove: () => <path d="M5 12h14" />,
  add_comment: () => <g><path d="M5 5h14v10H9l-4 4V5z" /><path d="M12 8v4" /><path d="M10 10h4" /></g>,
  history: () => <g><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 5v5h5" /><path d="M12 8v5l3 2" /></g>,
  close: () => <g><path d="M6 6l12 12" /><path d="M18 6L6 18" /></g>,
  check: () => <path d="M5 12.5l4.5 4.5L19 7.5" />,
  done_all: () => <g><path d="M3.5 12.5l3.5 3.5 7-8" /><path d="M10.5 16l1.5 1.5 8-9" /></g>,
  search: () => <g><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></g>,
  delete: () => <g><path d="M5 7h14" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" /></g>,
  delete_forever: () => <g><path d="M5 7h14" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" /><path d="M10 11l4 4" /><path d="M14 11l-4 4" /></g>,
  delete_sweep: () => <g><path d="M8 7h11" /><path d="M12 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" /><path d="M10 7l1 12a2 2 0 0 0 2 2h3a2 2 0 0 0 2-2l1-12" /><path d="M3 10h4" /><path d="M4 14h3" /><path d="M5 18h2" /></g>,
  content_copy: () => <g><rect x="8" y="8" width="12" height="12" rx="1" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></g>,
  download: () => <g><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></g>,
  file_download: () => <g><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></g>,
  save_as: () => <g><path d="M5 4h11l3 3v13H5V4z" /><path d="M8 4v6h7" /><path d="M8 17h6" /><path d="M16 14l3 3" /><path d="M19 14l-3 3" /></g>,
  arrow_forward: () => <g><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></g>,
  arrow_back: () => <g><path d="M19 12H5" /><path d="M11 6l-6 6 6 6" /></g>,
  arrow_upward: () => <g><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></g>,
  chevron_left: () => <path d="M15 6l-6 6 6 6" />,
  chevron_right: () => <path d="M9 6l6 6-6 6" />,
  keyboard_arrow_down: () => <path d="M7 10l5 5 5-5" />,
  expand_more: () => <path d="M7 10l5 5 5-5" />,
  expand_less: () => <path d="M7 14l5-5 5 5" />,
  play_arrow: ({ fill }) => fill !== 0
    ? <path d="M8 5l11 7-11 7V5z" fill="currentColor" />
    : <path d="M8 5l11 7-11 7V5z" />,
  play_circle: ({ fill }) => fill !== 0
    ? <g><circle cx="12" cy="12" r="8" fill="currentColor" /><path d="M10 8.5l6 3.5-6 3.5v-7z" fill="var(--bg-primary)" stroke="none" /></g>
    : <g><circle cx="12" cy="12" r="8" /><path d="M10 8.5l6 3.5-6 3.5v-7z" /></g>,
  stop: ({ fill }) => fill !== 0
    ? <rect x="8" y="8" width="8" height="8" rx="1" fill="currentColor" />
    : <rect x="8" y="8" width="8" height="8" rx="1" />,
  stop_circle: ({ fill }) => fill !== 0
    ? <g><circle cx="12" cy="12" r="8" fill="currentColor" /><rect x="9" y="9" width="6" height="6" rx="1" fill="var(--bg-primary)" stroke="none" /></g>
    : <g><circle cx="12" cy="12" r="8" /><rect x="9" y="9" width="6" height="6" rx="1" /></g>,
  refresh: () => <g><path d="M19 8a7 7 0 1 0 1 5" /><path d="M19 4v4h-4" /></g>,
  open_in_new: () => <g><path d="M10 5H5v14h14v-5" /><path d="M13 5h6v6" /><path d="M19 5l-9 9" /></g>,
  open_in_full: () => <g><path d="M9 4H4v5" /><path d="M4 4l6 6" /><path d="M15 4h5v5" /><path d="M20 4l-6 6" /><path d="M9 20H4v-5" /><path d="M4 20l6-6" /><path d="M15 20h5v-5" /><path d="M20 20l-6-6" /></g>,
  fullscreen: () => <g><path d="M9 4H4v5" /><path d="M4 4l6 6" /><path d="M15 4h5v5" /><path d="M20 4l-6 6" /><path d="M9 20H4v-5" /><path d="M4 20l6-6" /><path d="M15 20h5v-5" /><path d="M20 20l-6-6" /></g>,
  drive_file_rename_outline: () => <g><path d="M5 19h4l10-10-4-4L5 15v4z" /><path d="M13 7l4 4" /><path d="M4 21h16" /></g>,
  attach_file: () => <path d="M18 8.5l-7.7 7.7a4 4 0 0 1-5.7-5.7L13 2.1a2.7 2.7 0 0 1 3.8 3.8L8.6 14.1a1.4 1.4 0 0 1-2-2L14 4.7" />,
  visibility: () => <g><path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.5" /></g>,
  visibility_off: () => <g><path d="M4 4l16 16" /><path d="M10.6 10.6A2.4 2.4 0 0 0 12 14.4c.7 0 1.3-.3 1.8-.7" /><path d="M7.2 7.8C4.6 9.4 3 12 3 12s3.2 6 9 6c1.7 0 3.1-.5 4.3-1.2" /><path d="M14 6.3c4.4.9 7 5.7 7 5.7a15 15 0 0 1-2.1 2.8" /></g>,
  restore_from_trash: () => <g><path d="M5 7h14" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M7 7l1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12" /><path d="M12 16V10" /><path d="M9 13l3-3 3 3" /></g>,

  info: () => <g><circle cx="12" cy="12" r="8" /><path d="M12 11v5" /><circle cx="12" cy="8" r="0.6" fill="currentColor" /></g>,
  error: () => <g><circle cx="12" cy="12" r="8" /><path d="M12 8v5" /><circle cx="12" cy="16" r="0.6" fill="currentColor" /></g>,
  check_circle: ({ fill }) => fill !== 0
    ? <g><circle cx="12" cy="12" r="8" fill="currentColor" /><path d="M8 12.5l3 3 5-5" stroke="var(--bg-primary)" /></g>
    : <g><circle cx="12" cy="12" r="8" /><path d="M8 12.5l3 3 5-5" /></g>,
  label: () => <g><path d="M4 7a2 2 0 0 1 2-2h9l5 7-5 7H6a2 2 0 0 1-2-2V7z" /><circle cx="8" cy="12" r="1.2" fill="currentColor" /></g>,
  tag: () => <g><path d="M9 4l-1 16" /><path d="M16 4l-1 16" /><path d="M4 9h16" /><path d="M4 15h16" /></g>,
  star: ({ fill }) => fill !== 0
    ? <path d="M12 4l2.5 5.1 5.6.8-4 3.9.9 5.5-5-2.7-5 2.7.9-5.5-4-3.9 5.6-.8L12 4z" fill="currentColor" />
    : <path d="M12 4l2.5 5.1 5.6.8-4 3.9.9 5.5-5-2.7-5 2.7.9-5.5-4-3.9 5.6-.8L12 4z" />,
  drag_indicator: () => <g><circle cx="9" cy="6" r="1.2" fill="currentColor" /><circle cx="15" cy="6" r="1.2" fill="currentColor" /><circle cx="9" cy="12" r="1.2" fill="currentColor" /><circle cx="15" cy="12" r="1.2" fill="currentColor" /><circle cx="9" cy="18" r="1.2" fill="currentColor" /><circle cx="15" cy="18" r="1.2" fill="currentColor" /></g>,

  light_mode: () => <g><circle cx="12" cy="12" r="4" /><path d="M12 3v2" /><path d="M12 19v2" /><path d="M3 12h2" /><path d="M19 12h2" /><path d="M5.5 5.5l1.5 1.5" /><path d="M17 17l1.5 1.5" /><path d="M5.5 18.5L7 17" /><path d="M17 7l1.5-1.5" /></g>,
  dark_mode: () => <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  settings: () => <g><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3 1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8 1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></g>,
  left_panel_close: () => <g><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M9 5v14" /><path d="M15 9l-3 3 3 3" /></g>,
  auto_awesome: ({ fill }) => fill !== 0
    ? <g fill="currentColor"><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4z" /><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z" /></g>
    : <g><path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4z" /><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7L19 16z" /></g>,
  progress_activity: () => <path d="M12 4a8 8 0 1 1-5.7 2.3" />,
  spinner: () => <path d="M12 4a8 8 0 1 1-5.7 2.3" />,
} satisfies Record<string, IconRenderer>;

export type IconName = keyof typeof ICON_PATHS;

export interface IconProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'> {
  name: IconName | string;
  fill?: number;
  size?: number | string;
  color?: string;
  opacity?: number;
  className?: string;
  title?: string;
  style?: React.CSSProperties;
  strokeWidth?: number;
}

const fallbackIcon = (
  <circle cx="12" cy="12" r="3" fill="currentColor" opacity="0.35" stroke="none" />
);

export const Icon: React.FC<IconProps> = ({
  name,
  fill = 0,
  size = 18,
  color,
  opacity,
  className,
  title,
  style,
  strokeWidth = 1.5,
  ...spanProps
}) => {
  const render = ICON_PATHS[name as IconName];
  const shouldHide = title ? undefined : true;

  return (
    <span
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={shouldHide}
      aria-label={title}
      {...spanProps}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        color,
        opacity,
        flexShrink: 0,
        lineHeight: 0,
        ...style,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        focusable="false"
      >
        {render ? render({ fill }) : fallbackIcon}
      </svg>
    </span>
  );
};


