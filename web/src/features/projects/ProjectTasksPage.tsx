// /projects/:projectId/tasks — every task of the project: selectable list with toolbar,
// grouped by status by default.

import { TaskList } from '../tasks/TaskList';
import { useProjectContext } from './projectContext';

export default function ProjectTasksPage() {
  const { project } = useProjectContext();
  return (
    <TaskList
      key={project.id}
      filter={{ projectIds: [project.id] }}
      groupBy="status"
      selectable
      toolbar
      createDefaults={{ projectId: project.id }}
      hide={['project']}
      emptyMessage="No tasks in this project yet."
    />
  );
}
