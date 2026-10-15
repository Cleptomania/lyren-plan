import { describe, expect, it } from 'vitest';
import { boardConfigSchema, customGroupKey, resolveDropPatch } from '@shared/board';
import { buildFilterContext } from '@shared/filter';
import { task } from '../../components/domain/fixtures.test-utils';
import { BOARD_TEMPLATES, findTemplate, templatesFor } from './templates';

const tags = [
  { id: 1, name: 'bug' },
  { id: 2, name: 'Blocked' },
];

describe('board templates', () => {
  it('every template builds a valid config for global and project boards', () => {
    for (const t of BOARD_TEMPLATES) {
      for (const projectId of [null, 7]) {
        const parsed = boardConfigSchema.safeParse(t.build({ tags, projectId }));
        expect(parsed.success, `${t.id} / ${projectId}`).toBe(true);
      }
    }
  });

  it('offers project-spanning templates only for global boards', () => {
    expect(templatesFor(null).map((t) => t.id)).toEqual(BOARD_TEMPLATES.map((t) => t.id));
    expect(templatesFor(3).map((t) => t.id)).not.toContain('project-lanes');
    const triage = boardConfigSchema.parse(findTemplate('priority')!.build({ tags, projectId: 3 }));
    expect(triage.swimlanes.groupBy).toBe('none');
    expect(boardConfigSchema.parse(findTemplate('priority')!.build({ tags, projectId: null })).swimlanes.groupBy).toBe('project');
  });

  it('custom starter: Blocked only with a "blocked" tag; each drop patch lands the task in its column', () => {
    const without = boardConfigSchema.parse(findTemplate('custom')!.build({ tags: [], projectId: null }));
    expect(without.columns.custom.map((c) => c.name)).toEqual(['Now', 'Next', 'Later']);
    const cfg = boardConfigSchema.parse(findTemplate('custom')!.build({ tags, projectId: null }));
    expect(cfg.columns.custom.map((c) => c.id)).toEqual(['blocked', 'now', 'next', 'later']);
    const fctx = buildFilterContext({ statuses: [{ id: 1, category: 'unstarted' }], projects: [{ id: 1, status: 'active' }], today: '2026-10-14', weekStartsOn: 1 });
    for (const col of cfg.columns.custom) {
      const patch = resolveDropPatch(col.onDrop!, '2026-10-14', 1);
      const moved = task({
        priority: patch.priority ?? 2,
        tags: (patch.addTagIds ?? []).map((id) => ({ id, name: String(id), color: '#000000' })),
      });
      expect(customGroupKey(moved, cfg.columns.custom, fctx), col.id).toBe(col.id);
    }
  });

  it('hides the redundant project badge on project boards', () => {
    for (const t of BOARD_TEMPLATES) {
      expect(boardConfigSchema.parse(t.build({ tags, projectId: 7 })).card.fields.project, t.id).toBe(false);
    }
    expect(boardConfigSchema.parse(findTemplate('status')!.build({ tags, projectId: null })).card.fields.project).toBe(true);
  });

  it('due-this-week hides the buckets its filter excludes', () => {
    const cfg = boardConfigSchema.parse(findTemplate('due-week')!.build({ tags, projectId: null }));
    expect(cfg.columns.groupBy).toBe('due');
    expect(cfg.columns.prefs.due?.hidden).toEqual(['past', 'next_week', 'later', 'no_date']);
  });
});
