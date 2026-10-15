// Client-side check of a JSON export before it is sent to POST /api/data/import: parse,
// validate the shape with the shared exportSchema and summarise what it contains. The server
// re-validates everything (shape + referential integrity); this only gives early, readable
// feedback and the counts shown before the user confirms.

import { exportSchema } from '@shared/export';

export interface ImportCount {
  key: string;
  label: string;
  count: number;
}

export interface ImportSummary {
  exportedAt: string;
  appVersion: string;
  counts: ImportCount[];
}

export type ImportCheck =
  | { ok: true; payload: unknown; summary: ImportSummary }
  | { ok: false; error: string; problems: string[] };

const COUNTED: ReadonlyArray<[key: string, label: string]> = [
  ['projects', 'Projects'],
  ['milestones', 'Milestones'],
  ['epics', 'Epics'],
  ['tasks', 'Tasks'],
  ['comments', 'Comments'],
  ['worklogs', 'Work logs'],
  ['tags', 'Tags'],
  ['statuses', 'Statuses'],
  ['boards', 'Boards'],
  ['activity', 'Activity entries'],
];

const MAX_PROBLEMS = 5;

export function checkImportFile(text: string): ImportCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON.', problems: [] };
  }
  if (typeof raw !== 'object' || raw === null || (raw as { format?: unknown }).format !== 'lyren-plan-export') {
    return { ok: false, error: 'This is not a Lyren Plan export file.', problems: [] };
  }
  const version = (raw as { formatVersion?: unknown }).formatVersion;
  if (version !== 1) {
    return {
      ok: false,
      error: `This export uses format version ${JSON.stringify(version)}, which this version of Lyren Plan cannot import.`,
      problems: [],
    };
  }
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const problems = issues.slice(0, MAX_PROBLEMS).map((i) => {
      const where = i.path.map(String).join('.');
      return where ? `${where}: ${i.message}` : i.message;
    });
    if (issues.length > MAX_PROBLEMS) problems.push(`…and ${issues.length - MAX_PROBLEMS} more`);
    return { ok: false, error: 'The file does not match the export format.', problems };
  }
  const data = parsed.data as unknown as Record<string, unknown[]>;
  return {
    ok: true,
    payload: raw,
    summary: {
      exportedAt: parsed.data.exportedAt,
      appVersion: parsed.data.appVersion,
      counts: COUNTED.map(([key, label]) => ({ key, label, count: data[key]?.length ?? 0 })),
    },
  };
}
