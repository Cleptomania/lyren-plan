// /activity — the global activity feed with a project filter.

import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { useLookups } from '../../api/bootstrap';
import { useDocumentTitle } from '../../lib/hooks';
import { ActivityFeed } from './ActivityFeed';
import { ProjectFilter, useProjectParam } from './ProjectFilter';

export default function ActivityPage() {
  useDocumentTitle('Activity');
  const [projectId, setProjectId] = useProjectParam();
  const { projectById } = useLookups();
  const project = projectId !== undefined ? projectById.get(projectId) : undefined;

  return (
    <Page
      width="narrow"
      header={
        <PageHeader
          title="Activity"
          subtitle={project ? `Changes in ${project.name}` : 'Changes across all projects, newest first'}
          actions={
            // The width lives on a wrapper: Select's own `w-full` beats a `w-36` passed to it, and
            // in the shrink-to-fit actions slot the native select then grows to its longest option.
            <div className="w-36 sm:w-56">
              <ProjectFilter value={projectId} onChange={setProjectId} />
            </div>
          }
        />
      }
    >
      <ActivityFeed key={projectId ?? 'all'} projectId={projectId} />
    </Page>
  );
}
