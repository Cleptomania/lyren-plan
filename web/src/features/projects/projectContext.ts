// The project resolved by ProjectLayout, shared with its child routes via <Outlet context>.

import { useOutletContext } from 'react-router';
import type { ProjectDTO } from '@shared/types';

export interface ProjectOutletContext {
  project: ProjectDTO;
}

/** The current project (only inside ProjectLayout's child routes, which render after it resolved). */
export function useProjectContext(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}

/** A positive integer route param, else null. */
export function parseRouteId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
