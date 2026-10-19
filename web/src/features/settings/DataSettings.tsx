// Space settings → Data (owners; design §8, §12.10): the space's archive, downloaded after the re-auth window is
// checked (ensureReauth; the download is a plain GET the browser follows with the session cookie), the way to
// import an archive into a new space (/spaces/import), and Replace this space (features/import/ReplaceSpace),
// which puts an archive's content in place of the space's after its people are mapped. The instance backup and
// the self-hosting notes are in Administration → Overview (§12.12).

import { Download, Upload } from 'lucide-react';
import { exportUrl } from '../../api/importExport';
import { useSpace } from '../../app/space';
import { Button, ButtonLink } from '../../components/ui';
import { ReplaceSpace } from '../import/ReplaceSpace';
import { downloadWithReauth } from './download';
import { SettingsCard, SettingsPage } from './SettingsBlocks';

export default function DataSettings() {
  const { id: sid, name } = useSpace();
  return (
    <SettingsPage title="Data" description={`Take ${name} with you, bring a space in, or put an earlier copy of this one back.`}>
      <SettingsCard
        title="Space archive"
        description="Everything in this space, and the names and addresses of the people its entries name, in one compressed file (.json.gz). Import it into a new space here or on another instance. Members, accounts and passwords are not in it."
        actions={
          <Button icon={<Download aria-hidden />} onClick={() => void downloadWithReauth(exportUrl(sid))}>
            Download space archive
          </Button>
        }
      />
      <SettingsCard
        title="Import into a new space"
        description="Bring an archive in as a space of its own, next to this one. You become its owner."
        actions={
          <ButtonLink to="/spaces/import" icon={<Upload aria-hidden />}>
            Import a space…
          </ButtonLink>
        }
      />
      <ReplaceSpace />
    </SettingsPage>
  );
}
