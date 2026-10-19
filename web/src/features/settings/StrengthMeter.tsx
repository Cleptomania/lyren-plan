// The strength hint under a new password (passwordStrength.ts): four bars and a sentence, read out as
// they change. Account settings → Security and the public pages that set a password (sign-up, reset,
// invitations) share it.

import { clsx } from 'clsx';
import { passwordStrength } from './passwordStrength';

const STRENGTH_COLORS = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'] as const;

/** `min`: the instance's minimum length (AuthStatusDTO.instance.passwordMinLength). */
export function StrengthMeter({ password, min }: { password: string; min: number }) {
  const s = passwordStrength(password, min);
  return (
    <div className="flex flex-col gap-1.5" aria-live="polite">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={clsx('h-1 flex-1 rounded-full transition-colors', password && s.score >= i ? STRENGTH_COLORS[s.score] : 'bg-surface-3')}
          />
        ))}
      </div>
      <p className="text-xs text-fg-muted">
        {s.label && <span className="font-medium text-fg">{s.label}. </span>}
        {s.hint}
      </p>
    </div>
  );
}
