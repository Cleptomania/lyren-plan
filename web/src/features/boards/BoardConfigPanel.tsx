// Board configuration drawer (full-screen on phones). Every change applies to the board
// immediately and saved boards autosave (useBoardConfig debounces ~400 ms) — no Save button.

import { Check, Kanban, List } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { CARD_COLOR_BY, CARD_FIELD_LABELS, CARD_FIELDS, type BoardConfig, type CardColorBy } from '@shared/board';
import { LIMITS } from '@shared/constants';
import { TASK_SORT_FIELDS, type TaskSortField } from '@shared/schemas';
import type { BoardDTO } from '@shared/types';
import { useUpdateBoard } from '../../api/boards';
import { Checkbox, Drawer, Field, Input, SegmentedControl, Select, Tabs, Textarea, toast } from '../../components/ui';
import type { ConfigSection } from './boardUi';
import { FilterEditor } from './FilterEditor';
import { GroupsEditor } from './GroupsEditor';
import type { ConfigUpdate } from './useBoardConfig';
import type { BoardModel } from './useBoardModel';

export interface BoardConfigPanelProps {
  open: boolean;
  onClose: () => void;
  section: ConfigSection;
  onSectionChange: (section: ConfigSection) => void;
  config: BoardConfig;
  setConfig: (update: ConfigUpdate) => void;
  model: BoardModel;
  /** Project board: project filter / grouping are fixed. */
  scopeProjectId: number | null;
  /** The saved board (name / description); null before a project's first board exists. */
  board: BoardDTO | null;
  /** This device shows the board as a list (phone toggle). */
  forcedList: boolean;
}

const SORT_FIELD_LABELS: Record<TaskSortField, string> = {
  manual: 'Manual order',
  priority: 'Priority',
  dueDate: 'Due date',
  startDate: 'Start date',
  createdAt: 'Created',
  updatedAt: 'Last updated',
  title: 'Title',
  number: 'Task number',
  estimate: 'Estimate',
  status: 'Status',
};

const COLOR_BY_LABELS: Record<CardColorBy, string> = {
  none: 'No color',
  project: 'Project',
  milestone: 'Milestone',
  epic: 'Epic',
  priority: 'Priority',
  status: 'Status',
  tag: 'First tag',
};

const always = () => true;

/**
 * Text input saved ~400 ms after typing stops (board name / description). A pending edit is
 * saved right away when the field unmounts (tab switch, Esc / Back closing the drawer), so
 * "Saved automatically" holds even before the debounce fires.
 */
function useDebouncedField(value: string, save: (v: string) => void, valid: (v: string) => boolean = always) {
  const [text, setText] = useState(value);
  const editing = useRef(false);
  const latest = useRef({ value, save, valid, text, saved: value });
  latest.current = { ...latest.current, value, save, valid, text };
  useEffect(() => {
    if (!editing.current) setText(value);
  }, [value]);
  useEffect(() => {
    const { value: current, valid: ok } = latest.current;
    if (text === current || !ok(text)) return;
    const t = window.setTimeout(() => {
      latest.current.saved = text;
      latest.current.save(text);
    }, 400);
    return () => window.clearTimeout(t);
  }, [text]);
  useEffect(
    () => () => {
      const { text: t, value: current, saved, valid: ok, save: commit } = latest.current;
      if (t !== current && t !== saved && ok(t)) commit(t);
    },
    [],
  );
  return {
    text,
    onChange: (v: string) => {
      editing.current = true;
      setText(v);
    },
    onBlur: () => {
      editing.current = false;
      if (!valid(text)) setText(latest.current.value);
    },
  };
}

const nonBlank = (v: string) => v.trim().length > 0;

function BoardDetails({ board }: { board: BoardDTO }) {
  const uid = useId();
  const { mutate } = useUpdateBoard();
  const save = (patch: { name?: string; description?: string }) => mutate({ id: board.id, ...patch }, { onError: (err) => toast.error(err) });
  const name = useDebouncedField(board.name, (v) => save({ name: v.trim() }), nonBlank);
  const description = useDebouncedField(board.description, (v) => save({ description: v }));
  return (
    <section className="flex flex-col gap-3">
      <Field label="Name" htmlFor={`${uid}-name`} required error={nonBlank(name.text) ? undefined : 'A board needs a name'}>
        <Input id={`${uid}-name`} size="sm" value={name.text} maxLength={LIMITS.boardNameMax} onChange={(e) => name.onChange(e.target.value)} onBlur={name.onBlur} />
      </Field>
      <Field label="Description" htmlFor={`${uid}-desc`} optional>
        <Textarea
          id={`${uid}-desc`}
          autoGrow
          minRows={2}
          maxRows={6}
          maxLength={2000}
          value={description.text}
          onChange={(e) => description.onChange(e.target.value)}
          onBlur={description.onBlur}
        />
      </Field>
    </section>
  );
}

function LayoutSection({ config, setConfig, board, forcedList }: Pick<BoardConfigPanelProps, 'config' | 'setConfig' | 'board' | 'forcedList'>) {
  const uid = useId();
  const manual = config.sort.field === 'manual';
  return (
    <div className="flex flex-col gap-6">
      {board && <BoardDetails board={board} />}
      <Field label="Layout" hint={forcedList ? 'This device shows boards as a list (toggle it in the filter bar).' : undefined}>
        <SegmentedControl<BoardConfig['layout']>
          aria-label="Layout"
          fullWidth
          value={config.layout}
          onChange={(layout) => setConfig((c) => ({ ...c, layout }))}
          options={[
            { value: 'kanban', label: 'Board', icon: <Kanban /> },
            { value: 'list', label: 'List', icon: <List /> },
          ]}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <Field label="Order cards by" htmlFor={`${uid}-sort`}>
          <Select
            id={`${uid}-sort`}
            size="sm"
            value={config.sort.field}
            options={TASK_SORT_FIELDS.map((f) => ({ value: f, label: SORT_FIELD_LABELS[f] }))}
            onChange={(e) => setConfig((c) => ({ ...c, sort: { ...c.sort, field: e.target.value as TaskSortField } }))}
          />
        </Field>
        <SegmentedControl<'asc' | 'desc'>
          aria-label="Sort direction"
          size="sm"
          fullWidth
          value={config.sort.dir}
          onChange={(dir) => setConfig((c) => ({ ...c, sort: { ...c.sort, dir } }))}
          options={[
            { value: 'asc', label: manual ? 'Top to bottom' : 'Ascending' },
            { value: 'desc', label: manual ? 'Reversed' : 'Descending' },
          ]}
        />
        <p className="text-xs text-fg-muted">
          {manual
            ? 'Drag cards to put them in order. The order is shared by every board and list.'
            : 'Dragging moves cards between groups; their order follows the sort.'}
        </p>
      </div>
    </div>
  );
}

function CardsSection({ config, setConfig }: Pick<BoardConfigPanelProps, 'config' | 'setConfig'>) {
  const uid = useId();
  const card = config.card;
  const set = (patch: Partial<BoardConfig['card']>) => setConfig((c) => ({ ...c, card: { ...c.card, ...patch } }));
  return (
    <div className="flex flex-col gap-6">
      <Field label="Density">
        <SegmentedControl<BoardConfig['card']['density']>
          aria-label="Card density"
          fullWidth
          value={card.density}
          onChange={(density) => set({ density })}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </Field>
      <Field label="Colored edge" htmlFor={`${uid}-color`}>
        <Select
          id={`${uid}-color`}
          size="sm"
          value={card.colorBy}
          options={CARD_COLOR_BY.map((c) => ({ value: c, label: COLOR_BY_LABELS[c] }))}
          onChange={(e) => set({ colorBy: e.target.value as CardColorBy })}
        />
      </Field>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1.5 text-[13px] font-medium text-fg">Show on cards</legend>
        <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
          {CARD_FIELDS.map((f) => (
            <Checkbox
              key={f}
              label={CARD_FIELD_LABELS[f]}
              checked={card.fields[f]}
              onCheckedChange={(on) => set({ fields: { ...card.fields, [f]: on } })}
              // Touch: 40px rows, so each row is its own target (no overlapping hit areas).
              className="pointer-coarse:min-h-10 pointer-coarse:items-center"
            />
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function BoardConfigPanel(props: BoardConfigPanelProps) {
  const { open, onClose, section, onSectionChange, config, setConfig, model, scopeProjectId, board, forcedList } = props;
  const uid = useId();
  const tabsId = `cfg${uid.replace(/:/g, '')}`;
  const listLayout = config.layout === 'list' || forcedList;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      modal={false}
      width="32rem"
      title={
        // The hint ellipsizes when the header is narrow (a bare text node in a flex row can't).
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">Configure board</span>
          <span className="flex min-w-0 items-center gap-1 text-xs font-normal text-fg-subtle">
            <Check aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">Saved automatically</span>
          </span>
        </span>
      }
      bodyClassName="flex flex-col"
    >
      <div className="sticky top-0 z-10 border-b border-border bg-popover px-4">
        <Tabs<ConfigSection>
          id={tabsId}
          aria-label="Board settings"
          value={section}
          onChange={onSectionChange}
          items={[
            { value: 'layout', label: 'Layout' },
            { value: 'filter', label: 'Filter' },
            { value: 'columns', label: 'Columns' },
            { value: 'lanes', label: 'Lanes', disabled: false },
            { value: 'cards', label: 'Cards' },
          ]}
        />
      </div>
      <div role="tabpanel" id={`${tabsId}-panel-${section}`} aria-labelledby={`${tabsId}-tab-${section}`} className="px-4 py-4 pb-safe-3">
        {section === 'layout' && <LayoutSection config={config} setConfig={setConfig} board={board} forcedList={forcedList} />}
        {section === 'filter' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-fg-muted">The board shows tasks matching all of these. Empty fields don’t filter.</p>
            <FilterEditor
              idPrefix={`${tabsId}-filter`}
              value={config.filter}
              onChange={(filter) => setConfig((c) => ({ ...c, filter: scopeProjectId === null ? filter : { ...filter, projectIds: [scopeProjectId] } }))}
              scopeProjectId={scopeProjectId}
            />
          </div>
        )}
        {section === 'columns' && (
          <GroupsEditor axis="columns" config={config} setConfig={setConfig} groups={model.editGroups.columns} ctx={model.ctx} scopeProjectId={scopeProjectId} />
        )}
        {section === 'lanes' &&
          (listLayout ? (
            <p className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-[13px] text-fg-muted">
              Swimlanes are not used in the list layout{forcedList && config.layout !== 'list' ? ' on this device' : ''}. Switch the layout to Board to use them.
            </p>
          ) : (
            <GroupsEditor axis="swimlanes" config={config} setConfig={setConfig} groups={model.editGroups.lanes} ctx={model.ctx} scopeProjectId={scopeProjectId} />
          ))}
        {section === 'cards' && <CardsSection config={config} setConfig={setConfig} />}
      </div>
    </Drawer>
  );
}
