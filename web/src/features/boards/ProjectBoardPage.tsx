// /projects/:projectId/board — the project's saved boards as tabs (position order; `?board=<id>`
// selects one; the last one per project is remembered on this device), "+ New board", quick
// filters, Configure and the board. Without saved boards it renders
// defaultBoardConfig({ filter: { projectIds: [id] } }) and creates a project board named
// "Board" on the first configuration change, so nothing is lost — or when "+ New board" adds
// another board, so the "Board" tab stays next to the new one.
//
// Rendered inside ProjectLayout, which provides the project header + tabs in a FullBleedPage;
// this page fills the remaining height. On short viewports the project header, board tabs and
// filter row scroll away and only the board area (FULL_BLEED_MAIN) keeps the full height.

import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ExternalLink, MoreHorizontal, Plus, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { defaultBoardConfig, type BoardConfig } from '@shared/board';
import type { BoardDTO, BootstrapDTO, ProjectDTO } from '@shared/types';
import { useCreateBoard } from '../../api/boards';
import { useLookups } from '../../api/bootstrap';
import { qk } from '../../api/keys';
import { FULL_BLEED_MAIN } from '../../components/layout/Page';
import { usePersistentState } from '../../components/layout/usePersistentState';
import { Button, IconButton, Menu, Tabs, type MenuItem } from '../../components/ui';
import { boardMenuItems, useBoardActions } from './boardActions';
import { NewBoardDialog } from './NewBoardDialog';
import { useBoardChrome, useBoardWorkspace, WorkspaceBody, WorkspaceFilterBar, type BoardChrome } from './workspace';

const BOARD_PARAM = 'board';

function parseId(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const isBoardId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function Workspace({
  project,
  board,
  fallback,
  chrome,
  create,
  onCreated,
  onSelect,
  boards,
}: {
  project: ProjectDTO;
  board: BoardDTO | null;
  fallback: BoardConfig;
  chrome: BoardChrome;
  /** Saves the virtual default board (named "Board") with this config. */
  create: (config: BoardConfig) => Promise<BoardDTO>;
  onCreated: (board: BoardDTO) => void;
  onSelect: (id: number | null) => void;
  boards: BoardDTO[];
}) {
  const navigate = useNavigate();
  const actions = useBoardActions();
  const ws = useBoardWorkspace({ board, fallback, projectId: project.id, create, onCreated });

  const menu: MenuItem[] = board
    ? boardMenuItems(board, actions, {
        extra: [{ label: 'Open as a page', icon: <ExternalLink />, onSelect: () => navigate(`/boards/${board.id}`) }],
        remove: {
          onConfirmed: () => {
            const next = boards.find((b) => b.id !== board.id);
            onSelect(next ? next.id : null);
          },
        },
      })
    : [];

  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border px-4 md:px-6">
        <WorkspaceFilterBar ws={ws} chrome={chrome} className="min-w-0 flex-1" />
        <Button size="sm" icon={<SlidersHorizontal />} hideLabelOnMobile onClick={() => chrome.openPanel()} aria-expanded={chrome.panel.open}>
          Configure
        </Button>
        {menu.length > 0 && (
          <Menu label={`${board?.name ?? 'Board'} actions`} items={menu} trigger={<IconButton size="sm" aria-label="Board actions" icon={<MoreHorizontal />} />} />
        )}
      </div>
      <div className={clsx('relative min-h-0 flex-1', FULL_BLEED_MAIN)}>
        <WorkspaceBody ws={ws} chrome={chrome} />
      </div>
    </>
  );
}

function ProjectBoards({ project }: { project: ProjectDTO }) {
  const lookups = useLookups();
  const boards = useMemo(() => lookups.boards.filter((b) => b.projectId === project.id), [lookups.boards, project.id]);
  const [params, setParams] = useSearchParams();
  const [remembered, setRemembered] = usePersistentState<number>(`lyren.projectBoard.${project.id}`, 0, isBoardId);
  const requested = parseId(params.get(BOARD_PARAM));
  const selected = boards.find((b) => b.id === requested) ?? boards.find((b) => b.id === remembered) ?? boards[0] ?? null;
  const chrome = useBoardChrome();
  const [newOpen, setNewOpen] = useState(false);
  const fallback = useMemo(() => defaultBoardConfig({ filter: { projectIds: [project.id] } }), [project.id]);

  // Saving the virtual default board: on its first configuration change (Workspace), or before
  // "+ New board" adds another one. The in-flight creation is shared so both never create it twice.
  const qc = useQueryClient();
  const { mutateAsync: createBoard } = useCreateBoard();
  const creatingDefault = useRef<Promise<BoardDTO> | null>(null);
  const createDefault = useCallback(
    (config: BoardConfig) => {
      const run = createBoard({ name: 'Board', projectId: project.id, config });
      creatingDefault.current = run;
      const settle = () => {
        if (creatingDefault.current === run) creatingDefault.current = null;
      };
      run.then(settle, settle);
      return run;
    },
    [createBoard, project.id],
  );
  const keepDefaultBoard = useCallback(async () => {
    await creatingDefault.current?.catch(() => undefined);
    // Read the cache, not the render's `boards`: a creation may have finished since.
    const saved = qc.getQueryData<BootstrapDTO>(qk.bootstrap)?.boards.some((b) => b.projectId === project.id);
    if (!saved) await createDefault(fallback);
  }, [qc, project.id, createDefault, fallback]);

  useEffect(() => {
    if (selected && selected.id !== remembered) setRemembered(selected.id);
  }, [selected, remembered, setRemembered]);

  const select = useCallback(
    (id: number | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === null) next.delete(BOARD_PARAM);
          else next.set(BOARD_PARAM, String(id));
          return next;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );

  const tabs = boards.length > 0 ? boards.map((b) => ({ value: String(b.id), label: b.name })) : [{ value: 'new', label: 'Board' }];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-4 md:px-6">
        <Tabs<string>
          aria-label={`Boards of ${project.name}`}
          value={selected ? String(selected.id) : 'new'}
          onChange={(v) => v !== 'new' && select(Number(v))}
          items={tabs}
          className="min-w-0 flex-1"
        />
        <Button size="sm" variant="ghost" icon={<Plus />} hideLabelOnMobile onClick={() => setNewOpen(true)} className="shrink-0">
          New board
        </Button>
      </div>
      <Workspace
        key={selected?.id ?? 'new'}
        project={project}
        board={selected}
        boards={boards}
        fallback={fallback}
        chrome={chrome}
        create={createDefault}
        onCreated={(b) => select(b.id)}
        onSelect={select}
      />
      <NewBoardDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        projectId={project.id}
        onCreated={(b) => select(b.id)}
        beforeCreate={boards.length === 0 ? keepDefaultBoard : undefined}
      />
    </div>
  );
}

export default function ProjectBoardPage() {
  const { projectId } = useParams();
  const id = parseId(projectId);
  const { projectById } = useLookups();
  const project = id === null ? undefined : projectById.get(id);
  // ProjectLayout renders the "not found" state.
  if (!project) return null;
  return <ProjectBoards key={project.id} project={project} />;
}
