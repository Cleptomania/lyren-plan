// A Menu whose items are built only when it opens (header menus read the latest board state).

import { useState, type ReactElement } from 'react';
import { Menu, type MenuItemInput } from '../../components/ui';

export function LazyMenu({ trigger, build, label }: { trigger: ReactElement; build: () => MenuItemInput[]; label: string }) {
  const [open, setOpen] = useState(false);
  return <Menu trigger={trigger} items={open ? build() : []} open={open} onOpenChange={setOpen} label={label} />;
}
