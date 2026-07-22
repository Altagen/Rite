/**
 * Icon set — the exact SVG paths from the design mock (design/mock/rite.js +
 * full-data.js + the per-mock `M` set), as React components, so the app matches
 * the mock's iconography. All are stroked (fill:none, 2px, round caps), 24×24.
 */

type IconProps = { className?: string };

function Svg({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      className={className ?? 'h-4 w-4'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconTerminal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17l6-5-6-5M12 19h8" />
  </Svg>
);
export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13 2L4.5 13H11l-1 9 8.5-11H12l1-9z" />
  </Svg>
);
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </Svg>
);
export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5v14l11-7z" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 9l6 6 6-6" />
  </Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6l6 6-6 6" />
  </Svg>
);
export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6l-6 6 6 6" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4-4" />
  </Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M2.5 20a6.5 6.5 0 0113 0M16 5.5a3 3 0 010 5.5M21.5 20a6.5 6.5 0 00-4-5.6" />
  </Svg>
);
export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 13a1 1 0 00.2 1.1l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1 1 0 00-1.1-.2 1 1 0 00-.6.9V21a2 2 0 11-4 0v-.2a1 1 0 00-.7-.9 1 1 0 00-1.1.2l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1 1 0 00.2-1.1 1 1 0 00-.9-.6H3a2 2 0 110-4h.2a1 1 0 00.9-.7 1 1 0 00-.2-1.1l-.1-.1A2 2 0 116.6 4.6l.1.1a1 1 0 001.1.2H8a1 1 0 00.6-.9V3a2 2 0 114 0v.2a1 1 0 00.6.9 1 1 0 001.1-.2l.1-.1a2 2 0 112.8 2.8l-.1.1a1 1 0 00-.2 1.1V8a1 1 0 00.9.6H21a2 2 0 110 4h-.2a1 1 0 00-.9.6z" />
  </Svg>
);
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
  </Svg>
);
export const IconSplit = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </Svg>
);
export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </Svg>
);
export const IconPanel = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Svg>
);
export const IconKey = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2L20 3M17 6l2 2M14 9l2 2" />
  </Svg>
);
export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13" />
  </Svg>
);
export const IconSignOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M16 17l5-5-5-5M21 12H9M12 3H6a2 2 0 00-2 2v14a2 2 0 002 2h6" />
  </Svg>
);
export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 20h9M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z" />
  </Svg>
);
export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3v12M8 11l4 4 4-4M5 21h14" />
  </Svg>
);
export const IconGrid = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Svg>
);
export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
  </Svg>
);
export const IconSort = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 6h12M3 12h9M3 18h6M17 8l3-3 3 3M20 5v14" />
  </Svg>
);

/* Identity icons (folder / collection / machine) — distinct, per the mock. */
export const IconFolder = ({ className, color }: IconProps & { color?: string | null }) => (
  <svg className={className ?? 'h-4 w-4'} style={color ? { color } : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
  </svg>
);
export const IconCollection = ({ className, color }: IconProps & { color?: string | null }) => (
  <svg className={className ?? 'h-4 w-4'} style={color ? { color } : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3.5 12L12 17l8.5-5M3.5 16L12 21l8.5-5" />
  </svg>
);
export const IconMachine = ({ className, color }: IconProps & { color?: string | null }) => (
  <svg className={className ?? 'h-4 w-4'} style={color ? { color } : undefined} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="5" width="18" height="6" rx="1.5" />
    <rect x="3" y="13" width="18" height="6" rx="1.5" />
    <path d="M6.5 8h.01M6.5 16h.01M17 8h1.5M17 16h1.5" />
  </svg>
);
