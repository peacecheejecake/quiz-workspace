// Decorative icons of the AI 질문 panel (ASK-01); always next to a visible or accessible name.
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Base({ children, ...props }: IconProps) {
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
      style={{ display: 'block' }}
      {...props}
    >
      {children}
    </svg>
  );
}

/** A speech bubble with a spark: the header's `AI 질문`. */
export function AskIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z" />
      <path d="M12 10.5v3M10.5 12h3" />
    </Base>
  );
}

/** A filled square: `답변 중지`. */
export function StopIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor" />
    </Base>
  );
}

/** An arrow up: `보내기`. */
export function SendIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </Base>
  );
}
