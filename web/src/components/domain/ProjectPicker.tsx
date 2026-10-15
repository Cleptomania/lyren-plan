import { FolderOpen } from 'lucide-react';
import { useLookups } from '../../api/bootstrap';
import { ColorDot, Picker } from '../ui';
import { useProjectOptions } from './options';
import type { DomainPickerProps } from './pickerTypes';
import { PropertyButton } from './PropertyButton';

export interface ProjectPickerProps extends DomainPickerProps {
  /** Selected project id (null = none chosen yet). */
  value: number | null;
  onChange: (projectId: number) => void;
  /** Also list archived projects under an "Archived" heading (default false). */
  includeArchived?: boolean;
  /** Default-trigger text when nothing is selected. */
  placeholder?: string;
}

/** Choose a project: active ones in position order (key as hint), archived optional. */
export function ProjectPicker({
  value,
  onChange,
  includeArchived = false,
  placeholder = 'Select project',
  label = 'Project',
  trigger,
  triggerProps,
  panelClassName,
  ...popup
}: ProjectPickerProps) {
  const { projectById } = useLookups();
  const options = useProjectOptions({ includeArchived });
  const current = value !== null ? projectById.get(value) : undefined;
  const triggerEl = trigger ?? (
    <PropertyButton
      aria-label={`${label}: ${current?.name ?? 'none'}`}
      icon={current ? <ColorDot color={current.color} square /> : <FolderOpen />}
      placeholder={!current}
      {...triggerProps}
    >
      {current?.name ?? placeholder}
    </PropertyButton>
  );
  return (
    <Picker<number>
      label={label}
      options={options}
      value={value ?? undefined}
      onChange={onChange}
      trigger={triggerEl}
      emptyText="No projects"
      className={panelClassName}
      {...popup}
    />
  );
}
