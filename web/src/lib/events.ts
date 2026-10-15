// Tiny typed app-wide event bus for opening global UI (create-task dialog,
// command palette) from anywhere without prop drilling or providers.

import { useEffect, useRef } from 'react';
import type { TaskCreateInput } from '@shared/schemas';

export interface AppEvents {
  /** Open the "New task" dialog with optional prefilled fields. */
  'create-task': Partial<TaskCreateInput>;
  /** Open the command palette / global search (optionally with initial text). */
  'command-palette': { query?: string };
  /** Open/close the mobile "More" navigation sheet (open omitted = toggle). */
  'toggle-nav': { open?: boolean };
}

const target = new EventTarget();

export function emit<K extends keyof AppEvents>(name: K, detail: AppEvents[K]): void {
  target.dispatchEvent(new CustomEvent(name, { detail }));
}

export function useAppEvent<K extends keyof AppEvents>(name: K, handler: (detail: AppEvents[K]) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<AppEvents[K]>).detail);
    target.addEventListener(name, listener);
    return () => target.removeEventListener(name, listener);
  }, [name]);
}

/** Convenience wrappers. */
export const openCreateTask = (defaults: Partial<TaskCreateInput> = {}) => emit('create-task', defaults);
export const openCommandPalette = (query?: string) => emit('command-palette', { query });
