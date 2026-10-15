import { useMediaQuery } from '../../../lib/hooks';

/** Query under which anchored menus/pickers/popovers render as bottom sheets instead. */
export const SHEET_MODE_QUERY = '(max-width: 767px), (pointer: coarse)';

/**
 * True on phones and touch-first devices: menus, pickers and popovers render as bottom
 * sheets with large touch targets instead of anchored dropdowns.
 */
export function useSheetMode(): boolean {
  return useMediaQuery(SHEET_MODE_QUERY);
}
