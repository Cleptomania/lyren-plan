// A link to pass on to someone else (an invitation's, a reset link) when the instance sends no mail: made
// absolute (lib/shareLinks.ts), with a choice of address when the instance has several for other devices
// (InstanceInfoDTO.shareOrigins), the copy button, and a warning when the link works only on this computer.

import { useState } from 'react';
import { absoluteLink, linkAt, linkOrigins, loopbackWarning } from '../../lib/shareLinks';
import { CopyField } from './CopyField';
import { Select } from './Select';

export interface ShareLinkFieldProps {
  /** As the server answered it: absolute, or a path (`/invite#t=…`). */
  link: string;
  /** InstanceInfoDTO.shareOrigins. */
  shareOrigins: readonly string[];
  /** What it is, for the labels ("invitation link"). */
  label: string;
}

export function ShareLinkField({ link, shareOrigins, label }: ShareLinkFieldProps) {
  const absolute = absoluteLink(link, window.location.origin);
  const origins = linkOrigins(shareOrigins, window.location.origin);
  const [origin, setOrigin] = useState(() => new URL(absolute).origin);
  const shown = origins.length > 1 ? linkAt(absolute, origin) : absolute;
  const warning = loopbackWarning(shown);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {origins.length > 1 && (
        <Select
          aria-label="Address of the link"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          options={origins.map((o) => ({ value: o, label: o }))}
        />
      )}
      <CopyField value={shown} label={label} />
      {warning && <p className="text-[13px] font-medium text-warning">{warning}</p>}
    </div>
  );
}
