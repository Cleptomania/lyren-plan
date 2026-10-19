// "New task" dialog (lazy chunk of TaskCreateDialogHost). Full-screen on phones (Back closes
// it via the kit's overlay history). The unsent draft lives in sessionStorage; closing with
// typed content asks before discarding it. mod+Enter creates; "Create another" keeps the
// dialog open with the same project and epic.

import { AlignLeft, FolderPlus, NotebookPen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS } from '@shared/constants';
import { taskCreateInput, type TaskCreateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useCreateTask } from '../../api/tasks';
import { useSpaceId, useSpacePath } from '../../app/space';
import {
  DatePicker,
  EpicPicker,
  EstimatePicker,
  PriorityPicker,
  ProjectPicker,
  StatusPicker,
  TagPicker,
} from '../../components/domain';
import {
  Button,
  ButtonLink,
  Dialog,
  EmptyState,
  Field,
  MarkdownEditor,
  Shortcut,
  Switch,
  Textarea,
  apiFieldErrors,
  toast,
  useConfirm,
  useOverlayControls,
  zodFieldErrors,
  type FieldErrors,
} from '../../components/ui';
import { spaceKey } from '../../lib/spaceStorage';
import { useOpenTask } from '../../lib/taskLinks';
import {
  draftHasContent,
  draftToInput,
  initialDraft,
  parseStoredDraft,
  sanitizeDraft,
  withProject,
  type CreateDraft,
} from './createDraft';
import { readLastProjectId, readSessionJson, writeLastProjectId, writeSessionJson } from './taskHelpers';

/** The space's unsent draft (sessionStorage). */
const draftKey = (spaceId: string) => spaceKey(spaceId, 'createTaskDraft');

export interface TaskCreateDialogProps {
  open: boolean;
  /** Prefill (openCreateTask(defaults), the page's project/epic for the 'c' hotkey). */
  defaults: Partial<TaskCreateInput>;
  onClose: () => void;
}

export default function TaskCreateDialog({ open, defaults, onClose }: TaskCreateDialogProps) {
  const sid = useSpaceId();
  const lookups = useLookups();
  const confirm = useConfirm();
  const openTask = useOpenTask();
  const create = useCreateTask();
  const titleRef = useRef<HTMLTextAreaElement>(null);
  /** Synchronous double-submit guard (isPending only updates on the next render). */
  const submitting = useRef(false);

  const draftLookups = useMemo(
    () => ({
      projects: lookups.projects,
      epicById: lookups.epicById,
      defaultStatusId: lookups.defaultStatus?.id ?? null,
      statusIds: new Set(lookups.statuses.map((s) => s.id)),
      tagIds: new Set(lookups.tags.map((t) => t.id)),
    }),
    [lookups],
  );

  // An unsent draft (same browser session) wins over the prefill, unless the caller passed
  // a title of its own (e.g. "Create task …" from the command palette).
  const [{ draft: startDraft, restored }] = useState(() => {
    const stored = parseStoredDraft(readSessionJson(draftKey(sid)));
    if (stored && draftHasContent(stored) && !defaults.title?.trim()) {
      return { draft: sanitizeDraft(stored, draftLookups, readLastProjectId(sid)), restored: true };
    }
    return { draft: initialDraft(defaults, draftLookups, readLastProjectId(sid)), restored: false };
  });
  const [draft, setDraft] = useState<CreateDraft>(startDraft);
  const [showRestored, setShowRestored] = useState(restored);
  const [showDescription, setShowDescription] = useState(startDraft.description !== '');
  const [createAnother, setCreateAnother] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const dirty = draftHasContent(draft);

  useEffect(() => {
    writeSessionJson(draftKey(sid), draftHasContent(draft) ? draft : null);
  }, [sid, draft]);

  const update = (patch: Partial<CreateDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
  };

  const discard = () => {
    writeSessionJson(draftKey(sid), null);
    onClose();
  };

  const requestClose = async () => {
    if (!draftHasContent(draft)) return discard();
    const ok = await confirm({
      title: 'Discard this task?',
      body: 'The task has not been created yet. Your title and description will be lost.',
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      danger: true,
    });
    if (ok) discard();
  };

  const submit = () => {
    if (submitting.current) return;
    const local: FieldErrors = {};
    if (draft.projectId === null) local.projectId = 'Choose a project';
    const parsed = taskCreateInput.safeParse(draftToInput(draft, defaults));
    const fieldErrors = { ...(parsed.success ? {} : zodFieldErrors(parsed.error)), ...local };
    if (!parsed.success || Object.keys(local).length > 0) {
      setErrors(fieldErrors);
      if (fieldErrors.title) titleRef.current?.focus();
      return;
    }
    submitting.current = true;
    const onCreated = (task: TaskDTO) => {
      writeLastProjectId(sid, task.projectId);
      toast.success(`Created ${task.ref}`, { action: { label: 'Open', onClick: () => openTask(task.id) } });
      if (!createAnother) return discard();
      // Keep the project and epic for the next one.
      setDraft({ ...initialDraft(defaults, draftLookups, task.projectId), projectId: draft.projectId, epicId: draft.epicId });
      setShowDescription(false);
      setErrors({});
      writeSessionJson(draftKey(sid), null);
      requestAnimationFrame(() => titleRef.current?.focus());
    };
    create
      .mutateAsync(parsed.data)
      .finally(() => {
        submitting.current = false;
      })
      .then(onCreated, (err: unknown) => {
        setErrors(apiFieldErrors(err));
        toast.error(err);
      });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The description editor handles mod+Enter itself (and prevents the default).
    if (e.defaultPrevented) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const noProjects = !lookups.projects.some((p) => p.status !== 'archived') && draft.projectId === null;
  const bordered = { bordered: true } as const;

  return (
    <Dialog
      open={open}
      onClose={() => void requestClose()}
      title="New task"
      size="lg"
      initialFocus={titleRef}
      closeOnOutsideClick={!dirty}
      onSubmit={noProjects ? undefined : submit}
      footer={
        noProjects ? undefined : (
          <>
            <Switch
              size="sm"
              checked={createAnother}
              onCheckedChange={setCreateAnother}
              label="Create another"
              className="mr-auto"
            />
            <span className="hidden text-xs text-fg-subtle md:inline pointer-coarse:hidden">
              <Shortcut combo="mod+enter" />
            </span>
            {/* Very narrow phones: the header's ✕ is the cancel action. */}
            <Button onClick={() => void requestClose()} className="max-[400px]:hidden">
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create task
            </Button>
          </>
        )
      }
    >
      {noProjects ? (
        <NoProjects />
      ) : (
        <div className="flex flex-col gap-4" onKeyDown={onKeyDown}>
          {showRestored && (
            <div role="status" className="flex flex-wrap items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-fg">
              <NotebookPen aria-hidden className="size-4 shrink-0 text-accent" />
              <span className="flex-1">Restored your unsent draft.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(initialDraft(defaults, draftLookups, readLastProjectId(sid)));
                  setShowDescription(false);
                  setShowRestored(false);
                  titleRef.current?.focus();
                }}
              >
                Start over
              </Button>
            </div>
          )}

          <Field label="Title" required error={errors.title}>
            <Textarea
              ref={titleRef}
              autoGrow
              minRows={1}
              maxRows={6}
              value={draft.title}
              maxLength={LIMITS.titleMax}
              placeholder="What needs to be done?"
              enterKeyHint="done"
              onChange={(e) => update({ title: e.target.value.replace(/\r?\n/g, ' ') })}
              onKeyDown={(e) => {
                // Titles are one line: Enter creates the task.
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="text-base font-medium"
            />
          </Field>

          <div role="group" aria-label="Properties" className="flex flex-col gap-1.5">
            <div className="flex flex-wrap gap-2">
              <ProjectPicker
                value={draft.projectId}
                onChange={(projectId) => {
                  setDraft((d) => withProject(d, projectId, lookups.epicById));
                  setErrors((e) => ({ ...e, projectId: undefined, epicId: undefined }));
                }}
                triggerProps={{ ...bordered, 'aria-invalid': errors.projectId ? true : undefined }}
              />
              {draft.statusId !== null && (
                <StatusPicker value={draft.statusId} onChange={(statusId) => update({ statusId })} triggerProps={bordered} />
              )}
              <PriorityPicker value={draft.priority} onChange={(priority) => update({ priority })} triggerProps={bordered} />
              {draft.projectId !== null && (
                <EpicPicker projectId={draft.projectId} value={draft.epicId} onChange={(epicId) => update({ epicId })} triggerProps={bordered} />
              )}
              <TagPicker value={draft.tagIds} onChange={(tagIds) => update({ tagIds })} triggerProps={bordered} />
              <DatePicker
                label="Due date"
                value={draft.dueDate}
                min={draft.startDate ?? undefined}
                onChange={(dueDate) => update({ dueDate })}
                triggerProps={bordered}
              />
              <EstimatePicker value={draft.estimate} onChange={(estimate) => update({ estimate })} triggerProps={bordered} />
            </div>
            {(errors.projectId || errors.epicId || errors.statusId || errors.dueDate || errors.tagIds) && (
              <p role="alert" className="text-xs text-danger">
                {errors.projectId ?? errors.epicId ?? errors.statusId ?? errors.dueDate ?? errors.tagIds}
              </p>
            )}
          </div>

          {showDescription ? (
            <Field label="Description" error={errors.description}>
              <MarkdownEditor
                value={draft.description}
                onChange={(description) => update({ description })}
                autoFocus={draft.description === ''}
                minRows={4}
                maxRows={14}
                maxLength={LIMITS.descriptionMax}
                placeholder="Add details… (Markdown supported)"
              />
            </Field>
          ) : (
            <Button variant="ghost" size="sm" icon={<AlignLeft />} className="-ml-2 self-start" onClick={() => setShowDescription(true)}>
              Add description
            </Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

function NoProjects() {
  const sp = useSpacePath();
  const controls = useOverlayControls();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<FolderPlus />}
      title="Create a project first"
      body="Tasks live in projects. Create one, then add tasks to it."
      action={
        <ButtonLink
          to={sp('/projects')}
          variant="primary"
          onClick={(e) => {
            // Modified clicks (new tab / window) keep the link's own behaviour.
            if (!controls || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            // The projects page REPLACES the dialog's own history entry (phones), so Back from
            // it returns to the page under the dialog instead of a dead same-URL entry.
            e.preventDefault();
            navigate(sp('/projects'), { replace: controls.closeForNavigation() });
          }}
        >
          Go to projects
        </ButtonLink>
      }
    />
  );
}
