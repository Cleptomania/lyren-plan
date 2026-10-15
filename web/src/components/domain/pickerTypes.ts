import type { Placement } from '@floating-ui/react';
import type { ReactElement } from 'react';
import type { PropertyButtonProps } from './PropertyButton';

/** Props shared by the domain pickers (StatusPicker, EpicPicker …). */
export interface DomainPickerProps {
  /** Accessible name of the list; sheet title on phones. */
  label?: string;
  /** Custom trigger element. Default: a PropertyButton showing the current value. */
  trigger?: ReactElement;
  /** Extra props for the default trigger (fullWidth, bordered, chevron, size, className, disabled …). */
  triggerProps?: Partial<PropertyButtonProps>;
  /** Controlled open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Desktop placement (default 'bottom-start'). */
  placement?: Placement;
  /** Desktop panel classes (default width 16rem). */
  panelClassName?: string;
}
