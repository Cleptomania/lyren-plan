// Centered card layout shared by the sign-in, first-run setup and public pages (sign-up, password reset,
// email confirmation, recovery, invitations), with their form-level messages.

import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { AppMark } from '../../components/layout/AppMark';
import { Card } from '../../components/ui/Card';

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 pb-safe pt-safe">
      <main className={clsx('w-full py-10', wide ? 'max-w-md' : 'max-w-sm')}>
        <div className="mb-6 flex flex-col items-center gap-4 text-center">
          <AppMark size={44} />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}
          </div>
        </div>
        <Card padding="lg" className="shadow-pop">
          {children}
        </Card>
        {footer && <div className="mt-6 text-center text-xs leading-relaxed text-fg-subtle">{footer}</div>}
      </main>
    </div>
  );
}

/** Form-level error box (wrong password, rate limit, server unreachable…). */
export function FormAlert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
      {children}
    </div>
  );
}

/** Form-level confirmation (a link was sent, a password changed). */
export function FormNotice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-md border border-success/30 bg-success-soft px-3 py-2 text-sm text-fg">
      {children}
    </div>
  );
}

/** "or" between two ways of doing the same (a password, or a passkey). */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-fg-subtle" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      or
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A plain link in the auth pages' text. */
export const AUTH_LINK = 'font-medium text-accent hover:underline';
