// Height measurement for auto-growing textareas. Measures with an off-screen clone so the
// real element never collapses (which would make a document-scrolling page jump).

const COPIED = [
  'box-sizing',
  'width',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'line-height',
  'text-transform',
  'text-indent',
  'tab-size',
  'word-break',
  'overflow-wrap',
  'white-space',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
] as const;

let shadow: HTMLTextAreaElement | null = null;

function getShadow(): HTMLTextAreaElement {
  if (shadow && shadow.isConnected) return shadow;
  shadow = document.createElement('textarea');
  shadow.setAttribute('aria-hidden', 'true');
  shadow.tabIndex = -1;
  Object.assign(shadow.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    height: '0',
    minHeight: '0',
    maxHeight: 'none',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
    border: '0 solid transparent',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(shadow);
  return shadow;
}

/** Resize `el` to fit its content, between minRows and maxRows (maxRows 0 = unlimited). */
export function autosizeTextarea(el: HTMLTextAreaElement, minRows: number, maxRows: number): void {
  if (!el.isConnected) return;
  const cs = window.getComputedStyle(el);
  const s = getShadow();
  for (const prop of COPIED) s.style.setProperty(prop, cs.getPropertyValue(prop));
  s.style.borderStyle = 'solid';
  s.value = el.value || el.placeholder || 'x';

  const lineHeight = Number.parseFloat(cs.lineHeight) || Number.parseFloat(cs.fontSize) * 1.45 || 20;
  const padding = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
  const border = Number.parseFloat(cs.borderTopWidth) + Number.parseFloat(cs.borderBottomWidth);
  const borderBox = cs.boxSizing === 'border-box';
  const extra = borderBox ? padding + border : 0;
  const contentHeight = s.scrollHeight - padding; // scrollHeight includes padding, not border

  const min = minRows * lineHeight + extra;
  const max = maxRows > 0 ? maxRows * lineHeight + extra : Number.POSITIVE_INFINITY;
  const wanted = contentHeight + extra;
  const height = Math.min(max, Math.max(min, wanted));
  el.style.height = `${Math.ceil(height)}px`;
  el.style.overflowY = wanted > max ? 'auto' : 'hidden';
}
