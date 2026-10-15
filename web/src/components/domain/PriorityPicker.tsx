import { PRIORITY_META, type Priority } from '@shared/constants';
import { Picker } from '../ui';
import { usePriorityOptions } from './options';
import type { DomainPickerProps } from './pickerTypes';
import { PriorityIcon } from './PriorityIcon';
import { PropertyButton } from './PropertyButton';

export interface PriorityPickerProps extends DomainPickerProps {
  value: Priority;
  onChange: (priority: Priority) => void;
}

/** Choose a priority (Urgent … Low, No priority). */
export function PriorityPicker({ value, onChange, label = 'Priority', trigger, triggerProps, panelClassName, ...popup }: PriorityPickerProps) {
  const options = usePriorityOptions();
  const triggerEl = trigger ?? (
    <PropertyButton
      aria-label={`${label}: ${PRIORITY_META[value].label}`}
      icon={<PriorityIcon priority={value} label={null} />}
      placeholder={value === 0}
      {...triggerProps}
    >
      {PRIORITY_META[value].label}
    </PropertyButton>
  );
  return (
    <Picker<Priority>
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      trigger={triggerEl}
      className={panelClassName ?? 'w-52'}
      {...popup}
    />
  );
}
