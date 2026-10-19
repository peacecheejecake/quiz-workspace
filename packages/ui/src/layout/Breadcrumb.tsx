import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ComponentType, ReactNode } from 'react';
import { cx } from '../internal/cx';
import { ArrowLeftIcon, ChevronRightIcon } from '../primitives/icons';

/**
 * Element used for in-app links: `next/link`'s `Link` (or any component taking `href`,
 * `className` and `children`). Defaults to a plain `<a>`. A component, not a render function,
 * so a Server Component can pass `Link` straight through.
 */
export type LinkComponent = ComponentType<
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }
>;

export interface BreadcrumbItem {
  label: ReactNode;
  /** Omit on the last item: it is the current page (`aria-current="page"`, not a link). */
  href?: string;
}

export interface BreadcrumbProps {
  /** Path from the top level to the current page; the last item is the current page. */
  items: readonly BreadcrumbItem[];
  /** Name of the navigation landmark. */
  label?: string;
  linkComponent?: LinkComponent;
  className?: string;
}

/**
 * Breadcrumb trail (WAI-ARIA APG breadcrumb pattern): a labelled `<nav>` holding an ordered list;
 * separators are decorative and the current page carries `aria-current="page"`.
 */
export function Breadcrumb({
  items,
  label = '위치',
  linkComponent: LinkAs = 'a' as unknown as LinkComponent,
  className,
}: BreadcrumbProps) {
  return (
    <nav aria-label={label} className={cx('qz-breadcrumb', className)}>
      <ol className="list">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={index} className="item">
              {index > 0 ? <ChevronRightIcon className="separator" width={14} height={14} /> : null}
              {last || item.href === undefined ? (
                <span
                  className={last ? 'current' : 'text'}
                  aria-current={last ? 'page' : undefined}
                >
                  {item.label}
                </span>
              ) : (
                <LinkAs href={item.href} className="link qz-focus-ring">
                  {item.label}
                </LinkAs>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

interface BackLinkBaseProps {
  /** Visible text and accessible name, e.g. "문서 목록". */
  label: ReactNode;
  /** Show only the arrow; the label stays as the accessible name. */
  hideLabel?: boolean;
  className?: string;
}

export type BackLinkProps = BackLinkBaseProps &
  (
    | ({ href: string; linkComponent?: LinkComponent } & Omit<
        AnchorHTMLAttributes<HTMLAnchorElement>,
        'href' | 'children' | 'className'
      >)
    | ({ href?: undefined; linkComponent?: undefined } & Omit<
        ButtonHTMLAttributes<HTMLButtonElement>,
        'children' | 'className'
      >)
  );

/**
 * "Back" control shown above a page reached by a button (arrow + label). With `href` it is a link
 * (pass `linkComponent={Link}` for client-side navigation); without, a button whose `onClick`
 * goes back (e.g. `router.back()`).
 */
export function BackLink(props: BackLinkProps) {
  const { label, hideLabel = false, className } = props;
  const content = (
    <>
      <ArrowLeftIcon width={16} height={16} />
      <span className={hideLabel ? 'qz-visually-hidden' : 'label'}>{label}</span>
    </>
  );
  const classes = cx('qz-back-link', 'qz-focus-ring', className);
  if (props.href !== undefined) {
    const {
      label: _label,
      hideLabel: _hide,
      className: _class,
      linkComponent: LinkAs = 'a' as unknown as LinkComponent,
      href,
      ...rest
    } = props;
    return (
      <LinkAs href={href} className={classes} data-icon-only={hideLabel || undefined} {...rest}>
        {content}
      </LinkAs>
    );
  }
  const {
    label: _label,
    hideLabel: _hide,
    className: _class,
    linkComponent: _link,
    href: _href,
    type = 'button',
    ...rest
  } = props;
  return (
    <button type={type} className={classes} data-icon-only={hideLabel || undefined} {...rest}>
      {content}
    </button>
  );
}
