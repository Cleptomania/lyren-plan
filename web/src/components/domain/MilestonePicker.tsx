import { Milestone } from 'lucide-react';
import { useLookups } from '../../api/bootstrap';
import { Picker } from '../ui';
import type { ProjectScope } from './entityGroups';
import { useMilestoneOptions } from './options';
import type { DomainPickerProps } from './pickerTypes';
import { PropertyButton } from './PropertyButton';

export interface MilestonePickerProps extends DomainPickerProps {
  /** Milestones of this project (or several; null = all non-archived projects). */
  projectId: ProjectScope;
  value: number | null;
  onChange: (milestoneId: number | null) => void;
  /** Offer "No milestone" (default true). */
  allowNone?: boolean;
  noneLabel?: string;
}

/**
 * Choose a milestone, e.g. for an epic. (A task's milestone comes from its epic, so tasks
 * use EpicPicker.)
 */
export function MilestonePicker({
  projectId,
  value,
  onChange,
  allowNone = true,
  noneLabel = 'No milestone',
  label = 'Milestone',
  trigger,
  triggerProps,
  panelClassName,
  ...popup
}: MilestonePickerProps) {
  const { milestoneById } = useLookups();
  const options = useMilestoneOptions({ projectId, includeNone: allowNone, noneLabel });
  const current = value !== null ? milestoneById.get(value) : undefined;
  const triggerEl = trigger ?? (
    <PropertyButton aria-label={`${label}: ${current?.name ?? noneLabel}`} icon={<Milestone />} placeholder={!current} {...triggerProps}>
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
      emptyText="No milestones"
      className={panelClassName}
      {...popup}
    />
  );
}
