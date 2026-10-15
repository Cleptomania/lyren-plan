// A rough, dependency-free password strength hint (length first, variety second, obvious
// patterns penalised). It only guides; the server enforces the minimum length.

import { LIMITS } from '@shared/constants';

export type StrengthScore = 0 | 1 | 2 | 3 | 4;

export interface PasswordStrength {
  score: StrengthScore;
  /** '' for an empty password. */
  label: '' | 'Too short' | 'Weak' | 'Fair' | 'Good' | 'Strong';
  hint: string;
}

const COMMON = /password|passwort|qwerty|azerty|letmein|welcome|iloveyou|admin|lyren|123456|abcdef/i;

function isSequential(pw: string): boolean {
  if (pw.length < 4) return false;
  const codes = [...pw].map((ch) => ch.codePointAt(0)!);
  const step = codes[1]! - codes[0]!;
  return Math.abs(step) <= 1 && codes.every((code, i) => i === 0 || code - codes[i - 1]! === step);
}

export function passwordStrength(pw: string): PasswordStrength {
  if (pw.length === 0) return { score: 0, label: '', hint: `Use at least ${LIMITS.passwordMin} characters.` };
  if (pw.length < LIMITS.passwordMin) {
    return { score: 0, label: 'Too short', hint: `Use at least ${LIMITS.passwordMin} characters.` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const unique = new Set(pw).size;
  let score = pw.length >= 20 ? 4 : pw.length >= 16 ? 3 : pw.length >= 12 ? 2 : 1;
  if (classes >= 3 && score < 4) score += 1;
  if (COMMON.test(pw) || isSequential(pw) || unique <= 3) score = 1;
  const s = score as StrengthScore;
  const label = s >= 4 ? 'Strong' : s === 3 ? 'Good' : s === 2 ? 'Fair' : 'Weak';
  const hint =
    s >= 3
      ? 'Nice — hard to guess.'
      : COMMON.test(pw) || isSequential(pw) || unique <= 3
        ? 'Avoid common words and simple patterns.'
        : 'Longer is stronger: try a passphrase of a few unrelated words.';
  return { score: s, label, hint };
}
