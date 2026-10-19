// Choosing an import file and what its quick check found (design §12.10; archiveFile.ts): the file button, the
// name and size of the chosen file, then either what was wrong with it or what it holds. Shared by the import
// into a new space (/spaces/import) and Replace this space (Settings → Data).

import { FileUp, TriangleAlert } from 'lucide-react';
import { useState, type ChangeEvent } from 'react';
import { useAuthStatus } from '../../api/auth';
import { buttonClasses, Spinner } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { readImportFile, sizeText, type ArchiveCheck, type ArchiveSummary } from './archiveFile';

export interface SelectedArchive {
  file: File;
  check: ArchiveCheck;
}

/** The file button and the chosen file; `onSelect(null)` when the choice is cleared. */
export function ArchiveFilePicker({
  selected,
  onSelect,
  disabled,
}: {
  selected: SelectedArchive | null;
  onSelect: (selected: SelectedArchive | null) => void;
  disabled?: boolean;
}) {
  const maxBytes = useAuthStatus().data?.instance.limits.importMaxBytes ?? null;
  const [reading, setReading] = useState(false);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // The same file chosen again after a change on disk is read again.
    e.target.value = '';
    if (!file) return;
    setReading(true);
    try {
      onSelect({ file, check: await readImportFile(file, maxBytes) });
    } finally {
      setReading(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      {/* Keyboard focus lands on the visually hidden input: draw the ring on the label. */}
      <label
        className={buttonClasses({
          className:
            'cursor-pointer has-[:disabled]:pointer-events-none has-[:disabled]:opacity-50 ' +
            'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus has-[:focus-visible]:outline-solid',
        })}
      >
        <FileUp aria-hidden className="size-4" />
        {selected ? 'Choose another file' : 'Choose archive'}
        <input
          type="file"
          accept=".gz,.json,application/gzip,application/json"
          className="sr-only"
          disabled={disabled || reading}
          onChange={(e) => void onFile(e)}
        />
      </label>
      {reading && <Spinner size="sm" label="Reading file" />}
      {selected && !reading && (
        <span className="min-w-0 truncate text-[13px] text-fg-muted">
          {selected.file.name} · {sizeText(selected.file.size)}
        </span>
      )}
    </div>
  );
}

/** A refusal with the problems it lists (the file's check, or the server's answer). */
export function ProblemAlert({ title, message, problems }: { title?: string; message: string; problems: readonly string[] }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] text-fg">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        <p className={title ? 'mt-0.5 break-words' : 'font-medium break-words'}>{message}</p>
        {problems.length > 0 && (
          <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-4 break-words text-fg-muted">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** What a file holds: when and where it was exported, and the rows of each table. */
export function ArchiveSummaryView({ summary }: { summary: ArchiveSummary }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-fg-muted">
        {summary.version === 2 ? (
          <>
            A space archive of <span className="font-medium text-fg">{summary.spaceName}</span>, exported {formatDateTime(summary.exportedAt)} from
            Lyren Plan <span className="font-mono">{summary.appVersion}</span>.
          </>
        ) : (
          <>
            An export of Lyren Plan <span className="font-mono">{summary.appVersion}</span>, made {formatDateTime(summary.exportedAt)}. It names no
            people: everything in it becomes yours.
          </>
        )}
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
        {summary.counts.map((c) => (
          <div key={c.key} className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1">
            <dt className="text-fg-muted">{c.label}</dt>
            <dd className="font-medium tabular-nums text-fg">{c.count.toLocaleString()}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The check's answer: its refusal, or the summary. */
export function ArchiveCheckView({ check }: { check: ArchiveCheck }) {
  return check.ok ? <ArchiveSummaryView summary={check.summary} /> : <ProblemAlert message={check.error} problems={check.problems} />;
}
