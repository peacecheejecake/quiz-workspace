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

/** Circular arrow for "다시 풀기" (retry). */
export function RetryIcon(props: IconProps) {
  return (
    <svg {...base} fill="none" {...props}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </svg>
  );
}
