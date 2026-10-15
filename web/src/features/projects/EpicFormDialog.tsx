// Create / edit an epic: name, milestone (of the same project), status, color, dates and
// Markdown description.

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { DEFAULT_EPIC_COLOR, EPIC_STATUSES, EPIC_STATUS_LABELS, LIMITS, MILESTONE_STATUS_LABELS, type EpicStatus } from '@shared/constants';
import { epicCreateInput, epicUpdateInput, type EpicUpdateInput } from '@shared/schemas';
import type { EpicDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useCreateEpic, useUpdateEpic } from '../../api/projects';
import { DateField } from '../../components/domain';
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
} from '../../components/ui';
import { epicUrl } from '../../lib/taskLinks';
import { isMilestoneClosed } from './hierarchy';
import { DATE_ORDER_ERROR } from './MilestoneFormDialog';

export interface EpicFormDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  /** Edit this epic; omit to create one. */
  epic?: EpicDTO;
  /** Milestone preselected for a new epic (e.g. "Add epic" inside a milestone). */
  defaultMilestoneId?: number | null;
}

interface FormState {
  name: string;
  milestoneId: number | null;
  status: EpicStatus;
  color: string;
  startDate: string | null;
  dueDate: string | null;
  description: string;
}

function initialState(epic: EpicDTO | undefined, defaultMilestoneId: number | null): FormState {
  return {
    name: epic?.name ?? '',
    milestoneId: epic ? epic.milestoneId : defaultMilestoneId,
    status: epic?.status ?? 'open',
    color: epic?.color ?? DEFAULT_EPIC_COLOR,
    startDate: epic?.startDate ?? null,
    dueDate: epic?.dueDate ?? null,
    description: epic?.description ?? '',
  };
}

const STATUS_OPTIONS = EPIC_STATUSES.map((s) => ({ value: s, label: EPIC_STATUS_LABELS[s] }));

export function EpicFormDialog({ open, onClose, projectId, epic, defaultMilestoneId = null }: EpicFormDialogProps) {
  const navigate = useNavigate();
  const { milestonesByProject } = useLookups();
  const create = useCreateEpic();
  const update = useUpdateEpic();
  const [form, setForm] = useState<FormState>(() => initialState(epic, defaultMilestoneId));
  const [errors, setErrors] = useState<FieldErrors>({});
  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (open) {
      setForm(initialState(epic, defaultMilestoneId));
      setErrors({});
    }
  }, [open]);

  const milestones = milestonesByProject.get(projectId) ?? [];
  const milestoneOptions = [
    { value: '', label: 'No milestone' },
    ...milestones.map((m) => ({
      value: String(m.id),
      label: isMilestoneClosed(m.status) ? `${m.name} (${MILESTONE_STATUS_LABELS[m.status]})` : m.name,
    })),
  ];

  const initial = initialState(epic, defaultMilestoneId);
  const dirty = (Object.keys(initial) as Array<keyof FormState>).some((k) => form[k] !== initial[k]);
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined, ...(field === 'startDate' && { dueDate: undefined }) }));
  };
  const fail = (err: unknown) => {
    setErrors(apiFieldErrors(err));
    toast.error(err);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (form.startDate && form.dueDate && form.startDate > form.dueDate) {
      setErrors({ dueDate: DATE_ORDER_ERROR });
      return;
    }
    if (!epic) {
      const parsed = epicCreateInput.safeParse({ projectId, ...form });
      if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
      create.mutate(parsed.data, {
        onSuccess: (created) => {
          toast.success(`Epic “${created.name}” created`, {
            action: { label: 'Open', onClick: () => navigate(epicUrl(created.projectId, created.id)) },
          });
          onClose();
        },
        onError: fail,
      });
      return;
    }
    const patch: EpicUpdateInput = {};
    if (form.name !== initial.name) patch.name = form.name;
    if (form.milestoneId !== initial.milestoneId) patch.milestoneId = form.milestoneId;
    if (form.status !== initial.status) patch.status = form.status;
    if (form.color !== initial.color) patch.color = form.color;
    if (form.startDate !== initial.startDate) patch.startDate = form.startDate;
    if (form.dueDate !== initial.dueDate) patch.dueDate = form.dueDate;
    if (form.description !== initial.description) patch.description = form.description;
    const parsed = epicUpdateInput.safeParse(patch);
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    if (Object.keys(parsed.data).length === 0) return onClose();
    update.mutate(
      { id: epic.id, ...parsed.data },
      {
        onSuccess: (saved) => {
          toast.success(`Saved “${saved.name}”`);
          onClose();
        },
        onError: fail,
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={epic ? 'Edit epic' : 'New epic'}
      description={epic ? undefined : 'Epics group related tasks; assign one to a milestone to roll its progress up.'}
      onSubmit={submit}
      closeOnOutsideClick={!dirty}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {epic ? 'Save' : 'Create epic'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" required error={errors.name}>
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            maxLength={LIMITS.nameMax}
            autoComplete="off"
            placeholder="Design system"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Milestone" error={errors.milestoneId}>
            <Select
              value={form.milestoneId === null ? '' : String(form.milestoneId)}
              options={milestoneOptions}
              onChange={(e) => set('milestoneId', e.target.value ? Number(e.target.value) : null)}
            />
          </Field>
          <Field label="Status" error={errors.status}>
            <Select value={form.status} options={STATUS_OPTIONS} onChange={(e) => set('status', e.target.value as EpicStatus)} />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <DateField label="Start date" optional value={form.startDate} onChange={(v) => set('startDate', v)} error={errors.startDate} />
          <DateField
            label="Due date"
            optional
            value={form.dueDate}
            onChange={(v) => set('dueDate', v)}
            min={form.startDate ?? undefined}
            error={errors.dueDate}
          />
        </div>
        <Field label="Color" error={errors.color}>
          <ColorPicker value={form.color} onChange={(color) => set('color', color)} aria-label="Epic color" />
        </Field>
        <Field label="Description" optional error={errors.description}>
          <MarkdownEditor
            value={form.description}
            onChange={(v) => set('description', v)}
            placeholder="What is this epic about? (Markdown supported)"
            minRows={3}
            maxRows={12}
            maxLength={LIMITS.descriptionMax}
          />
        </Field>
      </div>
    </Dialog>
  );
}
