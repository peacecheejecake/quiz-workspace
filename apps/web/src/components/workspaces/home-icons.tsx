// The sticky line's two text buttons shown as icons while the 문제 search is open on a phone
// (UX12-HOMEFILTER). Same 24 box and stroke as the kit's icons.
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const shared = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

/** A page with a folded corner: the `문서 N` menu. */
export function DocumentsIcon(props: IconProps) {
  return (
    <svg {...shared} {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </svg>
  );
}

/** A clipboard with a check: 모의고사. */
export function MockExamIcon(props: IconProps) {
  return (
    <svg {...shared} {...props}>
      <path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <path d="M9 3h6v3H9zM9 14l2 2 4-4" />
    </svg>
  );
}
