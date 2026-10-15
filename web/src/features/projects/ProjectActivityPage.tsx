// /projects/:projectId/activity — the project's activity feed (structural changes and tasks).

import { ActivityFeed } from '../timeline/ActivityFeed';
import { useProjectContext } from './projectContext';

export default function ProjectActivityPage() {
  const { project } = useProjectContext();
  return (
    <div className="mx-auto w-full max-w-3xl">
      <h2 className="sr-only">Activity</h2>
      <ActivityFeed key={project.id} projectId={project.id} />
    </div>
  );
}
