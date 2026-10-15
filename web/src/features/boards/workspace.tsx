// What a board page needs around a board: autosaving config state, URL quick filters, the
// per-device "show as list on phones" toggle, the data model, select mode and the config
// panel. BoardPage and ProjectBoardPage compose these with their own headers.

import { useCallback, useState } from 'react';
import type { BoardConfig } from '@shared/board';
import type { BoardDTO } from '@shared/types';
import { isBoolean, usePersistentState } from '../../components/layout/usePersistentState';
import { useIsMobile } from '../../lib/hooks';
import type { ConfigSection } from './boardUi';
import { BoardConfigPanel } from './BoardConfigPanel';
import { BoardView } from './BoardView';
import { EMPTY_QUICK_FILTERS, hasQuickFilters } from './filters';
import { QuickFilterBar } from './QuickFilterBar';
import { useBoardConfig } from './useBoardConfig';
import { useBoardModel } from './useBoardModel';
import { useQuickFilters } from './useQuickFilters';

/** Panel + select-mode state; lifted above the (keyed) workspace so it survives board switches. */
export function useBoardChrome() {
  const [panel, setPanel] = useState<{ open: boolean; section: ConfigSection }>({ open: false, section: 'layout' });
  const [selectMode, setSelectMode] = useState(false);
  const openPanel = useCallback((section?: ConfigSection) => setPanel((p) => ({ open: true, section: section ?? p.section })), []);
  const closePanel = useCallback(() => setPanel((p) => ({ ...p, open: false })), []);
  const setSection = useCallback((section: ConfigSection) => setPanel((p) => ({ ...p, section })), []);
  return { panel, openPanel, closePanel, setSection, selectMode, setSelectMode };
}

export type BoardChrome = ReturnType<typeof useBoardChrome>;

export interface BoardWorkspaceOptions {
  board: BoardDTO | null;
  /** Config shown when there is no saved board yet. */
  fallback: BoardConfig;
  /** Project scope of a project board. */
  projectId: number | null;
  /** Create the board on the first change (project Board tab without boards). */
  create?: (config: BoardConfig) => Promise<BoardDTO>;
  onCreated?: (board: BoardDTO) => void;
}

export function useBoardWorkspace({ board, fallback, projectId, create, onCreated }: BoardWorkspaceOptions) {
  const mobile = useIsMobile();
  const [listOnPhone, setListOnPhone] = usePersistentState('lyren.board.listOnPhone', false, isBoolean);
  const { config, setConfig } = useBoardConfig(board, fallback, create, onCreated);
  const [quick, setQuick] = useQuickFilters();
  const layout: BoardConfig['layout'] = mobile && listOnPhone ? 'list' : config.layout;
  const model = useBoardModel(config, { projectId, quick, layout });
  return { board, projectId, mobile, listOnPhone, setListOnPhone, config, setConfig, quick, setQuick, layout, model };
}

export type BoardWorkspace = ReturnType<typeof useBoardWorkspace>;

export function WorkspaceFilterBar({ ws, chrome, className }: { ws: BoardWorkspace; chrome: BoardChrome; className?: string }) {
  return (
    <QuickFilterBar
      value={ws.quick}
      onChange={ws.setQuick}
      refreshing={ws.model.refreshing}
      selectMode={chrome.selectMode}
      onSelectModeChange={chrome.setSelectMode}
      mobileList={ws.mobile ? { value: ws.listOnPhone, onChange: ws.setListOnPhone } : undefined}
      className={className}
    />
  );
}

export function WorkspaceBody({ ws, chrome }: { ws: BoardWorkspace; chrome: BoardChrome }) {
  return (
    <>
      <BoardView
        config={ws.config}
        setConfig={ws.setConfig}
        model={ws.model}
        projectId={ws.projectId}
        mobile={ws.mobile}
        quickFiltersActive={hasQuickFilters(ws.quick)}
        onClearQuickFilters={() => ws.setQuick(EMPTY_QUICK_FILTERS)}
        onConfigure={chrome.openPanel}
        selectMode={chrome.selectMode}
        onSelectModeChange={chrome.setSelectMode}
      />
      <BoardConfigPanel
        open={chrome.panel.open}
        onClose={chrome.closePanel}
        section={chrome.panel.section}
        onSectionChange={chrome.setSection}
        config={ws.config}
        setConfig={ws.setConfig}
        model={ws.model}
        scopeProjectId={ws.projectId}
        board={ws.board}
        forcedList={ws.mobile && ws.listOnPhone && ws.config.layout === 'kanban'}
      />
    </>
  );
}
