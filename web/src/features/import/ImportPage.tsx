// /spaces/import: an archive imported into a new space (design §8.4, §12.10), the way a space moves from another
// instance. Choose the file (checked here first, archiveFile.ts) and name the space (the archive's name by
// default); Continue creates the space, `importing` and owned by the importer alone, and sends the file for
// analysis; the mapping step (MappingStep) decides who each person the archive names becomes here; Import sends
// the file again with the mapping, and the result offers to invite the people who are not members yet. The space
// waits as `importing` until then: `?space=<id>` continues it (/spaces links there), and Discard deletes it at
// once. Another file can be tried in the same space.

import { ArrowRight, Trash2, Upload } from 'lucide-react';
import { useReducer, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { LIMITS } from '@shared/constants';
import { spaceUpdateInput } from '@shared/schemas';
import type { ImportAnalysisDTO, ImportResultDTO, SpaceSummaryDTO } from '@shared/types';
import { useAuthStatus } from '../../api/auth';
import { useAnalyzeImport, useCommitImport, useCreateImportSpace, useDiscardImport } from '../../api/importExport';
import { rememberLastSpace, spaceLink } from '../../app/space';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button, ButtonLink, EmptyState, Field, Input, apiFieldErrors, toast, useConfirm } from '../../components/ui';
import { useDocumentTitle } from '../../lib/hooks';
import { SettingsCard } from '../settings/SettingsBlocks';
import { ArchiveCheckView, ArchiveFilePicker, ProblemAlert, type SelectedArchive } from './ArchiveFileField';
import { failureTitle, importFailure, type ImportFailure } from './importResult';
import { ImportResultView } from './ImportResultView';
import { importFit, mappingInput, mappingReducer, unmappedUsers } from './mapping';
import { MappingStep } from './MappingStep';

export default function ImportPage() {
  useDocumentTitle('Import a space');
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const status = useAuthStatus().data;
  const createSpace = useCreateImportSpace();
  const analyze = useAnalyzeImport();
  const commit = useCommitImport();
  const discard = useDiscardImport();

  // The space waiting for this import (?space=): one the account owns that is still being imported. A commit or a
  // discard changes the auth status before its answer arrives: until then, the page keeps the space it showed.
  const spaceParam = params.get('space');
  const found = spaceParam ? (status?.spaces.find((s) => s.id === spaceParam && s.status === 'importing' && s.role === 'owner') ?? null) : null;
  const lastFound = useRef<SpaceSummaryDTO | null>(null);
  if (found) lastFound.current = found;
  const space = found ?? (commit.isPending || discard.isPending ? lastFound.current : null);

  const [selected, setSelected] = useState<SelectedArchive | null>(null);
  const [name, setName] = useState('');
  // Typed by the person: another archive's name no longer replaces it.
  const [nameTyped, setNameTyped] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();
  const [analysis, setAnalysis] = useState<ImportAnalysisDTO | null>(null);
  const [choices, dispatch] = useReducer(mappingReducer, new Map());
  const [skipActivity, setSkipActivity] = useState(false);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [done, setDone] = useState<{ id: string; name: string; result: ImportResultDTO } | null>(null);
  const busy = createSpace.isPending || analyze.isPending || commit.isPending || discard.isPending;

  const choose = (next: SelectedArchive | null) => {
    setSelected(next);
    setAnalysis(null);
    setFailure(null);
    // The archive's name, unless one was typed.
    if (next?.check.ok && !nameTyped) setName(next.check.summary.spaceName ?? '');
  };

  const start = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected?.check.ok || busy) return;
    setFailure(null);
    let target = space;
    if (!target) {
      const parsed = spaceUpdateInput.safeParse({ name });
      if (!parsed.success) return setNameError(parsed.error.issues[0]?.message ?? 'Required');
      try {
        target = await createSpace.mutateAsync(parsed.data.name);
      } catch (err) {
        const field = apiFieldErrors(err).name;
        if (field) setNameError(field);
        else setFailure(importFailure(err));
        return;
      }
      // A reload, or /spaces, continues in this space.
      setParams({ space: target.id }, { replace: true });
    }
    try {
      const res = await analyze.mutateAsync({ spaceId: target.id, mode: 'new', file: selected.file });
      dispatch({ type: 'reset', analysis: res });
      setSkipActivity(false);
      setAnalysis(res);
    } catch (err) {
      setFailure(importFailure(err));
    }
  };

  const runImport = async () => {
    if (!space || !selected || !analysis || busy) return;
    setFailure(null);
    try {
      const result = await commit.mutateAsync({ spaceId: space.id, mode: 'new', file: selected.file, mapping: mappingInput(analysis, choices, skipActivity) });
      setDone({ id: space.id, name: space.name, result });
      setParams({}, { replace: true });
    } catch (err) {
      setFailure(importFailure(err));
    }
  };

  const discardImport = async () => {
    if (!space) return;
    const ok = await confirm({
      title: `Discard the import into ${space.name}?`,
      body: 'The space is deleted at once. The archive file is not changed.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      await discard.mutateAsync(space.id);
      toast.success(`Discarded the import into ${space.name}`);
      void navigate('/spaces');
    } catch (err) {
      toast.error(err);
    }
  };

  const header = <PageHeader title="Import a space" icon={<Upload aria-hidden />} backTo="/spaces" />;

  if (done) {
    const open = () => {
      rememberLastSpace(done.id);
      void navigate(spaceLink(done.id, '/'));
    };
    return (
      <Page width="narrow" header={header}>
        <SettingsCard title={`Imported ${done.name}`}>
          <ImportResultView
            spaceId={done.id}
            spaceName={done.name}
            result={done.result}
            replaced={false}
            actions={
              <Button variant="primary" trailingIcon={<ArrowRight aria-hidden />} onClick={open}>
                Open {done.name}
              </Button>
            }
          />
        </SettingsCard>
      </Page>
    );
  }

  if (spaceParam && status && !space) {
    return (
      <Page width="narrow" header={header}>
        <EmptyState
          icon={<Upload />}
          title="This import is not waiting any more"
          body="It was finished or discarded, or the space is not yours. Your spaces are listed on the Spaces page."
          action={<ButtonLink to="/spaces">Spaces</ButtonLink>}
        />
      </Page>
    );
  }

  const unmapped = analysis ? unmappedUsers(analysis, choices) : [];
  const fit = analysis ? importFit(analysis.estimate, skipActivity) : null;
  // Once Continue has made the space (?space= is set before the analysis), a refusal leaves it waiting.
  const refusedTitle = failure ? failureTitle(space?.name ?? (spaceParam ? 'The new space' : null), failure) : '';

  return (
    <Page width="narrow" header={header}>
      <div className="flex flex-col gap-5">
        <SettingsCard
          title="Archive"
          description={
            space
              ? `Importing into ${space.name}, which waits until the import is done.${selected ? '' : ' Choose the archive to import.'}`
              : 'A space archive from Settings → Data → Download space archive, on this instance or another, or an export of Lyren Plan 1.x (.json). The archive becomes a new space of yours.'
          }
          actions={
            space ? (
              <Button size="sm" variant="ghost" icon={<Trash2 aria-hidden />} onClick={() => void discardImport()} loading={discard.isPending} disabled={busy}>
                Discard
              </Button>
            ) : undefined
          }
        >
          <form className="flex flex-col gap-4" onSubmit={(e) => void start(e)} noValidate>
            <ArchiveFilePicker selected={selected} onSelect={choose} disabled={busy} />
            {selected && <ArchiveCheckView check={selected.check} />}
            {selected?.check.ok && !space && (
              <Field label="Name of the new space" error={nameError}>
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameTyped(true);
                    if (nameError) setNameError(undefined);
                  }}
                  maxLength={LIMITS.spaceNameMax}
                  disabled={busy}
                />
              </Field>
            )}
            {failure && !analysis && <ProblemAlert title={refusedTitle} message={failure.message} problems={failure.problems} />}
            {selected?.check.ok && !analysis && (
              <div className="flex justify-end">
                <Button type="submit" variant="primary" trailingIcon={<ArrowRight aria-hidden />} loading={createSpace.isPending || analyze.isPending}>
                  Continue
                </Button>
              </div>
            )}
          </form>
        </SettingsCard>

        {analysis && space && (
          <SettingsCard title="Import" description={`Everything in the archive goes into ${space.name}. You become its owner; nobody else is added.`}>
            <div className="flex flex-col gap-4">
              <MappingStep
                analysis={analysis}
                choices={choices}
                onChoose={(archiveId, target) => dispatch({ type: 'choose', archiveId, target })}
                skipActivity={skipActivity}
                onSkipActivity={setSkipActivity}
                disabled={busy}
              />
              {failure && <ProblemAlert title={refusedTitle} message={failure.message} problems={failure.problems} />}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="primary"
                  icon={<Upload aria-hidden />}
                  loading={commit.isPending}
                  disabled={unmapped.length > 0 || !fit?.fits}
                  onClick={() => void runImport()}
                >
                  Import
                </Button>
              </div>
            </div>
          </SettingsCard>
        )}
      </div>
    </Page>
  );
}
