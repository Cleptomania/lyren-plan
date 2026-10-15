// One place that owns the milestone / epic create, edit and delete dialogs of a page.
// Pages call the returned openers and render `dialogs` once.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { EpicDTO, MilestoneDTO } from '@shared/types';
import { DeleteEpicDialog, DeleteMilestoneDialog, type DeleteCallbacks } from './DeleteDialogs';
import { EpicFormDialog } from './EpicFormDialog';
import { MilestoneFormDialog } from './MilestoneFormDialog';

type FormTarget =
  | { kind: 'milestone'; milestone?: MilestoneDTO }
  | { kind: 'epic'; epic?: EpicDTO; milestoneId?: number | null };

export interface HierarchyDialogs {
  newMilestone: () => void;
  editMilestone: (milestone: MilestoneDTO) => void;
  deleteMilestone: (milestone: MilestoneDTO, callbacks?: DeleteCallbacks<MilestoneDTO>) => void;
  newEpic: (milestoneId?: number | null) => void;
  editEpic: (epic: EpicDTO) => void;
  deleteEpic: (epic: EpicDTO, callbacks?: DeleteCallbacks<EpicDTO>) => void;
  /** Render once in the page. */
  dialogs: ReactNode;
}

export function useHierarchyDialogs(projectId: number): HierarchyDialogs {
  // The last form target is kept while the dialog animates closed.
  const [form, setForm] = useState<FormTarget>({ kind: 'milestone' });
  const [formOpen, setFormOpen] = useState(false);
  const [milestoneToDelete, setMilestoneToDelete] = useState<{ milestone: MilestoneDTO; callbacks?: DeleteCallbacks<MilestoneDTO> } | null>(null);
  const [epicToDelete, setEpicToDelete] = useState<{ epic: EpicDTO; callbacks?: DeleteCallbacks<EpicDTO> } | null>(null);

  const open = useCallback((target: FormTarget) => {
    setForm(target);
    setFormOpen(true);
  }, []);
  const close = useCallback(() => setFormOpen(false), []);

  const api = useMemo(
    () => ({
      newMilestone: () => open({ kind: 'milestone' }),
      editMilestone: (milestone: MilestoneDTO) => open({ kind: 'milestone', milestone }),
      deleteMilestone: (milestone: MilestoneDTO, callbacks?: DeleteCallbacks<MilestoneDTO>) => setMilestoneToDelete({ milestone, callbacks }),
      newEpic: (milestoneId: number | null = null) => open({ kind: 'epic', milestoneId }),
      editEpic: (epic: EpicDTO) => open({ kind: 'epic', epic }),
      deleteEpic: (epic: EpicDTO, callbacks?: DeleteCallbacks<EpicDTO>) => setEpicToDelete({ epic, callbacks }),
    }),
    [open],
  );

  const dialogs = (
    <>
      <MilestoneFormDialog
        open={formOpen && form.kind === 'milestone'}
        onClose={close}
        projectId={projectId}
        milestone={form.kind === 'milestone' ? form.milestone : undefined}
      />
      <EpicFormDialog
        open={formOpen && form.kind === 'epic'}
        onClose={close}
        projectId={projectId}
        epic={form.kind === 'epic' ? form.epic : undefined}
        defaultMilestoneId={form.kind === 'epic' ? (form.milestoneId ?? null) : null}
      />
      <DeleteMilestoneDialog
        milestone={milestoneToDelete?.milestone ?? null}
        onClose={() => setMilestoneToDelete(null)}
        {...milestoneToDelete?.callbacks}
      />
      <DeleteEpicDialog epic={epicToDelete?.epic ?? null} onClose={() => setEpicToDelete(null)} {...epicToDelete?.callbacks} />
    </>
  );

  return { ...api, dialogs };
}
