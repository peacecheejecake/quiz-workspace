// Storybook stand-in for `next/link` (no Next router in Storybook): a plain anchor. Aliased by
// packages/ui/.storybook/main.ts for the viewer stories only.
import type { AnchorHTMLAttributes } from 'react';

export default function Link({
  href,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { readonly href: string }) {
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}
