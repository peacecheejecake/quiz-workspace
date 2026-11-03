import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  width: 20,
  height: 20,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/** Five-point star (same silhouette as the favorite marker); `filled` for the "on" state. */
export function StarIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base} fill={filled ? 'currentColor' : 'none'} {...props}>
      <path d="M12 2.5 15.1 8.5 21.6 9.45 16.8 14.1 17.95 20.65 12 17.5 6.05 20.65 7.2 14.1 2.4 9.45 8.9 8.5Z" />
    </svg>
  );
}

/*
 * Question mark in a circle for "다시 풀기" (retry, UX9 QVIEW-01-C08). Off: outlined circle and
 * glyph in `currentColor`. On (`filled`): a solid circle with the glyph drawn in
 * `--color-on-accent`, so the state shows by shape as well as color.
 */
export function RetryIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  const glyph = filled ? { style: { stroke: 'var(--color-on-accent)' } } : {};
  return (
    <svg {...base} fill="none" data-filled={filled ? 'true' : 'false'} {...props}>
      <circle cx="12" cy="12" r="9.5" fill={filled ? 'currentColor' : 'none'} />
      <path d="M9.25 9.25a2.75 2.75 0 1 1 3.9 2.5c-.75.35-1.15.95-1.15 1.75v.25" {...glyph} />
      <path d="M12 17.25h.01" {...glyph} strokeWidth={2.5} />
    </svg>
  );
}
