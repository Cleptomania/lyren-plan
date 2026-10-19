// Settings → Tags: search, create, rename / recolor inline (members and up), merge into another tag and
// delete (admins and owners, design §6.2).
// Edits are optimistic through the bootstrap cache (rolled back with an error toast).

import { useQueryClient } from '@tanstack/react-query';
import { GitMerge, MoreHorizontal, Pencil, Plus, Search, Tag as TagIcon, Trash2, X } from 'lucide-react';
import { useDeferredValue, useMemo, useState, type FormEvent } from 'react';
import { LIMITS } from '@shared/constants';
import { tagCreateInput } from '@shared/schemas';
import type { TagDTO } from '@shared/types';
import { useCreateTag, useDeleteTag, useMergeTag, useUpdateTag } from '../../api/spaceAdmin';
import { useLookups } from '../../api/bootstrap';
import { ApiError } from '../../api/client';
import { qk } from '../../api/keys';
import { useSpace, useSpaceId } from '../../app/space';
import { paletteColor } from '../../components/domain';
import {
  Button,
  ColorDot,
  ColorPicker,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  InlineEdit,
  Input,
  Menu,
  PickerList,
  apiFieldErrors,
  toast,
  useConfirm,
  useSheetMode,
  zodFieldErrors,
  type FieldErrors,
} from '../../components/ui';
import { pluralize } from '../../lib/format';
import { ColorButton } from './ColorButton';
import { SettingsPage } from './SettingsBlocks';
import { useOptimisticBootstrap } from './useOptimisticBootstrap';

const fold = (s: string) => s.toLocaleLowerCase();

function matchesQuery(tag: TagDTO, query: string): boolean {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  const name = fold(tag.name);
  return tokens.every((t) => name.includes(t));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface TagItemProps {
  tag: TagDTO;
  onPatch: (tag: TagDTO, input: { name?: string; color?: string }) => void;
  onMerge: (tag: TagDTO) => void;
  onDelete: (tag: TagDTO) => void;
}

function TagItem({ tag, onPatch, onMerge, onDelete }: TagItemProps) {
  const { manageStructure } = useSpace().permissions;
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex min-w-0 items-center gap-1 px-2 py-1.5 md:gap-2">
      <ColorButton value={tag.color} onChange={(color) => onPatch(tag, { color })} label={`Color of “${tag.name}”`} />
      <div className="min-w-0 flex-1">
        <InlineEdit
          value={tag.name}
          onSave={(name) => onPatch(tag, { name })}
          aria-label={`Name of tag “${tag.name}”`}
          maxLength={LIMITS.tagNameMax}
          editing={editing}
          onEditingChange={setEditing}
          className="text-sm font-medium text-fg"
        />
      </div>
      <span className="shrink-0 px-1 text-xs tabular-nums text-fg-muted">{pluralize(tag.taskCount, 'task')}</span>
      <Menu
        label={`Tag “${tag.name}”`}
        trigger={<IconButton aria-label={`Actions for “${tag.name}”`} icon={<MoreHorizontal />} size="sm" />}
        items={[
          { label: 'Rename', icon: <Pencil />, onSelect: () => setEditing(true) },
          manageStructure && { label: 'Merge into…', icon: <GitMerge />, onSelect: () => onMerge(tag) },
          { separator: true },
          manageStructure && { label: 'Delete…', icon: <Trash2 />, danger: true, onSelect: () => onDelete(tag) },
        ]}
      />
    </li>
  );
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

function CreateTagDialog({ initialName, onClose }: { initialName: string | null; onClose: () => void }) {
  const create = useCreateTag();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const open = initialName !== null;
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(initialName);
      setColor(null);
      setErrors({});
    }
  }
  // Until a color is picked, follow the name (same default as creating a tag while tagging).
  const effectiveColor = color ?? paletteColor(name.trim() || 'tag');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = tagCreateInput.safeParse({ name, color: effectiveColor });
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    create.mutate(parsed.data, {
      onSuccess: (tag) => {
        toast.success(`Tag “${tag.name}” created`);
        onClose();
      },
      onError: (err) => {
        const fields = apiFieldErrors(err);
        if (err instanceof ApiError && err.status === 409) fields.name = err.message;
        setErrors(fields);
        if (!fields.name) toast.error(err);
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New tag"
      onSubmit={submit}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending}>
            Create tag
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" required error={errors.name}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((x) => ({ ...x, name: undefined }));
            }}
            maxLength={LIMITS.tagNameMax}
            placeholder="e.g. needs design"
            autoComplete="off"
          />
        </Field>
        <Field label="Color">
          <ColorPicker value={effectiveColor} onChange={setColor} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function MergeTagDialog({ tag, onClose }: { tag: TagDTO | null; onClose: () => void }) {
  const { tags } = useLookups();
  const merge = useMergeTag();
  const sheetMode = useSheetMode();
  const [shown, setShown] = useState<TagDTO | null>(null);
  const [targetId, setTargetId] = useState<number | undefined>();
  const open = tag !== null;
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (tag) {
      setShown(tag);
      setTargetId(undefined);
    }
  }
  const options = useMemo(
    () =>
      tags
        .filter((t) => t.id !== shown?.id)
        .map((t) => ({ value: t.id, label: t.name, icon: <ColorDot color={t.color} size="md" />, hint: String(t.taskCount) })),
    [tags, shown],
  );
  const target = tags.find((t) => t.id === targetId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!shown || !target) return;
    merge.mutate(
      { id: shown.id, targetId: target.id },
      {
        onSuccess: () => {
          toast.success(`Merged “${shown.name}” into “${target.name}”`);
          onClose();
        },
        onError: (err) => toast.error(err),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={shown ? `Merge “${shown.name}” into…` : 'Merge tag'}
      description="Its tasks get the tag you choose, then it is deleted."
      onSubmit={submit}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={merge.isPending} disabled={!target}>
            Merge
          </Button>
        </>
      }
    >
      {shown && (
        <div className="flex flex-col gap-4">
          {options.length === 0 ? (
            <p className="text-sm text-fg-muted">There is no other tag to merge into.</p>
          ) : (
            <PickerList<number>
              label="Merge into"
              options={options}
              value={targetId}
              onChange={setTargetId}
              placeholder="Search tags…"
              touch={sheetMode}
              searchable
              className="max-h-72 rounded-md border border-border"
            />
          )}
          {target && (
            <p className="text-sm text-fg-muted" aria-live="polite">
              {shown.taskCount > 0 ? (
                <>
                  {pluralize(shown.taskCount, 'task')} tagged “{shown.name}” will be tagged “{target.name}” instead.{' '}
                </>
              ) : null}
              “{shown.name}” is then deleted, and boards that filter by it switch to “{target.name}”.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function TagSettings() {
  const { tags } = useLookups();
  const sid = useSpaceId();
  const qc = useQueryClient();
  const optimistic = useOptimisticBootstrap();
  const update = useUpdateTag();
  const remove = useDeleteTag();
  const confirm = useConfirm();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [createName, setCreateName] = useState<string | null>(null);
  const [merging, setMerging] = useState<TagDTO | null>(null);
  const visible = useMemo(() => tags.filter((t) => matchesQuery(t, deferredQuery)), [tags, deferredQuery]);
  const trimmed = query.trim();
  const exact = tags.some((t) => fold(t.name) === fold(trimmed));

  const patch = async (tag: TagDTO, input: { name?: string; color?: string }) => {
    const rollback = await optimistic((b) => ({ ...b, tags: b.tags.map((t) => (t.id === tag.id ? { ...t, ...input } : t)) }));
    update.mutate({ id: tag.id, ...input }, {
      onError: (err) => {
        rollback();
        toast.error(err);
      },
    });
  };

  const requestDelete = async (tag: TagDTO) => {
    const ok = await confirm({
      title: `Delete “${tag.name}”?`,
      body:
        tag.taskCount > 0
          ? `It is on ${pluralize(tag.taskCount, 'task')} (archived tasks not counted) and will be removed from all of them. This can’t be undone.`
          : 'No tasks use this tag. This can’t be undone.',
      confirmLabel: 'Delete tag',
      danger: true,
    });
    if (!ok) return;
    const rollback = await optimistic((b) => ({ ...b, tags: b.tags.filter((t) => t.id !== tag.id) }));
    remove.mutate(tag.id, {
      onSuccess: () => toast.success(`Deleted “${tag.name}”`),
      onError: (err) => {
        rollback();
        toast.error(err);
        void qc.invalidateQueries({ queryKey: qk.bootstrap(sid) });
      },
    });
  };

  return (
    <SettingsPage
      title="Tags"
      description="Tags are shared by all projects. Rename or recolor them here, merge duplicates, or delete ones you no longer need."
      actions={
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreateName(exact ? '' : trimmed)}>
          New tag
        </Button>
      }
    >
      {tags.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface shadow-card">
          <EmptyState
            icon={<TagIcon />}
            title="No tags yet"
            body="Create tags here or while tagging a task. Use them to filter and group boards."
            action={
              <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreateName('')}>
                Create a tag
              </Button>
            }
          />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tags"
            aria-label="Search tags"
            leadingIcon={<Search aria-hidden />}
            trailing={
              query ? <IconButton aria-label="Clear search" icon={<X />} size="sm" tooltip={false} onClick={() => setQuery('')} /> : undefined
            }
            className="md:max-w-sm"
            inputClassName="[&::-webkit-search-cancel-button]:hidden"
          />
          <section aria-label="Tags" className="min-w-0 rounded-lg border border-border bg-surface shadow-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-fg-muted" aria-live="polite">
              <span>
                {deferredQuery.trim()
                  ? `${visible.length} of ${pluralize(tags.length, 'tag')}`
                  : pluralize(tags.length, 'tag')}
              </span>
              <span>Tasks</span>
            </div>
            {visible.length > 0 ? (
              <ul className="flex flex-col divide-y divide-border">
                {visible.map((t) => (
                  <TagItem key={t.id} tag={t} onPatch={(tag, input) => void patch(tag, input)} onMerge={setMerging} onDelete={(tag) => void requestDelete(tag)} />
                ))}
              </ul>
            ) : (
              <EmptyState
                size="sm"
                icon={<Search />}
                title={`No tags match “${trimmed}”`}
                action={
                  !exact && trimmed ? (
                    <Button icon={<Plus aria-hidden />} onClick={() => setCreateName(trimmed)}>
                      Create “{trimmed}”
                    </Button>
                  ) : undefined
                }
              />
            )}
          </section>
        </div>
      )}
      <CreateTagDialog initialName={createName} onClose={() => setCreateName(null)} />
      <MergeTagDialog tag={merging} onClose={() => setMerging(null)} />
    </SettingsPage>
  );
}
