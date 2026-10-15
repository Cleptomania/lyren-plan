// TaskList toolbar: search box, "Show closed" / "Show archived", sort and group menus, and the
// "Select" toggle. In a narrow toolbar (phones, the epic and milestone pages' column) the two
// toggles read "Closed" / "Archived" ("Show" stays in their accessible names).

import { clsx } from 'clsx';
import { ArrowDownWideNarrow, ArrowUpDown, ArrowUpNarrowWide, CheckSquare, Rows3, Search, X } from 'lucide-react';
import { LIMITS } from '@shared/constants';
import { TASK_SORT_FIELDS, type TaskSort } from '@shared/schemas';
import { Button, Checkbox, IconButton, Input, Menu, Spinner, type MenuItem } from '../../components/ui';
import { GROUP_BY_LABELS, SORT_FIELD_LABELS, type TaskListGroupBy } from './taskListModel';

const TOGGLE_CLASS = 'shrink-0 whitespace-nowrap px-1';

/** "Show closed", or just "Closed" in a narrow toolbar. */
function toggleLabel(word: string) {
  return (
    <>
      <span className="@max-[44rem]:sr-only">Show </span>
      <span className="@max-[44rem]:capitalize">{word}</span>
    </>
  );
}

export interface TaskListToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  showClosed: boolean;
  onShowClosedChange: (value: boolean) => void;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  groupBy: TaskListGroupBy;
  groupChoices: readonly TaskListGroupBy[];
  onGroupByChange: (groupBy: TaskListGroupBy) => void;
  /** Show the "Select" toggle. */
  selectable: boolean;
  selecting: boolean;
  onSelectingChange: (selecting: boolean) => void;
  /** A changed filter is loading (previous results are still shown). */
  fetching: boolean;
}

export function TaskListToolbar({
  search,
  onSearchChange,
  showClosed,
  onShowClosedChange,
  showArchived,
  onShowArchivedChange,
  sort,
  onSortChange,
  groupBy,
  groupChoices,
  onGroupByChange,
  selectable,
  selecting,
  onSelectingChange,
  fetching,
}: TaskListToolbarProps) {
  const sortItems: MenuItem[] = [
    { heading: 'Sort by' },
    ...TASK_SORT_FIELDS.map((field) => ({
      label: SORT_FIELD_LABELS[field],
      checked: sort.field === field,
      onSelect: () => onSortChange({ ...sort, field }),
    })),
    { separator: true },
    { label: 'Ascending', icon: <ArrowUpNarrowWide />, checked: sort.dir === 'asc', onSelect: () => onSortChange({ ...sort, dir: 'asc' }) },
    { label: 'Descending', icon: <ArrowDownWideNarrow />, checked: sort.dir === 'desc', onSelect: () => onSortChange({ ...sort, dir: 'desc' }) },
  ];
  const groupItems: MenuItem[] = [
    { heading: 'Group by' },
    ...groupChoices.map((g) => ({ label: GROUP_BY_LABELS[g], checked: groupBy === g, onSelect: () => onGroupByChange(g) })),
  ];
  const sortLabel = `${SORT_FIELD_LABELS[sort.field]}${sort.dir === 'desc' ? ' ↓' : ''}`;
  const groupLabel = groupBy === 'none' ? 'Group' : GROUP_BY_LABELS[groupBy];

  return (
    <div className="@container flex flex-wrap items-center gap-x-2 gap-y-2">
      <Input
        type="search"
        size="sm"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        maxLength={LIMITS.searchMax}
        aria-label="Filter tasks"
        placeholder="Filter tasks…"
        leadingIcon={<Search />}
        autoComplete="off"
        enterKeyHint="search"
        // The clear button below replaces the browser's own.
        inputClassName="[&::-webkit-search-cancel-button]:hidden"
        trailing={
          fetching ? (
            <span className="flex size-8 items-center justify-center">
              <Spinner size="sm" label="Loading" />
            </span>
          ) : search ? (
            <IconButton size="sm" aria-label="Clear filter" tooltip={false} icon={<X />} onClick={() => onSearchChange('')} />
          ) : undefined
        }
        className="min-w-0 basis-full md:max-w-80 md:flex-1 md:basis-64"
      />
      {/* flex-auto (not flex-1): the controls keep their natural width and the whole group
          wraps under the search box when both do not fit on one line. Narrow phones (≤ ~340px)
          put the two toggles on a line of their own; wrapping (and safe alignment) means the
          controls never spill past the left edge. */}
      <div className="flex min-w-0 flex-auto flex-wrap items-center justify-end-safe gap-x-1 gap-y-1">
        {/* gap-2: each checkbox's enlarged touch target stays clear of the label before it. */}
        <div
          className={clsx(
            'mr-auto flex shrink-0 items-center gap-2 md:mr-1',
            // When the buttons don't all fit next to the toggles, all of them go to line 2.
            selectable ? '@max-[20rem]:basis-full' : '@max-[17.5rem]:basis-full',
          )}
        >
          <Checkbox label={toggleLabel('closed')} checked={showClosed} onCheckedChange={onShowClosedChange} className={TOGGLE_CLASS} />
          <Checkbox
            label={toggleLabel('archived')}
            checked={showArchived}
            onCheckedChange={onShowArchivedChange}
            className={TOGGLE_CLASS}
          />
        </div>
        <Menu
          label="Sort"
          items={sortItems}
          trigger={
            <Button
              size="sm"
              variant="ghost"
              hideLabelOnMobile
              icon={<ArrowUpDown />}
              aria-label={`Sort: ${SORT_FIELD_LABELS[sort.field]}, ${sort.dir === 'asc' ? 'ascending' : 'descending'}`}
            >
              {sortLabel}
            </Button>
          }
        />
        <Menu
          label="Group"
          items={groupItems}
          trigger={
            <Button size="sm" variant="ghost" hideLabelOnMobile icon={<Rows3 />} aria-label={`Group by: ${GROUP_BY_LABELS[groupBy]}`}>
              {groupLabel}
            </Button>
          }
        />
        {selectable && (
          <Button
            size="sm"
            variant={selecting ? 'secondary' : 'ghost'}
            hideLabelOnMobile
            icon={<CheckSquare />}
            aria-pressed={selecting}
            onClick={() => onSelectingChange(!selecting)}
          >
            {selecting ? 'Done' : 'Select'}
          </Button>
        )}
      </div>
    </div>
  );
}
