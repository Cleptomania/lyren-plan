// Layout blocks shared by the settings pages: the page heading, titled cards and label/control rows.

import { clsx } from 'clsx';
import { useId, type ReactNode } from 'react';
import { useDocumentTitle } from '../../lib/hooks';

export interface SettingsPageProps {
  title: string;
  description?: ReactNode;
  /** Buttons next to the heading (e.g. "Add status"). */
  actions?: ReactNode;
  children: ReactNode;
}

/** One settings section: h2 + description + content. Sets the document title. */
export function SettingsPage({ title, description, actions, children }: SettingsPageProps) {
  useDocumentTitle(`${title} · Settings`);
  return (
    <div className="flex min-w-0 flex-col gap-5 md:gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-fg">{title}</h2>
          {description && <p className="mt-0.5 max-w-prose text-sm text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export interface SettingsCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Controls at the end of the card header. */
  actions?: ReactNode;
  children?: ReactNode;
  /** Action row at the bottom (buttons), separated by a border. */
  footer?: ReactNode;
  /** Remove the body padding (for edge-to-edge lists). */
  flush?: boolean;
  className?: string;
}

/** A titled card (rendered as a <section> labelled by its title). */
export function SettingsCard({ title, description, actions, children, footer, flush, className }: SettingsCardProps) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={clsx('min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-card', className)}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3 px-4 pt-4">
        {/* Actions wrap below the title on narrow cards instead of squeezing the text. */}
        <div className="min-w-0 flex-[1_1_16rem]">
          <h3 id={titleId} className="text-sm font-semibold text-fg">
            {title}
          </h3>
          {description && <div className="mt-0.5 text-[13px] text-fg-muted">{description}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && <div className={clsx(flush ? 'mt-3' : 'p-4')}>{children}</div>}
      {children === undefined && <div className="h-4" />}
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-2/50 px-4 py-3">{footer}</div>
      )}
    </section>
  );
}

export interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Id of the control the label belongs to (omit for groups that carry their own aria-label). */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** Label + description on the left, control on the right (stacked on phones). */
export function SettingRow({ label, description, htmlFor, children, className }: SettingRowProps) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div className={clsx('flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6', className)}>
      <div className="min-w-0">
        <Label {...(htmlFor ? { htmlFor } : {})} className="text-sm font-medium text-fg">
          {label}
        </Label>
        {description && <div className="mt-0.5 text-[13px] text-fg-muted">{description}</div>}
      </div>
      <div className="flex min-w-0 shrink-0 items-center sm:justify-end">{children}</div>
    </div>
  );
}

/** Divided stack of SettingRows. */
export function SettingRows({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col divide-y divide-border">{children}</div>;
}
