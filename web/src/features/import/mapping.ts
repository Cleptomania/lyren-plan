// The mapping step of an import (design §8.5, §8.9, §12.10): who each person the archive names becomes here
// (an account the importer can already see, or a former member kept by name only), preselected from the
// analysis's suggestions, and whether the import fits the instance's limits (IMPORT_MAX_ROW_WRITES per import,
// what is left of IMPORT_DAILY_ROW_WRITES today), with or without its activity history. Pure, so the reducer and
// the texts are unit-tested (mapping.test.ts); the server checks the mapping and the limits again at the commit.

import type { ImportMappingInput } from '@shared/schemas';
import type { ArchiveUserDTO, ImportAnalysisDTO, ImportCandidateDTO, ImportTarget } from '@shared/types';

/** Each archive user's target, by archive id. */
export type MappingChoices = ReadonlyMap<number, ImportTarget>;

export type MappingAction = { type: 'choose'; archiveId: number; target: ImportTarget } | { type: 'reset'; analysis: ImportAnalysisDTO };

/** The suggestions of an analysis, as the step starts with them. */
export function initialChoices(analysis: Pick<ImportAnalysisDTO, 'suggestions'>): MappingChoices {
  return new Map(analysis.suggestions.map((s) => [s.archiveId, s.target]));
}

export function mappingReducer(state: MappingChoices, action: MappingAction): MappingChoices {
  switch (action.type) {
    case 'choose': {
      const next = new Map(state);
      next.set(action.archiveId, action.target);
      return next;
    }
    case 'reset':
      return initialChoices(action.analysis);
  }
}

/** A target as a Picker value: 'placeholder' or 'user:<id>'. */
export type TargetKey = 'placeholder' | `user:${number}`;

export function targetKey(target: ImportTarget): TargetKey {
  return target.kind === 'placeholder' ? 'placeholder' : `user:${target.userId}`;
}

export function targetOfKey(key: TargetKey): ImportTarget {
  return key === 'placeholder' ? { kind: 'placeholder' } : { kind: 'user', userId: Number(key.slice('user:'.length)) };
}

function validTarget(target: ImportTarget | undefined, candidateIds: ReadonlySet<number>): boolean {
  return target !== undefined && (target.kind === 'placeholder' || candidateIds.has(target.userId));
}

/** The archive users without a target among the analysis's candidates (Import stays disabled until none). */
export function unmappedUsers(analysis: Pick<ImportAnalysisDTO, 'users' | 'candidates'>, choices: MappingChoices): ArchiveUserDTO[] {
  const ids = new Set(analysis.candidates.map((c) => c.userId));
  return analysis.users.filter((u) => !validTarget(choices.get(u.archiveId), ids));
}

/** The commit's `mapping` field: a target for each user the archive's rows reference. */
export function mappingInput(analysis: Pick<ImportAnalysisDTO, 'users'>, choices: MappingChoices, skipActivity: boolean): ImportMappingInput {
  return {
    mapping: analysis.users.flatMap((u) => {
      const target = choices.get(u.archiveId);
      return target ? [{ archiveId: u.archiveId, target }] : [];
    }),
    ...(skipActivity && { skipActivity: true }),
  };
}

export const PLACEHOLDER_LABEL = 'Keep as former member (name only)';

export interface TargetOption {
  value: TargetKey;
  label: string;
  /** The address, shown after the name and matched by the filter box. */
  hint?: string;
  group: string;
}

/** The candidates as the person's choices: keeping the name first, then the importer, then everyone by name. */
export function targetOptions(candidates: readonly ImportCandidateDTO[]): TargetOption[] {
  const you = candidates.filter((c) => c.isYou);
  const others = candidates.filter((c) => !c.isYou);
  return [
    { value: 'placeholder', label: PLACEHOLDER_LABEL, group: 'Keep the name' },
    ...[...you, ...others].map((c) => ({
      value: `user:${c.userId}` as const,
      label: c.isYou ? `${c.displayName} (you)` : c.displayName,
      ...(c.email !== null && { hint: c.email }),
      group: 'Accounts',
    })),
  ];
}

/** What a target reads as on its button. */
export function targetText(target: ImportTarget | undefined, candidates: readonly ImportCandidateDTO[]): string {
  if (!target) return 'Choose…';
  if (target.kind === 'placeholder') return 'Former member (name only)';
  const c = candidates.find((x) => x.userId === target.userId);
  if (!c) return 'Choose…';
  return c.isYou ? `${c.displayName} (you)` : c.displayName;
}

const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** How many entries name the person: "3 tasks, 12 comments, 40 activity entries". */
export function referencesText(refs: ArchiveUserDTO['references']): string {
  const parts = [
    refs.tasks > 0 && count(refs.tasks, 'task', 'tasks'),
    refs.comments > 0 && count(refs.comments, 'comment', 'comments'),
    refs.worklogs > 0 && count(refs.worklogs, 'work log', 'work logs'),
    refs.activity > 0 && count(refs.activity, 'activity entry', 'activity entries'),
  ].filter((p): p is string => typeof p === 'string');
  return parts.length > 0 ? parts.join(', ') : 'Named in no entry';
}

// ---- Limits (§8.9) ------------------------------------------------------------------------------

export interface ImportFit {
  /** The rows the commit is estimated to write, with the choice made. */
  rowWrites: number;
  fits: boolean;
  /** Why it does not fit: the per-import limit, or what is left of today's budget. */
  reason: 'per_import' | 'daily' | null;
  /** Leaving out the activity history makes it fit (offer "Import without the activity history"). */
  offerSkip: boolean;
}

/** Whether the import fits the limits of `estimate` with `skipActivity` as chosen. */
export function importFit(estimate: ImportAnalysisDTO['estimate'], skipActivity: boolean): ImportFit {
  const fitsLimit = (n: number) => estimate.limit === null || n <= estimate.limit;
  const fitsToday = (n: number) => estimate.dailyLeft === null || n <= estimate.dailyLeft;
  const fits = (n: number) => fitsLimit(n) && fitsToday(n);
  const rowWrites = skipActivity ? estimate.rowWritesWithoutActivity : estimate.rowWrites;
  return {
    rowWrites,
    fits: fits(rowWrites),
    reason: fits(rowWrites) ? null : !fitsLimit(rowWrites) ? 'per_import' : 'daily',
    offerSkip: !fits(estimate.rowWrites) && fits(estimate.rowWritesWithoutActivity),
  };
}

/** Nothing is left of today's import budget (dailyLeft 0). */
export const DAILY_LIMIT_TEXT = 'This instance has reached today’s import limit; try again after 00:00 UTC.';

/**
 * What the step says when the import does not fit (null when it does): the per-import limit it is over; that
 * nothing is left of today's budget, or what is (when some is left, smaller imports still go through); and what
 * leaving the activity out would need, with when to try again when today's budget is all that stands in the way.
 */
export function fitText(estimate: ImportAnalysisDTO['estimate'], fit: ImportFit): string | null {
  if (fit.fits) return null;
  const n = (v: number) => v.toLocaleString('en-US');
  const { limit, dailyLeft } = estimate;
  const without = estimate.rowWritesWithoutActivity;
  const overLimit = (rows: number) => limit !== null && rows > limit;
  const overToday = (rows: number) => dailyLeft !== null && rows > dailyLeft;
  const parts: string[] = [];
  if (overLimit(fit.rowWrites)) parts.push(`This import needs about ${n(fit.rowWrites)} row writes; this instance allows ${n(limit!)} per import.`);
  if (dailyLeft === 0) return [...parts, DAILY_LIMIT_TEXT].join(' ');
  // What is left of today's budget is all that keeps this choice, or leaving the activity out, from fitting.
  const todayBlocks = !overLimit(fit.rowWrites) && overToday(fit.rowWrites);
  const todayBlocksSkip = !fit.offerSkip && without < fit.rowWrites && !overLimit(without) && overToday(without);
  if (todayBlocks) {
    parts.push(`About ${n(dailyLeft!)} row writes are left of today’s import limit, and this import needs about ${n(fit.rowWrites)}.`);
  }
  if (fit.offerSkip) parts.push(`Without its activity history it needs about ${n(without)}.`);
  else if (todayBlocksSkip) {
    parts.push(
      todayBlocks
        ? `Even without its activity history it needs about ${n(without)}.`
        : `Without its activity history it needs about ${n(without)}, but only about ${n(dailyLeft!)} are left of today’s import limit.`,
    );
  }
  if (!fit.offerSkip && (todayBlocks || todayBlocksSkip)) parts.push('Try again after 00:00 UTC.');
  return parts.join(' ');
}

/** Whether Replace may be pressed: everyone mapped, the limits kept, and on Cloudflare the download begun (§8.8). */
export function replaceReady(o: { mapped: boolean; fits: boolean; needsDownload: boolean; downloaded: boolean }): boolean {
  return o.mapped && o.fits && (!o.needsDownload || o.downloaded);
}
