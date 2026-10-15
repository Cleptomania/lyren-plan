// Centered card layout shared by the sign-in and first-run setup screens.

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
