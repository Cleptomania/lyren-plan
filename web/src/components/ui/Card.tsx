import { clsx } from 'clsx';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Inner padding. Default 'md'. */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Hover affordance for clickable cards. */
  interactive?: boolean;
}

const PADDING = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-4 md:p-6' } as const;

/** Bordered surface for grouping content. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { padding = 'md', interactive, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        'min-w-0 rounded-lg border border-border bg-surface shadow-card',
        PADDING[padding],
        interactive && 'transition-colors duration-150 hover:border-border-strong',
        className,
      )}
      {...rest}
    />
  );
});

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned controls. */
  actions?: ReactNode;
  className?: string;
}

/** Title row for a Card (place inside a Card with padding="none" plus your own body, or with padding). */
export function CardHeader({ title, description, icon, actions, className }: CardHeaderProps) {
  return (
    <div className={clsx('flex min-w-0 items-start gap-3', className)}>
      {icon && <span className="mt-0.5 shrink-0 text-fg-muted [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-sm font-semibold text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="-my-1 flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

export interface SectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Heading level for the title (default 2). */
  level?: 2 | 3;
}

/** A titled block of a page (settings groups, dashboard sections…). */
export function Section({ title, description, actions, children, className, level = 2 }: SectionProps) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <section className={clsx('flex min-w-0 flex-col gap-3', className)}>
      {(title || actions) && (
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            {title && <H className="text-[15px] font-semibold text-fg">{title}</H>}
            {description && <p className="mt-0.5 text-[13px] text-fg-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
