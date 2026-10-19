// Administration → Overview (design §5.8.18, §12.2, §12.12), from GET /api/admin/overview: what an
// administrator should act on (the warnings), what this instance is and how it is configured (read-only; no
// secret is part of it), the recent administrative actions of every admin, the mail test, the backup
// download on Node (re-auth first), and the notes on running it: the self-hosting notes, or the desktop
// app's data folder and commands.

import { DatabaseBackup, MailCheck, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { localToday } from '@shared/dates';
import type { AdminEventDTO, InstanceInfoDTO } from '@shared/types';
import { BACKUP_URL, useAdminOverview, useSendTestMail } from '../../api/admin';
import { useAccount, useAuthStatus } from '../../api/auth';
import { errorMessage } from '../../api/client';
import { Button, ErrorState, SkeletonList, SkeletonText } from '../../components/ui';
import { formatDateTime, formatRelativeTime, pluralize } from '../../lib/format';
import { downloadWithReauth } from '../settings/download';
import { SelfHostingNotes, selfHostingTitle } from '../settings/SelfHostingNotes';
import { SettingRow, SettingRows, SettingsCard, SettingsPage } from '../settings/SettingsBlocks';
import { addressText, adminEventText, configRows, countsText, limitText, POLICY_TEXT, testMailText } from './overview';

function Value({ children, mono }: { children: string; mono?: boolean }) {
  return <span className={mono ? 'break-all font-mono text-sm text-fg' : 'text-sm text-fg sm:text-right'}>{children}</span>;
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="flex gap-2.5 rounded-lg border border-warning/40 bg-warning-soft p-3 text-[13px] text-fg">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}

function MailTestCard({ transport }: { transport: 'log' | 'smtp' | 'resend' | 'cloudflare' | undefined }) {
  const account = useAccount();
  const test = useSendTestMail();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const send = () => {
    setResult(null);
    test.mutate(undefined, {
      onSuccess: (res) => setResult({ ok: true, text: testMailText(res, account.email ?? '', transport ?? 'log') }),
      onError: (err) => setResult({ ok: false, text: errorMessage(err) }),
    });
  };
  return (
    <SettingsCard
      title="Mail"
      description={account.email ? `Send a test message to your own address, ${account.email}, to check the mail settings.` : 'Add an email address to your account to send yourself a test message.'}
      actions={
        <Button icon={<MailCheck aria-hidden />} loading={test.isPending} disabled={!account.email} onClick={send}>
          Send test email
        </Button>
      }
    >
      {result ? (
        <p
          role="status"
          className={
            result.ok
              ? 'rounded-md border border-success/30 bg-success-soft p-3 text-[13px] break-words text-fg'
              : 'rounded-md border border-danger/30 bg-danger-soft p-3 text-[13px] break-words text-fg'
          }
        >
          {result.ok ? result.text : `The test message was not sent: ${result.text}`}
        </p>
      ) : undefined}
    </SettingsCard>
  );
}

function EventRow({ event }: { event: AdminEventDTO }) {
  const details = [formatRelativeTime(event.createdAt), event.ip].filter(Boolean);
  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-4 py-2.5">
      <span className="text-sm text-fg">{adminEventText(event)}</span>
      <span className="text-[13px] text-fg-muted" title={formatDateTime(event.createdAt)}>
        {details.join(' · ')}
      </span>
    </li>
  );
}

function InstanceCard({ instance, version, runsOn, counts }: { instance: InstanceInfoDTO; version: string; runsOn: string; counts?: string }) {
  return (
    <SettingsCard title="Instance" description={counts}>
      <SettingRows>
        <SettingRow label="Name">
          <Value>{instance.name}</Value>
        </SettingRow>
        <SettingRow label="Version">
          <Value mono>{version}</Value>
        </SettingRow>
        <SettingRow label="Runs on">
          <Value>{runsOn}</Value>
        </SettingRow>
        <SettingRow label="Sign-up">
          <Value>{POLICY_TEXT[instance.signupPolicy]}</Value>
        </SettingRow>
        <SettingRow label="Address for links" description="Where links meant for other devices point.">
          <Value mono={instance.shareOrigins.length > 0}>{addressText(instance.shareOrigins)}</Value>
        </SettingRow>
      </SettingRows>
    </SettingsCard>
  );
}

export default function AdminOverview() {
  const status = useAuthStatus().data;
  const account = useAccount();
  const overview = useAdminOverview();
  if (!status) return null;
  const { instance } = status;
  // Set only by the single-file desktop app, for instance admins.
  const desktop = status.desktopData;
  const data = overview.data;
  return (
    <SettingsPage title="Overview" description="This Lyren Plan instance.">
      {data?.warnings.map((w) => <Warning key={w}>{w}</Warning>)}
      {data && data.orphanedPasskeyAccounts > 0 && (
        // §5.6's warning is among those above; the list shows its accounts.
        <Link to="/admin/users?orphaned=1" className="-mt-2 self-start text-[13px] font-medium text-accent hover:underline">
          Show the {pluralize(data.orphanedPasskeyAccounts, 'account')} that can’t sign in here
        </Link>
      )}
      <InstanceCard
        instance={data?.instance ?? instance}
        version={status.version}
        runsOn={desktop ? 'Desktop app' : instance.runtime === 'cloudflare' ? 'Cloudflare' : 'Node.js'}
        counts={data ? countsText(data.counts) : undefined}
      />
      <SettingsCard title="Configuration" description="Set on the server (environment variables); shown here, never changed.">
        {overview.isPending ? (
          <SkeletonText lines={5} />
        ) : overview.error ? (
          <ErrorState size="sm" error={overview.error} onRetry={() => void overview.refetch()} />
        ) : (
          <SettingRows>
            {configRows(overview.data.config).map((row) => (
              <SettingRow key={row.label} label={row.label} description={<code className="font-mono text-[12px]">{row.variables}</code>}>
                <Value>{row.value}</Value>
              </SettingRow>
            ))}
            <SettingRow label="Spaces per account" description={<code className="font-mono text-[12px]">MAX_SPACES_PER_USER</code>}>
              <Value>{limitText(instance.limits.maxSpacesPerUser, 'spaces')}</Value>
            </SettingRow>
            <SettingRow label="Members per space" description={<code className="font-mono text-[12px]">MAX_MEMBERS_PER_SPACE</code>}>
              <Value>{limitText(instance.limits.maxMembersPerSpace, 'members')}</Value>
            </SettingRow>
            <SettingRow label="Largest import" description={<code className="font-mono text-[12px]">IMPORT_BODY_LIMIT</code>}>
              <Value>{`${Math.round(instance.limits.importMaxBytes / 2 ** 20)} MiB`}</Value>
            </SettingRow>
          </SettingRows>
        )}
      </SettingsCard>
      <SettingsCard title="Recent administrative actions" description="What the administrators did lately, newest first; every administrator sees this list." flush>
        {overview.isPending ? (
          <SkeletonList rows={3} className="px-4 pb-3" />
        ) : overview.error ? (
          <ErrorState size="sm" error={overview.error} onRetry={() => void overview.refetch()} />
        ) : overview.data.recentAdminEvents.length === 0 ? (
          <p className="border-t border-border px-4 py-3 text-sm text-fg-muted">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-border border-t border-border" aria-label="Recent administrative actions">
            {overview.data.recentAdminEvents.map((e) => (
              <EventRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </SettingsCard>
      <MailTestCard transport={data?.config.mailTransport} />
      {instance.features.backupDownload && (
        <SettingsCard
          title="Download a backup"
          description={
            desktop
              ? 'A backup set (.tar) of the accounts and every space, each a consistent snapshot (sign-in sessions removed). Restore it with the restore command described below.'
              : 'A backup set (.tar) of the accounts and every space, each a consistent snapshot (sign-in sessions removed). Restore it on the server with the restore command described below. Every download is listed in the recent actions.'
          }
          actions={
            <Button icon={<DatabaseBackup aria-hidden />} onClick={() => void downloadWithReauth(BACKUP_URL)}>
              Download backup
            </Button>
          }
        />
      )}
      {instance.runtime === 'node' && (
        <SettingsCard title={selfHostingTitle(desktop)}>
          <SelfHostingNotes username={account.email ?? account.username ?? ''} mail={instance.mail} desktop={desktop} today={localToday()} />
        </SettingsCard>
      )}
    </SettingsPage>
  );
}
