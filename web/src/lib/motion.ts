// Motion preferences for scripted scrolling. index.css tones transitions down for
// prefers-reduced-motion, but a JS scroll with behavior 'smooth' overrides any CSS, so scroll
// calls ask here for their behavior instead of hard-coding 'smooth'.

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 'smooth', or 'auto' (an instant jump) when the user asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}
