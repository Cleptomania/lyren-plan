// /projects/:projectId/epics/:epicId — inline-editable name/description, status, milestone,
// color, dates, progress and the epic's tasks grouped by status.

import { useRef } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { LIMITS } from '@shared/constants';
import type { EpicDTO, ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSpace, useSpaceId, useSpacePath } from '../../app/space';
import { DatePicker, MilestonePicker, PropertyButton } from '../../components/domain';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card, ColorPicker, InlineEdit, Popover, type MenuItem } from '../../components/ui';
import { formatDate, isoToLocalDate } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { epicUrl, milestoneUrl, projectUrl } from '../../lib/taskLinks';
import { TaskList } from '../tasks/TaskList';
import { EditableMarkdown } from './EditableMarkdown';
import { EntityNotFound, ProgressPanel, PropertyList, PropertyRow, SidePanel } from './EntityPageParts';
import { isEpicClosed } from './hierarchy';
import { epicMenuItems } from './hierarchyMenus';
import { LifecyclePicker } from './LifecycleStatus';
import { parseRouteId, useProjectContext } from './projectContext';
import { useHierarchyDialogs } from './useHierarchyDialogs';
import { useStillInBootstrap } from './leaveSave';
import { useSaveEpic } from './useHierarchyMutations';

export default function EpicPage() {
  const sid = useSpaceId();
  const { project } = useProjectContext();
  const { epicId } = useParams();
  const id = parseRouteId(epicId);
  const { epicById } = useLookups();
  const epic = id === null ? undefined : epicById.get(id);
  const deletingRef = useRef(false);
  useDocumentTitle(epic ? `${epic.name} · ${project.name}` : deletingRef.current ? null : 'Epic not found');

  if (!epic) return deletingRef.current ? null : <EntityNotFound kind="Epic" project={project} />;
  if (epic.projectId !== project.id) return <Navigate replace to={epicUrl(sid, epic.projectId, epic.id)} />;
  return <EpicView key={epic.id} project={project} epic={epic} deletingRef={deletingRef} />;
}

function EpicView({ project, epic: e, deletingRef }: { project: ProjectDTO; epic: EpicDTO; deletingRef: { current: boolean } }) {
  const sp = useSpacePath();
  const sid = useSpaceId();
  const { write } = useSpace().permissions;
  const navigate = useNavigate();
  const { milestoneById, milestonesByProject } = useLookups();
  const save = useSaveEpic();
  const stillInBootstrap = useStillInBootstrap();
  const dialogs = useHierarchyDialogs(project.id);
  const milestone = e.milestoneId === null ? undefined : milestoneById.get(e.milestoneId);
  const milestones = milestonesByProject.get(project.id) ?? [];
  const closed = isEpicClosed(e.status);

  const setMilestone = (milestoneId: number | null) => {
    if (milestoneId === e.milestoneId) return;
    const target = milestoneId === null ? undefined : milestoneById.get(milestoneId);
    void save(e, { milestoneId }, target ? `Moved to ${target.name}` : 'Removed from its milestone');
  };
  // Viewers (design §12.9) read the epic: no menu, no editors.
  const menu = write
    ? epicMenuItems(e, {
        edit: () => dialogs.editEpic(e),
        setStatus: (status) => void save(e, { status }),
        milestones,
        setMilestone,
        remove: () =>
          dialogs.deleteEpic(e, {
            onDeleting: () => (deletingRef.current = true),
            onFailed: () => (deletingRef.current = false),
            onDeleted: () => navigate(milestone ? milestoneUrl(sid, project.id, milestone.id) : projectUrl(sid, project.id), { replace: true }),
          }),
      }).filter((item): item is MenuItem => !!item)
    : undefined;

  return (
    <Page
      width="wide"
      header={
        <PageHeader
          title={e.name}
          icon={<span aria-hidden className="size-3 rotate-45 rounded-[3px]" style={{ backgroundColor: e.color }} />}
          subtitle={`Epic · ${project.name}${milestone ? ` › ${milestone.name}` : ''}`}
          backTo={milestone ? milestoneUrl(sid, project.id, milestone.id) : projectUrl(sid, project.id)}
          breadcrumbs={[
            { label: 'Projects', to: sp('/projects') },
            { label: project.name, to: projectUrl(sid, project.id) },
            ...(milestone ? [{ label: milestone.name, to: milestoneUrl(sid, project.id, milestone.id) }] : []),
          ]}
          menu={menu}
        />
      }
    >
      <div className="flex flex-col gap-6">
        <InlineEdit
          value={e.name}
          onSave={(name) => save(e, { name })}
          disabled={!write}
          aria-label="Epic name"
          maxLength={LIMITS.nameMax}
          className="text-xl font-semibold leading-tight text-fg md:text-2xl"
        />
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
          <SidePanel>
            <PropertyList>
              <PropertyRow label="Status">
                <LifecyclePicker kind="epic" size="md" value={e.status} onChange={(status) => void save(e, { status })} subject={e.name} />
              </PropertyRow>
              <PropertyRow label="Milestone">
                <MilestonePicker projectId={project.id} value={e.milestoneId} onChange={setMilestone} triggerProps={{ fullWidth: true, readOnly: !write }} />
              </PropertyRow>
              <PropertyRow label="Color">
                <Popover
                  title="Epic color"
                  className="w-72 p-3"
                  trigger={
                    <PropertyButton
                      fullWidth
                      readOnly={!write}
                      aria-label={write ? `Epic color: ${e.color}. Change` : `Epic color: ${e.color}`}
                      icon={<span className="size-3 rotate-45 rounded-[3px]" style={{ backgroundColor: e.color }} />}
                    >
                      <span className="font-mono text-xs">{e.color}</span>
                    </PropertyButton>
                  }
                >
                  {({ close }) => (
                    <ColorPicker
                      value={e.color}
                      aria-label="Epic color"
                      onChange={(color) => {
                        close();
                        if (color.toLowerCase() !== e.color) void save(e, { color });
                      }}
                    />
                  )}
                </Popover>
              </PropertyRow>
              <PropertyRow label="Start date">
                <DatePicker
                  kind="start"
                  label="Start date"
                  value={e.startDate}
                  max={e.dueDate ?? undefined}
                  onChange={(startDate) => void save(e, { startDate })}
                  triggerProps={{ fullWidth: true, readOnly: !write }}
                />
              </PropertyRow>
              <PropertyRow label="Due date">
                <DatePicker
                  label="Due date"
                  value={e.dueDate}
                  closed={closed}
                  min={e.startDate ?? undefined}
                  onChange={(dueDate) => void save(e, { dueDate })}
                  triggerProps={{ fullWidth: true, readOnly: !write }}
                />
              </PropertyRow>
              {e.completedAt && (
                <PropertyRow label={e.status === 'cancelled' ? 'Cancelled' : 'Done'}>
                  <span className="px-2 text-sm text-fg">{formatDate(isoToLocalDate(e.completedAt))}</span>
                </PropertyRow>
              )}
            </PropertyList>
            <div className="border-t border-border pt-4">
              <ProgressPanel stats={e.stats} color={e.color} />
            </div>
          </SidePanel>

          <div className="flex min-w-0 flex-col gap-6">
            <Card padding="lg">
              <EditableMarkdown
                heading="Description"
                label="Epic description"
                value={e.description}
                onSave={async (description) => (await save(e, { description })) !== undefined}
                canSaveOnLeave={() => stillInBootstrap('epics', e.id)}
                readOnly={!write}
              />
            </Card>
            <section aria-labelledby="epic-tasks" className="flex flex-col gap-3">
              <h2 id="epic-tasks" className="text-[15px] font-semibold text-fg">
                Tasks
              </h2>
              <TaskList
                filter={{ projectIds: [project.id], epicIds: [e.id] }}
                groupBy="status"
                createDefaults={{ projectId: project.id, epicId: e.id }}
                hide={['project', 'epic', 'milestone']}
                emptyMessage="No tasks in this epic yet."
              />
            </section>
          </div>
        </div>
      </div>
      {dialogs.dialogs}
    </Page>
  );
}

