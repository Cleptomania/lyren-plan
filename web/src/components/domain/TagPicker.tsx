// Multi-select tag picker with search and inline "Create tag “…”" (returns tag ids).

import { useQueryClient } from '@tanstack/react-query';
import { Tag } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { LIMITS } from '@shared/constants';
import type { BootstrapDTO, TagDTO } from '@shared/types';
import { useCreateTag } from '../../api/admin';
import { useLookups } from '../../api/bootstrap';
import { qk } from '../../api/keys';
import { Picker, PickerList, toast } from '../ui';
import { useTagOptions } from './options';
import type { DomainPickerProps } from './pickerTypes';
import { PropertyButton } from './PropertyButton';
import { paletteColor } from './taskDisplay';
import { TagList } from './Tags';

/**
 * Create a tag (color picked from the palette by name) and put it into the bootstrap
 * cache right away, so it shows up in chips and options before the refetch lands.
 * Errors are toasted and re-thrown (the picker keeps the typed text).
 */
export function useCreateTagFromPicker(): (name: string) => Promise<TagDTO> {
  const qc = useQueryClient();
  const { mutateAsync } = useCreateTag();
  return useCallback(
    async (raw: string) => {
      const name = raw.trim();
      if (name.length > LIMITS.tagNameMax) {
        const message = `Tag names can be at most ${LIMITS.tagNameMax} characters`;
        toast.error(message);
        throw new Error(message);
      }
      try {
        const tag = await mutateAsync({ name, color: paletteColor(name) });
        qc.setQueryData<BootstrapDTO>(qk.bootstrap, (boot) =>
          boot && !boot.tags.some((t) => t.id === tag.id) ? { ...boot, tags: [...boot.tags, tag] } : boot,
        );
        return tag;
      } catch (err) {
        toast.error(err);
        throw err;
      }
    },
    [mutateAsync, qc],
  );
}

interface TagValueProps {
  /** Selected tag ids. */
  value: readonly number[];
  onChange: (tagIds: number[]) => void;
  /** Offer "Create tag “…”" for unknown names (default true). */
  allowCreate?: boolean;
}

function useTagCreate(value: readonly number[], onChange: (ids: number[]) => void, allowCreate: boolean) {
  const create = useCreateTagFromPicker();
  return useMemo(
    () =>
      allowCreate
        ? async (name: string) => {
            const tag = await create(name);
            onChange([...value.filter((id) => id !== tag.id), tag.id]);
          }
        : undefined,
    [allowCreate, create, onChange, value],
  );
}

const createLabel = (query: string) => `Create tag “${query}”`;

export interface TagPickerProps extends TagValueProps, DomainPickerProps {
  /** Default-trigger text when no tag is selected. */
  placeholder?: string;
  /** Max chips in the default trigger before "+k" (default 3). */
  maxChips?: number;
}

/** Popup tag picker. The default trigger shows the selected tags as chips. */
export function TagPicker({
  value,
  onChange,
  allowCreate = true,
  placeholder = 'Add tags',
  maxChips = 3,
  label = 'Tags',
  trigger,
  triggerProps,
  panelClassName,
  ...popup
}: TagPickerProps) {
  const { tagById } = useLookups();
  const options = useTagOptions();
  const onCreate = useTagCreate(value, onChange, allowCreate);
  const selected = value.map((id) => tagById.get(id)).filter((t): t is TagDTO => t !== undefined);
  const triggerEl = trigger ?? (
    <PropertyButton
      aria-label={selected.length > 0 ? `${label}: ${selected.map((t) => t.name).join(', ')}` : placeholder}
      icon={selected.length > 0 ? undefined : <Tag />}
      placeholder={selected.length === 0}
      {...triggerProps}
    >
      {selected.length > 0 ? <TagList tags={selected} max={maxChips} wrap={false} /> : placeholder}
    </PropertyButton>
  );
  return (
    <Picker<number>
      multiple
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      onCreate={onCreate}
      createLabel={createLabel}
      placeholder={allowCreate ? 'Search or create…' : 'Search…'}
      emptyText={allowCreate ? 'Type to create a tag' : 'No tags'}
      searchable
      trigger={triggerEl}
      className={panelClassName ?? 'w-64'}
      {...popup}
    />
  );
}

export interface TagPickerListProps extends TagValueProps {
  /** Larger rows (phones). */
  touch?: boolean;
  /** Focus the search field on mount (default true). */
  autoFocus?: boolean;
  className?: string;
}

/** The same search + checklist without a popup (dialogs, side panels). */
export function TagPickerList({ value, onChange, allowCreate = true, touch, autoFocus, className }: TagPickerListProps) {
  const options = useTagOptions();
  const onCreate = useTagCreate(value, onChange, allowCreate);
  return (
    <PickerList<number>
      multiple
      label="Tags"
      options={options}
      value={value}
      onChange={onChange}
      onCreate={onCreate}
      createLabel={createLabel}
      placeholder={allowCreate ? 'Search or create…' : 'Search…'}
      emptyText={allowCreate ? 'Type to create a tag' : 'No tags'}
      searchable
      touch={touch}
      autoFocus={autoFocus}
      className={className}
    />
  );
}
