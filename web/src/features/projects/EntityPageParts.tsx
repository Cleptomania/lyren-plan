// Building blocks of the milestone and epic pages: the property panel and the not-found state.

import { SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProgressStats, ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { TaskProgress } from '../../components/domain';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { ButtonLink, Card, EmptyState } from '../../components/ui';
import { projectUrl } from '../../lib/taskLinks';

/** Label / value grid for the property panel (`<dl>`). */
export function PropertyList({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">{children}</dl>;
}

export function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** Task-count and estimate progress of a milestone / epic. */
export function ProgressPanel({ stats, color }: { stats: ProgressStats; color?: string }) {
  const { settings } = useLookups();
  return (
    <div className="flex flex-col gap-3">
      <TaskProgress stats={stats} label="Tasks" color={color} />
      {stats.estimateTotal > 0 && (
        <TaskProgress stats={stats} basis="estimate" label={settings.estimateUnit === 'hours' ? 'Estimated hours' : 'Story points'} color={color} />
      )}
    </div>
  );
}

/** Side panel card (properties + progress); on phones it sits under the title. */
export function SidePanel({ children }: { children: ReactNode }) {
  return (
    <aside className="lg:order-last">
      <Card padding="md" className="flex flex-col gap-4">
        {children}
      </Card>
    </aside>
  );
}

export function EntityNotFound({ kind, project }: { kind: 'Milestone' | 'Epic'; project: ProjectDTO }) {
  return (
    <Page
      width="wide"
      header={
        <PageHeader
          title={`${kind} not found`}
          backTo={projectUrl(project.id)}
          breadcrumbs={[
            { label: 'Projects', to: '/projects' },
            { label: project.name, to: projectUrl(project.id) },
          ]}
        />
      }
    >
      <EmptyState
        icon={<SearchX />}
        title={`This ${kind.toLowerCase()} doesn’t exist`}
        body="It may have been deleted, or the link is wrong."
        action={<ButtonLink to={projectUrl(project.id)}>Back to {project.name}</ButtonLink>}
      />
    </Page>
  );
}
