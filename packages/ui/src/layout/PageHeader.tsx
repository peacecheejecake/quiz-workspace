import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '../internal/cx';

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Page title rendered as the page's `<h1>`. */
  title: ReactNode;
  description?: ReactNode;
  /** Back control above the title (`<BackLink>`), for pages reached by a button. */
  back?: ReactNode;
  /** Location trail above the title (`<Breadcrumb>`, which is its own labelled `<nav>`). */
  breadcrumb?: ReactNode;
  /** Page-level actions (buttons) aligned to the end. */
  actions?: ReactNode;
}

export function PageHeader({
  title,
  description,
  back,
  breadcrumb,
  actions,
  className,
  ...rest
}: PageHeaderProps) {
  return (
    <header className={cx('qz-page-header', className)} {...rest}>
      <div className="text">
        {back || breadcrumb ? (
          <div className="nav">
            {back}
            {breadcrumb ? <div className="breadcrumb">{breadcrumb}</div> : null}
          </div>
        ) : null}
        <h1 className="title">{title}</h1>
        {description ? <p className="description">{description}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}
