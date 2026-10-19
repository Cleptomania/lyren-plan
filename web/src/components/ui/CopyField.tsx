// A value to hand on (an invitation link, a reset link): shown whole in a read-only field, selected on
// focus, with a copy button that confirms in place. Works on plain-HTTP instances too (lib/clipboard.ts).

import { clsx } from 'clsx';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { copyText } from '../../lib/clipboard';
import { Button } from './Button';
import { CONTROL_HEIGHTS, CONTROL_SURFACE } from './controlStyles';
import { toast } from './Toast';

export interface CopyFieldProps {
  value: string;
  /** What is copied, for the field's and the button's labels ("invitation link"). */
  label: string;
  className?: string;
}

export function CopyField({ value, label, className }: CopyFieldProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div className={clsx('flex min-w-0 items-center gap-2', className)}>
      <input
        readOnly
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
        className={clsx('block w-full min-w-0 px-3 font-mono text-xs', CONTROL_HEIGHTS.md, CONTROL_SURFACE)}
      />
      <Button
        icon={copied ? <Check className="text-success" /> : <Copy />}
        aria-label={copied ? 'Copied' : `Copy ${label}`}
        onClick={() =>
          void copyText(value).then(
            () => setCopied(true),
            () => toast.error('Could not copy — select the text and copy it manually'),
          )
        }
        className="shrink-0"
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
