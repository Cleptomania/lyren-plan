// /spaces: the account's spaces (design §12.2, §12.9): the invitations to its address (PendingInvitations),
// the list with the account's role and the member count, creating a space (with sample data if wanted),
// importing one from an archive (/spaces/import, §12.10), and the recently deleted spaces their owner can still
// restore until the purge date. A space still being imported cannot be opened yet: its row continues the import
// or discards it. `?create=1` (the switcher's "Create space…") opens the create dialog.

import { ArchiveRestore, ChevronRight, LayoutGrid, Plus, Trash2, Upload } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { LIMITS } from '@shared/constants';
import { localToday } from '@shared/dates';
import { spaceCreateInput } from '@shared/schemas';
import type { DeletedSpaceDTO, SpaceSummaryDTO } from '@shared/types';
import { useAuthStatus } from '../../api/auth';
import { errorMessage } from '../../api/client';
import { useDiscardImport } from '../../api/importExport';
import { useCreateSpace, useDeletedSpaces, useRestoreSpace, useSpaces } from '../../api/spaces';
import { ROLE_LABELS } from '../../app/permissions';
import { rememberLastSpace, spaceLink } from '../../app/space';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { SpaceTile } from '../../components/layout/SpaceSwitcher';
import { Badge, Button, ButtonLink, Checkbox, Dialog, EmptyState, Field, Input, Section, SkeletonList, apiFieldErrors, toast, useConfirm, zodFieldErrors } from '../../components/ui';
import { formatDate, isoToLocalDate, pluralize } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { PendingInvitations } from './PendingInvitations';

export default function SpacesPage() {
  useDocumentTitle('Spaces');
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = useAuthStatus().data;
  // The auth status lists the spaces already; the list's own request keeps this page current.
  const spaces = useSpaces();
  const list = spaces.data ?? status?.spaces;
  const deleted = useDeletedSpaces();
  const creating = params.get('create') === '1';
  const setCreating = (open: boolean) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (open) next.set('create', '1');
        else next.delete('create');
        return next;
      },
      { replace: true },
    );

  const create = (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      Create space
    </Button>
  );
  const importSpace = (compact: boolean) => (
    <ButtonLink to="/spaces/import" icon={<Upload aria-hidden />} hideLabelOnMobile={compact}>
      Import a space…
    </ButtonLink>
  );

  return (
    <Page
      width="narrow"
      header={
        <PageHeader
          title="Spaces"
          icon={<LayoutGrid aria-hidden />}
          actions={
            list && list.length > 0 ? (
              <>
                {importSpace(true)}
                {create}
              </>
            ) : undefined
          }
        />
      }
    >
      <div className="flex flex-col gap-8">
        <PendingInvitations />
        {!list ? (
          <SkeletonList rows={3} />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid />}
            title="No spaces yet"
            body="A space holds projects, boards and tasks, and the people who work on them. Create one to start planning, or import one from an archive."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {importSpace(false)}
                {create}
              </div>
            }
          />
        ) : (
          <ul aria-label="Your spaces" className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-card">
            {list.map((s) => (
              <li key={s.id}>
                <SpaceRow space={s} />
              </li>
            ))}
          </ul>
        )}

        {deleted.data && deleted.data.length > 0 && (
          <Section title="Recently deleted" description="You can restore a deleted space until it is removed for good.">
            <ul aria-label="Recently deleted spaces" className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-card">
              {deleted.data.map((s) => (
                <li key={s.id}>
                  <DeletedSpaceRow space={s} />
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>

      <CreateSpaceDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(space) => {
          rememberLastSpace(space.id);
          navigate(spaceLink(space.id, '/'));
        }}
        maxSpaces={status?.instance.limits.maxSpacesPerUser ?? null}
      />
    </Page>
  );
}

function SpaceRow({ space }: { space: SpaceSummaryDTO }) {
  // A space still being imported opens once its import is done: continue it, or discard it.
  if (space.status === 'importing') return <ImportingSpaceRow space={space} />;
  return (
    <Link
      to={spaceLink(space.id, '/')}
      onClick={() => rememberLastSpace(space.id)}
      className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-surface-2"
    >
      <SpaceTile name={space.name} className="size-8 text-xs" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{space.name}</span>
        <span className="block text-xs text-fg-muted">{pluralize(space.memberCount, 'member')}</span>
      </span>
      <Badge variant={space.role === 'viewer' ? 'warning' : 'outline'}>{ROLE_LABELS[space.role]}</Badge>
      <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle" />
    </Link>
  );
}

function ImportingSpaceRow({ space }: { space: SpaceSummaryDTO }) {
  const discard = useDiscardImport();
  const confirm = useConfirm();
  const discardImport = async () => {
    const ok = await confirm({
      title: `Discard the import into ${space.name}?`,
      body: 'The space is deleted at once. The archive file is not changed.',
      confirmLabel: 'Discard',
      danger: true,
    });
    if (!ok) return;
    try {
      // The row leaves the list once the space is gone; the toast does not depend on it.
      await discard.mutateAsync(space.id);
      toast.success(`Discarded the import into ${space.name}`);
    } catch (err) {
      toast.error(err);
    }
  };
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <SpaceTile name={space.name} className="size-8 text-xs opacity-70" />
      {/* The buttons wrap below the name on narrow screens rather than squeezing it. */}
      <span className="min-w-0 flex-[1_1_12rem]">
        <span className="block truncate text-sm font-medium text-fg">{space.name}</span>
        <span className="block text-xs text-fg-muted">Import not finished</span>
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button size="sm" icon={<Trash2 aria-hidden />} loading={discard.isPending} onClick={() => void discardImport()} aria-label={`Discard the import into ${space.name}`}>
          Discard
        </Button>
        <ButtonLink size="sm" variant="primary" to={`/spaces/import?space=${space.id}`} aria-label={`Continue the import into ${space.name}`}>
          Continue
        </ButtonLink>
      </div>
    </div>
  );
}

function DeletedSpaceRow({ space }: { space: DeletedSpaceDTO }) {
  const restore = useRestoreSpace();
  const navigate = useNavigate();
  const today = localToday();
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
      <Trash2 aria-hidden className="size-4 shrink-0 text-fg-subtle" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-fg">{space.name}</span>
        <span className="block text-xs text-fg-muted">
          Deleted {formatDate(isoToLocalDate(space.deletedAt), today)} · removed for good on {formatDate(isoToLocalDate(space.purgeAfter), today)}
        </span>
      </span>
      <Button
        size="sm"
        icon={<ArchiveRestore />}
        loading={restore.isPending}
        onClick={() =>
          restore.mutate(space.id, {
            onSuccess: (restored) =>
              toast.success(`Restored ${restored.name}`, {
                action: {
                  label: 'Open',
                  onClick: () => {
                    rememberLastSpace(restored.id);
                    navigate(spaceLink(restored.id, '/'));
                  },
                },
              }),
            onError: (err) => toast.error(err),
          })
        }
      >
        Restore
      </Button>
    </div>
  );
}

function CreateSpaceDialog({
  open,
  onClose,
  onCreated,
  maxSpaces,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (space: SpaceSummaryDTO) => void;
  /** InstanceInfoDTO.limits.maxSpacesPerUser (null: no limit). */
  maxSpaces: number | null;
}) {
  const createSpace = useCreateSpace();
  const [name, setName] = useState('');
  const [sampleData, setSampleData] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName('');
      setSampleData(false);
      setError(undefined);
      setFailure(null);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = spaceCreateInput.safeParse({ name, createSampleData: sampleData, today: localToday() });
    if (!parsed.success) return setError(zodFieldErrors(parsed.error).name);
    setFailure(null);
    createSpace.mutate(parsed.data, {
      onSuccess: (space) => {
        onClose();
        onCreated(space);
      },
      onError: (err) => {
        const field = apiFieldErrors(err).name;
        if (field) setError(field);
        // A quota or a server problem: said in the dialog, which keeps the name for another try.
        else setFailure(errorMessage(err));
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create space"
      description={
        maxSpaces !== null ? `A space has its own projects, boards and members. You can own up to ${pluralize(maxSpaces, 'space')}.` : 'A space has its own projects, boards and members.'
      }
      size="sm"
      mobileLayout="sheet"
      closeOnOutsideClick={false}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose} disabled={createSpace.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={createSpace.isPending}>
            Create space
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" error={error}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(undefined);
            }}
            maxLength={LIMITS.spaceNameMax}
            placeholder="Team, Home, Client work…"
          />
        </Field>
        <Checkbox
          checked={sampleData}
          onCheckedChange={setSampleData}
          label="Add sample data"
          description="A demo project with tasks, so you can try things out. Delete it whenever you like."
        />
        {failure && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] text-fg">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
