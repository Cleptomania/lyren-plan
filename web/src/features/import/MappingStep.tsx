// The mapping step of an import (design §8.5, §8.9, §12.10; mapping.ts): one row for each person the archive's
// entries name, with how many entries name them, and whom they become here: an account the importer can already
// see (themselves, the members of their spaces, or for an instance admin every account) in a filterable picker,
// or a former member kept by name only. The rows start from the analysis's suggestions (the same email address,
// else the importer for the only person or the exporter). Below them, whether the import fits the instance's
// limits, and "Import without the activity history" when that makes it fit.

import { ChevronDown, TriangleAlert, UserRound } from 'lucide-react';
import { useMemo } from 'react';
import type { ArchiveUserDTO, ImportAnalysisDTO, ImportTarget } from '@shared/types';
import { useAccount } from '../../api/auth';
import { Avatar, Button, Checkbox, Picker, type PickerOption } from '../../components/ui';
import { fitText, importFit, referencesText, targetKey, targetOfKey, targetOptions, targetText, type MappingChoices, type TargetKey } from './mapping';

function PersonRow({
  user,
  target,
  options,
  analysis,
  onChoose,
  disabled,
}: {
  user: ArchiveUserDTO;
  target: ImportTarget | undefined;
  options: ReadonlyArray<PickerOption<TargetKey>>;
  analysis: ImportAnalysisDTO;
  onChoose: (target: ImportTarget) => void;
  disabled?: boolean;
}) {
  const current = targetText(target, analysis.candidates);
  return (
    <li className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={user.displayName} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{user.displayName}</p>
          <p className="truncate text-[13px] text-fg-muted">
            {user.kind === 'placeholder' ? 'A former member (name only)' : (user.email ?? 'No email address')}
          </p>
          <p className="text-[13px] text-fg-subtle">{referencesText(user.references)}</p>
        </div>
      </div>
      <Picker<TargetKey>
        label={`${user.displayName} becomes`}
        searchable
        placeholder="Filter by name or email…"
        emptyText="No account matches"
        options={options}
        value={target ? targetKey(target) : undefined}
        onChange={(key) => onChoose(targetOfKey(key))}
        className="w-80"
        placement="bottom-end"
        trigger={
          <Button
            size="sm"
            disabled={disabled}
            icon={<UserRound aria-hidden />}
            trailingIcon={<ChevronDown aria-hidden className="text-fg-subtle" />}
            aria-label={`${user.displayName} becomes: ${current} (change)`}
            className="w-full min-w-0 sm:w-64 [&>span]:flex-1 [&>span]:text-left"
          >
            {current}
          </Button>
        }
      />
    </li>
  );
}

export function MappingStep({
  analysis,
  choices,
  onChoose,
  skipActivity,
  onSkipActivity,
  disabled,
}: {
  analysis: ImportAnalysisDTO;
  choices: MappingChoices;
  onChoose: (archiveId: number, target: ImportTarget) => void;
  skipActivity: boolean;
  onSkipActivity: (skip: boolean) => void;
  disabled?: boolean;
}) {
  const account = useAccount();
  const options = useMemo<Array<PickerOption<TargetKey>>>(
    () => targetOptions(analysis.candidates).map((o) => ({ ...o, keywords: o.hint })),
    [analysis.candidates],
  );
  const fit = importFit(analysis.estimate, skipActivity);
  const limitText = fitText(analysis.estimate, fit);
  const v1 = analysis.format === 'lyren-plan-export/1';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h4 className="text-sm font-semibold text-fg">People</h4>
        <p className="mt-0.5 text-[13px] text-fg-muted">
          {v1
            ? 'This export is from before archives named people: every task, comment, work log and activity entry in it becomes yours.'
            : analysis.users.length === 0
              ? 'No entry in this archive names a person.'
              : `Choose whom each person’s entries belong to here. ${
                  account.isInstanceAdmin
                    ? 'As an administrator of this instance you can choose any account.'
                    : 'You can choose yourself and the members of your spaces.'
                } Entries that become someone else’s are marked as imported by you.`}
        </p>
      </div>
      {analysis.users.length > 0 && (
        <ul aria-label="People in the archive" className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border">
          {analysis.users.map((u) => (
            <PersonRow
              key={u.archiveId}
              user={u}
              target={choices.get(u.archiveId)}
              options={options}
              analysis={analysis}
              onChoose={(target) => onChoose(u.archiveId, target)}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
      {(fit.offerSkip || skipActivity) && (
        <Checkbox
          checked={skipActivity}
          onCheckedChange={onSkipActivity}
          disabled={disabled}
          label="Import without the activity history"
          description={`The tasks, comments and work logs come along; the history of changes (${analysis.counts.activity.toLocaleString()} entries) does not.`}
        />
      )}
      {limitText && (
        <p role="status" className="flex gap-2.5 rounded-md border border-warning/40 bg-warning-soft p-3 text-[13px] text-fg">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span className="min-w-0">{limitText}</span>
        </p>
      )}
    </div>
  );
}
