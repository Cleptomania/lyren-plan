// Panels that toasts must not cover, for the Toaster (Toast.tsx) to steer around. useModal
// registers every Dialog / Sheet / Drawer / palette panel while it is open: 'modal' panels (a
// scrim or full-screen panel makes everything under them inert) and 'docked' ones (the desktop
// task drawer, beside a page that stays usable). Framework-free; the React side subscribes.

export type ToastObstacleKind = 'modal' | 'docked';

export interface ToastObstacle {
  el: HTMLElement;
  kind: ToastObstacleKind;
}

let obstacles: readonly ToastObstacle[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Register an open panel (newest last, i.e. on top); returns the unregister function. */
export function addToastObstacle(el: HTMLElement, kind: ToastObstacleKind): () => void {
  const entry: ToastObstacle = { el, kind };
  obstacles = [...obstacles, entry];
  emit();
  return () => {
    obstacles = obstacles.filter((o) => o !== entry);
    emit();
  };
}

export function subscribeToastObstacles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToastObstacles(): readonly ToastObstacle[] {
  return obstacles;
}
