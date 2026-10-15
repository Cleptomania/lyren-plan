# Domain components (`components/domain`)

How tasks and their metadata look and are edited everywhere: cards, rows, the shared task
menu, pickers, badges and labels. Built on `components/ui`; data comes from `useLookups()`.

```tsx
import { TaskCard, TaskRow, TaskActionsMenu, StatusPicker, DueDateLabel, taskActions } from '../../components/domain';
```

## Ground rules

| Topic | Rule |
|---|---|
| Data | Components read statuses / projects / epics / milestones / tags / settings from `useLookups()` themselves. You pass the **task** (or the entity for badges). Missing entities (stale ids) render nothing instead of crashing. |
| Editing tasks | All task edits from domain UI go through **`taskActions`** (optimistic `useUpdateTask`, error toast + rollback). `<TaskActionsHost />` executes them — **AppShell mounts it** (next to `ConfirmHost`); nothing to do in features. |
| Memoization | `TaskCard` / `TaskRow` are `React.memo`. Pass **stable** callbacks (`useCallback`) for `onOpen`, `onSelectedChange` and function-style `extraMenuItems`. `fields` and `hide` compare by content, so inline literals are fine. |
| Opening | Cards and rows open on click/tap anywhere (not links). Default `onOpen` = the task drawer (`?task=<id>`). Clicks on nested controls (status icon, checkbox, "⋯", menu items in portals) never open the task. |
| Touch | Cards/rows: `touch-action: manipulation`, no callout, no text selection — long press is free for dnd-kit's TouchSensor. The "⋯" menu is **always visible on touch** (`pointer: coarse`), on hover/focus with a mouse. |
| Colors | Entity colors via inline style; overdue / today use `danger` / `warning` tokens plus an icon and screen-reader text (never color alone). Status icons encode the category by **shape**. |
| Sizes | `size: 'sm' \| 'md'` on chips/labels (`sm` = 20px, cards/rows; `md` = 24px, drawer/forms). |

---

## Task presentation

### `TaskCard` (board card, SPEC §8.3)
```tsx
<TaskCard
  task={task}
  fields={config.card.fields}          // CardConfig['fields'] (partial OK); default = board defaults
  density={config.card.density}        // 'comfortable' (default) | 'compact'
  colorBy={config.card.colorBy}        // colored left edge: none|project|milestone|epic|priority|status|tag
  onOpen={openTask}                    // default: task drawer
  selected={selectedIds.has(task.id)}
  dragging={isDragging}                // dimmed placeholder, clicks ignored
  extraMenuItems={boardMenuItems}      // (task) => MenuItemInput[] — evaluated only when "⋯" opens
/>
```
Extra props: `overlay` (inside `DragOverlay`: lifted look, no menu, no clicks), `showMenu` (default true).
**Any other HTML prop and the `ref` go to the root `div`**, so dnd-kit can be wired directly. Follow
`useSortableItem` in features/boards/dnd.tsx: the root is both the sortable node AND the activator node,
and gets `role="group"` instead of dnd-kit's default `role="button"` (a button must not wrap the title
and "⋯" buttons):
```tsx
const SORTABLE_ATTRIBUTES = { role: 'group', roleDescription: 'Draggable task' } as const;
const { setNodeRef, setActivatorNodeRef, listeners, attributes, isDragging } =
  useSortable({ id: dndId, data, attributes: SORTABLE_ATTRIBUTES });
const ref = useCallback((el: HTMLDivElement | null) => { setNodeRef(el); setActivatorNodeRef(el); },
  [setNodeRef, setActivatorNodeRef]);
<TaskCard ref={ref} {...listeners} {...attributes} task={task} dragging={isDragging} extraMenuItems={boardMenuItems} />
// DragOverlay: <TaskCard task={activeTask} overlay colorBy={…} fields={…} density={…} />
```
The title is a `<button>` (keyboard: Tab + Enter opens). The "⋯" menu's wrapper stops pointer events
and the keys a card or the drag sensor act on (Enter, Space, arrows; `stopCardEvents`), so pressing "⋯"
never starts a drag, while other keys still reach global shortcuts (mod+K, `/`, `c`, `?`). The focused root is the keyboard drag handle (Space/Enter picks the
card up); the next Tab stop is the title, where Enter opens the task. That split relies on the
activator node: with `setActivatorNodeRef` on the root, dnd-kit's KeyboardSensor only starts a drag
for keys whose target IS the root. Without it (plain `useSortable` + `setNodeRef`), Enter on the title
bubbles up and picks the card up instead of opening it. Milestones have no color: `colorBy: 'milestone'`
uses a stable palette color per milestone. Closed tasks: muted title (cancelled also struck through).

### `TaskRow` (lists, board list layout, dashboard, search)
```tsx
<TaskRow
  task={task}
  hide={['project']}                    // drop redundant badges: 'project' | 'epic' | 'milestone' | 'status'
  fields={config.card.fields}           // board list layout: show exactly these (else row defaults)
  onOpen={openTask}
  selectable selected={sel.has(task.id)}
  onSelectedChange={(on, { shiftKey }) => toggle(task.id, on, shiftKey)}   // shiftKey for range selection
  extraMenuItems={…}
/>
```
Also `compact` (36px desktop rows), `showRef` (default true), `editable` (default true: status and
priority icons open pickers and save immediately), `showMenu`, `active` (highlight, e.g. the open task),
`dragging`. The layout follows the row's own width (container query), not the viewport. Rows ≥ 35rem:
one line `[☐] [priority] [ref] [status] title … tags epic milestone project due est 💬 [⋯]`; the title
keeps ≥ max(12rem, 40%) and chips that do not fit drop out whole (tags first). Narrower rows (phones,
narrow columns): status + 2-line title, metadata wrapped below (priority shown as an icon there).
Row defaults (`DEFAULT_ROW_FIELDS`): card defaults + status + estimate. Rows render a `div`; wrap them in
your own list (`<div className="divide-y divide-border">`).

### `TaskProgress` (alias `ProgressBar`, SPEC §9.1)
```tsx
<TaskProgress stats={epic.stats} label={epic.name} color={epic.color} />   // bar + "12/20 done · 60%"
<TaskProgress stats={milestone.stats} basis="estimate" />                  // "8/21 pts done · 38%"
```
`showText` (default true), `size`. Pure helper: `progressSummary(stats, basis?, unit?)`.

---

## Task actions (the non-drag way to change a task)

### `TaskActionsMenu` / `useTaskActions`
Menu: **Open · Status ▸ · Priority ▸ · Due date ▸** (Today / Tomorrow / Next week / Pick a date… / Clear) **·
Tags…** (dialog: search, toggle, create) **· Move to epic ▸** (this project's epics grouped by milestone +
"No epic") **· Move to project ▸ · [extra items] · Duplicate · Archive/Unarchive** (toast with Undo) **·
Delete…** (confirm). Current values are checked and shown as hints.
```tsx
<TaskActionsMenu task={task} />                                     // "⋯" IconButton
<TaskActionsMenu task={task} triggerVariant="compact" />            // 28px "⋯" with a 40px hit area
<TaskActionsMenu task={task} onOpen={false} onDeleted={() => navigate(projectUrl(task.projectId))} />  // task page / drawer
<TaskActionsMenu task={task} extraItems={(t) => [{ label: 'Move to column', items: … }]} trigger={<Button>Actions</Button>} />

const items = useTaskActions(task, extraItems, { onOpen: false });   // MenuItem[] for your own <Menu> / PageHeader menu
```
Props: `extraItems` (list or `(task) => list`, inserted before Duplicate/Archive/Delete), `onOpen`
(handler, or `false` to hide "Open"), `onDeleted` (after a confirmed delete; **without it** the host closes the
task drawer if it shows the deleted task), `trigger`, `triggerVariant`, `triggerClassName`, `placement`,
`open`/`onOpenChange`. Items are built only while the menu is open, so a menu per card is cheap.

### `taskActions` (imperative)
```tsx
taskActions.update(task, { statusId }, { success: 'Moved to Done', undo: { statusId: task.statusId } });
taskActions.setArchived(task, true);   // toast with Undo
taskActions.duplicate(task);           // toast with "Open"
taskActions.delete(task, { onDeleted });  // confirm first
taskActions.editTags(task);            // tag dialog
taskActions.pickDueDate(task);         // due-date dialog
taskActions.open(task);                // task drawer
```
Updates are optimistic (`useUpdateTask`); failures roll back with `toast.error`. Board extra items
("Move to column ▸" …) should call `taskActions.update(task, patch, { success })` too.

---

## Pickers and editors (controlled; each calls your `onChange`)

All pickers share `DomainPickerProps`: `label`, `trigger` (custom element), `triggerProps` (for the
default **`PropertyButton`** trigger: `fullWidth`, `bordered`, `chevron`, `size`, `className`, `disabled`),
`open`/`onOpenChange`, `placement`, `panelClassName`. Desktop: anchored popover with search (when > 7
options), keyboard ↑/↓/Enter/Esc. Phones/touch: bottom sheet with 48px rows.

| Component | Props | Notes |
|---|---|---|
| `StatusPicker` | `value: number`, `onChange(statusId)` | Position order, category icons. |
| `PriorityPicker` | `value: Priority`, `onChange(p)` | Urgent → Low, No priority last. |
| `ProjectPicker` | `value: number \| null`, `onChange(projectId)`, `includeArchived?`, `placeholder?` | Active projects (key as hint); archived under "Archived" when included. |
| `EpicPicker` | `projectId`, `value: number \| null`, `onChange(id \| null)`, `allowNone?` (true), `noneLabel?` | Grouped by milestone; "No epic" first. `projectId` may be one id, several, or null (all active). |
| `MilestonePicker` | `projectId`, `value`, `onChange`, `allowNone?`, `noneLabel?` | For epics (a task's milestone comes from its epic). |
| `TagPicker` | `value: number[]`, `onChange(ids)`, `allowCreate?` (true), `placeholder?`, `maxChips?` | Multi-select; "Create tag “…”" creates via `useCreateTag` (palette color by name) and selects it. Default trigger shows chips. |
| `TagPickerList` | same + `touch?`, `autoFocus?` | The list without a popup (dialogs, panels). |
| `DatePicker` | `value`, `onChange(date \| null)`, `kind?: 'due' \| 'start'`, `closed?`, `min?`, `max?`, `label?` | Property button ("Tomorrow", red when overdue) → quick dates, date input + "Set date", Clear. |
| `DateField` | `label`, `value`, `onChange`, `hint?`, `error?`, `required?`, `min?`, `max?`, `quickOptions?` (true) | Form field: labelled native date input + quick-date menu (Today / Tomorrow / Next week / Clear). |
| `EstimatePicker` | `value: number \| null`, `onChange`, `unit?` | Presets (1 2 3 5 8 13 pts / ½ 1 2 4 8 16 h) + custom value + Clear. |
| `EstimateField` | `value`, `onChange`, `label?`, `commitOn?: 'blur' \| 'change'`, `unit?` | Form field with unit suffix; hours accept "1h 30m". Use `commitOn="change"` in forms submitted with Enter. |

Unit defaults to `settings.estimateUnit`. "Next week" = first day of next week (`settings.weekStartsOn`),
same as a board drop patch's `due: 'next_week'`.

**Task property panel** (drawer) — compose the pickers, saving through `taskActions`:
```tsx
const save = (patch: TaskUpdateInput) => taskActions.update(task, patch);
<dl className="grid grid-cols-[6.5rem_1fr] items-center gap-y-0.5">
  <dt className="text-xs text-fg-muted">Status</dt>
  <dd><StatusPicker value={task.statusId} onChange={(statusId) => save({ statusId })} triggerProps={{ fullWidth: true }} /></dd>
  <dt className="text-xs text-fg-muted">Epic</dt>
  <dd><EpicPicker projectId={task.projectId} value={task.epicId} onChange={(epicId) => save({ epicId })} triggerProps={{ fullWidth: true }} /></dd>
  <dt className="text-xs text-fg-muted">Tags</dt>
  <dd><TagPicker value={task.tags.map((t) => t.id)} onChange={(tagIds) => save({ tagIds })} triggerProps={{ fullWidth: true }} /></dd>
  <dt className="text-xs text-fg-muted">Due</dt>
  <dd><DatePicker value={task.dueDate} closed={isClosed} onChange={(dueDate) => save({ dueDate })} min={task.startDate ?? undefined} triggerProps={{ fullWidth: true }} /></dd>
  …
</dl>
```

**Filters** (multi-select) — use the UI kit `Picker multiple` with the option builders:
```tsx
const options = useEpicOptions({ projectId: filter.projectIds, includeNone: true });   // null = "No epic"
<Picker<number | null> multiple label="Epics" options={options} value={filter.epicIds ?? []} onChange={…} trigger={…} />
```
Hooks: `useStatusOptions()`, `usePriorityOptions()`, `useProjectOptions({ includeArchived })`,
`useMilestoneOptions({ projectId, includeNone, noneLabel })`, `useEpicOptions(…)`, `useTagOptions()`.
Pure builders: `statusOptions(statuses)`, `priorityOptions()`, `projectOptions(projects, …)`,
`milestoneOptions(lookups, …)`, `epicOptions(lookups, …)`, `tagOptions(tags)`; `PRIORITY_ORDER` = `[4,3,2,1,0]`.

---

## Display

| Component | Props | Notes |
|---|---|---|
| `StatusIcon` | `status`, `fraction?`, `size?` (16), `label?` (default status name; `null` = decorative) | backlog dashed ○ · unstarted ○ · started ◔ (pie = `statusFraction(status, statuses)`) · completed ✓ · cancelled ✕. |
| `PriorityIcon` | `priority`, `size?`, `label?` | none "---" · low/med/high 1–3 bars · urgent "!" square. `priorityLabel(p)`, `priorityColor(p)`. |
| `StatusBadge` | `status`, `size?`, `plain?` | Icon + name. |
| `PriorityBadge` | `priority`, `hideNone?`, `size?`, `plain?` | Icon + "High". |
| `ProjectBadge` | `project`, `show?: 'key' \| 'name' \| 'both'`, `size?`, `plain?` | Color square + key (full name for screen readers). |
| `ProjectDot` | `project`, `size?` | Labelled color square. |
| `EpicBadge` / `EpicDot` | `epic` / `color` | Diamond in the epic color + name (truncates). |
| `MilestoneBadge` | `milestone` | Milestone icon + name; closed milestones muted. |
| `TagChip` | `tag`, `size?`, `onRemove?` | Dot + name; × button (40px hit area) when `onRemove`. |
| `TagList` | `tags`, `max?`, `size?`, `wrap?`, `onRemove?` | First `max` chips + "+k" (names in title / screen-reader text). |
| `DueDateLabel` | `date`, `today?`, `closed?`, `verbose?`, `size?`, `plain?` | "Today" (amber), "Tomorrow", "Fri, Oct 16", overdue red with alert icon + "Overdue, due …" for screen readers; `verbose` shows "Overdue · Oct 3" / "Due today". Closed tasks never overdue. |
| `StartDateLabel` | `date`, `today?` | Start icon + date. |
| `EstimateLabel` | `value`, `unit?` | "3 pts" / "4h". |
| `DurationLabel` | `minutes`, `srLabel?` | Clock + "1h 30m" (`formatMinutes`). |
| `CommentCountLabel` | `count` | Bubble + count. |
| `TaskRef` | `value` | Muted "LYR-42". |
| `UserAvatar` | `user` (`UserRef \| null`), `size?`, `showName?` | Initials; null → "Unknown user". |
| `Pill` | `icon?`, `trailing?`, `size?`, `tone?: 'subtle' \| 'muted' \| 'default' \| 'danger' \| 'warning'` (`subtle` for closed items: dimmer but still AA, never dim text with opacity), `plain?`, `textClassName?` | The chip all of the above use — for new metadata labels. |
| `PropertyButton` | `icon?`, `placeholder?`, `fullWidth?`, `bordered?`, `chevron?`, `size?`, `tone?` | Quiet left-aligned value button (picker trigger). |

## Pure helpers (unit-tested)

`taskColor(task, colorBy, lookups)` · `taskClosedKind(task, statusById)` / `taskIsClosed(…)` ·
`resolveFields(fields, defaults)` / `resolveRowFields(fields, hide, showRef)` · `DEFAULT_CARD_FIELDS` /
`DEFAULT_ROW_FIELDS` · `markdownExcerpt(md, max?)` (plain-text preview: inline code kept verbatim, tables flattened) · `paletteColor(seed)` ·
`tagPatch(before, after)` → `{ addTagIds?, removeTagIds? } | null` · `dueState(date, today, closed)` ·
`quickDates(today, weekStartsOn)` · `parseEstimateInput(text, unit)` · `progressSummary(stats, basis, unit)` ·
`groupEpicsByMilestone(lookups, projectIds)` / `epicGroupLabel` / `scopeProjectIds` · `statusFraction` ·
`buildTaskActionItems(task, ctx, actions, options)` · `isOpenClick(event)` (the card/row click guard) ·
`useSharedToday()` (local date, one shared timer for all cards).
