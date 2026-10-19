// /projects — project cards filtered by status (Active / On hold / Completed / Archived / All),
// "New project", and manual order (drag on desktop, Move up/down in each card's menu). Viewers only open
// projects; deleting one is for admins and owners (design §6.2, §12.9).

import { clsx } from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  ExternalLink,
  FolderKanban,
  Milestone as MilestoneIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ProjectStatus } from '@shared/constants';
import type { MilestoneDTO, ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { useSpace, useSpaceId } from '../../app/space';
import { DueDateLabel, markdownExcerpt, useSharedToday } from '../../components/domain';
import { Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button, Card, EmptyState, IconButton, Menu, ProgressBar, Section, Tabs, toast, type MenuItemInput } from '../../components/ui';
import { percent, pluralize } from '../../lib/format';
import { useDocumentTitle } from '../../lib/hooks';
import { projectUrl } from '../../lib/taskLinks';
import { DeleteProjectDialog } from './DeleteDialogs';
import { moveWithinSubset, nextMilestone, reorderSubset } from './hierarchy';
import { LifecycleBadge, lifecycleMeta } from './LifecycleStatus';
import { ProjectFormDialog } from './ProjectFormDialog';
import { SortableList, type SortableRenderProps } from './SortableList';
import { useReorder, useSaveProject } from './useHierarchyMutations';

type Filter = ProjectStatus | 'all';
const FILTERS: readonly Filter[] = [...PROJECT_STATUSES, 'all'];
const FILTER_LABELS: Record<Filter, string> = { ...PROJECT_STATUS_LABELS, all: 'All' };
const EMPTY_FILTER_TEXT: Record<ProjectStatus, { title: string; body: string }> = {
  active: { title: 'No active projects', body: 'Projects you are working on appear here.' },
  on_hold: { title: 'No projects on hold', body: 'Put a project on hold from its menu to park it here.' },
  completed: { title: 'No completed projects', body: 'Mark a project as completed when its work is done.' },
  archived: { title: 'No archived projects', body: 'Archived projects and their tasks are hidden from task lists and boards.' },
};

function parseFilter(value: string | null): Filter {
  return FILTERS.includes(value as Filter) ? (value as Filter) : 'active';
}

export default function ProjectsPage() {
  useDocumentTitle('Projects');
  const { projects, milestonesByProject } = useLookups();
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('status'));
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectDTO | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<ProjectDTO | null>(null);
  const reorder = useReorder('projects');
  const save = useSaveProject();
  const { write, deleteProjects } = useSpace().permissions;

  const setFilter = (next: Filter) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next === 'active') sp.delete('status');
        else sp.set('status', next);
        return sp;
      },
      { replace: true },
    );

  const counts = Object.fromEntries(FILTERS.map((f) => [f, f === 'all' ? projects.length : projects.filter((p) => p.status === f).length])) as Record<
    Filter,
    number
  >;
  const groups: Array<{ key: string; title?: string; description?: string; items: ProjectDTO[] }> =
    filter === 'all'
      ? [
          { key: 'current', items: projects.filter((p) => p.status !== 'archived') },
          {
            key: 'archived',
            title: 'Archived',
            description: 'Hidden from task lists, boards and the sidebar.',
            items: projects.filter((p) => p.status === 'archived'),
          },
        ]
      : [{ key: filter, items: projects.filter((p) => p.status === filter) }];
  const fullIds = projects.map((p) => p.id);

  const openCreate = () => {
    setEditing(undefined);
    setFormOpen(true);
  };
  const setStatus = async (project: ProjectDTO, status: ProjectStatus) => {
    const previous = project.status;
    if (!(await save(project, { status }))) return;
    toast.success(`${project.name}: ${lifecycleMeta('project', status).label}`, {
      action: { label: 'Undo', onClick: () => void save(project, { status: previous }) },
    });
  };
  const applyOrder = (ids: number[] | null) => {
    if (ids) void reorder(ids);
  };

  const menuFor = (project: ProjectDTO, siblings: ProjectDTO[]): MenuItemInput[] => {
    const visibleIds = siblings.map((p) => p.id);
    const index = visibleIds.indexOf(project.id);
    if (!write) return [];
    return [
      {
        label: 'Edit…',
        icon: <Pencil />,
        onSelect: () => {
          setEditing(project);
          setFormOpen(true);
        },
      },
      {
        label: 'Status',
        hint: lifecycleMeta('project', project.status).label,
        icon: (() => {
          const Icon = lifecycleMeta('project', project.status).icon;
          return <Icon />;
        })(),
        items: PROJECT_STATUSES.map((status) => {
          const Icon = lifecycleMeta('project', status).icon;
          return {
            label: lifecycleMeta('project', status).label,
            icon: <Icon />,
            checked: status === project.status,
            onSelect: () => status !== project.status && void setStatus(project, status),
          };
        }),
      },
      { separator: true },
      {
        label: 'Move up',
        icon: <ArrowUp />,
        disabled: index <= 0,
        onSelect: () => applyOrder(moveWithinSubset(fullIds, visibleIds, project.id, -1)),
      },
      {
        label: 'Move down',
        icon: <ArrowDown />,
        disabled: index < 0 || index >= visibleIds.length - 1,
        onSelect: () => applyOrder(moveWithinSubset(fullIds, visibleIds, project.id, 1)),
      },
      { separator: true },
      deleteProjects && { label: 'Delete…', icon: <Trash2 />, danger: true, onSelect: () => setDeleteTarget(project) },
    ];
  };

  const empty = counts[filter] === 0;

  return (
    <Page
      width="wide"
      header={
        <PageHeader
          title="Projects"
          actions={
            write && (
              <Button variant="primary" icon={<Plus />} onClick={openCreate}>
                New project
              </Button>
            )
          }
        >
          {projects.length > 0 && (
            <Tabs<Filter>
              aria-label="Filter projects by status"
              value={filter}
              onChange={setFilter}
              items={FILTERS.map((f) => ({ value: f, label: FILTER_LABELS[f], count: counts[f] }))}
              className="-mb-px"
            />
          )}
        </PageHeader>
      }
    >
      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban />}
          title="No projects yet"
          body={write ? 'Projects hold milestones, epics and tasks. Create your first one to get started.' : 'Projects hold milestones, epics and tasks.'}
          action={
            write && (
              <Button variant="primary" icon={<Plus />} onClick={openCreate}>
                New project
              </Button>
            )
          }
        />
      ) : empty && filter !== 'all' ? (
        <EmptyState
          icon={<FolderKanban />}
          title={EMPTY_FILTER_TEXT[filter].title}
          body={EMPTY_FILTER_TEXT[filter].body}
          action={
            filter === 'active' ? (
              write && (
                <Button variant="primary" icon={<Plus />} onClick={openCreate}>
                  New project
                </Button>
              )
            ) : (
              <Button onClick={() => setFilter('all')}>Show all projects</Button>
            )
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          {groups
            .filter((g) => g.items.length > 0)
            .map((group) => (
              <Section key={group.key} title={group.title} description={group.description}>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <SortableList
                    items={group.items}
                    getId={projectId}
                    getLabel={projectName}
                    noun="projects"
                    layout="grid"
                    disabled={!write}
                    onMove={(activeId, overId) =>
                      applyOrder(reorderSubset(fullIds, group.items.map(projectId), activeId, overId))
                    }
                    renderItem={(project, sortable) => (
                      <ProjectCard
                        project={project}
                        milestones={milestonesByProject.get(project.id) ?? []}
                        sortable={sortable}
                        menu={menuFor(project, group.items)}
                      />
                    )}
                  />
                </div>
              </Section>
            ))}
        </div>
      )}

      {write && <ProjectFormDialog open={formOpen} onClose={() => setFormOpen(false)} project={editing} />}
      {deleteProjects && <DeleteProjectDialog project={deleteTarget} onClose={() => setDeleteTarget(null)} />}
    </Page>
  );
}

const projectId = (p: ProjectDTO) => p.id;
const projectName = (p: ProjectDTO) => p.name;

function ProjectCard({
  project,
  milestones,
  sortable,
  menu,
}: {
  project: ProjectDTO;
  milestones: readonly MilestoneDTO[];
  sortable: SortableRenderProps;
  menu: MenuItemInput[];
}) {
  const sid = useSpaceId();
  const navigate = useNavigate();
  const s = project.stats;
  const excerpt = markdownExcerpt(project.description, 180);
  const done = percent(s.tasksClosed, s.tasksTotal);
  return (
    <Card
      ref={sortable.ref}
      style={sortable.style}
      padding="none"
      className={clsx(
        'relative flex min-h-44 flex-col overflow-hidden transition-[border-color,box-shadow] hover:border-border-strong',
        sortable.isDragging && 'shadow-drag',
      )}
    >
      <div aria-hidden className="h-1 shrink-0" style={{ backgroundColor: project.color }} />
      <div className="flex flex-1 flex-col gap-3 p-4 pt-3">
        <div className="flex items-start gap-1.5">
          {sortable.handle && <div className="relative z-10 mt-1">{sortable.handle}</div>}
          <div className="min-w-0 flex-1">
            <div className="flex min-h-5 items-center gap-2 text-xs text-fg-muted">
              <span className="font-mono font-medium tracking-wide">{project.key}</span>
              {project.status !== 'active' && <LifecycleBadge kind="project" status={project.status} />}
            </div>
            <h3 className="mt-0.5 text-[15px] font-semibold leading-snug text-fg">
              {/* Stretched link: the whole card opens the project; controls above it stay clickable. */}
              <Link
                to={projectUrl(sid, project.id)}
                className="break-words outline-none after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
              >
                {project.name}
              </Link>
            </h3>
          </div>
          {menu.some(Boolean) && (
            <Menu
              label={project.name}
              items={[{ label: 'Open', icon: <ExternalLink />, onSelect: () => navigate(projectUrl(sid, project.id)) }, { separator: true }, ...menu]}
              trigger={<IconButton aria-label={`Actions for ${project.name}`} icon={<MoreHorizontal />} className="relative z-10 -mr-2 -mt-1" />}
            />
          )}
        </div>
        {excerpt && <p className="line-clamp-2 text-[13px] leading-5 text-fg-muted">{excerpt}</p>}
        <div className="mt-auto flex flex-col gap-2">
          <ProgressBar value={s.tasksClosed} total={s.tasksTotal} color={project.color} aria-label={`${project.name} progress`} />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span>
              <span className="font-medium tabular-nums text-fg">{s.tasksOpen}</span> open
            </span>
            {s.tasksOverdue > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-danger">
                <CircleAlert aria-hidden className="size-3.5" />
                {s.tasksOverdue} overdue
              </span>
            )}
            <span className="tabular-nums">{s.tasksTotal > 0 ? `${s.tasksClosed}/${s.tasksTotal} done · ${done}%` : 'No tasks yet'}</span>
          </div>
          <MilestoneSummary project={project} milestones={milestones} />
        </div>
      </div>
    </Card>
  );
}

function MilestoneSummary({ project, milestones }: { project: ProjectDTO; milestones: readonly MilestoneDTO[] }) {
  const today = useSharedToday();
  const { milestonesTotal, milestonesCompleted } = project.stats;
  const next = nextMilestone(milestones);
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-t border-border pt-2 text-xs text-fg-muted">
      <MilestoneIcon aria-hidden className="size-3.5 shrink-0 text-fg-subtle" />
      {milestonesTotal === 0 ? (
        <span>No milestones</span>
      ) : next ? (
        <>
          <span className="min-w-0 truncate">
            <span className="sr-only">Next milestone: </span>
            <span className="font-medium text-fg">{next.name}</span>
          </span>
          {next.dueDate && <DueDateLabel date={next.dueDate} today={today} plain />}
          <span className="ml-auto shrink-0 tabular-nums">
            {milestonesCompleted}/{pluralize(milestonesTotal, 'milestone')} done
          </span>
        </>
      ) : (
        <span>All {pluralize(milestonesTotal, 'milestone')} closed</span>
      )}
    </div>
  );
}
