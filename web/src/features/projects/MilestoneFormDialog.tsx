// Create / edit a milestone: name, status, start → due dates and Markdown description.

import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LIMITS, MILESTONE_STATUSES, MILESTONE_STATUS_LABELS, type MilestoneStatus } from '@shared/constants';
import { milestoneCreateInput, milestoneUpdateInput, type MilestoneUpdateInput } from '@shared/schemas';
import type { MilestoneDTO } from '@shared/types';
import { useCreateMilestone, useUpdateMilestone } from '../../api/projects';
import { DateField } from '../../components/domain';
import {
  Button,
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
import { milestoneUrl } from '../../lib/taskLinks';

export interface MilestoneFormDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  /** Edit this milestone; omit to create one (appended to the project's milestones). */
  milestone?: MilestoneDTO;
}

interface FormState {
  name: string;
  status: MilestoneStatus;
  startDate: string | null;
  dueDate: string | null;
  description: string;
}

function initialState(m: MilestoneDTO | undefined): FormState {
  return {
    name: m?.name ?? '',
    status: m?.status ?? 'planned',
    startDate: m?.startDate ?? null,
    dueDate: m?.dueDate ?? null,
    description: m?.description ?? '',
  };
}

export const DATE_ORDER_ERROR = 'Due date must be on or after the start date';
const STATUS_OPTIONS = MILESTONE_STATUSES.map((s) => ({ value: s, label: MILESTONE_STATUS_LABELS[s] }));

export function MilestoneFormDialog({ open, onClose, projectId, milestone }: MilestoneFormDialogProps) {
  const navigate = useNavigate();
  const create = useCreateMilestone();
  const update = useUpdateMilestone();
  const [form, setForm] = useState<FormState>(() => initialState(milestone));
  const [errors, setErrors] = useState<FieldErrors>({});
  const pending = create.isPending || update.isPending;

  useEffect(() => {
    if (open) {
      setForm(initialState(milestone));
      setErrors({});
    }
  }, [open]);

  const initial = initialState(milestone);
  const dirty = (Object.keys(initial) as Array<keyof FormState>).some((k) => form[k] !== initial[k]);
  const set = <K extends keyof FormState>(field: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [field]: value }));
    // A start date change can resolve a date-order error reported on the due date.
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
    if (!milestone) {
      const parsed = milestoneCreateInput.safeParse({ projectId, ...form });
      if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
      create.mutate(parsed.data, {
        onSuccess: (created) => {
          toast.success(`Milestone “${created.name}” created`, {
            action: { label: 'Open', onClick: () => navigate(milestoneUrl(created.projectId, created.id)) },
          });
          onClose();
        },
        onError: fail,
      });
      return;
    }
    const patch: MilestoneUpdateInput = {};
    if (form.name !== initial.name) patch.name = form.name;
    if (form.status !== initial.status) patch.status = form.status;
    if (form.startDate !== initial.startDate) patch.startDate = form.startDate;
    if (form.dueDate !== initial.dueDate) patch.dueDate = form.dueDate;
    if (form.description !== initial.description) patch.description = form.description;
    const parsed = milestoneUpdateInput.safeParse(patch);
    if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
    if (Object.keys(parsed.data).length === 0) return onClose();
    update.mutate(
      { id: milestone.id, ...parsed.data },
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
      title={milestone ? 'Edit milestone' : 'New milestone'}
      description={milestone ? undefined : 'Milestones group epics towards a target date.'}
      onSubmit={submit}
      closeOnOutsideClick={!dirty}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {milestone ? 'Save' : 'Create milestone'}
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
            placeholder="MVP launch"
          />
        </Field>
        <Field label="Status" error={errors.status}>
          <Select value={form.status} options={STATUS_OPTIONS} onChange={(e) => set('status', e.target.value as MilestoneStatus)} />
        </Field>
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
        <Field label="Description" optional error={errors.description}>
          <MarkdownEditor
            value={form.description}
            onChange={(v) => set('description', v)}
            placeholder="Scope, success criteria… (Markdown supported)"
            minRows={3}
            maxRows={12}
            maxLength={LIMITS.descriptionMax}
          />
        </Field>
      </div>
    </Dialog>
  );
}
