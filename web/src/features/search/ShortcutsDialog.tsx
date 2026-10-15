// Keyboard shortcuts help ('?') — lazy chunk of CommandPalette.tsx. Lists SHORTCUT_GROUPS with
// platform-specific key labels (⌘ on Apple devices, Ctrl elsewhere) and spoken names for
// screen readers. Keys are shown on touch devices too (tablets with keyboards).

import { Fragment, useId } from 'react';
import { Dialog, isApplePlatform, Kbd } from '../../components/ui';
import { formatShortcutKeys } from '../../components/ui/shortcuts';
import { SHORTCUT_GROUPS, spokenCombo, type ShortcutEntry } from './shortcutList';

export interface ShortcutsDialogProps {
  open: boolean;
  onClose: () => void;
}

export default function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const apple = isApplePlatform();
  const baseId = useId();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Work faster without leaving the keyboard."
      size="lg"
    >
      <div className="grid gap-x-8 gap-y-6 pb-2 md:grid-cols-2">
        {SHORTCUT_GROUPS.map((group, gi) => {
          const headingId = `${baseId}-${gi}`;
          return (
            <section key={group.title} aria-labelledby={headingId} className="min-w-0">
              <h3 id={headingId} className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                {group.title}
              </h3>
              {group.note && <p className="mt-1 text-xs text-fg-muted">{group.note}</p>}
              <dl className="mt-2 divide-y divide-border">
                {group.items.map((item) => (
                  <div key={item.label} className="flex min-h-10 items-center justify-between gap-4 py-1.5">
                    <dt className="min-w-0 text-sm text-fg">{item.label}</dt>
                    <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                      <Keys entry={item} apple={apple} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}

function Keys({ entry, apple }: { entry: ShortcutEntry; apple: boolean }) {
  const spoken = entry.combos.map((c) => spokenCombo(c, apple)).join(entry.together ? ', ' : ' or ');
  return (
    <>
      <span className="sr-only">{spoken}</span>
      <span aria-hidden className="flex flex-wrap items-center justify-end gap-1">
        {entry.combos.map((combo, i) => (
          <Fragment key={combo}>
            {i > 0 && !entry.together && <span className="px-0.5 text-xs text-fg-subtle">or</span>}
            <span className="inline-flex items-center gap-0.5">
              {formatShortcutKeys(combo, apple).map((key, k) => (
                <Kbd key={k}>{key}</Kbd>
              ))}
            </span>
          </Fragment>
        ))}
      </span>
    </>
  );
}
