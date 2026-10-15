import { describe, expect, it } from 'vitest';
import type { ToastObstacle } from './internal/toastObstacles';
import { activeObstacles, placeToasts, samePlacement, settledPanel, type Box, type PlacementInput } from './toastPlacement';

const box = (top: number, right: number, bottom: number, left: number): Box => ({ top, right, bottom, left });

// Phone 390×844: the stack (one toast, 52px) sits 12px above the 56px tab bar.
const phone = (obstacles: Box[], { height = 52, controls = [] as Box[] } = {}): PlacementInput => ({
  viewport: { width: 390, height: 844 },
  slot: box(776 - height, 378, 776, 12),
  obstacles,
  controls,
  minTop: 12,
  gap: 8,
});
// Desktop 1280×800: a 22rem stack at the bottom right.
const desktop = (obstacles: Box[], { controls = [] as Box[] } = {}): PlacementInput => ({
  viewport: { width: 1280, height: 800 },
  slot: box(732, 1264, 784, 912),
  obstacles,
  controls,
  minTop: 12,
  gap: 8,
});
/** A full-width row of controls between two y values (phone). */
const row = (top: number, bottom: number) => box(top, 374, bottom, 16);
const FULL = box(0, 390, 844, 0);

describe('placeToasts', () => {
  it('keeps the usual spot when no panel is there', () => {
    expect(placeToasts(phone([]))).toEqual({ mode: 'default' });
    // A centred confirm card on a phone, a centred dialog on desktop.
    expect(placeToasts(phone([box(300, 374, 520, 16)]))).toEqual({ mode: 'default' });
    expect(placeToasts(desktop([box(150, 896, 650, 384)]))).toEqual({ mode: 'default' });
  });

  it('sits right above a bottom sheet, over its scrim', () => {
    // The More sheet rests on the tab bar (bottom 788) and rises to 420.
    expect(placeToasts(phone([box(420, 390, 788, 0)]))).toEqual({ mode: 'above', bottom: 844 - 412 });
    // A bottom sheet card on a tablet-width layout.
    expect(placeToasts(desktop([box(500, 1000, 784, 488)]))).toEqual({ mode: 'above', bottom: 800 - 492 });
    // Room for one toast above a tall sheet, but not for three: then inside it (no controls there).
    expect(placeToasts(phone([box(100, 390, 844, 0)]))).toEqual({ mode: 'above', bottom: 844 - 92 });
    expect(placeToasts(phone([box(100, 390, 844, 0)], { height: 170 }))).toEqual({ mode: 'default' });
  });

  it('moves beside a drawer docked on the right', () => {
    expect(placeToasts(desktop([box(0, 1280, 800, 640)]))).toEqual({ mode: 'beside', right: 1280 - 632 });
  });

  it('inside a full-screen panel, keeps the usual spot when no control is under it', () => {
    // The create dialog: fields at the top, a pinned footer below the usual spot.
    const controls = [row(10, 50), row(100, 140), row(160, 200), row(790, 834)];
    expect(placeToasts(phone([FULL], { controls }))).toEqual({ mode: 'default' });
  });

  it('inside a full-screen panel, hops above the controls in the way', () => {
    // A sticky composer (700–780) under the usual spot, a property row at 560–600, free above it.
    const controls = [row(10, 50), row(560, 600), row(700, 780)];
    expect(placeToasts(phone([FULL], { controls }))).toEqual({ mode: 'above', bottom: 844 - 684 });
    // Not enough room between the composer and the row above: hop above that row too.
    const tight = [row(10, 50), row(620, 660), row(700, 780)];
    expect(placeToasts(phone([FULL], { controls: tight }))).toEqual({ mode: 'above', bottom: 844 - 604 });
    // Controls only cover part of the width that the stack does not use: they do not count.
    expect(placeToasts(desktop([box(0, 1280, 800, 200)], { controls: [box(740, 600, 780, 220)] }))).toEqual({ mode: 'default' });
  });

  it('goes to the top edge when a full-screen panel has no free band', () => {
    const packed = Array.from({ length: 20 }, (_, i) => row(i * 42, i * 42 + 40));
    expect(placeToasts(phone([FULL], { controls: packed }))).toEqual({ mode: 'top' });
    // A drawer covering nearly the whole width, full of controls.
    expect(placeToasts(desktop([box(0, 1280, 800, 200)], { controls: [box(0, 1280, 800, 200)] }))).toEqual({ mode: 'top' });
  });

  it('never picks a spot that another panel covers', () => {
    // A second panel right above a sheet: no room above them; inside the top one, no controls.
    expect(placeToasts(phone([box(420, 390, 788, 0), box(300, 390, 420, 0)]))).toEqual({ mode: 'default' });
    expect(placeToasts(phone([box(420, 390, 788, 0), box(300, 390, 420, 0)], { controls: [row(420, 788)] }))).toEqual({
      mode: 'above',
      bottom: 844 - 404,
    });
  });
});

describe('activeObstacles', () => {
  const el = (name: string) => ({ name }) as unknown as HTMLElement;
  const drawer = el('drawer');
  const sheet = el('sheet');
  const dialog = el('dialog');
  it('uses the topmost modal panel only, else every docked panel', () => {
    const list = (...o: ToastObstacle[]) => o;
    expect(activeObstacles([])).toEqual([]);
    expect(activeObstacles(list({ el: drawer, kind: 'docked' }))).toEqual([drawer]);
    expect(activeObstacles(list({ el: drawer, kind: 'docked' }, { el: dialog, kind: 'modal' }))).toEqual([dialog]);
    expect(activeObstacles(list({ el: drawer, kind: 'modal' }, { el: sheet, kind: 'modal' }))).toEqual([sheet]);
  });
});

describe('samePlacement', () => {
  it('ignores sub-pixel moves', () => {
    expect(samePlacement({ mode: 'above', bottom: 400 }, { mode: 'above', bottom: 400.4 })).toBe(true);
    expect(samePlacement({ mode: 'above', bottom: 400 }, { mode: 'above', bottom: 410 })).toBe(false);
    expect(samePlacement({ mode: 'top' }, { mode: 'top' })).toBe(true);
    expect(samePlacement({ mode: 'top' }, { mode: 'default' })).toBe(false);
  });
});

describe('settledPanel', () => {
  // The New epic dialog on a phone: full screen, with the colour row and the Markdown editor
  // toolbar where the stack usually sits (y 680-776).
  const settled = [box(56, 374, 96, 16), row(690, 730), row(738, 776), box(796, 374, 836, 16)];
  const drawnAt = (dy: number) => settled.map((c) => ({ ...c, top: c.top + dy, bottom: c.bottom + dy }));

  it('measures a sliding panel where it will settle, at any point of its slide-in', () => {
    for (const dy of [844, 574, 270, 12, 0]) {
      const m = settledPanel({ rect: box(dy, 390, 844 + dy, 0), layout: FULL, controls: drawnAt(dy) }, 844);
      expect(m.obstacle).toEqual(FULL);
      expect(m.controls).toEqual(settled);
    }
  });

  it('toast shown, then a full-screen dialog opens: the stack leaves the dialog’s controls', () => {
    // Measured one frame into the slide-in (the case that used to read as "clear").
    const m = settledPanel({ rect: box(270, 390, 1114, 0), layout: FULL, controls: drawnAt(270) }, 844);
    const placement = placeToasts(phone([m.obstacle], { height: 96, controls: m.controls }));
    expect(placement.mode).not.toBe('default');
  });

  it('re-placing after the panel’s content grew moves a stack that was fine before', () => {
    const drawer = [box(56, 374, 96, 16), row(300, 340)];
    const before = settledPanel({ rect: FULL, layout: FULL, controls: drawer }, 844);
    expect(placeToasts(phone([before.obstacle], { controls: before.controls }))).toEqual({ mode: 'default' });
    // The comment composer expands under the stack.
    const after = settledPanel({ rect: FULL, layout: FULL, controls: [...drawer, row(640, 800)] }, 844);
    const placement = placeToasts(phone([after.obstacle], { controls: after.controls }));
    expect(placement).toEqual({ mode: 'above', bottom: 844 - (640 - 16) });
  });

  it('drops controls scrolled out of the panel’s visible part', () => {
    const sheet = box(420, 390, 788, 0);
    const m = settledPanel({ rect: sheet, layout: sheet, controls: [box(380, 374, 410, 16), box(500, 374, 540, 16), box(800, 374, 840, 16)] }, 844);
    expect(m.controls).toEqual([box(500, 374, 540, 16)]);
  });
});
