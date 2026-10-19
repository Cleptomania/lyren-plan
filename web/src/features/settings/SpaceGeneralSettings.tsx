// Space settings → General: the space's name (owners rename it, §6.2) and its estimate unit and default
// board (design §3.6; admins and owners change them), saved optimistically (useUpdateSettings) with a
// small "Saving… / Saved" status. Everyone else sees them read-only.

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { LIMITS } from '@shared/constants';
import { spaceUpdateInput } from '@shared/schemas';
import { useLookups } from '../../api/bootstrap';
import { useUpdateSettings, type SettingsPatch } from '../../api/spaceAdmin';
import { useRenameSpace } from '../../api/spaces';
import { useSpace, useSpacePath } from '../../app/space';
import { Button, Field, Input, SegmentedControl, Select, apiFieldErrors, toast, zodFieldErrors } from '../../components/ui';
import { SaveStatus, useSaveState } from './SaveStatus';
import { SettingRow, SettingRows, SettingsCard, SettingsPage } from './SettingsBlocks';

const UNIT_OPTIONS = [
  { value: 'points', label: 'Points' },
  { value: 'hours', label: 'Hours' },
] as const;

/** Board options: global boards first, then each project's boards under its name. */
function useBoardGroups() {
  const { boards, projects } = useLookups();
  return useMemo(() => {
    const groups: Array<{ label: string; boards: typeof boards }> = [];
    const global = boards.filter((b) => b.projectId === null);
    if (global.length) groups.push({ label: 'Boards', boards: global });
    for (const p of projects) {
      const own = boards.filter((b) => b.projectId === p.id);
      if (own.length) groups.push({ label: p.status === 'archived' ? `${p.name} (archived)` : p.name, boards: own });
    }
    return groups;
  }, [boards, projects]);
}

function NameCard() {
  const space = useSpace();
  const rename = useRenameSpace(space.id);
  const [name, setName] = useState(space.name);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => setName(space.name), [space.name]);
  const canRename = space.permissions.rename;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = spaceUpdateInput.safeParse({ name });
    if (!parsed.success) return setError(zodFieldErrors(parsed.error).name);
    setError(undefined);
    rename.mutate(parsed.data, {
      onSuccess: (saved) => toast.success(`Renamed the space to ${saved.name}`),
      onError: (err) => {
        setError(apiFieldErrors(err).name);
        toast.error(err);
      },
    });
  };

  return (
    <SettingsCard title="Name" description={canRename ? 'Shown to everyone in the space.' : 'Only owners rename the space.'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Space name" hideLabel error={error}>
          <Input
            value={name}
            readOnly={!canRename}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(undefined);
            }}
            maxLength={LIMITS.spaceNameMax}
            className="read-only:bg-surface-2 read-only:text-fg-muted read-only:shadow-none"
          />
        </Field>
        {canRename && (
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={name.trim() === space.name} loading={rename.isPending}>
              Rename
            </Button>
          </div>
        )}
      </form>
    </SettingsCard>
  );
}

export default function SpaceGeneralSettings() {
  const sp = useSpacePath();
  const { manageStructure } = useSpace().permissions;
  const { settings, boards } = useLookups();
  const update = useUpdateSettings();
  const saving = useSaveState();
  const boardGroups = useBoardGroups();
  const boardSelectId = useId();
  const needsBoard = settings.homePage === 'default_board' && settings.defaultBoardId === null;
  const save = (patch: SettingsPatch) => {
    saving.begin();
    update.mutate(patch, {
      onError: (err) => toast.error(err),
      onSettled: (_data, err) => saving.end(!err),
    });
  };

  return (
    <SettingsPage
      title="General"
      description={manageStructure ? 'Settings of this space, for everyone in it.' : 'Settings of this space. Only admins and owners change them.'}
      actions={<SaveStatus state={saving.state} />}
    >
      <NameCard />
      <SettingsCard title="Estimates">
        <SettingRows>
          <SettingRow label="Estimate unit" description="How task estimates are entered and shown. Existing values are not converted.">
            <SegmentedControl
              aria-label="Estimate unit"
              disabled={!manageStructure}
              value={settings.estimateUnit}
              onChange={(estimateUnit) => save({ estimateUnit })}
              options={UNIT_OPTIONS}
            />
          </SettingRow>
        </SettingRows>
      </SettingsCard>

      <SettingsCard title="Default board" description="Opens when the home page in your preferences is the default board.">
        <SettingRows>
          <SettingRow
            label="Default board"
            htmlFor={boardSelectId}
            description={
              boards.length === 0 ? (
                <>
                  This space has no boards yet.{' '}
                  {manageStructure && (
                    <Link to={sp('/boards')} className="font-medium text-accent hover:underline">
                      Create one
                    </Link>
                  )}
                </>
              ) : needsBoard && manageStructure ? (
                <span className="text-warning">Choose a board — until then the dashboard opens.</span>
              ) : undefined
            }
          >
            <Select
              id={boardSelectId}
              className="sm:w-64"
              disabled={boards.length === 0 || !manageStructure}
              value={settings.defaultBoardId === null ? '' : String(settings.defaultBoardId)}
              onChange={(e) => save({ defaultBoardId: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">No default board</option>
              {boardGroups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.boards.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </SettingRow>
        </SettingRows>
      </SettingsCard>
    </SettingsPage>
  );
}
