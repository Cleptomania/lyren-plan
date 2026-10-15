// /boards/:boardId — one saved board, full-bleed (100dvh-based) with its own scrollers.
// Header: inline-editable name, description / project link, Configure, and the board menu
// (duplicate, default board, open at startup, delete). Quick filters sit under the title.

import { SlidersHorizontal, SquareKanban } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { LIMITS } from '@shared/constants';
import type { BoardDTO } from '@shared/types';
import { useUpdateBoard } from '../../api/boards';
import { useLookups } from '../../api/bootstrap';
import { FULL_BLEED_MAIN, FullBleedPage, Page } from '../../components/layout/Page';
import { PageHeader } from '../../components/layout/PageHeader';
import { Button, ButtonLink, EmptyState, InlineEdit, toast } from '../../components/ui';
import { useDocumentTitle } from '../../lib/hooks';
import { boardHref, boardMenuItems, useBoardActions } from './boardActions';
import { useBoardChrome, useBoardWorkspace, WorkspaceBody, WorkspaceFilterBar } from './workspace';

function parseId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function BoardNotFound() {
  return (
    <Page header={<PageHeader title="Board not found" backTo="/boards" breadcrumbs={[{ label: 'Boards', to: '/boards' }]} />}>
      <EmptyState
        icon={<SquareKanban />}
        title="This board doesn’t exist"
        body="It may have been deleted, or the link is wrong."
        action={<ButtonLink to="/boards">All boards</ButtonLink>}
      />
    </Page>
  );
}

function BoardScreen({ board }: { board: BoardDTO }) {
  const navigate = useNavigate();
  const lookups = useLookups();
  const actions = useBoardActions();
  const { mutate: updateBoard } = useUpdateBoard();
  const chrome = useBoardChrome();
  const ws = useBoardWorkspace({ board, fallback: board.config, projectId: board.projectId });
  const project = board.projectId === null ? undefined : lookups.projectById.get(board.projectId);

  const subtitle = project ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: project.color }} />
      <span className="truncate">
        Board of{' '}
        <Link to={boardHref(board)} className="font-medium text-fg-muted underline-offset-2 hover:text-fg hover:underline">
          {project.name}
        </Link>
      </span>
    </span>
  ) : (
    board.description || undefined
  );

  return (
    <FullBleedPage
      className={FULL_BLEED_MAIN}
      header={
        <PageHeader
          title={
            <InlineEdit
              value={board.name}
              aria-label="Board name"
              maxLength={LIMITS.boardNameMax}
              onSave={(name) => updateBoard({ id: board.id, name: name.trim() }, { onError: (err) => toast.error(err) })}
              className="-ml-1.5 max-w-full"
            />
          }
          subtitle={subtitle}
          icon={<SquareKanban />}
          backTo="/boards"
          breadcrumbs={[
            { label: 'Boards', to: '/boards' },
            ...(project ? [{ label: project.name, to: `/projects/${project.id}/board` }] : []),
          ]}
          actions={
            <Button icon={<SlidersHorizontal />} hideLabelOnMobile onClick={() => chrome.openPanel()} aria-expanded={chrome.panel.open}>
              Configure
            </Button>
          }
          menu={boardMenuItems(board, actions, {
            remove: { onConfirmed: () => navigate(project ? `/projects/${project.id}/board` : '/boards', { replace: true }) },
          })}
        >
          <WorkspaceFilterBar ws={ws} chrome={chrome} />
        </PageHeader>
      }
    >
      <WorkspaceBody ws={ws} chrome={chrome} />
    </FullBleedPage>
  );
}

export default function BoardPage() {
  const { boardId } = useParams();
  const id = parseId(boardId);
  const { boardById } = useLookups();
  const board = id === null ? undefined : boardById.get(id);
  useDocumentTitle(board ? board.name : 'Board not found');
  if (!board) return <BoardNotFound />;
  return <BoardScreen key={board.id} board={board} />;
}
