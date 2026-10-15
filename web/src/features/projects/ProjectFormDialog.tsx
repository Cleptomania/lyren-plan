// Create / edit a project: name, key (suggested from the name while untouched, validated
// live for format and uniqueness), color, status and Markdown description.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { DEFAULT_PROJECT_COLOR, LIMITS, PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectStatus } from '@shared/constants';
import { projectCreateInput, projectUpdateInput, type ProjectUpdateInput } from '@shared/schemas';
import type { ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useCreateProject, useUpdateProject } from '../../api/projects';
import {
  Button,
  ColorPicker,
  Dialog,
  Field,
  Input,
  MarkdownEditor,
  Select,
  apiFieldErrors,
  toast,
  zodFieldErrors,
  type FieldErrors,
  type OverlayControls,
} from '../../components/ui';
import { projectUrl } from '../../lib/taskLinks';
import { normalizeKeyInput, projectKeyError, suggestProjectKey } from './projectKey';

export interface ProjectFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Edit this project; omit to create a new one (then navigates to it). */
  project?: ProjectDTO;
}

interface FormState {
  name: string;
  key: string;
  /** The user typed in the key field: stop suggesting from the name. */
  keyTouched: boolean;
  color: string;
  status: ProjectStatus;
  description: string;
}

function initialState(project: ProjectDTO | undefined): FormState {
  return {
    name: project?.name ?? '',
    key: project?.key ?? '',
    keyTouched: project !== undefined,
    color: project?.color ?? DEFAULT_PROJECT_COLOR,
    status: project?.status ?? 'active',
    description: project?.description ?? '',
  };
}

const STATUS_OPTIONS = PROJECT_STATUSES.map((s) => ({ value: s, label: PROJECT_STATUS_LABELS[s] }));

export function ProjectFormDialog({ open, onClose, project }: ProjectFormDialogProps) {
  const { projects } = useLookups();
  const navigate = useNavigate();
  const create = useCreateProject();
  const update = useUpdateProject();
  const controls = useRef<OverlayControls>(null);
  const [form, setForm] = useState<FormState>(() => initialState(project));
  const [errors, setErrors] = useState<FieldErrors>({});
  const editing = project !== undefined;
  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (open) {
      setForm(initialState(project));
      setErrors({});
    }
    // Reset only when the dialog opens (not when the project refetches while it is open).
  }, [open]);

  const initial = initialState(project);
  const dirty = (Object.keys(initial) as Array<keyof FormState>).some((k) => k !== 'keyTouched' && form[k] !== initial[k]);
  const keyProblem = form.key ? projectKeyError(form.key, projects, project?.id) : undefined;

  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
  };
  const onNameChange = (name: string) => {
    setForm((f) => ({ ...f, name, key: f.keyTouched ? f.key : suggestProjectKey(name, projects) }));
    if (errors.name || errors.key) setErrors((e) => ({ ...e, name: undefined, key: undefined }));
  };

  const fail = (err: unknown) => {
    setErrors(apiFieldErrors(err));
    toast.error(err);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (keyProblem) {
      setErrors((x) => ({ ...x, key: keyProblem }));
      return;
    }
    if (!project) {
      const parsed = projectCreateInput.safeParse({
        name: form.name,
        key: form.key || undefined,
        color: form.color,
        status: form.status,
        description: form.description,
      });
      if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
      create.mutate(parsed.data, {
        onSuccess: (created) => {
          toast.success(`Created ${created.name} (${created.key})`);
          // On phones the dialog has its own history entry: the project page replaces it.
          const replace = controls.current?.closeForNavigation() ?? false;
          onClose();
          navigate(projectUrl(created.id), { replace });
        },
        onError: fail,
      });
      return;
    }
    const patch: ProjectUpdateInput = {};
    if (form.name !== initial.name) patch.name = form.name;
    if (form.key !== initial.key) patch.key = form.key;
    if (form.color !== initial.color) patch.color = form.color;
    if (form.status !== initial.status) patch.status = form.status;
    if (form.description !== initial.description) patch.description = form.description;
    const parsed = projectUpdateInput.safeParse(patch);
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    if (Object.keys(parsed.data).length === 0) return onClose();
    update.mutate(
      { id: project.id, ...parsed.data },
      {
        onSuccess: (saved) => {
          toast.success(`Saved ${saved.name}`);
          onClose();
        },
        onError: fail,
      },
    );
  };

  const keyHint = project
    ? `Prefix of task references. Changing it renames every reference (${project.key}-12 → ${form.key || '…'}-12).`
    : form.key
      ? `Task references will look like ${form.key}-12.`
      : 'Prefix of task references. Leave empty to generate one from the name.';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? 'Edit project' : 'New project'}
      description={editing ? undefined : 'Projects group milestones, epics and tasks.'}
      onSubmit={submit}
      controlsRef={controls}
      closeOnOutsideClick={!dirty}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {editing ? 'Save' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <Field label="Name" required error={errors.name}>
            <Input
              value={form.name}
              onChange={(e) => onNameChange(e.target.value)}
              maxLength={LIMITS.nameMax}
              autoComplete="off"
              placeholder="Website relaunch"
            />
          </Field>
          <Field label="Key" error={errors.key ?? keyProblem} hint={keyHint}>
            <Input
              value={form.key}
              onChange={(e) => {
                const key = normalizeKeyInput(e.target.value);
                setForm((f) => ({ ...f, key, keyTouched: true }));
                if (errors.key) setErrors((x) => ({ ...x, key: undefined }));
              }}
              maxLength={LIMITS.projectKeyMax}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="WEB"
              inputClassName="font-mono uppercase tracking-wide"
            />
          </Field>
        </div>
        <Field label="Status" error={errors.status}>
          <Select
            value={form.status}
            options={STATUS_OPTIONS}
            onChange={(e) => set('status', e.target.value as ProjectStatus)}
          />
        </Field>
        <Field label="Color" error={errors.color}>
          <ColorPicker value={form.color} onChange={(color) => set('color', color)} aria-label="Project color" />
        </Field>
        <Field label="Description" optional error={errors.description}>
          <MarkdownEditor
            value={form.description}
            onChange={(description) => set('description', description)}
            placeholder="Goals, links, notes… (Markdown supported)"
            minRows={3}
            maxRows={12}
            maxLength={LIMITS.descriptionMax}
          />
        </Field>
      </div>
    </Dialog>
  );
}
