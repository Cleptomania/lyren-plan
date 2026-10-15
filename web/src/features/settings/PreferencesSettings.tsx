// Settings → Preferences: theme (this device), week start, estimate unit and home page.
// Server settings are saved optimistically (bootstrap cache) with a small "Saving… / Saved" status.

import { Check, LayoutDashboard, Monitor, Moon, Sun, SquareKanban } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import type { SettingsUpdateInput } from '@shared/schemas';
import { useUpdateSettings } from '../../api/admin';
import { useLookups } from '../../api/bootstrap';
import { useThemePreference } from '../../components/layout/useShellState';
import { SegmentedControl, Select, Spinner, toast } from '../../components/ui';
import type { ThemePreference } from '../../lib/theme';
import { SettingRow, SettingRows, SettingsCard, SettingsPage } from './SettingsBlocks';
import { useOptimisticBootstrap } from './useOptimisticBootstrap';

type SaveState = 'idle' | 'saving' | 'saved';

/** Optimistic settings saves plus a status for the page header. */
function useSaveSettings() {
  const optimistic = useOptimisticBootstrap();
  const update = useUpdateSettings();
  const [state, setState] = useState<SaveState>('idle');
  const inFlight = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = async (patch: SettingsUpdateInput) => {
    window.clearTimeout(timer.current);
    inFlight.current++;
    setState('saving');
    const rollback = await optimistic((b) => ({ ...b, settings: { ...b.settings, ...patch } }));
    update.mutate(patch, {
      onError: (err) => {
        rollback();
        toast.error(err);
      },
      onSettled: (_data, err) => {
        inFlight.current--;
        if (inFlight.current > 0) return;
        setState(err ? 'idle' : 'saved');
        if (!err) timer.current = window.setTimeout(() => setState('idle'), 2000);
      },
    });
  };
  return { save, state };
}

function SaveStatus({ state }: { state: SaveState }) {
  return (
    <span aria-live="polite" className="flex h-8 items-center gap-1.5 text-xs text-fg-muted">
      {state === 'saving' && (
        <>
          <Spinner size="xs" label={null} /> Saving…
        </>
      )}
      {state === 'saved' && (
        <>
          <Check aria-hidden className="size-3.5 text-success" /> Saved
        </>
      )}
    </span>
  );
}

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: <Sun aria-hidden /> },
  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden /> },
  { value: 'system', label: 'System', icon: <Monitor aria-hidden /> },
] as const;

const WEEK_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '0', label: 'Sunday' },
] as const;

const UNIT_OPTIONS = [
  { value: 'points', label: 'Points' },
  { value: 'hours', label: 'Hours' },
] as const;

const HOME_OPTIONS = [
  { value: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard aria-hidden /> },
  { value: 'default_board', label: 'Default board', icon: <SquareKanban aria-hidden /> },
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

export default function PreferencesSettings() {
  const { settings, boards } = useLookups();
  const [theme, setTheme] = useThemePreference();
  const { save, state } = useSaveSettings();
  const boardGroups = useBoardGroups();
  const boardSelectId = useId();
  const needsBoard = settings.homePage === 'default_board' && settings.defaultBoardId === null;

  return (
    <SettingsPage title="Preferences" description="How Lyren Plan looks and behaves." actions={<SaveStatus state={state} />}>
      <SettingsCard title="Appearance">
        <SettingRows>
          <SettingRow label="Theme" description="Saved on this device only.">
            <SegmentedControl<ThemePreference> aria-label="Theme" value={theme} onChange={setTheme} options={THEME_OPTIONS} />
          </SettingRow>
        </SettingRows>
      </SettingsCard>

      <SettingsCard title="Dates and estimates">
        <SettingRows>
          <SettingRow label="Week starts on" description="Used by calendars, “this week” filters and due-date groups.">
            <SegmentedControl
              aria-label="Week starts on"
              value={String(settings.weekStartsOn) as '0' | '1'}
              onChange={(v) => void save({ weekStartsOn: v === '0' ? 0 : 1 })}
              options={WEEK_OPTIONS}
            />
          </SettingRow>
          <SettingRow label="Estimate unit" description="How task estimates are entered and shown. Existing values are not converted.">
            <SegmentedControl
              aria-label="Estimate unit"
              value={settings.estimateUnit}
              onChange={(estimateUnit) => void save({ estimateUnit })}
              options={UNIT_OPTIONS}
            />
          </SettingRow>
        </SettingRows>
      </SettingsCard>

      <SettingsCard title="Home page" description="What opens when you start the app.">
        <SettingRows>
          <SettingRow label="Start on">
            <SegmentedControl
              aria-label="Home page"
              value={settings.homePage}
              onChange={(homePage) => void save({ homePage })}
              options={HOME_OPTIONS}
            />
          </SettingRow>
          <SettingRow
            label="Default board"
            htmlFor={boardSelectId}
            description={
              boards.length === 0 ? (
                <>
                  You have no boards yet.{' '}
                  <Link to="/boards" className="font-medium text-accent hover:underline">
                    Create one
                  </Link>
                </>
              ) : needsBoard ? (
                <span className="text-warning">Choose a board — until then the dashboard opens.</span>
              ) : (
                'Opened when the home page is set to the default board.'
              )
            }
          >
            <Select
              id={boardSelectId}
              className="sm:w-64"
              disabled={boards.length === 0}
              value={settings.defaultBoardId === null ? '' : String(settings.defaultBoardId)}
              onChange={(e) => void save({ defaultBoardId: e.target.value ? Number(e.target.value) : null })}
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
