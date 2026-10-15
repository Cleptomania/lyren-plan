// Config panel → Columns / Lanes: group-by field, visibility toggles, the group list (order by
// drag or ↑/↓, hide, collapse, WIP limits) and, for custom grouping, adding / editing /
// removing custom groups (name, color, match filter, drop patch with landing warnings).

import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ChevronsDownUp, Eye, EyeOff, GripVertical, Pencil, Plus, Trash2, TriangleAlert, Wand2 } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  activePrefs,
  COLUMN_GROUP_FIELDS,
  GROUP_FIELD_LABELS,
  newCustomColumnId,
  OTHER_GROUP_KEY,
  SWIMLANE_GROUP_FIELDS,
  type BoardConfig,
  type ColumnGroupField,
  type CustomColumn,
  type DropPatch,
  type SwimlaneGroupField,
} from '@shared/board';
import { LIMITS } from '@shared/constants';
import { useLookups } from '../../api/bootstrap';
import { Button, ColorDot, ColorPicker, Field, IconButton, Input, Popover, SegmentedControl, Select, Switch, useConfirm } from '../../components/ui';
import {
  addCustomGroup,
  clashesWithColumns,
  moveAmongVisible,
  parseWipLimit,
  removeCustomGroup,
  setColumnsGroupBy,
  setGroupCollapsed,
  setGroupHidden,
  setGroupOrder,
  setLanesGroupBy,
  setWipLimit,
  updateCustomGroup,
  WIP_LIMIT_MAX,
  type AxisName,
} from './configOps';
import { dropPatchFromMatch, dropPatchWarnings } from './customDrop';
import { DropPatchEditor } from './DropPatchEditor';
import { FilterEditor } from './FilterEditor';
import type { BoardContext, BoardGroup } from './grouping';
import { GroupIcon, GroupLabel } from './parts';
import type { ConfigUpdate } from './useBoardConfig';

export interface GroupsEditorProps {
  axis: AxisName;
  config: BoardConfig;
  setConfig: (update: ConfigUpdate) => void;
  /** Every group of this axis (hidden ones included) as the saved config sees it: model.editGroups (quick filters ignored). */
  groups: readonly BoardGroup[];
  ctx: BoardContext;
  scopeProjectId: number | null;
}

const NONE_FIELDS = new Set(['milestone', 'epic', 'tag']);

// ---------------------------------------------------------------------------
// WIP input
// ---------------------------------------------------------------------------

/**
 * WIP limit field: applies a valid value shortly after typing stops, on blur / Enter, and when
 * it unmounts (Esc or Back close the panel without a blur); invalid text reverts on blur.
 */
function WipInput({ group, limit, onChange }: { group: BoardGroup; limit: number | undefined; onChange: (n: number | null) => void }) {
  const shown = limit ? String(limit) : '';
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const latest = useRef({ text, limit, onChange });
  latest.current = { text, limit, onChange };
  /** Apply `t` when valid (false when invalid); unchanged values are not re-saved. */
  const apply = useCallback((t: string): boolean => {
    const next = parseWipLimit(t);
    if (next === undefined) return false;
    const { limit: current, onChange: save } = latest.current;
    if ((next ?? undefined) !== current) save(next);
    return true;
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => apply(text), 600);
    return () => window.clearTimeout(t);
  }, [text, apply]);
  useEffect(() => () => void apply(latest.current.text), [apply]);
  const commit = () => {
    if (!apply(text)) setText(shown);
  };
  return (
    <div className="w-20 shrink-0">
      <Input
        size="sm"
        type="number"
        inputMode="numeric"
        min={1}
        max={WIP_LIMIT_MAX}
        placeholder="WIP"
        aria-label={`WIP limit for ${group.label}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom group editor
// ---------------------------------------------------------------------------

type DropMode = 'set' | 'reorder' | 'none';

function CustomGroupEditor({
  col,
  axis,
  setConfig,
  ctx,
  scopeProjectId,
}: {
  col: CustomColumn;
  axis: AxisName;
  setConfig: (update: ConfigUpdate) => void;
  ctx: BoardContext;
  scopeProjectId: number | null;
}) {
  const uid = useId();
  const lookups = useLookups();
  const [name, setName] = useState(col.name);
  useEffect(() => setName(col.name), [col.name]);
  const update = (patch: Partial<CustomColumn>) => setConfig((c) => updateCustomGroup(c, axis, col.id, patch));
  // `{}` means reorder-only; "Change fields" with nothing chosen yet is shown as an empty editor.
  const [wantFields, setWantFields] = useState(false);
  const hasFields = col.onDrop !== null && Object.keys(col.onDrop).length > 0;
  const mode: DropMode = col.onDrop === null ? 'none' : hasFields || wantFields ? 'set' : 'reorder';
  const suggested = useMemo(() => dropPatchFromMatch(col.match, lookups), [col.match, lookups]);
  const warnings = useMemo(
    () => (col.onDrop && mode === 'set' ? dropPatchWarnings(col.match, col.onDrop, ctx) : []),
    [col.match, col.onDrop, mode, ctx],
  );
  const epic = typeof col.onDrop?.epicId === 'number' ? lookups.epicById.get(col.onDrop.epicId) : undefined;
  const epicConflict = !!(epic && col.onDrop?.projectId !== undefined && epic.projectId !== col.onDrop.projectId);

  return (
    <div className="flex flex-col gap-4 border-t border-border bg-bg/60 px-3 py-3">
      <div className="flex items-end gap-2">
        <Field label="Name" htmlFor={`${uid}-name`} className="min-w-0 flex-1">
          <Input
            id={`${uid}-name`}
            size="sm"
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value);
              if (e.target.value.trim()) update({ name: e.target.value.trim() });
            }}
          />
        </Field>
        <Popover
          title="Color"
          trigger={
            <Button size="sm" aria-label={`Color of ${col.name}`} icon={col.color ? <ColorDot color={col.color} /> : <ColorDot color="#94a3b8" />}>
              <span className="max-md:sr-only">Color</span>
            </Button>
          }
        >
          {({ close }) => (
            <div className="flex flex-col gap-3">
              <ColorPicker
                value={col.color ?? '#64748b'}
                onChange={(color) => {
                  update({ color });
                  close();
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  update({ color: null });
                  close();
                }}
              >
                No color
              </Button>
            </div>
          )}
        </Popover>
      </div>

      <section className="flex flex-col gap-2">
        <h4 className="text-[13px] font-semibold text-fg">Tasks in this group</h4>
        <p className="text-xs text-fg-muted">
          A task goes to the first group whose conditions it meets{axis === 'columns' ? ' (left to right)' : ' (top to bottom)'}. Archived tasks
          count here only when the board shows them.
        </p>
        <FilterEditor
          idPrefix={`${uid}-match`}
          value={col.match}
          onChange={(match) => {
            // Keep the drop patch in step with the match while it is still the suggested one.
            const prev = dropPatchFromMatch(col.match, lookups);
            const follow = col.onDrop !== null && JSON.stringify(col.onDrop) === JSON.stringify(prev);
            update(follow ? { match, onDrop: dropPatchFromMatch(match, lookups) } : { match });
          }}
          scopeProjectId={scopeProjectId}
          archiveControls={false}
          compact
        />
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-[13px] font-semibold text-fg">When a task is dropped here</h4>
        <SegmentedControl<DropMode>
          aria-label="Drop behaviour"
          size="sm"
          fullWidth
          value={mode}
          onChange={(m) => {
            setWantFields(m === 'set');
            update({ onDrop: m === 'none' ? null : m === 'reorder' ? {} : hasFields ? col.onDrop : suggested });
          }}
          options={[
            { value: 'set', label: 'Change fields' },
            { value: 'reorder', label: 'Reorder only' },
            { value: 'none', label: 'No drops' },
          ]}
        />
        {mode === 'reorder' && <p className="text-xs text-fg-muted">Cards can be reordered here, but not dropped in from other groups.</p>}
        {mode === 'none' && <p className="text-xs text-fg-muted">This group isn’t a drop target.</p>}
        {mode === 'set' && col.onDrop && (
          <>
            <DropPatchEditor idPrefix={`${uid}-drop`} value={col.onDrop} onChange={(onDrop: DropPatch) => update({ onDrop })} scopeProjectId={scopeProjectId} />
            {Object.keys(suggested).length > 0 && JSON.stringify(suggested) !== JSON.stringify(col.onDrop) && (
              <Button size="sm" variant="ghost" icon={<Wand2 />} onClick={() => update({ onDrop: suggested })} className="self-start">
                Fill in from the conditions
              </Button>
            )}
            {(warnings.length > 0 || epicConflict) && (
              <ul className="flex flex-col gap-1 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
                {epicConflict && (
                  <li className="flex gap-1.5">
                    <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                    The epic belongs to another project, so tasks can’t be dropped here.
                  </li>
                )}
                {warnings.map((w) => (
                  <li key={w} className="flex gap-1.5">
                    <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
                    <span>
                      <span className="sr-only">Warning: </span>
                      {w}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group rows
// ---------------------------------------------------------------------------

interface RowProps {
  axis: AxisName;
  group: BoardGroup;
  field: ColumnGroupField | SwimlaneGroupField;
  index: number;
  total: number;
  sortable: boolean;
  wip?: number;
  custom?: CustomColumn;
  editing: boolean;
  onEdit: (on: boolean) => void;
  onMove: (delta: -1 | 1) => void;
  setConfig: (update: ConfigUpdate) => void;
  ctx: BoardContext;
  scopeProjectId: number | null;
}

function GroupRow({ axis, group, field, index, total, sortable, wip, custom, editing, onEdit, onMove, setConfig, ctx, scopeProjectId }: RowProps) {
  const confirm = useConfirm();
  const { setNodeRef, setActivatorNodeRef, listeners, attributes, transform, transition, isDragging } = useSortable({
    id: group.key,
    disabled: !sortable,
  });
  const noun = axis === 'columns' ? 'column' : 'lane';
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={clsx('rounded-lg border border-border bg-surface', isDragging && 'relative z-10 shadow-drag')}
    >
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 py-1 pl-1 pr-1.5">
        <div className="flex min-w-[9rem] flex-1 items-center gap-1.5">
          {sortable ? (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...listeners}
              {...attributes}
              aria-label={`Reorder ${group.label}`}
              className="flex size-10 shrink-0 cursor-grab touch-manipulation items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg md:size-8"
            >
              <GripVertical aria-hidden className="size-4" />
            </button>
          ) : (
            <span className="size-10 shrink-0 md:size-8" />
          )}
          <GroupIcon field={field} group={group} />
          <GroupLabel group={group} className={clsx('text-[13px]', group.hidden && 'opacity-60')} />
          <span className="shrink-0 text-xs tabular-nums text-fg-subtle">{group.count}</span>
          {group.stale && <span className="shrink-0 text-xs text-fg-subtle">(not in scope)</span>}
        </div>
        <div className="flex items-center gap-0.5">
          {axis === 'columns' && <WipInput group={group} limit={wip} onChange={(n) => setConfig((c) => setWipLimit(c, group.key, n))} />}
          <IconButton
            size="sm"
            aria-label={group.collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
            pressed={group.collapsed}
            icon={<ChevronsDownUp />}
            onClick={() => setConfig((c) => setGroupCollapsed(c, axis, group.key, !group.collapsed))}
          />
          <IconButton
            size="sm"
            aria-label={group.hidden ? `Show ${group.label}` : `Hide ${group.label}`}
            pressed={group.hidden}
            icon={group.hidden ? <EyeOff /> : <Eye />}
            onClick={() => setConfig((c) => setGroupHidden(c, axis, group.key, !group.hidden))}
          />
          <IconButton size="sm" aria-label={`Move ${group.label} up`} icon={<ArrowUp />} disabled={!sortable || index === 0} onClick={() => onMove(-1)} />
          <IconButton size="sm" aria-label={`Move ${group.label} down`} icon={<ArrowDown />} disabled={!sortable || index >= total - 1} onClick={() => onMove(1)} />
          {custom && (
            <>
              <IconButton size="sm" aria-label={`Edit ${group.label}`} aria-expanded={editing} pressed={editing} icon={<Pencil />} onClick={() => onEdit(!editing)} />
              <IconButton
                size="sm"
                aria-label={`Remove ${group.label}`}
                icon={<Trash2 />}
                onClick={async () => {
                  const ok = await confirm({ title: `Remove the ${noun} “${group.label}”?`, body: 'Tasks are not changed.', confirmLabel: 'Remove', danger: true });
                  if (ok) setConfig((c) => removeCustomGroup(c, axis, custom.id));
                }}
              />
            </>
          )}
        </div>
      </div>
      {custom && editing && <CustomGroupEditor col={custom} axis={axis} setConfig={setConfig} ctx={ctx} scopeProjectId={scopeProjectId} />}
    </li>
  );
}

// ---------------------------------------------------------------------------

export function GroupsEditor({ axis, config, setConfig, groups, ctx, scopeProjectId }: GroupsEditorProps) {
  const uid = useId();
  const a = config[axis];
  const field = a.groupBy;
  const isCustom = field === 'custom';
  const [editing, setEditing] = useState<string | null>(null);
  const noun = axis === 'columns' ? 'column' : 'lane';
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const fieldOptions = (axis === 'columns' ? COLUMN_GROUP_FIELDS : SWIMLANE_GROUP_FIELDS)
    .filter((f) => f !== 'project' || scopeProjectId === null || f === field)
    .filter((f) => axis === 'columns' || !clashesWithColumns(config.columns.groupBy, f as SwimlaneGroupField))
    .map((f) => ({ value: f, label: GROUP_FIELD_LABELS[f] }));

  const keys = groups.map((g) => g.key);
  const sortableKeys = isCustom ? keys.filter((k) => k !== OTHER_GROUP_KEY && a.custom.some((c) => c.id === k)) : keys;
  const prefs = activePrefs(a);
  const customById = new Map(a.custom.map((c) => [c.id, c]));

  const move = (key: string, delta: -1 | 1) => setConfig((c) => setGroupOrder(c, axis, moveAmongVisible(sortableKeys, sortableKeys, key, delta)));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = sortableKeys.indexOf(String(active.id));
    const to = sortableKeys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = [...sortableKeys];
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));
    setConfig((c) => setGroupOrder(c, axis, next));
  };

  const addCustom = () => {
    const id = newCustomColumnId();
    setConfig((c) => addCustomGroup(c, axis, { id, name: `New ${noun}`, color: null, match: {}, onDrop: {} }));
    setEditing(id);
  };

  return (
    <div className="flex flex-col gap-5">
      <Field label={axis === 'columns' ? 'Columns show' : 'Swimlanes show'} htmlFor={`${uid}-groupby`}>
        <Select
          id={`${uid}-groupby`}
          size="sm"
          value={field}
          options={fieldOptions.map((o) => ({ value: o.value, label: o.value === 'none' ? 'No swimlanes' : o.label }))}
          onChange={(e) =>
            setConfig((c) =>
              axis === 'columns' ? setColumnsGroupBy(c, e.target.value as ColumnGroupField) : setLanesGroupBy(c, e.target.value as SwimlaneGroupField),
            )
          }
        />
      </Field>

      {field !== 'none' && (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface px-3">
          {!isCustom && (
            <Switch
              label={`Show empty ${noun}s`}
              checked={a.showEmpty}
              onCheckedChange={(showEmpty) => setConfig((c) => ({ ...c, [axis]: { ...c[axis], showEmpty } }) as BoardConfig)}
            />
          )}
          {NONE_FIELDS.has(field) && (
            <Switch
              label={`Show “${field === 'tag' ? 'No tags' : field === 'epic' ? 'No epic' : 'No milestone'}”`}
              checked={a.showNone}
              onCheckedChange={(showNone) => setConfig((c) => ({ ...c, [axis]: { ...c[axis], showNone } }) as BoardConfig)}
            />
          )}
          {isCustom && (
            <Switch
              label="Show “Other”"
              description="Tasks that match no custom group."
              checked={a.showUnmatched}
              onCheckedChange={(showUnmatched) => setConfig((c) => ({ ...c, [axis]: { ...c[axis], showUnmatched } }) as BoardConfig)}
            />
          )}
        </div>
      )}

      {field !== 'none' && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-fg">{axis === 'columns' ? 'Columns' : 'Lanes'}</h3>
            {isCustom && (
              <Button size="sm" icon={<Plus />} onClick={addCustom} disabled={a.custom.length >= LIMITS.customColumnsMax}>
                Add {noun}
              </Button>
            )}
          </div>
          {isCustom && a.custom.length === 0 && (
            <p className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-center text-[13px] text-fg-muted">
              No custom {noun}s yet. Add one and choose which tasks it holds.
            </p>
          )}
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={sortableKeys} strategy={verticalListSortingStrategy}>
              <ul className="flex flex-col gap-1.5">
                {groups.map((g) => {
                  const custom = customById.get(g.key);
                  const sortable = sortableKeys.includes(g.key);
                  return (
                    <GroupRow
                      key={g.key}
                      axis={axis}
                      group={g}
                      field={field}
                      index={sortableKeys.indexOf(g.key)}
                      total={sortableKeys.length}
                      sortable={sortable}
                      wip={prefs.wipLimits[g.key]}
                      custom={custom}
                      editing={editing === g.key}
                      onEdit={(on) => setEditing(on ? g.key : null)}
                      onMove={(d) => move(g.key, d)}
                      setConfig={setConfig}
                      ctx={ctx}
                      scopeProjectId={scopeProjectId}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
          {!isCustom && <p className="text-xs text-fg-muted">Drag or use the arrows to reorder. Hidden {noun}s keep their tasks out of view.</p>}
        </section>
      )}
    </div>
  );
}
