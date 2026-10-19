// The security notices of the auth status (design §5.8.11, §12.7), shown once after signing in: as soon
// as they arrive they are marked seen (POST /api/account/notices/seen, so the next sign-in does not
// show them again), and the banner stays until it is dismissed.

import { ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { localToday } from '@shared/dates';
import type { NoticeDTO } from '@shared/types';
import { useMarkNoticesSeen } from '../../api/account';
import { useAuthStatus } from '../../api/auth';
import { IconButton } from '../../components/ui';
import { noticeText } from './notices';

export function NoticesBanner() {
  const notices = useAuthStatus().data?.notices;
  const { mutate: markSeen } = useMarkNoticesSeen();
  const [shown, setShown] = useState<NoticeDTO[]>([]);
  const marked = useRef(new Set<number>());

  useEffect(() => {
    const fresh = (notices ?? []).filter((n) => !marked.current.has(n.id));
    if (fresh.length === 0) return;
    for (const n of fresh) marked.current.add(n.id);
    setShown((s) => [...s, ...fresh]);
    markSeen();
  }, [notices, markSeen]);

  if (shown.length === 0) return null;
  const today = localToday();
  return (
    <div role="alert" className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[70] mx-auto flex max-w-xl gap-3 rounded-lg border border-warning/40 bg-popover p-3 text-sm shadow-pop">
      <ShieldAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {shown.map((n) => (
          <p key={n.id} className="text-fg">
            {noticeText(n, today)}
          </p>
        ))}
      </div>
      <IconButton aria-label="Dismiss" icon={<X />} size="sm" className="-my-1 -mr-1 shrink-0" onClick={() => setShown([])} />
    </div>
  );
}
