// Project overview: description (inline-editable), summary stats, then the hierarchy —
// milestones in order with their epics (each expandable to its tasks), epics without a
// milestone, and tasks without an epic. Sections remember their open state per device.

import { clsx } from 'clsx';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, Milestone as MilestoneIcon, MoreHorizontal, Plus } from 'lucide-react';
import { useCallback, useId, useMemo, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { MilestoneDTO, ProjectDTO } from '@shared/types';
import { useLookups } from '../../api/bootstrap';
import { isBoolean, usePersistentState } from '../../components/layout/usePersistentState';
import { Button, Card, Disclosure, EmptyState, IconButton, Menu, ProgressBar } from '../../components/ui';
import { percent, pluralize } from '../../lib/format';
import { milestoneUrl } from '../../lib/taskLinks';
import { TaskList } from '../tasks/TaskList';
import { EditableMarkdown } from './EditableMarkdown';
import { DateRange, StatTile } from './EntityMeta';
import { EpicList } from './EpicList';
import { buildHierarchy, isMilestoneClosed, moveWithinSubset, reorderSubset, type MilestoneSection } from './hierarchy';
import { milestoneMenuItems } from './hierarchyMenus';
import { LifecyclePicker } from './LifecycleStatus';
import { useProjectContext } from './projectContext';
import { SortableList, type SortableRenderProps } from './SortableList';
import { useHierarchyDialogs, type HierarchyDialogs } from './useHierarchyDialogs';
import { useStillInBootstrap } from './leaveSave';
import { useReorder, useSaveMilestone, useSaveProject } from './useHierarchyMutations';

export default function ProjectOverview() {
  const { project } = useProjectContext();
  // Keyed so per-project persisted UI state is re-read when switching projects.
  return <Overview key={project.id} project={project} />;
}

type OpenState = Record<string, boolean>;
const isOpenState = (v: unknown): v is OpenState =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(isBoolean);

/** Remembered open/closed state of overview sections (milestones `m:<id>`, epics `e:<id>`, groups `s:<name>`). */
function useOverviewState(projectId: number) {
  const [state, setState] = usePersistentState<OpenState>(`lyren.overview.${projectId}`, {}, isOpenState);
  return useMemo(
    () => ({
      isOpen: (key: string, fallback: boolean) => state[key] ?? fallback,
      setOpen: (key: string, open: boolean) => setState((s) => ({ ...s, [key]: open })),
      setMany: (keys: string[], open: boolean) => setState((s) => ({ ...s, ...Object.fromEntries(keys.map((k) => [k, open])) })),
    }),
    [state, setState],
  );
}

function Overview({ project }: { project: ProjectDTO }) {
  const { milestonesByProject, epicsByProject } = useLookups();
  const milestones = milestonesByProject.get(project.id) ?? [];
  const epics = epicsByProject.get(project.id) ?? [];
  const { sections, loose } = buildHierarchy(milestones, epics);
  const allEpicIds = [...epics].sort((a, b) => a.position - b.position || a.id - b.id).map((e) => e.id);
  const dialogs = useHierarchyDialogs(project.id);
  const saveProject = useSaveProject();
  const stillInBootstrap = useStillInBootstrap();
  const ui = useOverviewState(project.id);

  const milestoneOpen = (m: MilestoneDTO) => ui.isOpen(`m:${m.id}`, !isMilestoneClosed(m.status));
  const allMilestonesOpen = sections.length > 0 && sections.every((s) => milestoneOpen(s.milestone));
  const epicExpanded = useCallback((id: number) => ui.isOpen(`e:${id}`, false), [ui]);
  const setEpicExpanded = useCallback((id: number, open: boolean) => ui.setOpen(`e:${id}`, open), [ui]);

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <Card padding="lg">
          <EditableMarkdown
            heading="About"
            label="Project description"
            value={project.description}
            onSave={async (description) => (await saveProject(project, { description })) !== undefined}
            canSaveOnLeave={() => stillInBootstrap('projects', project.id)}
          />
        </Card>
        <ProjectSummary project={project} />
      </div>

      <section aria-labelledby="milestones-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="milestones-heading" className="flex items-baseline gap-2 text-[15px] font-semibold text-fg">
            Milestones
            {milestones.length > 0 && <span className="text-xs font-medium tabular-nums text-fg-subtle">{milestones.length}</span>}
          </h2>
          <div className="flex items-center gap-1">
            {sections.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                hideLabelOnMobile
                icon={allMilestonesOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
                onClick={() => ui.setMany(sections.map((s) => `m:${s.milestone.id}`), !allMilestonesOpen)}
              >
                {allMilestonesOpen ? 'Collapse all' : 'Expand all'}
              </Button>
            )}
            <Button size="sm" icon={<Plus />} onClick={dialogs.newMilestone}>
              Add milestone
            </Button>
          </div>
        </div>
        {sections.length === 0 ? (
          <Card padding="none" className="border-dashed shadow-none">
            <EmptyState
              size="sm"
              icon={<MilestoneIcon />}
              title="No milestones yet"
              body="Milestones group epics towards a target date and roll up their progress."
              action={
                <Button size="sm" icon={<Plus />} onClick={dialogs.newMilestone}>
                  Add milestone
                </Button>
              }
            />
          </Card>
        ) : (
          <MilestoneList
            project={project}
            sections={sections}
            milestones={milestones}
            allEpicIds={allEpicIds}
            dialogs={dialogs}
            isOpen={milestoneOpen}
            setOpen={(m, open) => ui.setOpen(`m:${m.id}`, open)}
            epicExpanded={epicExpanded}
            setEpicExpanded={setEpicExpanded}
          />
        )}
      </section>

      <Disclosure
        title="Epics without milestone"
        count={loose.length}
        open={ui.isOpen('s:loose', true)}
        onOpenChange={(open) => ui.setOpen('s:loose', open)}
        actions={
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => dialogs.newEpic(null)}>
            Add epic
          </Button>
        }
        contentClassName="mt-2"
      >
        <Card padding="none">
          <EpicList
            projectId={project.id}
            epics={loose}
            allEpicIds={allEpicIds}
            milestones={milestones}
            dialogs={dialogs}
            expandable
            isExpanded={epicExpanded}
            onExpandedChange={setEpicExpanded}
            emptyText={epics.length === 0 ? 'No epics yet. Epics group related tasks.' : 'Every epic belongs to a milestone.'}
          />
        </Card>
      </Disclosure>

      <Disclosure
        title="Tasks without epic"
        open={ui.isOpen('s:tasks', true)}
        onOpenChange={(open) => ui.setOpen('s:tasks', open)}
        contentClassName="mt-2"
      >
        <TaskList
          filter={{ projectIds: [project.id], epicIds: [null] }}
          toolbar={false}
          createDefaults={{ projectId: project.id }}
          hide={['project', 'epic', 'milestone']}
          emptyMessage={project.stats.tasksTotal === 0 ? 'No tasks yet.' : 'Every task belongs to an epic.'}
        />
      </Disclosure>

      {dialogs.dialogs}
    </div>
  );
}

function ProjectSummary({ project }: { project: ProjectDTO }) {
  const s = project.stats;
  const pct = percent(s.tasksClosed, s.tasksTotal);
  return (
    <Card padding="lg" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-fg">Progress</h2>
          <span className="text-2xl font-semibold tabular-nums text-fg">{pct}%</span>
        </div>
        <ProgressBar value={s.tasksClosed} total={s.tasksTotal} color={project.color} size="md" aria-label="Project progress" />
        <p className="text-xs text-fg-muted">
          {s.tasksTotal > 0 ? `${s.tasksClosed} of ${pluralize(s.tasksTotal, 'task')} closed` : 'No tasks yet'}
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-2">
        <StatTile label="Open" value={s.tasksOpen} />
        <StatTile label="Closed" value={s.tasksClosed} hint="Done or cancelled" />
        <StatTile label="Overdue" value={s.tasksOverdue} tone={s.tasksOverdue > 0 ? 'danger' : undefined} />
      </dl>
      <dl className="grid grid-cols-2 gap-2">
        <StatTile label="Milestones done" value={`${s.milestonesCompleted}/${s.milestonesTotal}`} />
        <StatTile label="Epics done" value={`${s.epicsDone}/${s.epicsTotal}`} />
      </dl>
    </Card>
  );
}

const sectionId = (s: MilestoneSection) => s.milestone.id;
const sectionName = (s: MilestoneSection) => s.milestone.name;

function MilestoneList({
  project,
  sections,
  milestones,
  allEpicIds,
  dialogs,
  isOpen,
  setOpen,
  epicExpanded,
  setEpicExpanded,
}: {
  project: ProjectDTO;
  sections: MilestoneSection[];
  milestones: readonly MilestoneDTO[];
  allEpicIds: number[];
  dialogs: HierarchyDialogs;
  isOpen: (m: MilestoneDTO) => boolean;
  setOpen: (m: MilestoneDTO, open: boolean) => void;
  epicExpanded: (epicId: number) => boolean;
  setEpicExpanded: (epicId: number, open: boolean) => void;
}) {
  const navigate = useNavigate();
  const reorder = useReorder('milestones');
  const save = useSaveMilestone();
  const ids = sections.map(sectionId);
  const apply = (next: number[] | null) => {
    if (next) void reorder(next);
  };
  return (
    <div className="flex flex-col gap-3">
      <SortableList
        items={sections}
        getId={sectionId}
        getLabel={sectionName}
        noun="milestones"
        onMove={(activeId, overId) => apply(reorderSubset(ids, ids, activeId, overId))}
        renderItem={(section, sortable) => {
          const m = section.milestone;
          const index = ids.indexOf(m.id);
          const setStatus = (status: MilestoneDTO['status']) => {
            // Closed milestones default to collapsed: pin the current state so the card
            // doesn't collapse under the pointer right after completing it.
            setOpen(m, isOpen(m));
            void save(m, { status });
          };
          return (
            <MilestoneCard
              project={project}
              section={section}
              sortable={sortable}
              open={isOpen(m)}
              onOpenChange={(open) => setOpen(m, open)}
              onStatus={setStatus}
              menu={milestoneMenuItems(m, {
                open: () => navigate(milestoneUrl(project.id, m.id)),
                edit: () => dialogs.editMilestone(m),
                setStatus,
                addEpic: () => dialogs.newEpic(m.id),
                move: {
                  up: index > 0 ? () => apply(moveWithinSubset(ids, ids, m.id, -1)) : null,
                  down: index < ids.length - 1 ? () => apply(moveWithinSubset(ids, ids, m.id, 1)) : null,
                },
                remove: () => dialogs.deleteMilestone(m),
              })}
            >
              <EpicList
                projectId={project.id}
                epics={section.epics}
                allEpicIds={allEpicIds}
                milestones={milestones}
                dialogs={dialogs}
                expandable
                isExpanded={epicExpanded}
                onExpandedChange={setEpicExpanded}
                emptyText="No epics in this milestone yet."
              />
              <div className="border-t border-border px-2 py-1.5 md:px-3">
                <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => dialogs.newEpic(m.id)}>
                  Add epic
                </Button>
              </div>
            </MilestoneCard>
          );
        }}
      />
    </div>
  );
}

function MilestoneCard({
  project,
  section,
  sortable,
  open,
  onOpenChange,
  onStatus,
  menu,
  children,
}: {
  project: ProjectDTO;
  section: MilestoneSection;
  sortable: SortableRenderProps;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStatus: (status: MilestoneDTO['status']) => void;
  menu: ReturnType<typeof milestoneMenuItems>;
  children: ReactNode;
}) {
  const panelId = useId();
  const m = section.milestone;
  const closed = isMilestoneClosed(m.status);
  const s = m.stats;
  return (
    <Card ref={sortable.ref} style={sortable.style} padding="none" className={clsx(sortable.isDragging && 'shadow-drag')}>
      <div className="flex items-start gap-1 p-2 md:p-3">
        {sortable.handle && <div className="mt-1.5">{sortable.handle}</div>}
        <IconButton
          aria-label={`${open ? 'Collapse' : 'Expand'} ${m.name}`}
          aria-expanded={open}
          aria-controls={panelId}
          tooltip={false}
          onClick={() => onOpenChange(!open)}
          icon={<ChevronRight className={clsx('transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')} />}
        />
        <div className="min-w-0 flex-1 py-1.5">
          {/* Touch: when the status picker wraps below the name, keep their touch targets apart. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pointer-coarse:gap-y-4">
            <h3 className="min-w-0 text-[15px] font-semibold leading-6">
              {/* Touch: a 40px tall target (padding cancelled by margins). */}
              <Link
                to={milestoneUrl(project.id, m.id)}
                className={clsx(
                  'break-words hover:underline pointer-coarse:-my-2 pointer-coarse:block pointer-coarse:py-2',
                  closed ? 'text-fg-muted' : 'text-fg',
                )}
              >
                {m.name}
              </Link>
            </h3>
            <LifecyclePicker kind="milestone" value={m.status} onChange={onStatus} subject={m.name} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted pointer-coarse:mt-2">
            <DateRange start={m.startDate} due={m.dueDate} closed={closed} />
            <span className="tabular-nums">
              {s.epicsTotal > 0 ? `${s.epicsDone}/${s.epicsTotal} epics done` : 'No epics'}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <ProgressBar value={s.tasksClosed} total={s.tasksTotal} aria-label={`${m.name} progress`} className="flex-1" />
            <span className="shrink-0 text-xs tabular-nums text-fg-muted">
              {s.tasksTotal > 0 ? `${s.tasksClosed}/${s.tasksTotal} · ${percent(s.tasksClosed, s.tasksTotal)}%` : 'No tasks'}
            </span>
          </div>
        </div>
        <Menu label={m.name} items={menu} trigger={<IconButton aria-label={`Actions for ${m.name}`} icon={<MoreHorizontal />} />} />
      </div>
      <div id={panelId} hidden={!open} className="border-t border-border">
        {open && children}
      </div>
    </Card>
  );
}

