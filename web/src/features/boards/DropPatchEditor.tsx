// Editor for a custom group's drop patch (what dropping a task there changes).

import type { DropPatch } from '@shared/board';
import { PRIORITY_META, type Priority } from '@shared/constants';
import { localToday } from '@shared/dates';
import { useLookups } from '../../api/bootstrap';
import { PRIORITY_ORDER, TagPicker } from '../../components/domain';
import { DateInput, Field, Select } from '../../components/ui';

export interface DropPatchEditorProps {
  value: DropPatch;
  onChange: (next: DropPatch) => void;
  /** Project board: the project can't change and epics are scoped to it. */
  scopeProjectId: number | null;
  idPrefix: string;
}

const KEEP = '';

type DueChoice = '' | 'today' | 'tomorrow' | 'next_week' | 'clear' | 'date';

function clean(p: DropPatch): DropPatch {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as DropPatch;
}

export function DropPatchEditor({ value, onChange, scopeProjectId, idPrefix }: DropPatchEditorProps) {
  const lookups = useLookups();
  const set = (patch: Partial<DropPatch>) => onChange(clean({ ...value, ...patch }));
  const epicProject = value.projectId ?? scopeProjectId;
  const epics = lookups.epics.filter((e) =>
    epicProject !== null && epicProject !== undefined ? e.projectId === epicProject : lookups.projectById.get(e.projectId)?.status !== 'archived',
  );
  const multiProject = epicProject === null || epicProject === undefined;
  const dueChoice: DueChoice = value.dueDate !== undefined ? 'date' : (value.due ?? '');
  const id = (k: string) => `${idPrefix}-${k}`;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Status" htmlFor={id('status')}>
        <Select
          id={id('status')}
          size="sm"
          value={value.statusId === undefined ? KEEP : String(value.statusId)}
          onChange={(e) => set({ statusId: e.target.value === KEEP ? undefined : Number(e.target.value) })}
          options={[{ value: KEEP, label: 'Don’t change' }, ...lookups.statuses.map((s) => ({ value: String(s.id), label: s.name }))]}
        />
      </Field>
      <Field label="Priority" htmlFor={id('priority')}>
        <Select
          id={id('priority')}
          size="sm"
          value={value.priority === undefined ? KEEP : String(value.priority)}
          onChange={(e) => set({ priority: e.target.value === KEEP ? undefined : (Number(e.target.value) as Priority) })}
          options={[{ value: KEEP, label: 'Don’t change' }, ...PRIORITY_ORDER.map((p) => ({ value: String(p), label: PRIORITY_META[p].label }))]}
        />
      </Field>
      {scopeProjectId === null && (
        <Field label="Project" htmlFor={id('project')} hint={value.projectId !== undefined ? 'Moving to another project clears the epic unless one is set.' : undefined}>
          <Select
            id={id('project')}
            size="sm"
            value={value.projectId === undefined ? KEEP : String(value.projectId)}
            onChange={(e) => {
              const projectId = e.target.value === KEEP ? undefined : Number(e.target.value);
              const epic = typeof value.epicId === 'number' ? lookups.epicById.get(value.epicId) : undefined;
              set({ projectId, ...(epic && projectId !== undefined && epic.projectId !== projectId ? { epicId: undefined } : {}) });
            }}
            options={[
              { value: KEEP, label: 'Don’t change' },
              ...lookups.projects
                .filter((p) => p.status !== 'archived' || p.id === value.projectId)
                .map((p) => ({ value: String(p.id), label: `${p.name} (${p.key})` })),
            ]}
          />
        </Field>
      )}
      <Field label="Epic" htmlFor={id('epic')}>
        <Select
          id={id('epic')}
          size="sm"
          value={value.epicId === undefined ? KEEP : value.epicId === null ? 'none' : String(value.epicId)}
          onChange={(e) => set({ epicId: e.target.value === KEEP ? undefined : e.target.value === 'none' ? null : Number(e.target.value) })}
          options={[
            { value: KEEP, label: 'Don’t change' },
            { value: 'none', label: 'Remove the epic' },
            ...epics.map((ep) => ({
              value: String(ep.id),
              label: multiProject ? `${ep.name} (${lookups.projectById.get(ep.projectId)?.key ?? '?'})` : ep.name,
            })),
          ]}
        />
      </Field>
      <Field label="Due date" htmlFor={id('due')}>
        <div className="flex flex-col gap-2">
          <Select
            id={id('due')}
            size="sm"
            value={dueChoice}
            onChange={(e) => {
              const v = e.target.value as DueChoice;
              if (v === 'date') set({ due: undefined, dueDate: value.dueDate ?? localToday() });
              else set({ due: v === '' ? undefined : v, dueDate: undefined });
            }}
            options={[
              { value: '', label: 'Don’t change' },
              { value: 'today', label: 'Today (when dropped)' },
              { value: 'tomorrow', label: 'Tomorrow' },
              { value: 'next_week', label: 'Start of next week' },
              { value: 'clear', label: 'Clear the due date' },
              { value: 'date', label: 'A fixed date…' },
            ]}
          />
          {dueChoice === 'date' && (
            <DateInput value={value.dueDate ?? null} clearable={false} size="sm" onChange={(d) => set({ dueDate: d ?? undefined })} />
          )}
        </div>
      </Field>
      <Field label="Archive" htmlFor={id('archived')}>
        <Select
          id={id('archived')}
          size="sm"
          value={value.archived === undefined ? KEEP : value.archived ? 'yes' : 'no'}
          onChange={(e) => set({ archived: e.target.value === KEEP ? undefined : e.target.value === 'yes' })}
          options={[
            { value: KEEP, label: 'Don’t change' },
            { value: 'yes', label: 'Archive the task' },
            { value: 'no', label: 'Unarchive the task' },
          ]}
        />
      </Field>
      <Field label="Add tags">
        <TagPicker
          value={value.addTagIds ?? []}
          onChange={(ids) => set({ addTagIds: ids, removeTagIds: (value.removeTagIds ?? []).filter((t) => !ids.includes(t)) })}
          placeholder="No tags added"
          triggerProps={{ fullWidth: true, bordered: true }}
        />
      </Field>
      <Field label="Remove tags">
        <TagPicker
          value={value.removeTagIds ?? []}
          onChange={(ids) => set({ removeTagIds: ids, addTagIds: (value.addTagIds ?? []).filter((t) => !ids.includes(t)) })}
          allowCreate={false}
          placeholder="No tags removed"
          triggerProps={{ fullWidth: true, bordered: true }}
        />
      </Field>
    </div>
  );
}
