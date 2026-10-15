import { CircleDashed } from 'lucide-react';
import { useLookups } from '../../api/bootstrap';
import { Picker } from '../ui';
import { EpicDot } from './EntityBadges';
import type { ProjectScope } from './entityGroups';
import { useEpicOptions } from './options';
import type { DomainPickerProps } from './pickerTypes';
import { PropertyButton } from './PropertyButton';

export interface EpicPickerProps extends DomainPickerProps {
  /** Epics of this project (or several; null = all non-archived projects). */
  projectId: ProjectScope;
  value: number | null;
  onChange: (epicId: number | null) => void;
  /** Offer "No epic" (default true). */
  allowNone?: boolean;
  noneLabel?: string;
}

/**
 * Choose an epic, grouped by milestone (milestone order, then epics without one).
 * Choosing an epic of another project moves the task there (server rule), so pass the
 * task's own project unless that is intended.
 */
export function EpicPicker({
  projectId,
  value,
  onChange,
  allowNone = true,
  noneLabel = 'No epic',
  label = 'Epic',
  trigger,
  triggerProps,
  panelClassName,
  ...popup
}: EpicPickerProps) {
  const { epicById } = useLookups();
  const options = useEpicOptions({ projectId, includeNone: allowNone, noneLabel });
  const current = value !== null ? epicById.get(value) : undefined;
  const triggerEl = trigger ?? (
    <PropertyButton
      aria-label={`${label}: ${current?.name ?? noneLabel}`}
      icon={current ? <EpicDot color={current.color} /> : <CircleDashed />}
      placeholder={!current}
      {...triggerProps}
    >
      {current?.name ?? noneLabel}
    </PropertyButton>
  );
  return (
    <Picker<number | null>
      label={label}
      options={options}
      value={value === null && !allowNone ? undefined : value}
      onChange={onChange}
      trigger={triggerEl}
      emptyText="No epics"
      className={panelClassName ?? 'w-72'}
      {...popup}
    />
  );
}
