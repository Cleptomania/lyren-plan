// Settings → Data → Replace this space (owners; design §8.4, §8.8, §12.10): an archive's content in place of
// everything in the space but its members. Choose the file (checked here first); Continue asks for the re-auth
// window and sends it for analysis; the mapping step (MappingStep) decides who each person the archive names
// becomes; "Replace …" asks for REPLACE to be typed and sends the file again with the mapping. The way back is
// Node's snapshot, which the result names with the command that undoes the import; Cloudflare keeps none, so
// "Download the current data first" must have started before Replace enables there (§8.8), for each analysis:
// a second replace from the same page needs a download of what the first one wrote.

import { CircleCheck, Download, Upload } from 'lucide-react';
import { useReducer, useState } from 'react';
import type { ImportAnalysisDTO, ImportResultDTO } from '@shared/types';
import { useAuthStatus } from '../../api/auth';
import { exportUrl, useAnalyzeImport, useCommitImport } from '../../api/importExport';
import { useSpace } from '../../app/space';
import { Button, useConfirm } from '../../components/ui';
import { ensureReauth } from '../account/ReauthDialog';
import { startDownload } from '../settings/download';
import { SettingsCard } from '../settings/SettingsBlocks';
import { ArchiveCheckView, ArchiveFilePicker, ProblemAlert, type SelectedArchive } from './ArchiveFileField';
import { importFailure, replaceFailureTitle, type ImportFailure } from './importResult';
import { ImportResultView } from './ImportResultView';
import { importFit, mappingInput, mappingReducer, replaceReady, unmappedUsers } from './mapping';
import { MappingStep } from './MappingStep';

export function ReplaceSpace() {
  const space = useSpace();
  const instance = useAuthStatus().data?.instance;
  const desktop = useAuthStatus().data?.desktop !== undefined;
  // Without a snapshot on the server (Cloudflare), the download is the way back.
  const needsDownload = instance?.runtime === 'cloudflare';
  const confirm = useConfirm();
  const analyze = useAnalyzeImport();
  const commit = useCommitImport();
  const [selected, setSelected] = useState<SelectedArchive | null>(null);
  const [analysis, setAnalysis] = useState<ImportAnalysisDTO | null>(null);
  const [choices, dispatch] = useReducer(mappingReducer, new Map());
  const [skipActivity, setSkipActivity] = useState(false);
  // The analysis the download of the current data was started for: each replace needs its own, of the data in the
  // space then (a finished replace, or another file analyzed, asks for a new one).
  const [downloadedFor, setDownloadedFor] = useState<ImportAnalysisDTO | null>(null);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [result, setResult] = useState<ImportResultDTO | null>(null);
  const busy = analyze.isPending || commit.isPending;

  const choose = (next: SelectedArchive | null) => {
    setSelected(next);
    setAnalysis(null);
    setFailure(null);
    setResult(null);
  };

  const check = async () => {
    if (!selected?.check.ok || busy || !(await ensureReauth())) return;
    setFailure(null);
    try {
      const res = await analyze.mutateAsync({ spaceId: space.id, mode: 'replace', file: selected.file });
      dispatch({ type: 'reset', analysis: res });
      setSkipActivity(false);
      setAnalysis(res);
    } catch (err) {
      setFailure(importFailure(err));
    }
  };

  const downloadFirst = async () => {
    const shown = analysis;
    if (!shown || !(await ensureReauth())) return;
    startDownload(exportUrl(space.id));
    setDownloadedFor(shown);
  };

  const replace = async () => {
    if (!selected || !analysis || busy) return;
    const ok = await confirm({
      title: `Replace everything in ${space.name}?`,
      body: (
        <>
          Every project, task, comment, work log, activity entry, tag, status, board and setting of{' '}
          <span className="font-medium text-fg">{space.name}</span> is replaced with the contents of{' '}
          <span className="font-medium text-fg">{selected.file.name}</span>. Its members, your other spaces and every account are kept.{' '}
          {needsDownload
            ? 'This instance keeps no copy of the current data: the archive you downloaded is the way back.'
            : `A copy of the current data is saved ${desktop ? 'in the backups folder next to the database' : 'on the server'} first.`}
        </>
      ),
      confirmLabel: 'Replace everything',
      danger: true,
      typeToConfirm: 'REPLACE',
    });
    if (!ok || !(await ensureReauth())) return;
    setFailure(null);
    try {
      const res = await commit.mutateAsync({ spaceId: space.id, mode: 'replace', file: selected.file, mapping: mappingInput(analysis, choices, skipActivity) });
      setSelected(null);
      setAnalysis(null);
      setResult(res);
    } catch (err) {
      setFailure(importFailure(err));
    }
  };

  const fit = analysis ? importFit(analysis.estimate, skipActivity) : null;
  const downloaded = analysis !== null && downloadedFor === analysis;
  const ready =
    analysis !== null && replaceReady({ mapped: unmappedUsers(analysis, choices).length === 0, fits: fit?.fits ?? false, needsDownload, downloaded });

  return (
    <SettingsCard
      title="Replace this space"
      description={`Put an archive’s content in place of everything in ${space.name} except its members. The people the archive names are matched to accounts first.`}
    >
      <div className="flex flex-col gap-4">
        {result && (
          <ImportResultView
            spaceId={space.id}
            spaceName={space.name}
            result={result}
            replaced
            actions={<Button onClick={() => setResult(null)}>Done</Button>}
          />
        )}
        {!result && (
          <>
            <ArchiveFilePicker selected={selected} onSelect={choose} disabled={busy} />
            {selected && <ArchiveCheckView check={selected.check} />}
            {failure && !analysis && <ProblemAlert title={replaceFailureTitle(failure, false)} message={failure.message} problems={failure.problems} />}
            {selected?.check.ok && !analysis && (
              <div className="flex justify-end">
                <Button variant="primary" loading={analyze.isPending} onClick={() => void check()}>
                  Continue
                </Button>
              </div>
            )}
          </>
        )}
        {analysis && (
          <>
            <MappingStep
              analysis={analysis}
              choices={choices}
              onChoose={(archiveId, target) => dispatch({ type: 'choose', archiveId, target })}
              skipActivity={skipActivity}
              onSkipActivity={setSkipActivity}
              disabled={busy}
            />
            <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-[13px] sm:flex-row sm:items-center sm:gap-3">
              <p className="min-w-0 flex-1 text-fg-muted">
                {needsDownload
                  ? 'This instance keeps no copy of the space before an import. Download the current data first: that archive is the way back.'
                  : `A copy of the current data is saved ${desktop ? 'in the backups folder' : 'on the server'} before anything is replaced. A download of your own does no harm.`}
              </p>
              {downloaded ? (
                <span role="status" className="flex shrink-0 items-center gap-1.5 text-fg">
                  <CircleCheck aria-hidden className="size-4 text-success" />
                  Download started
                </span>
              ) : (
                <Button size="sm" icon={<Download aria-hidden />} className="self-start sm:self-auto" onClick={() => void downloadFirst()}>
                  Download the current data first
                </Button>
              )}
            </div>
            {failure && <ProblemAlert title={replaceFailureTitle(failure, true)} message={failure.message} problems={failure.problems} />}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button onClick={() => choose(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" icon={<Upload aria-hidden />} loading={commit.isPending} disabled={!ready} onClick={() => void replace()}>
                Replace this space…
              </Button>
            </div>
          </>
        )}
      </div>
    </SettingsCard>
  );
}
