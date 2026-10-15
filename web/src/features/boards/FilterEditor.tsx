// TaskFilter editor shared by the board filter (config panel → Filter) and custom column /
// lane match filters (compact, without archive controls). Ids that no longer exist are shown
// as removable "(deleted)" chips (SPEC §5.11: clients ignore unknown ids).

import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import {
  DUE_PRESET_LABELS,
  DUE_PRESETS,
  LIMITS,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_META,
  type DuePreset,
  type Priority,
  type StatusCategory,
} from '@shared/constants';
import type { TaskFilter } from '@shared/schemas';
import { useLookups } from '../../api/bootstrap';
import {
  epicOptions,
  milestoneOptions,
  priorityOptions,
  projectOptions,
  PropertyButton,
  StatusIcon,
  type PropertyButtonProps,
  statusFraction,
  statusOptions,
  tagOptions,
} from '../../components/domain';
import { Field, Input, Picker, SegmentedControl, Select, Switch, useFieldControl, type PickerOption } from '../../components/ui';

export interface FilterEditorProps {
  value: TaskFilter;
  onChange: (next: TaskFilter) => void;
  /** Project board: the project filter is fixed (hidden) and pickers are scoped to it. */
  scopeProjectId: number | null;
  /** Archive mode / include archived projects (board filter only). */
  archiveControls?: boolean;
  /** Denser layout (custom groups). */
  compact?: boolean;
  /** Prefix for element ids (several editors on one panel). */
  idPrefix: string;
}

type Multi = string | number | null;

/** Remove undefined / empty-array keys so stored filters stay minimal. */
function cleanFilter(f: TaskFilter): TaskFilter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'search' && typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  if (!Array.isArray(out.tagIds) || (out.tagIds as unknown[]).length === 0) delete out.tagMode;
  return out as TaskFilter;
}

/** Picker trigger labelled by the enclosing Field (forwards the ref Picker anchors to). */
const PickerTrigger = forwardRef<HTMLButtonElement, { text: string; placeholder: boolean } & PropertyButtonProps>(function PickerTrigger(
  { text, placeholder, ...rest },
  ref,
) {
  const field = useFieldControl({});
  return (
    <PropertyButton ref={ref} {...rest} id={field.id} aria-describedby={field['aria-describedby']} bordered fullWidth chevron placeholder={placeholder}>
      {text}
    </PropertyButton>
  );
});

function DeletedChips<V extends Multi>({ ids, onRemove, noun }: { ids: V[]; onRemove: (id: V) => void; noun: string }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <span key={String(id)} className="inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border-strong pl-2 text-xs text-fg-muted">
          (deleted) {noun} #{String(id)}
          <button
            type="button"
            aria-label={`Remove deleted ${noun} ${String(id)} from the filter`}
            onClick={() => onRemove(id)}
            className="relative flex size-7 items-center justify-center rounded-md hover:bg-surface-3 hover:text-fg"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </span>
      ))}
    </div>
  );
}

function MultiField<V extends Multi>({
  label,
  options,
  value,
  onChange,
  anyLabel = 'Any',
  noun,
  hint,
}: {
  label: string;
  options: PickerOption<V>[];
  value: readonly V[] | undefined;
  onChange: (next: V[]) => void;
  anyLabel?: string;
  noun: string;
  hint?: string;
}) {
  const list = value ?? [];
  const known = new Set(options.map((o) => o.value));
  const missing = list.filter((v) => !known.has(v));
  const names = options.filter((o) => list.includes(o.value)).map((o) => o.label);
  const text = names.length === 0 ? (missing.length > 0 ? `${missing.length} deleted` : anyLabel) : names.join(', ');
  return (
    <Field label={label} hint={hint}>
      <Picker<V>
        multiple
        label={label}
        options={options}
        value={list}
        onChange={(next) => onChange([...next, ...missing.filter((m) => !next.includes(m))])}
        trigger={<PickerTrigger text={text} placeholder={list.length === 0} />}
        className="w-72"
      />
      <DeletedChips ids={missing} noun={noun} onRemove={(id) => onChange(list.filter((v) => v !== id))} />
    </Field>
  );
}

const CLOSED_PRESETS = [
  { value: 'off', label: 'Show all closed tasks' },
  { value: '0', label: 'Hide closed tasks' },
  { value: '1', label: 'Closed in the last day' },
  { value: '7', label: 'Closed in the last 7 days' },
  { value: '14', label: 'Closed in the last 14 days' },
  { value: '30', label: 'Closed in the last 30 days' },
  { value: 'custom', label: 'Custom…' },
] as const;

function ClosedField({ value, onChange, id }: { value: number | null | undefined; onChange: (v: number | null | undefined) => void; id: string }) {
  const preset = value === undefined || value === null ? 'off' : ['0', '1', '7', '14', '30'].includes(String(value)) ? String(value) : 'custom';
  const [custom, setCustom] = useState(preset === 'custom');
  const [days, setDays] = useState(value && preset === 'custom' ? String(value) : '');
  const selected = custom ? 'custom' : preset;
  return (
    <Field label="Closed tasks" htmlFor={id} hint={selected === 'custom' ? 'Closed tasks stay visible for this many days.' : undefined}>
      <div className="flex gap-2">
        <Select
          id={id}
          size="sm"
          value={selected}
          options={CLOSED_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') {
              setCustom(true);
              setDays(value ? String(value) : '3');
              onChange(value || 3);
              return;
            }
            setCustom(false);
            onChange(v === 'off' ? undefined : Number(v));
          }}
          className="min-w-0 flex-1"
        />
        {selected === 'custom' && (
          <div className="w-28 shrink-0">
            <Input
              size="sm"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              aria-label="Days"
              value={days}
              onChange={(e) => {
                setDays(e.target.value);
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 3650) onChange(n);
              }}
              trailing={<span className="pr-2 text-xs text-fg-subtle">days</span>}
            />
          </div>
        )}
      </div>
    </Field>
  );
}

/** Blank text is stored as "no search" (cleanFilter), so it never differs from an empty value. */
const sameSearch = (text: string, value: string) => text === value || (text.trim() === '' && value.trim() === '');

/**
 * Text field that commits after a short pause, and right away when it unmounts with a pending
 * edit (switching config tabs or closing the panel must not drop what was typed).
 */
function SearchField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const [text, setText] = useState(value);
  const latest = useRef({ value, onChange, text });
  latest.current = { value, onChange, text };
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (sameSearch(text, latest.current.value)) return;
    const t = window.setTimeout(() => latest.current.onChange(text), 350);
    return () => window.clearTimeout(t);
  }, [text]);
  useEffect(
    () => () => {
      const { text: t, value: v, onChange: commit } = latest.current;
      if (!sameSearch(t, v)) commit(t);
    },
    [],
  );
  return (
    <Field label="Text" htmlFor={id} hint="Every word must appear in the title, description or key.">
      <Input id={id} size="sm" value={text} maxLength={LIMITS.searchMax} placeholder="Any text" onChange={(e) => setText(e.target.value)} />
    </Field>
  );
}

export function FilterEditor({ value, onChange, scopeProjectId, archiveControls = true, compact, idPrefix }: FilterEditorProps) {
  const lookups = useLookups();
  const set = (patch: Partial<TaskFilter>) => onChange(cleanFilter({ ...value, ...patch }));
  const scope = scopeProjectId ?? (value.projectIds && value.projectIds.length > 0 ? value.projectIds : null);
  const scopeKey = scope === null ? '*' : String(scope);

  const projects = useMemo(() => projectOptions(lookups.projects, { includeArchived: true }), [lookups.projects]);
  const milestones = useMemo(() => milestoneOptions(lookups, { projectId: scope ?? undefined, includeNone: true }), [lookups, scopeKey]); // scopeKey stands in for `scope`
  const epics = useMemo(() => epicOptions(lookups, { projectId: scope ?? undefined, includeNone: true }), [lookups, scopeKey]);
  const statuses = useMemo(() => statusOptions(lookups.statuses), [lookups.statuses]);
  const categories = useMemo<PickerOption<StatusCategory>[]>(
    () =>
      STATUS_CATEGORIES.map((c) => {
        const s = lookups.statuses.find((x) => x.category === c);
        return {
          value: c,
          label: STATUS_CATEGORY_META[c].label,
          hint: STATUS_CATEGORY_META[c].description,
          icon: s ? <StatusIcon status={s} fraction={statusFraction(s, lookups.statuses)} label={null} /> : undefined,
        };
      }),
    [lookups.statuses],
  );
  const priorities = useMemo(() => priorityOptions(), []);
  const tags = useMemo(() => tagOptions(lookups.tags), [lookups.tags]);
  const tagsWithNone = useMemo<PickerOption<number | null>[]>(() => [{ value: null, label: 'No tags' }, ...tags], [tags]);
  const dues = useMemo<PickerOption<DuePreset>[]>(() => DUE_PRESETS.map((d) => ({ value: d, label: DUE_PRESET_LABELS[d] })), []);
  const tagCount = (value.tagIds ?? []).filter((t) => t !== null).length;

  return (
    <div className={clsx('flex flex-col', compact ? 'gap-3' : 'gap-4')}>
      {scopeProjectId === null && (
        <MultiField<number> label="Projects" noun="project" options={projects} value={value.projectIds} onChange={(projectIds) => set({ projectIds })} anyLabel="All projects" />
      )}
      <div className={clsx('grid gap-3', !compact && 'sm:grid-cols-2 sm:gap-4')}>
        <MultiField<number | null> label="Milestones" noun="milestone" options={milestones} value={value.milestoneIds} onChange={(milestoneIds) => set({ milestoneIds })} />
        <MultiField<number | null> label="Epics" noun="epic" options={epics} value={value.epicIds} onChange={(epicIds) => set({ epicIds })} />
        <MultiField<number> label="Statuses" noun="status" options={statuses} value={value.statusIds} onChange={(statusIds) => set({ statusIds })} />
        <MultiField<StatusCategory> label="Status categories" noun="category" options={categories} value={value.statusCategories} onChange={(statusCategories) => set({ statusCategories })} />
        <MultiField<Priority> label="Priorities" noun="priority" options={priorities} value={value.priorities} onChange={(p) => set({ priorities: p })} />
        <MultiField<DuePreset> label="Due" noun="preset" options={dues} value={value.due} onChange={(due) => set({ due })} anyLabel="Any due date" />
      </div>
      <div className="flex flex-col gap-2">
        <MultiField<number | null> label="Tags" noun="tag" options={tagsWithNone} value={value.tagIds} onChange={(tagIds) => set({ tagIds })} />
        {tagCount >= 2 && (
          <SegmentedControl<'any' | 'all'>
            aria-label="Tag matching"
            size="sm"
            value={value.tagMode ?? 'any'}
            onChange={(tagMode) => set({ tagMode })}
            options={[
              { value: 'any', label: 'Any of these tags' },
              { value: 'all', label: 'All of these tags' },
            ]}
          />
        )}
      </div>
      <MultiField<number> label="Without tags" noun="tag" options={tags} value={value.excludeTagIds} onChange={(excludeTagIds) => set({ excludeTagIds })} anyLabel="None excluded" />
      <SearchField id={`${idPrefix}-search`} value={value.search ?? ''} onChange={(search) => set({ search })} />
      <ClosedField id={`${idPrefix}-closed`} value={value.closedWithinDays} onChange={(closedWithinDays) => set({ closedWithinDays })} />
      {archiveControls && (
        <>
          <Field label="Archived tasks" htmlFor={`${idPrefix}-archived`}>
            <SegmentedControl<'exclude' | 'include' | 'only'>
              aria-label="Archived tasks"
              size="sm"
              fullWidth
              value={value.archived ?? 'exclude'}
              onChange={(archived) => set({ archived: archived === 'exclude' ? undefined : archived })}
              options={[
                { value: 'exclude', label: 'Hide' },
                { value: 'include', label: 'Include' },
                { value: 'only', label: 'Only' },
              ]}
            />
          </Field>
          {scopeProjectId === null && (
            <Switch
              label="Include archived projects"
              description="Tasks of archived projects are hidden unless a project is listed above."
              checked={value.includeArchivedProjects ?? false}
              onCheckedChange={(on) => set({ includeArchivedProjects: on || undefined })}
            />
          )}
        </>
      )}
    </div>
  );
}
