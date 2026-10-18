import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../internal/cx';

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode;
  description?: ReactNode;
  /** Decorative illustration or icon (hidden from assistive technology). */
  icon?: ReactNode;
  /** Primary next step, e.g. a `<Button>`. */
  action?: ReactNode;
  /** Heading level of the title; pick the one that fits the page outline. */
  headingLevel?: 2 | 3 | 4;
}

/** Explains why a list or view is empty and offers the next action. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  headingLevel = 2,
  className,
  ...rest
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <section className={cx('qz-empty-state', className)} {...rest}>
      {icon ? (
        <div className="qz-empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <Heading className="qz-empty-state__title">{title}</Heading>
      {description ? <p className="qz-empty-state__description">{description}</p> : null}
      {action ? <div className="qz-empty-state__action">{action}</div> : null}
    </section>
  );
}
