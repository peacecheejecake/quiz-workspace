import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function BaseIcon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </BaseIcon>
  );
}

/** Horizontal ellipsis for "더보기" action menus. */
export function MoreIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />
    </BaseIcon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </BaseIcon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </BaseIcon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m6 9 6 6 6-6" />
    </BaseIcon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M6 12h12" />
    </BaseIcon>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </BaseIcon>
  );
}

/** Tray with an upward arrow (file drop / upload). */
export function UploadIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />
    </BaseIcon>
  );
}

/** Back navigation arrow. */
export function ArrowLeftIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </BaseIcon>
  );
}

/** Breadcrumb separator. */
export function ChevronRightIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m9 6 6 6-6 6" />
    </BaseIcon>
  );
}

/** Chevron pointing up (collapse a disclosure). */
export function ChevronUpIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="m6 15 6-6 6 6" />
    </BaseIcon>
  );
}

/** Magnifying glass (search submit). */
export function SearchIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </BaseIcon>
  );
}

/** Trash can (delete). */
export function TrashIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.2A2 2 0 0 0 9.3 20h5.4a2 2 0 0 0 2-1.8L17.5 7M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    </BaseIcon>
  );
}

/** Clock with a counter-clockwise arrow (history). */
export function HistoryIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4.5V8.5h4" />
      <path d="M12 8v4.5l3 2" />
    </BaseIcon>
  );
}

/** Two linked rings (share link). */
export function ShareIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </BaseIcon>
  );
}

/** Head and shoulders (account menu trigger on narrow headers). */
export function AccountIcon(props: IconProps) {
  return (
    <BaseIcon {...props}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </BaseIcon>
  );
}
