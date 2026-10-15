import { describe, expect, it } from 'vitest';
import type { TaskKey } from '../../api/tasks';
import { createTaskDefaults, mobileTabForPath, taskKeyForLocation, type CreateDefaultsLookups } from './navigation';

const lookups: CreateDefaultsLookups = {
  projectById: new Map([
    [1, { id: 1 }],
    [2, { id: 2 }],
  ]),
  epicById: new Map([
    [10, { projectId: 1 }],
    [20, { projectId: 2 }],
  ]),
  boardById: new Map([
    [5, { projectId: 2, config: { filter: {} } }],
    [6, { projectId: null, config: { filter: { projectIds: [1] } } }],
    [7, { projectId: null, config: { filter: { projectIds: [1, 2] } } }],
  ]),
};

const at = (pathname: string, search = '') => createTaskDefaults({ pathname, search }, lookups);

describe('createTaskDefaults', () => {
  it('uses the project of project pages', () => {
    expect(at('/projects/1')).toEqual({ projectId: 1 });
    expect(at('/projects/2/board')).toEqual({ projectId: 2 });
    expect(at('/projects/1/milestones/3')).toEqual({ projectId: 1 });
  });
  it('adds the epic on epic pages when it belongs to the project', () => {
    expect(at('/projects/1/epics/10')).toEqual({ projectId: 1, epicId: 10 });
    expect(at('/projects/1/epics/20')).toEqual({ projectId: 1 });
  });
  it("uses a board's project or its single filtered project", () => {
    expect(at('/boards/5')).toEqual({ projectId: 2 });
    expect(at('/boards/6')).toEqual({ projectId: 1 });
    expect(at('/boards/7')).toEqual({});
  });
  it('returns nothing for unknown ids and other pages', () => {
    expect(at('/projects/99')).toEqual({});
    expect(at('/boards/abc')).toEqual({});
    expect(at('/dashboard')).toEqual({});
  });

  describe('with a task on screen', () => {
    // Loaded tasks: 41 = project 2 / epic 20, 42 = project 1 without epic, 43 = project 1 with a
    // foreign epic (stale data), 44 = an unknown project. By ref: WEB-7 = task 41.
    const tasks = new Map([
      [41, { projectId: 2, epicId: 20 }],
      [42, { projectId: 1, epicId: null }],
      [43, { projectId: 1, epicId: 20 }],
      [44, { projectId: 99, epicId: null }],
    ]);
    const seen: TaskKey[] = [];
    const withTasks: CreateDefaultsLookups = {
      ...lookups,
      findTask: (key) => {
        seen.push(key);
        return 'id' in key ? tasks.get(key.id) : key.ref === 'WEB-7' ? tasks.get(41) : undefined;
      },
    };
    const on = (pathname: string, search = '') => createTaskDefaults({ pathname, search }, withTasks);

    it("uses the task page's project and epic, by id or by ref", () => {
      expect(on('/tasks/41')).toEqual({ projectId: 2, epicId: 20 });
      expect(on('/tasks/web-7')).toEqual({ projectId: 2, epicId: 20 });
      expect(on('/tasks/42')).toEqual({ projectId: 1 });
      expect(seen.slice(-3)).toEqual([{ id: 41 }, { ref: 'WEB-7' }, { id: 42 }]);
    });
    it('prefers the drawer task over the page under it', () => {
      expect(on('/projects/1/board', '?task=41')).toEqual({ projectId: 2, epicId: 20 });
      expect(on('/projects/2/epics/20', 'task=42&q=x')).toEqual({ projectId: 1 });
      expect(on('/dashboard', '?task=41')).toEqual({ projectId: 2, epicId: 20 });
    });
    it("drops an epic of another project and ignores a task of an unknown project", () => {
      expect(on('/tasks/43')).toEqual({ projectId: 1 });
      expect(on('/tasks/44')).toEqual({});
      expect(on('/projects/1', '?task=44')).toEqual({ projectId: 1 });
    });
    it('falls back to the page while the task has not loaded', () => {
      expect(on('/projects/1/epics/10', '?task=999')).toEqual({ projectId: 1, epicId: 10 });
      expect(on('/tasks/999')).toEqual({});
      expect(on('/tasks/NOPE-1')).toEqual({});
      // Without a task lookup at all (e.g. no cache access), only the page counts.
      expect(at('/boards/5', '?task=41')).toEqual({ projectId: 2 });
    });
  });
});

describe('taskKeyForLocation', () => {
  it('reads the drawer param first, then a task page key', () => {
    expect(taskKeyForLocation({ pathname: '/boards/5', search: '?task=12' })).toEqual({ id: 12 });
    expect(taskKeyForLocation({ pathname: '/tasks/WEB-3', search: '?task=12' })).toEqual({ id: 12 });
    expect(taskKeyForLocation({ pathname: '/tasks/18' })).toEqual({ id: 18 });
    expect(taskKeyForLocation({ pathname: '/tasks/web-3' })).toEqual({ ref: 'WEB-3' });
  });
  it('ignores invalid drawer ids and other pages', () => {
    for (const search of ['?task=0', '?task=-3', '?task=1.5', '?task=abc', '?task=1e3', '?task=', '']) {
      expect(taskKeyForLocation({ pathname: '/dashboard', search })).toBeNull();
    }
    expect(taskKeyForLocation({ pathname: '/tasks' })).toBeNull();
    expect(taskKeyForLocation({ pathname: '/projects/1/tasks' })).toBeNull();
  });
});

describe('mobileTabForPath', () => {
  it('maps sections to tabs', () => {
    expect(mobileTabForPath('/')).toBe('home');
    expect(mobileTabForPath('/dashboard')).toBe('home');
    expect(mobileTabForPath('/projects/3/board')).toBe('projects');
    expect(mobileTabForPath('/boards')).toBe('boards');
    expect(mobileTabForPath('/settings/tags')).toBe('more');
    expect(mobileTabForPath('/tasks/WEB-1')).toBeNull();
  });
});
