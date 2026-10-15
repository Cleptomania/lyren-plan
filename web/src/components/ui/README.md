# UI kit (`components/ui`) and layout (`components/layout`)

Everything feature pages are built from. Import from the barrel:

```tsx
import { Button, Dialog, Field, Input, toast, useConfirm } from '../../components/ui';
import { Page, FullBleedPage } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
```

## Conventions

| Topic | Rule |
|---|---|
| Sizes | `size: 'sm' \| 'md'` (default `md`). Mobile is always ≥ 40px tall (touch); desktop is denser (md 36px, sm 32px). |
| Variants | Buttons: `primary \| secondary \| ghost \| danger`. Badges: `neutral \| accent \| success \| warning \| danger \| outline`. |
| `className` | Always goes on the **outermost** element. Components with an inner input also take `inputClassName` / `bodyClassName`. |
| `onChange` | Native wrappers (`Input`, `Textarea`, `Select`, `PasswordInput`) forward native props → `onChange(event)`. Custom controls call `onChange(value)` (`SegmentedControl`, `Tabs`, `Picker`, `ColorPicker`, `DateInput`, `MarkdownEditor`). Booleans use `checked` + `onCheckedChange(checked)` (`Checkbox`, `Switch`). `InlineEdit` uses `onSave(value)`. |
| Refs | Buttons, inputs, `Card` forward refs. |
| Open state | Overlays are controlled with `open` + `onClose`. Anchored ones (`Menu`, `Popover`, `Picker`) are uncontrolled by default and accept `open` + `onOpenChange`. |
| Triggers | `Menu` / `Popover` / `Picker` / `Tooltip` take a single element (`trigger={<Button>…</Button>}`); its own `ref` and handlers are preserved. |
| Icons | lucide icons, passed as elements (`icon={<Plus />}`); sized automatically (16px). |
| Colors | Only semantic tokens (`bg-surface`, `text-fg-muted`, `border-border`, `bg-popover`, `text-danger-fg`…, see `index.css`). Entity colors via `color` props / inline styles. |

### Mobile behaviour in one paragraph
Below `md` (768px) **or** on touch-first devices (`pointer: coarse`, see `useSheetMode()`), `Menu`, `Picker`
and `Popover` render as **bottom sheets** with 48px rows. `Dialog` is **full-screen** on phones (or a bottom
sheet / compact card via `mobileLayout`), `Drawer` is always a full-screen sheet on phones. Phone dialogs,
drawers and every bottom sheet push a history entry so **Back closes the top overlay only** (`history` prop;
confirms too). Tooltips never show on touch.

### Overlays, Esc and Back
Every overlay registers with `useOverlay()` (lib/overlays): only the top overlay reacts to Esc, single-key
hotkeys are off while one is open. `MarkdownEditor` (with `onCancel`) and `InlineEdit` register while
focused/editing, so Esc cancels the edit instead of closing the drawer around them.

**Closing because you navigate**: overlays with a history entry use `history.back()` when closed, which is
async and races with `navigate()` or another overlay's entry. Inside a `Dialog` / `Drawer` / `Sheet` use:

```tsx
const controls = useOverlayControls(); // { close, closeForNavigation, closeThen, afterClose } | null
// The destination REPLACES the overlay's entry (closeForNavigation() is true when it has one):
onSuccess: (project) => navigate(projectUrl(project.id), { replace: controls?.closeForNavigation() ?? false });
// Anything else that touches history / opens an overlay runs once the entry is gone:
controls?.closeThen(() => selectBoard(board.id));
```

From outside the overlay pass `controlsRef={ref}` and call the same methods on `ref.current`. `Menu` items,
single-select `Picker` choices and `await confirm()` already run after the sheet / confirm entry is gone, so
they may navigate or open dialogs freely. URL updates in place (same path, e.g. `setSearchParams(…, { replace })`)
while a sheet is open are kept when Back closes it. A controlled dialog whose success handler navigates with
`{ replace: true }` (e.g. "deleted → leave the page") calls `ref.current.afterClose(navigateAway)` and then
closes, so the replace hits the page's entry, not the dialog's (features/projects/DeleteDialogs). Choosing the
page that is already showing just closes the overlay (`close()`), never navigates (no duplicate entry).

Overlay entries no open overlay owns (a reload with an overlay open, Forward onto a closed overlay's entry)
are skipped automatically, so Back never stalls on a copy of the same page.

**Ghost taps**: for `TAP_GUARD_MS` (350ms) after a modal overlay appears, its scrim ignores presses and its
panel ignores pointer input (`tap-guard` in index.css), so the second tap of a quick double tap on the action
that opened it doesn't cancel or activate anything in it.

---

## Actions

### `Button`, `ButtonLink`, `IconButton`
```tsx
<Button variant="primary" icon={<Plus />} loading={m.isPending} onClick={save}>Save</Button>
<Button size="sm" hideLabelOnMobile icon={<Settings />}>Settings</Button>   // icon-only below md
<ButtonLink to="/projects" variant="ghost">All projects</ButtonLink>          // react-router Link
<IconButton aria-label="Delete" icon={<Trash2 />} variant="ghost" />           // aria-label required; tooltip on desktop
```
Props: `variant`, `size`, `icon`, `trailingIcon`, `loading` (spinner + disabled), `fullWidth`,
`hideLabelOnMobile`; `type` defaults to `"button"`. `IconButton`: `tooltip` (`true` = aria-label, string, or
`false`), `pressed` (toggle state). Helpers `buttonClasses()` / `iconButtonClasses()` style other elements.

### `Menu` (SPEC §9.1)
```tsx
<Menu
  trigger={<IconButton aria-label="More actions" icon={<MoreHorizontal />} />}
  label="Task actions"
  items={[
    { label: 'Edit', icon: <Pencil />, hint: 'E', onSelect: edit },
    { label: 'Priority', icon: <Flag />, items: PRIORITIES.map((p) => ({ label: p.label, checked: p.value === task.priority, onSelect: () => setPriority(p.value) })) },
    { heading: 'Danger zone' },
    canDelete && { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: remove },
  ]}
/>
```
`MenuItem = { label, icon?, onSelect?, danger?, disabled?, checked?, hint?, items? } | { separator: true } | { heading }`.
Falsy entries are skipped; stray separators/empty headings/empty submenus are tidied. Desktop: arrow keys,
Home/End, typeahead, →/← for submenus (also hover), Esc closes one level, Tab closes. Phones/touch: bottom
action sheet, submenus drill in with a back row. Focus returns to the trigger **before** `onSelect` runs, so a
dialog opened from a menu restores focus correctly. `placement` (default `bottom-end`), `open`/`onOpenChange`.

## Form controls

### `Field`
Label + control + hint/error. Kit controls inside pick up `id`, `aria-describedby`, `aria-invalid`, `required`.
```tsx
<Field label="Name" required error={errors.name} hint="Shown on cards">
  <Input value={name} onChange={(e) => setName(e.target.value)} />
</Field>
```
Props: `label`, `hint`, `error`, `required`, `optional`, `hideLabel`, `labelAction`, `htmlFor`.
For custom controls call `useFieldControl(props)` and spread the result.

**Validation helpers** (`formErrors.ts`): `zodFieldErrors(zodError)` and `apiFieldErrors(err)` (ApiError
`details`) → `{ [path]: message }`; `hasFieldErrors(errors)`. Pattern:
```tsx
const parsed = schema.safeParse(values);
if (!parsed.success) return setErrors(zodFieldErrors(parsed.error));
create.mutate(parsed.data, { onError: (err) => { setErrors(apiFieldErrors(err)); toast.error(err); } });
```

### Inputs
| Component | Notes |
|---|---|
| `Input` | `size`, `leadingIcon`, `trailing`, `invalid`, `inputClassName`. Full width. |
| `PasswordInput` | Input with show/hide toggle. Set `autoComplete` (`current-password` / `new-password`). |
| `Textarea` | `autoGrow`, `minRows` (3), `maxRows` (16, 0 = unlimited). Measures off-screen (no scroll jumps). |
| `Select` | Native select (OS picker on phones). `options={[{ value, label }]}` or `<option>` children, `placeholder`. Values are strings. |
| `Checkbox` | `label`, `description`, `indeterminate`, `onCheckedChange`. Bare: pass `aria-label`. Enlarged hit area. |
| `Switch` | `checked`, `onCheckedChange`, `label`, `description` (label → full-width settings row), `size`. |
| `SegmentedControl` | `value`, `onChange`, `options=[{ value, label, icon? }]`, required `aria-label`, `fullWidth`, `iconOnlyOnMobile`. |
| `DateInput` | `value: 'YYYY-MM-DD' \| null`, `onChange(value \| null)`, `min`, `max`, `clearable` (default true). Native picker. |
| `ColorPicker` | `value`, `onChange(hex)`, `palette` (default `COLOR_PALETTE`), `allowCustom` (native color input + hex field). |
| `InlineEdit` | Click-to-edit text: `value`, `onSave(next)` (only when changed), `aria-label`, `required`, `maxLength`, controlled `editing`/`onEditingChange` (for a "Rename" menu item), `className` for typography. Enter/blur saves, Esc cancels. |

### `Picker` (combobox) — base of the domain pickers
```tsx
<Picker<number>
  label="Status"
  options={statuses.map((s) => ({ value: s.id, label: s.name, icon: <StatusIcon status={s} />, group: CATEGORY[s.category] }))}
  value={task.statusId}
  onChange={(statusId) => update({ statusId })}
  trigger={<Button size="sm">{status.name}</Button>}
/>

<Picker<number>
  multiple
  label="Tags"
  options={tagOptions}
  value={tagIds}
  onChange={setTagIds}
  onCreate={async (name) => { const tag = await createTag.mutateAsync({ name }); setTagIds([...tagIds, tag.id]); }}
  trigger={<Button size="sm">Tags</Button>}
/>
```
`PickerOption = { value, label, icon?, hint?, keywords?, group?, disabled? }` (value: string | number | null).
Search matches all tokens in label/keywords/hint; shown when > 7 options or `onCreate` (override with
`searchable`). Single select closes on choice; multi stays open (sheet has a Done button). Keyboard: ↑/↓,
Enter, Esc. `placeholder`, `emptyText`, `createLabel`, `placement`, `open`/`onOpenChange`, `className` (desktop
panel width, default `w-64`). `PickerList` is the same list without the popup, for embedding.

## Overlays

### `Dialog`
```tsx
<Dialog
  open={open}
  onClose={() => setOpen(false)}
  title="New project"
  description="Projects group milestones, epics and tasks."
  onSubmit={submit}                     // wraps content in a <form>; footer submit buttons work
  footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" loading={m.isPending}>Create</Button></>}
>
  …fields…
</Dialog>
```
`size` (`sm` 24rem · `md` 32rem · `lg` 42rem · `xl` 56rem), `mobileLayout` (`fullscreen` default · `sheet` ·
`center`), `initialFocus` (default: first form field, else the dialog), `history` (default: true on phones,
any layout), `closeOnOutsideClick` (default true — set false for forms that confirm discarding),
`headerActions`, `hideCloseButton`, `controlsRef`, `bodyClassName`. Focus trap + restore, scroll lock.

### `Drawer`
Right (or left) side panel; full-screen sheet on phones. The body is the scroll container (sticky children
stick to it, e.g. a composer with `sticky bottom-0`).
```tsx
<Drawer open={!!taskId} onClose={closeTask} modal={false} history={false} width="36rem" header={<TaskDrawerHeader />} initialFocus={titleRef}>
  …
</Drawer>
```
`title` (default header) or `header` (custom, safe-area padding added on phones), `footer`, `width` (desktop,
default 36rem), `side`, `modal` (desktop only; `false` = no scrim, page stays interactive, focus not trapped),
`initialFocus` (default: the panel; focus returns to the opener), `history` (default true on phones — pass
`false` when the URL already tracks it, as the task drawer does with `?task=`), `aria-label`, `controlsRef`.

### `Sheet`
Bottom sheet (centered card on wide screens): `open`, `onClose`, `title` or `aria-label`, `footer`,
`showClose`, `history` (default **true**: Back closes it), `initialFocus` (default the sheet, so no keyboard
pops up), `controlsRef`, `bottomInset` (phones: a CSS length kept free below the sheet for chrome that stays
usable above the scrim — the "More" sheet rests on the tab bar with `var(--bottom-bar-h)`). Such chrome is
for touch only: the modal sheet keeps it out of the accessibility tree, so the sheet needs its own way to
close (the "More" sheet has a Close button; Esc works too) and the chrome leaves the Tab order meanwhile.

### `Popover`
```tsx
<Popover title="Color" trigger={<Button icon={<ColorDot color={color} />}>Color</Button>}>
  {({ close }) => <ColorPicker value={color} onChange={(c) => { setColor(c); close(); }} />}
</Popover>
```
`placement` (default `bottom-start`), `className` (panel; default `w-72 p-3`), `sheetOnMobile` (default true),
`initialFocus` (default first focusable), `open`/`onOpenChange`.

### `useConfirm()` / `ConfirmDialog`
```tsx
const confirm = useConfirm();
if (!(await confirm({ title: 'Delete project?', body: 'All tasks are deleted.', confirmLabel: 'Delete', danger: true, typeToConfirm: project.key }))) return;
```
Options: `title`, `body?`, `confirmLabel?` (default Confirm), `cancelLabel?`, `danger?` (red button, Cancel
focused), `typeToConfirm?`. Resolves `false` on cancel/Esc/scrim. Rendered by `<ConfirmHost />` (mounted by
AppShell). `<ConfirmDialog open onConfirm onCancel busy … />` is the controlled variant.

### `toast`
```tsx
toast.success('Task deleted', { action: { label: 'Undo', onClick: restore } });
toast.error(err);           // ApiError / Error / string → readable message
toast.info('Copied link');
toast.dismiss(id);          // every call returns the id
```
`durationMs` (default 4s; 6s for errors and toasts with an action; 0 = sticky). Identical visible toasts are
merged (×2). Max 3 visible; bottom-right on desktop, above the tab bar on phones. `<Toaster />` is mounted once (AuthedApp).

Toasts draw above every overlay (so Undo / Open stay reachable) but never sit on a control of an open
panel. Every Dialog / Sheet / Drawer / palette panel registers itself while open (`useModal`, option
`toastObstacle`: `'modal'` by default, `'docked'` for the non-modal desktop drawer), and the Toaster
(`toastPlacement.ts`) keeps the usual spot when the panel isn't there, else moves the stack right above
the panel (a bottom sheet, a centred card: over the scrim), beside a docked drawer, into the free band of a
full-screen panel nearest the usual spot (no button, field or link under it — usually above a pinned footer
or composer), and only as a last resort to the top edge over the panel's header. Panels are measured where
they settle (their untransformed box, `settledPanel`), so a panel that is still sliding in counts. The stack
re-places when toasts come or go, a panel opens, ends its enter transition, resizes, changes content (a
composer expanding, a field mounting late) or gets focus, and when the window resizes — at most once a
frame, and not while a panel scrolls.

### `Tooltip`
`<Tooltip content="Archived tasks are hidden"><button…/></Tooltip>` — desktop hover (450ms) / keyboard focus
only, never on touch; must never be the only way to get information. `placement`, `delay`, `describe` (adds
`aria-describedby`), `disabled`. Cheap: nothing floating mounts until hovered.

## Display

| Component | Props / notes |
|---|---|
| `Badge` | `variant`, `color` (entity hex → soft tinted chip), `size`, `icon`. |
| `ColorDot` | `color`, `size` (`xs \| sm \| md`), `square`, `label` (else decorative). |
| `Avatar` | `name` (initials), `size` (`xs`–`lg`). Decorative. |
| `Kbd`, `Shortcut` | `<Shortcut combo="mod+k" />` → ⌘K / Ctrl K, hidden on touch. `formatShortcut('mod+enter')` for strings (menu `hint`s). |
| `ProgressBar` | `value`, `total` (default 100), `label`, `showValue` (`'percent' \| 'fraction'`), `color`, `size`. role=progressbar. |
| `Spinner` | `size` (`xs`–`lg`), `label` (`null` = decorative). Uses currentColor. |
| `Skeleton` | `className` sets size/shape. `SkeletonText {lines}`, `SkeletonList {rows, withIcon}` announce "Loading". |
| `EmptyState` | `icon`, `title`, `body`, `action`, `size` (`sm` in cards, `md` pages). |
| `ErrorState` | `error` (anything thrown), `onRetry`, `title`, `size`. Offline errors get offline wording. |
| `Card` | `padding` (`none \| sm \| md \| lg`), `interactive`. `CardHeader {title, description, icon, actions}`. |
| `Section` | Titled page block: `title`, `description`, `actions`, `level`. |
| `Disclosure` | Collapsible: `title`, `count`, `actions`, `defaultOpen` (true) or `open`/`onOpenChange`. |
| `ListGroup` / `ListRow` | Divided card list. Row: `title`, `description`, `icon`, `meta`, `actions`, `to` (link) or `onClick`, `chevron`. |
| `Tabs` | Local: `value`, `onChange`, `items=[{ value, label, count?, icon?, disabled? }]`, `id` (aria wiring). |
| `RouteTabs` | NavLink tabs: `tabs=[{ to, label, end?, count?, icon? }]`. Both scroll horizontally on phones and fade the edge where tabs are scrolled out of view (`edge-fade`). |

### `Markdown` / `MarkdownEditor`
```tsx
<Markdown source={task.description} />
<MarkdownEditor value={draft} onChange={setDraft} onSubmit={send} onCancel={reset} placeholder="Leave a comment…"
  actions={<Button size="sm" variant="primary" onClick={send} disabled={!draft.trim()}>Comment</Button>} />
```
`Markdown`: GFM (tables, task lists, strikethrough), raw HTML shown as text, links open in a new tab
(`rel="noopener noreferrer"`), non-same-origin images become links; class `markdown`; renderer lazy-loaded
(plain text until then; `preloadMarkdown()` to warm it). `MarkdownEditor`: Write/Preview, toolbar (bold, italic,
code, link, lists, checklist — code/numbered hidden on phones), mod+B/I, Enter continues lists, mod+Enter →
`onSubmit`, Esc → `onCancel` (while focused). `minRows` (4), `maxRows` (20), `toolbar`, `actions`, `autoFocus`,
`disabled`, `maxLength`, `textareaRef`, `id` (works inside `Field`). Edits keep the native undo stack.

---

## Layout (`components/layout`)

### `Page` / `FullBleedPage`
```tsx
export default function ProjectsPage() {
  useDocumentTitle('Projects');
  return (
    <Page width="wide" header={<PageHeader title="Projects" actions={<Button variant="primary" icon={<Plus />} hideLabelOnMobile>New project</Button>} />}>
      …
    </Page>
  );
}
```
Pages scroll the **document**. `width`: `narrow` 48rem · `default` 64rem · `wide` 80rem · `full`; the header's
content aligns with it. Board pages use `<FullBleedPage header={…}>` — a fixed `100dvh`-based column (minus
the phone tab bar / offline banner); its child area is `flex-1 min-h-0` — put your own scroller inside
(`h-full overflow-auto`). Inner scrollers on phones should end with `pb-[var(--fab-space)]` so the "+"
button covers nothing.

### `PageHeader` (SPEC §9.1)
`{ title, subtitle?, icon?, backTo?, breadcrumbs?: {label, to?}[], actions?, menu?: MenuItem[], tabs?: {to, label, end?, count?}[], children?, sticky? }`
Sticky (safe-area aware). Breadcrumbs show on desktop; phones show ← (`backTo`, else the last linked crumb).
`menu` renders a "⋯" Menu at the end. Keep `actions` to ~2 compact items on phones (use `hideLabelOnMobile`,
move the rest into `menu`). `children` renders an extra row (filters) above the tabs.

### AppShell (mounted by AuthedApp)
Desktop: collapsible sidebar (`lyren.sidebar.collapsed` in localStorage; `toggle-nav` event toggles it).
Phones: bottom tab bar (Home · Projects · Boards · Search · More), "More" sheet (`toggle-nav` event), floating
"+" (hidden while an overlay is open or a text field is focused). "New task" buttons prefill the current
project/epic (`createTaskDefaultsForPath`). Offline banner. Also mounts `<ConfirmHost />`.
CSS variables on `<html>`: `--bottom-bar-h`, `--offline-h`, `--fab-space` (0px on desktop); utilities
`h-app-screen`, `pb-app-chrome`, `pb-app-bars`, `pb-safe-3`, `pt-safe-3` (index.css).

Also: `AppMark` (logo), `FullPageSpinner`, `PageSpinner`, `FullPageError` (FullPage.tsx).
