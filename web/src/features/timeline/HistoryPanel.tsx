// Task history: the task's own activity (oldest → newest) as sentences, with consecutive
// edits by the same person within a few minutes grouped together (an imported run says who imported
// it). Shows the latest 20.

import { History } from 'lucide-react';
import { useState } from 'react';
import type { ActivityDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { UserAvatar } from '../../components/domain';
import { Button, SkeletonList } from '../../components/ui';
import { pluralize } from '../../lib/format';
import { groupActivityRuns, type ActivityRun } from './activityGroups';
import { activityPhrases, actorName, type ActivityTextLookups } from './activityText';
import { ImportedNote } from './ImportedNote';
import { RelativeTime } from './RelativeTime';

export const HISTORY_INITIAL = 20;

export interface HistoryPanelProps {
  /** Oldest first; undefined while loading. */
  entries: ActivityDTO[] | undefined;
}

export function HistoryPanel({ entries }: HistoryPanelProps) {
  const lookups = useLookups();
  const [showAll, setShowAll] = useState(false);

  if (entries === undefined) return <SkeletonList rows={3} />;
  if (entries.length === 0) {
    return (
      <div className="flex items-center gap-2 py-3 text-sm text-fg-muted">
        <History aria-hidden className="size-4 text-fg-subtle" />
        No changes recorded yet.
      </div>
    );
  }

  const visible = showAll ? entries : entries.slice(-HISTORY_INITIAL);
  const hidden = entries.length - visible.length;
  const runs = groupActivityRuns(visible);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {hidden > 0 && (
        <Button size="sm" variant="ghost" icon={<History />} onClick={() => setShowAll(true)} className="self-start">
          Show all ({pluralize(hidden, 'earlier change')})
        </Button>
      )}
      <ol aria-label="Task history" className="flex min-w-0 flex-col">
        {runs.map((run) => (
          <HistoryRun key={run.key} run={run} lookups={lookups} />
        ))}
      </ol>
    </div>
  );
}

function HistoryRun({ run, lookups }: { run: ActivityRun; lookups: ActivityTextLookups }) {
  const phrases = run.entries.flatMap((e) => activityPhrases(e, lookups).map((text, i) => ({ key: `${e.id}.${i}`, text })));
  const first = run.entries[0]!;
  const name = actorName(first);
  const time = <RelativeTime iso={run.lastAt} className="text-fg-subtle" />;
  // A run is one person's: an imported one says who imported it (design §8.6).
  const imported = <ImportedNote entry={{ author: run.actor, importedBy: first.importedBy, importedAt: first.importedAt }} className="mt-0.5" />;

  return (
    <li className="flex min-w-0 gap-2.5 py-1.5">
      <UserAvatar user={run.actor} size="xs" className="mt-0.5" />
      {phrases.length === 1 ? (
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13px] leading-5 text-fg-muted">
            <span className="font-medium text-fg">{name}</span> {phrases[0]!.text} <span aria-hidden>·</span> {time}
          </p>
          {imported}
        </div>
      ) : (
        <div className="min-w-0 flex-1 text-[13px] leading-5">
          <p className="text-fg-muted">
            <span className="font-medium text-fg">{name}</span> <span aria-hidden>·</span> {time}
          </p>
          <ul className="mt-0.5 flex list-disc flex-col gap-0.5 pl-4 text-fg-muted marker:text-fg-subtle">
            {phrases.map((p) => (
              <li key={p.key} className="break-words">
                {p.text}
              </li>
            ))}
          </ul>
          {imported}
        </div>
      )}
    </li>
  );
}
