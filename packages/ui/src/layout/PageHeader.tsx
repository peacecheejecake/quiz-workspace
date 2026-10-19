import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../internal/cx';

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Page title rendered as the page's `<h1>`. */
  title: ReactNode;
  description?: ReactNode;
  /** Breadcrumb or back link rendered above the title (wrap it in a labelled `<nav>`). */
  breadcrumb?: ReactNode;
  /** Page-level actions (buttons) aligned to the end. */
  actions?: ReactNode;
}

export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  className,
  ...rest
}: PageHeaderProps) {
  return (
    <header className={cx('qz-page-header', className)} {...rest}>
      <div className="text">
        {breadcrumb ? <div className="breadcrumb">{breadcrumb}</div> : null}
        <h1 className="title">{title}</h1>
        {description ? <p className="description">{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
