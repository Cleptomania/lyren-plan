import { CircleDashed } from 'lucide-react';
import { useLookups } from '../../api/bootstrap';
import { Picker } from '../ui';
import { statusFraction } from './entityGroups';
import { useStatusOptions } from './options';
import type { DomainPickerProps } from './pickerTypes';
import { PropertyButton } from './PropertyButton';
import { StatusIcon } from './StatusIcon';

export interface StatusPickerProps extends DomainPickerProps {
  /** Selected status id. */
  value: number;
  onChange: (statusId: number) => void;
}

/** Choose a status (position order, category icons; searchable when there are many). */
export function StatusPicker({ value, onChange, label = 'Status', trigger, triggerProps, panelClassName, ...popup }: StatusPickerProps) {
  const { statusById, statuses } = useLookups();
  const options = useStatusOptions();
  const current = statusById.get(value);
  const triggerEl = trigger ?? (
    <PropertyButton
      aria-label={`${label}: ${current?.name ?? 'Unknown'}`}
      icon={current ? <StatusIcon status={current} fraction={statusFraction(current, statuses)} label={null} /> : <CircleDashed />}
      placeholder={!current}
      {...triggerProps}
    >
      {current?.name ?? 'Unknown status'}
    </PropertyButton>
  );
  return (
    <Picker<number>
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      trigger={triggerEl}
      className={panelClassName}
      {...popup}
    />
  );
}
