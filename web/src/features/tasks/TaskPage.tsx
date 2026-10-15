// /tasks/:taskKey — a task on its own page (key = numeric id or ref like 'LYR-12').

import { useQueryClient } from '@tanstack/react-query';
import { Link2, SearchX } from 'lucide-react';
import { useCallback, useEffect, useMemo } from 'react';
import { useNavigate, useParams } from 'react-router';
import type { TaskDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { ApiError } from '../../api/client';
import { qk } from '../../api/keys';
import { useTask, useTaskByRef } from '../../api/tasks';
import { useTaskActions } from '../../components/domain';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { ButtonLink, EmptyState, ErrorState, IconButton, Skeleton, SkeletonText } from '../../components/ui';
import { useDocumentTitle } from '../../lib/hooks';
import { epicUrl, milestoneUrl, projectUrl } from '../../lib/taskLinks';
import { copyTaskLink, detailMenuItems, TaskDetail } from './TaskDetail';

export default function TaskPage() {
  const { taskKey = '' } = useParams();
  const qc = useQueryClient();
  const numeric = /^\d+$/.test(taskKey);
  const byRef = useTaskByRef(numeric ? null : taskKey);
  const id = numeric ? Number(taskKey) : byRef.data?.id;
  // The detail cache (by id) is what optimistic edits update, so render from it.
  useEffect(() => {
    if (byRef.data && !qc.getQueryData(qk.task(byRef.data.id))) qc.setQueryData(qk.task(byRef.data.id), byRef.data);
  }, [byRef.data, qc]);
  const detail = useTask(id);
  const task = detail.data ?? byRef.data;
  const error = numeric ? detail.error : byRef.error;

  useDocumentTitle(task ? `${task.ref} ${task.title}` : 'Task');

  // A project move changes the ref: keep the address bar on the current one.
  const navigate = useNavigate();
  useEffect(() => {
    if (task && !numeric && task.ref.toUpperCase() !== taskKey.toUpperCase() && detail.data) {
      navigate(`/tasks/${task.ref}`, { replace: true });
    }
  }, [task, numeric, taskKey, detail.data, navigate]);

  if (task) return <TaskPageContent task={task} />;

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Page width="narrow" header={<PageHeader title="Task not found" backTo="/dashboard" />}>
        <EmptyState
          icon={<SearchX />}
          title={`There is no task “${taskKey}”`}
          body="It may have been deleted, or moved to another project (which gives it a new key)."
          action={<ButtonLink to="/dashboard">Go to the dashboard</ButtonLink>}
        />
      </Page>
    );
  }
  if (error) {
    return (
      <Page width="narrow" header={<PageHeader title="Task" backTo="/dashboard" />}>
        <ErrorState error={error} onRetry={() => void (numeric ? detail.refetch() : byRef.refetch())} />
      </Page>
    );
  }
  return (
    <Page width="wide" header={<PageHeader title={<Skeleton className="h-5 w-24" />} />}>
      <div className="flex flex-col gap-5" aria-busy>
        <Skeleton className="h-8 w-2/3" />
        <SkeletonText lines={8} />
      </div>
    </Page>
  );
}

function TaskPageContent({ task }: { task: TaskDTO }) {
  const navigate = useNavigate();
  const { projectById, milestoneById, epicById } = useLookups();
  const project = projectById.get(task.projectId);
  const milestone = task.milestoneId !== null ? milestoneById.get(task.milestoneId) : undefined;
  const epic = task.epicId !== null ? epicById.get(task.epicId) : undefined;
  const backTo = project ? `${projectUrl(project.id)}/tasks` : '/dashboard';

  const onDeleted = useCallback(() => navigate(backTo, { replace: true }), [navigate, backTo]);
  const extra = useMemo(() => detailMenuItems(task), [task]);
  const menu = useTaskActions(task, extra, { onOpen: false, onDeleted });

  const breadcrumbs = [
    project && { label: project.name, to: projectUrl(project.id) },
    project && milestone && { label: milestone.name, to: milestoneUrl(project.id, milestone.id) },
    project && epic && { label: epic.name, to: epicUrl(project.id, epic.id) },
    { label: task.ref },
  ].filter((c): c is { label: string; to?: string } => !!c);

  return (
    <Page
      width="wide"
      header={
        <PageHeader
          title={task.ref}
          backTo={backTo}
          breadcrumbs={breadcrumbs}
          actions={<IconButton aria-label={`Copy link to ${task.ref}`} tooltip="Copy link" icon={<Link2 />} onClick={() => copyTaskLink(task)} />}
          menu={menu}
        />
      }
    >
      <TaskDetail key={task.id} task={task} variant="page" />
    </Page>
  );
}
