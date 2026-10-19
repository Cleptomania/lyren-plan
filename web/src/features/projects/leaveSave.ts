// Leaving a page while a description editor still holds a draft saves it (EditableMarkdown).
// That save must not run once the entity itself is gone, i.e. it was just deleted or the user
// signed out and the cached data was dropped. Such a request could only fail, and it would
// show a "… not found" error toast right after "Deleted …".
//
// Project, milestone and epic pages render from the bootstrap lookups, so an entity whose page
// was on screen is in bootstrap. When it is missing at unmount, there is nothing left to save to.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { BootstrapDTO } from '@shared/types';
import { qk } from '../../api/keys';
import { useSpaceId } from '../../app/space';

export type HierarchyKind = 'projects' | 'milestones' | 'epics';

/** True while `id` is listed in the loaded bootstrap; false once it is gone or the cache was dropped. */
export function stillInBootstrap(boot: BootstrapDTO | undefined, kind: HierarchyKind, id: number): boolean {
  const list = boot?.[kind] as ReadonlyArray<{ id: number }> | undefined;
  return list ? list.some((e) => e.id === id) : false;
}

/** `(kind, id) => boolean` reading the bootstrap cache at call time (for EditableMarkdown's canSaveOnLeave). */
export function useStillInBootstrap(): (kind: HierarchyKind, id: number) => boolean {
  const sid = useSpaceId();
  const qc = useQueryClient();
  return useCallback((kind, id) => stillInBootstrap(qc.getQueryData<BootstrapDTO>(qk.bootstrap(sid)), kind, id), [qc, sid]);
}
