// Project filter shared by the Activity and Work log pages: a native select (OS picker on
// phones) whose value lives in the URL (?project=<id>) so filtered views can be shared.

import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { useLookups } from '../../api/bootstrap';
import { Select } from '../../components/ui';

export const PROJECT_PARAM = 'project';

/** Read/write a positive integer search param without touching the others (e.g. ?task=). */
export function useProjectParam(): [number | undefined, (projectId: number | undefined) => void] {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get(PROJECT_PARAM));
  const value = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  const set = useCallback(
    (projectId: number | undefined) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (projectId === undefined) next.delete(PROJECT_PARAM);
          else next.set(PROJECT_PARAM, String(projectId));
          return next;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );
  return [value, set];
}

export interface ProjectFilterProps {
  value: number | undefined;
  onChange: (projectId: number | undefined) => void;
  className?: string;
}

export function ProjectFilter({ value, onChange, className }: ProjectFilterProps) {
  const { projects, projectById } = useLookups();
  const active = projects.filter((p) => p.status !== 'archived');
  const archived = projects.filter((p) => p.status === 'archived');
  // A filter on a project that no longer exists still shows (and can be cleared).
  const stale = value !== undefined && !projectById.has(value);
  return (
    <Select
      aria-label="Filter by project"
      size="sm"
      value={value === undefined ? '' : String(value)}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      className={className}
    >
      <option value="">All projects</option>
      {stale && <option value={String(value)}>Deleted project</option>}
      {active.map((p) => (
        <option key={p.id} value={String(p.id)}>
          {p.name}
        </option>
      ))}
      {archived.length > 0 && (
        <optgroup label="Archived">
          {archived.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}
