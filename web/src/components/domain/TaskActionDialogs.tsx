// Dialogs opened from the task menu ("Tags…", "Due date ▸ Pick a date…"). Rendered by
// TaskActionsHost; changes are applied on Save as one PATCH.

import { useState } from 'react';
import type { ISODate } from '@shared/dates';
import { isValidISODate } from '@shared/dates';
import type { TaskUpdateInput } from '@shared/schemas';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { formatDate } from '../../lib/format';
import { Button, Dialog, useSheetMode } from '../ui';
import { DateField } from './DateField';
import { quickDates } from './dueDates';
import { TagPickerList } from './TagPicker';
import { tagPatch } from './taskDisplay';
import { useSharedToday } from './useSharedToday';

interface TaskDialogProps {
  task: TaskDTO;
  open: boolean;
  onClose: () => void;
  onSave: (patch: TaskUpdateInput) => void;
}

export function TaskTagsDialog({ task, open, onClose, onSave }: TaskDialogProps) {
  const sheetMode = useSheetMode();
  const [initial] = useState(() => task.tags.map((t) => t.id));
  const [ids, setIds] = useState<number[]>(initial);
  const patch = tagPatch(initial, ids);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Tags · ${task.ref}`}
      size="sm"
      closeOnOutsideClick={!patch}
      bodyClassName="flex flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (patch) onSave(patch);
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!patch}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex min-h-64 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface md:h-80 md:flex-none">
        <TagPickerList value={ids} onChange={setIds} touch={sheetMode} />
      </div>
    </Dialog>
  );
}

export function TaskDueDateDialog({ task, open, onClose, onSave }: TaskDialogProps) {
  const today = useSharedToday();
  const { settings } = useLookups();
  const [date, setDate] = useState<ISODate | null>(task.dueDate);
  const beforeStart = date !== null && task.startDate !== null && date < task.startDate;
  const valid = date === null || (isValidISODate(date) && !beforeStart);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Due date · ${task.ref}`}
      size="sm"
      mobileLayout="sheet"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        if (date !== task.dueDate) onSave({ dueDate: date });
        onClose();
      }}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!valid || date === task.dueDate}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <DateField
          label="Due date"
          value={date}
          onChange={setDate}
          min={task.startDate ?? undefined}
          quickOptions={false}
          error={beforeStart ? `Must be on or after the start date (${formatDate(task.startDate, today)})` : undefined}
        />
        <div role="group" aria-label="Quick dates" className="flex flex-wrap gap-2">
          {quickDates(today, settings.weekStartsOn).map((q) => (
            <Button key={q.key} size="sm" aria-pressed={date === q.date} variant={date === q.date ? 'primary' : 'secondary'} onClick={() => setDate(q.date)}>
              {q.label}
            </Button>
          ))}
          <Button size="sm" variant="ghost" disabled={date === null} onClick={() => setDate(null)}>
            No date
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
