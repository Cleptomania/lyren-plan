// Pure display helpers for tasks: closed state, card/row field sets, edge colors and
// plain-text previews. No React, no DOM — unit-tested in helpers.test.ts.

import { cardConfigSchema, type CardColorBy, type CardConfig } from '@shared/board';
import { COLOR_PALETTE, isClosedCategory, PRIORITY_META } from '@shared/constants';
import type { TaskUpdateInput } from '@shared/schemas';
import type { EpicDTO, MilestoneDTO, ProjectDTO, StatusDTO, TaskDTO } from '@shared/types';

export type CardFields = CardConfig['fields'];
export type CardFieldKey = keyof CardFields;

/** The board default (cardConfigSchema defaults): ref, project, epic, tags, priority, due date, comments. */
export const DEFAULT_CARD_FIELDS: Readonly<CardFields> = Object.freeze(cardConfigSchema.parse({}).fields);

/** What a TaskRow shows when no `fields` are given (lists, dashboard, search results). */
export const DEFAULT_ROW_FIELDS: Readonly<CardFields> = Object.freeze({
  ...DEFAULT_CARD_FIELDS,
  status: true,
  estimate: true,
});

/** Context badges a TaskRow can hide when they are redundant on the page. */
export type RowHideKey = 'project' | 'epic' | 'milestone' | 'status';

/** Merge partial field toggles over a default set. */
export function resolveFields(fields: Partial<CardFields> | undefined, defaults: Readonly<CardFields>): CardFields {
  return fields ? { ...defaults, ...fields } : { ...defaults };
}

/** Row field set: explicit `fields` (board list layout) or the row defaults, minus `hide` / ref. */
export function resolveRowFields(
  fields: Partial<CardFields> | undefined,
  hide: readonly RowHideKey[] | undefined,
  showRef: boolean,
): CardFields {
  const out = resolveFields(fields, DEFAULT_ROW_FIELDS);
  for (const key of hide ?? []) out[key] = false;
  if (!showRef) out.ref = false;
  return out;
}

export type ClosedKind = 'completed' | 'cancelled';

/** 'completed' / 'cancelled' when the task's status is closed, else null. */
export function taskClosedKind(task: Pick<TaskDTO, 'statusId'>, statusById: ReadonlyMap<number, StatusDTO>): ClosedKind | null {
  const category = statusById.get(task.statusId)?.category;
  if (!category || !isClosedCategory(category)) return null;
  return category === 'cancelled' ? 'cancelled' : 'completed';
}

export function taskIsClosed(task: Pick<TaskDTO, 'statusId'>, statusById: ReadonlyMap<number, StatusDTO>): boolean {
  return taskClosedKind(task, statusById) !== null;
}

function hashString(value: string): number {
  // FNV-1a: tiny, stable across sessions and platforms.
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A stable palette color for a seed (entities without a color of their own, new tags). */
export function paletteColor(seed: string | number): string {
  const palette = COLOR_PALETTE;
  return palette[hashString(String(seed).toLocaleLowerCase()) % palette.length]!;
}

export interface ColorLookups {
  projectById: ReadonlyMap<number, ProjectDTO>;
  milestoneById: ReadonlyMap<number, MilestoneDTO>;
  epicById: ReadonlyMap<number, EpicDTO>;
  statusById: ReadonlyMap<number, StatusDTO>;
}

/**
 * Edge color of a card for the board's `card.colorBy` (null = no edge).
 * Milestones have no color of their own: they get a stable palette color from their id.
 * 'tag' uses the first tag by name (TaskDTO.tags is sorted by name).
 */
export function taskColor(task: TaskDTO, colorBy: CardColorBy, lookups: ColorLookups): string | null {
  switch (colorBy) {
    case 'none':
      return null;
    case 'project':
      return lookups.projectById.get(task.projectId)?.color ?? null;
    case 'milestone':
      return task.milestoneId !== null && lookups.milestoneById.has(task.milestoneId)
        ? paletteColor(`milestone:${task.milestoneId}`)
        : null;
    case 'epic':
      return task.epicId !== null ? (lookups.epicById.get(task.epicId)?.color ?? null) : null;
    case 'priority':
      return task.priority === 0 ? null : PRIORITY_META[task.priority].color;
    case 'status':
      return lookups.statusById.get(task.statusId)?.color ?? null;
    case 'tag':
      return task.tags[0]?.color ?? null;
  }
}

/**
 * Plain-text preview of Markdown for card/row snippets: drops code blocks, images, heading /
 * list / quote markers and emphasis, keeps link text and inline code (verbatim, so `<li>` or
 * `a < b` survive), flattens GFM tables to "cell · cell", collapses whitespace, and truncates
 * at a word boundary with an ellipsis. Raw HTML is kept as text, as the Markdown renderer
 * shows it (it does not render HTML).
 */
export function markdownExcerpt(markdown: string, maxLength = 160): string {
  const code: string[] = [];
  /** Inline code is swapped for \u0000<n>\u0000 tokens so no later rule touches its text. */
  const protect = (text: string) => `\u0000${code.push(text) - 1}\u0000`;
  let text = markdown
    .replace(/\u0000/g, '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(~~~|$)/g, ' ')
    // Code spans: a run of n backticks up to the next run of exactly n (no line breaks).
    .replace(/(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (_m, _ticks: string, inner: string) =>
      protect(/^ .* $/.test(inner) ? inner.slice(1, -1) : inner),
    );
  text = flattenTables(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^<>\s]+)>/gi, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:!?-]+$/, '')}…`;
}

/** A GFM table delimiter row: `| --- | :-: |`, `---|---` (needs a pipe and a hyphen). */
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function tableCells(line: string): string {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(^|[^\\])\|$/, '$1')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'))
    .filter(Boolean)
    .join(' · ');
}

/** GFM tables (a header row, a delimiter row, rows up to a blank line) → one "a · b" line per row. */
function flattenTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (inTable) {
      if (line.trim() === '') {
        inTable = false;
        out.push(line);
      } else {
        out.push(tableCells(line));
      }
      continue;
    }
    const header = out[out.length - 1];
    if (header !== undefined && header.includes('|') && line.includes('|') && TABLE_DELIMITER.test(line)) {
      out[out.length - 1] = tableCells(header);
      inTable = true;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Tag change as add/remove ids relative to the tags the editor started from, so a
 * concurrent change to other tags is not overwritten. null = nothing changed.
 */
export function tagPatch(before: readonly number[], after: readonly number[]): TaskUpdateInput | null {
  const addTagIds = after.filter((id) => !before.includes(id));
  const removeTagIds = before.filter((id) => !after.includes(id));
  if (addTagIds.length === 0 && removeTagIds.length === 0) return null;
  return {
    ...(addTagIds.length > 0 ? { addTagIds } : {}),
    ...(removeTagIds.length > 0 ? { removeTagIds } : {}),
  };
}
