// /api/tasks — query, CRUD, duplicate and bulk edits (SPEC §5.5, §7). The write logic lives
// in services/taskMutations.ts; reading/filtering in services/tasks.ts.

import { Hono } from 'hono';
import {
  taskBulkDeleteInput,
  taskBulkUpdateInput,
  taskCreateInput,
  taskQueryInput,
  taskUpdateInput,
} from '@shared/schemas';
import type { TaskDTO, TaskQueryResult } from '@shared/types';
import { currentUser } from '../auth/context';
import type { AppEnv, Deps } from '../env';
import { notFound } from '../http/errors';
import { readId, readJson } from '../http/validate';
import {
  bulkDeleteTasks,
  bulkUpdateTasks,
  createTask,
  deleteTask,
  duplicateTask,
  updateTask,
} from '../services/taskMutations';
import { findTaskByRef, getTaskDTO, queryTasks } from '../services/tasks';

export function taskRoutes({ db }: Deps) {
  const r = new Hono<AppEnv>();

  r.post('/query', async (c) => {
    const input = await readJson(c, taskQueryInput);
    return c.json<TaskQueryResult>(queryTasks(db, input));
  });

  r.post('/bulk', async (c) => {
    const { ids, patch } = await readJson(c, taskBulkUpdateInput);
    const tasks = bulkUpdateTasks(db, { userId: currentUser(c).id }, ids, patch);
    return c.json<{ tasks: TaskDTO[] }>({ tasks });
  });

  r.post('/bulk-delete', async (c) => {
    const { ids } = await readJson(c, taskBulkDeleteInput);
    const deleted = bulkDeleteTasks(db, { userId: currentUser(c).id }, ids);
    return c.json<{ deleted: number }>({ deleted });
  });

  r.post('/', async (c) => {
    const input = await readJson(c, taskCreateInput);
    return c.json<TaskDTO>(createTask(db, { userId: currentUser(c).id }, input), 201);
  });

  r.get('/ref/:ref', (c) => {
    const task = findTaskByRef(db, c.req.param('ref'));
    if (!task) throw notFound('Task');
    return c.json<TaskDTO>(task);
  });

  r.get('/:id', (c) => c.json<TaskDTO>(getTaskDTO(db, readId(c))));

  r.patch('/:id', async (c) => {
    const id = readId(c);
    const input = await readJson(c, taskUpdateInput);
    return c.json<TaskDTO>(updateTask(db, { userId: currentUser(c).id }, id, input));
  });

  r.delete('/:id', (c) => {
    deleteTask(db, { userId: currentUser(c).id }, readId(c));
    return c.json({ ok: true as const });
  });

  r.post('/:id/duplicate', (c) => {
    const id = readId(c);
    return c.json<TaskDTO>(duplicateTask(db, { userId: currentUser(c).id }, id), 201);
  });

  return r;
}
