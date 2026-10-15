// /projects/:projectId/milestones/:milestoneId — inline-editable name/description, status,
// dates, progress, the milestone's epics and its tasks grouped by epic.

import { Milestone as MilestoneIcon, Plus } from 'lucide-react';
import { useRef } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { LIMITS } from '@shared/constants';
import type { MilestoneDTO, ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { DatePicker } from '../../components/domain';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button, Card, InlineEdit, type MenuItem } from '../../components/ui';
import { formatDate, isoToLocalDate } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { milestoneUrl, projectUrl } from '../../lib/taskLinks';
import { TaskList } from '../tasks/TaskList';
import { EditableMarkdown } from './EditableMarkdown';
import { EntityNotFound, ProgressPanel, PropertyList, PropertyRow, SidePanel } from './EntityPageParts';
import { EpicList } from './EpicList';
import { buildHierarchy, isMilestoneClosed } from './hierarchy';
import { milestoneMenuItems } from './hierarchyMenus';
import { LifecyclePicker } from './LifecycleStatus';
import { parseRouteId, useProjectContext } from './projectContext';
import { useHierarchyDialogs } from './useHierarchyDialogs';
import { useStillInBootstrap } from './leaveSave';
import { useSaveMilestone } from './useHierarchyMutations';

export default function MilestonePage() {
  const { project } = useProjectContext();
  const { milestoneId } = useParams();
  const id = parseRouteId(milestoneId);
  const { milestoneById } = useLookups();
  const milestone = id === null ? undefined : milestoneById.get(id);
  // Set while this page deletes the milestone, so its disappearance doesn't flash "not found".
  const deletingRef = useRef(false);
  useDocumentTitle(milestone ? `${milestone.name} · ${project.name}` : deletingRef.current ? null : 'Milestone not found');

  if (!milestone) return deletingRef.current ? null : <EntityNotFound kind="Milestone" project={project} />;
  if (milestone.projectId !== project.id) return <Navigate replace to={milestoneUrl(milestone.projectId, milestone.id)} />;
  return <MilestoneView key={milestone.id} project={project} milestone={milestone} deletingRef={deletingRef} />;
}

function MilestoneView({
  project,
  milestone: m,
  deletingRef,
}: {
  project: ProjectDTO;
  milestone: MilestoneDTO;
  deletingRef: { current: boolean };
}) {
  const navigate = useNavigate();
  const { milestonesByProject, epicsByProject } = useLookups();
  const save = useSaveMilestone();
  const stillInBootstrap = useStillInBootstrap();
  const dialogs = useHierarchyDialogs(project.id);
  const milestones = milestonesByProject.get(project.id) ?? [];
  const projectEpics = epicsByProject.get(project.id) ?? [];
  const { sections } = buildHierarchy(milestones, projectEpics);
  const epics = sections.find((s) => s.milestone.id === m.id)?.epics ?? [];
  const allEpicIds = [...projectEpics].sort((a, b) => a.position - b.position || a.id - b.id).map((e) => e.id);
  const closed = isMilestoneClosed(m.status);

  const remove = () =>
    dialogs.deleteMilestone(m, {
      onDeleting: () => (deletingRef.current = true),
      onFailed: () => (deletingRef.current = false),
      onDeleted: () => navigate(projectUrl(project.id), { replace: true }),
    });
  const menu = milestoneMenuItems(m, {
    edit: () => dialogs.editMilestone(m),
    setStatus: (status) => void save(m, { status }),
    addEpic: () => dialogs.newEpic(m.id),
    remove,
  }).filter((item): item is MenuItem => !!item);

  return (
    <Page
      width="wide"
      header={
        <PageHeader
          title={m.name}
          icon={<MilestoneIcon />}
          subtitle={`Milestone · ${project.name}`}
          backTo={projectUrl(project.id)}
          breadcrumbs={[
            { label: 'Projects', to: '/projects' },
            { label: project.name, to: projectUrl(project.id) },
          ]}
          menu={menu}
        />
      }
    >
      <div className="flex flex-col gap-6">
        <InlineEdit
          value={m.name}
          onSave={(name) => save(m, { name })}
          aria-label="Milestone name"
          maxLength={LIMITS.nameMax}
          className="text-xl font-semibold leading-tight text-fg md:text-2xl"
        />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
          <SidePanel>
            <PropertyList>
              <PropertyRow label="Status">
                <LifecyclePicker kind="milestone" size="md" value={m.status} onChange={(status) => void save(m, { status })} subject={m.name} />
              </PropertyRow>
              <PropertyRow label="Start date">
                <DatePicker
                  kind="start"
                  label="Start date"
                  value={m.startDate}
                  max={m.dueDate ?? undefined}
                  onChange={(startDate) => void save(m, { startDate })}
                  triggerProps={{ fullWidth: true }}
                />
              </PropertyRow>
              <PropertyRow label="Due date">
                <DatePicker
                  label="Due date"
                  value={m.dueDate}
                  closed={closed}
                  min={m.startDate ?? undefined}
                  onChange={(dueDate) => void save(m, { dueDate })}
                  triggerProps={{ fullWidth: true }}
                />
              </PropertyRow>
              {m.completedAt && (
                <PropertyRow label={m.status === 'cancelled' ? 'Cancelled' : 'Completed'}>
                  <span className="px-2 text-sm text-fg">{formatDate(isoToLocalDate(m.completedAt))}</span>
                </PropertyRow>
              )}
              <PropertyRow label="Epics">
                <span className="px-2 text-sm tabular-nums text-fg">
                  {m.stats.epicsTotal > 0 ? `${m.stats.epicsDone} of ${m.stats.epicsTotal} done` : 'None'}
                </span>
              </PropertyRow>
            </PropertyList>
            <div className="border-t border-border pt-4">
              <ProgressPanel stats={m.stats} />
            </div>
          </SidePanel>

          <div className="flex min-w-0 flex-col gap-6">
            <Card padding="lg">
              <EditableMarkdown
                heading="Description"
                label="Milestone description"
                value={m.description}
                onSave={async (description) => (await save(m, { description })) !== undefined}
                canSaveOnLeave={() => stillInBootstrap('milestones', m.id)}
              />
            </Card>

            <section aria-labelledby="milestone-epics" className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <h2 id="milestone-epics" className="text-[15px] font-semibold text-fg">
                  Epics
                </h2>
                <Button size="sm" icon={<Plus />} onClick={() => dialogs.newEpic(m.id)}>
                  Add epic
                </Button>
              </div>
              <Card padding="none">
                <EpicList
                  projectId={project.id}
                  epics={epics}
                  allEpicIds={allEpicIds}
                  milestones={milestones}
                  dialogs={dialogs}
                  emptyText="No epics in this milestone yet. Tasks join a milestone through their epic."
                />
              </Card>
            </section>

            <section aria-labelledby="milestone-tasks" className="flex flex-col gap-3">
              <h2 id="milestone-tasks" className="text-[15px] font-semibold text-fg">
                Tasks
              </h2>
              <TaskList
                filter={{ projectIds: [project.id], milestoneIds: [m.id] }}
                groupBy="epic"
                hide={['project', 'milestone', 'epic']}
                emptyMessage="No tasks yet. Add tasks to this milestone’s epics."
              />
            </section>
          </div>
        </div>
      </div>
      {dialogs.dialogs}
    </Page>
  );
}
