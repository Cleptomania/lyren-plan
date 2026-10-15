// Settings → Data: JSON export, SQLite backup download, JSON import (replaces everything after
// a typed confirmation; the server writes a safety snapshot first) and notes on the data folder,
// backups and password resets for the distribution that serves the client (SelfHostingNotes).

import { CircleCheck, DatabaseBackup, FileJson, FileUp, TriangleAlert, Upload, X } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { localToday } from '@shared/dates';
import type { ExportDTO } from '@shared/types';
import { BACKUP_SQLITE_URL, EXPORT_JSON_URL, useImportData } from '../../api/admin';
import { useBootstrap, useLookups } from '../../api/bootstrap';
import { ApiError } from '../../api/client';
import { Button, IconButton, Spinner, buttonClasses, toast, useConfirm } from '../../components/ui';
import { formatDateTime, pluralize } from '../../lib/format';
import { checkImportFile, type ImportCheck } from './importFile';
import { Path, SelfHostingNotes, selfHostingTitle } from './SelfHostingNotes';
import { SettingsCard, SettingsPage } from './SettingsBlocks';

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type Selected = { file: File; check: ImportCheck };

/** `desktop`: served by the single-file desktop app, which has a data folder rather than a server. */
function ImportCard({ desktop }: { desktop: boolean }) {
  const importData = useImportData();
  const confirm = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [done, setDone] = useState<{ backupFile: string; projects: number; tasks: number } | null>(null);

  const reset = () => {
    setSelected(null);
    setServerProblems([]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setServerProblems([]);
    setDone(null);
    if (!file) return setSelected(null);
    setReading(true);
    try {
      const text = await file.text();
      setSelected({ file, check: checkImportFile(text) });
    } catch {
      setSelected({ file, check: { ok: false, error: 'The file could not be read.', problems: [] } });
    } finally {
      setReading(false);
    }
  };

  const runImport = async () => {
    if (!selected?.check.ok) return;
    const { summary, payload } = selected.check;
    const tasks = summary.counts.find((c) => c.key === 'tasks')?.count ?? 0;
    const projects = summary.counts.find((c) => c.key === 'projects')?.count ?? 0;
    const ok = await confirm({
      title: 'Replace all data?',
      body: (
        <>
          Every project, task, comment, tag, status, board and setting {desktop ? 'in Lyren Plan' : 'on this server'} is replaced
          with the contents of <span className="font-medium text-fg">{selected.file.name}</span> ({pluralize(projects, 'project')},{' '}
          {pluralize(tasks, 'task')}). Your account and sign-ins are kept. A safety backup is saved{' '}
          {desktop ? 'in the data folder' : 'on the server'} first.
        </>
      ),
      confirmLabel: 'Replace everything',
      danger: true,
      typeToConfirm: 'REPLACE',
    });
    if (!ok) return;
    // The client checked the shape with exportSchema; the server validates it again.
    importData.mutate(payload as ExportDTO, {
      onSuccess: (res) => {
        reset();
        const projects = res.counts.projects ?? 0;
        const tasks = res.counts.tasks ?? 0;
        setDone({ backupFile: res.backupFile, projects, tasks });
        toast.success(`Import complete: ${pluralize(projects, 'project')}, ${pluralize(tasks, 'task')}. A safety backup was saved.`, {
          durationMs: 8000,
        });
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 413) {
          toast.error(`The file is larger than ${desktop ? 'Lyren Plan' : 'the server'} accepts (IMPORT_BODY_LIMIT).`);
          return;
        }
        if (err instanceof ApiError) setServerProblems(err.details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)));
        toast.error(err);
      },
    });
  };

  const check = selected?.check;
  return (
    <SettingsCard
      title="Import from JSON"
      description="Restore a Lyren Plan JSON export. This replaces all current data except user accounts."
    >
      <div className="flex flex-col gap-4">
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
            {selected ? 'Choose another file' : 'Choose export file'}
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              disabled={importData.isPending}
              onChange={(e) => void onFile(e)}
            />
          </label>
          {reading && <Spinner size="sm" label="Reading file" />}
          {selected && !reading && (
            <span className="min-w-0 truncate text-[13px] text-fg-muted">
              {selected.file.name} · {(selected.file.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB
            </span>
          )}
        </div>

        {done && (
          <div role="status" className="flex gap-2.5 rounded-md border border-success/30 bg-success-soft p-3 text-[13px] text-fg">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                Imported {pluralize(done.projects, 'project')} and {pluralize(done.tasks, 'task')}.
              </p>
              <p className="mt-0.5 text-fg-muted">
                Your previous data was saved {desktop ? '' : 'on the server '}as <Path>{done.backupFile}</Path> in the data{' '}
                {desktop ? 'folder' : 'directory'}. Restore it like any backup (see below) if you need to undo the import.
              </p>
            </div>
            <IconButton aria-label="Dismiss" icon={<X />} size="sm" className="-my-1 -mr-1" onClick={() => setDone(null)} />
          </div>
        )}

        {check && !check.ok && (
          <div role="alert" className="flex gap-2.5 rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] text-fg">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="font-medium">{check.error}</p>
              {check.problems.length > 0 && (
                <ul className="mt-1 list-disc pl-4 break-words text-fg-muted">
                  {check.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {check?.ok && (
          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <p className="text-[13px] text-fg-muted">
              Exported {formatDateTime(check.summary.exportedAt)} from Lyren Plan{' '}
              <span className="font-mono">{check.summary.appVersion}</span>. The file contains:
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              {check.summary.counts.map((c) => (
                <div key={c.key} className="flex items-baseline justify-between gap-2 border-b border-border/60 pb-1">
                  <dt className="text-fg-muted">{c.label}</dt>
                  <dd className="font-medium tabular-nums text-fg">{c.count.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
            {serverProblems.length > 0 && (
              <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px]">
                <p className="font-medium text-fg">{desktop ? 'Lyren Plan' : 'The server'} rejected this file. Nothing was changed.</p>
                <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-4 break-words text-fg-muted">
                  {serverProblems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button onClick={reset} disabled={importData.isPending}>
                Cancel
              </Button>
              <Button variant="danger" icon={<Upload aria-hidden />} loading={importData.isPending} onClick={() => void runImport()}>
                Replace all data…
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DataSettings() {
  const { user } = useLookups();
  // Set only by the single-file desktop app (BootstrapDTO.desktop).
  const desktop = useBootstrap().data?.desktop;
  return (
    <SettingsPage
      title="Data"
      description={
        desktop
          ? 'Your data lives in a single SQLite database on the computer that runs Lyren Plan. Take it with you any time.'
          : 'Your data lives in a single SQLite database on your server. Take it with you any time.'
      }
    >
      <SettingsCard
        title="Export as JSON"
        description="Everything except user accounts, in a documented format you can re-import here."
        actions={
          <a href={EXPORT_JSON_URL} download className={buttonClasses()}>
            <FileJson aria-hidden className="size-4" />
            Export JSON
          </a>
        }
      />
      <SettingsCard
        title="Download a database backup"
        description={
          desktop
            ? 'A consistent snapshot of the SQLite database (sign-in sessions removed). Restore it as described below.'
            : 'A consistent snapshot of the SQLite database (sign-in sessions removed). Restore it on the server as described below.'
        }
        actions={
          <a href={BACKUP_SQLITE_URL} download className={buttonClasses()}>
            <DatabaseBackup aria-hidden className="size-4" />
            Download backup
          </a>
        }
      />
      <ImportCard desktop={desktop !== undefined} />
      <SettingsCard title={selfHostingTitle(desktop)}>
        <SelfHostingNotes username={user.username} desktop={desktop} today={localToday()} />
      </SettingsCard>
    </SettingsPage>
  );
}
