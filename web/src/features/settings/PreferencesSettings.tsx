// Account settings → Preferences: theme (this device), week start and home page, which hold in every
// space. The account's preferences are saved optimistically (useUpdatePreferences) with a small
// "Saving… / Saved" status.

import { LayoutDashboard, Monitor, Moon, Sun, SquareKanban } from 'lucide-react';
import type { PreferencesUpdateInput } from '@shared/schemas';
import { DEFAULT_PREFERENCES } from '@shared/schemas';
import { useUpdatePreferences } from '../../api/account';
import { useAuthStatus } from '../../api/auth';
import { useThemePreference } from '../../components/layout/useShellState';
import { SegmentedControl, toast } from '../../components/ui';
import type { ThemePreference } from '../../lib/theme';
import { SaveStatus, useSaveState } from './SaveStatus';
import { SettingRow, SettingRows, SettingsCard, SettingsPage } from './SettingsBlocks';

const THEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: <Sun aria-hidden /> },
  { value: 'dark', label: 'Dark', icon: <Moon aria-hidden /> },
  { value: 'system', label: 'System', icon: <Monitor aria-hidden /> },
] as const;

const WEEK_OPTIONS = [
  { value: '1', label: 'Monday' },
  { value: '0', label: 'Sunday' },
] as const;

const HOME_OPTIONS = [
  { value: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard aria-hidden /> },
  { value: 'default_board', label: 'Default board', icon: <SquareKanban aria-hidden /> },
] as const;

export default function PreferencesSettings() {
  const preferences = useAuthStatus().data?.preferences ?? DEFAULT_PREFERENCES;
  const [theme, setTheme] = useThemePreference();
  const update = useUpdatePreferences();
  const saving = useSaveState();
  const save = (patch: PreferencesUpdateInput) => {
    saving.begin();
    update.mutate(patch, {
      onError: (err) => toast.error(err),
      onSettled: (_data, err) => saving.end(!err),
    });
  };

  return (
    <SettingsPage title="Preferences" description="How Lyren Plan looks and behaves, in every space." actions={<SaveStatus state={saving.state} />}>
      <SettingsCard title="Appearance">
        <SettingRows>
          <SettingRow label="Theme" description="Saved on this device only.">
            <SegmentedControl<ThemePreference> aria-label="Theme" value={theme} onChange={setTheme} options={THEME_OPTIONS} />
          </SettingRow>
        </SettingRows>
      </SettingsCard>

      <SettingsCard title="Dates">
        <SettingRows>
          <SettingRow label="Week starts on" description="Used by calendars, “this week” filters and due-date groups.">
            <SegmentedControl
              aria-label="Week starts on"
              value={String(preferences.weekStartsOn) as '0' | '1'}
              onChange={(v) => save({ weekStartsOn: v === '0' ? 0 : 1 })}
              options={WEEK_OPTIONS}
            />
          </SettingRow>
        </SettingRows>
      </SettingsCard>

      <SettingsCard title="Home page" description="What opens when you open a space.">
        <SettingRows>
          <SettingRow label="Start on" description="Each space chooses its default board in its own settings; without one, the dashboard opens.">
            <SegmentedControl aria-label="Home page" value={preferences.homePage} onChange={(homePage) => save({ homePage })} options={HOME_OPTIONS} />
          </SettingRow>
        </SettingRows>
      </SettingsCard>
    </SettingsPage>
  );
}
