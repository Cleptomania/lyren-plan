// Copying text (links, commands) to the clipboard.

/**
 * Copy text to the clipboard. The async Clipboard API only exists in secure contexts, and
 * self-hosted instances are often plain HTTP on a LAN, so fall back to execCommand.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.select();
  try {
    if (!document.execCommand('copy')) throw new Error('Copy is not supported in this browser');
  } finally {
    area.remove();
    active?.focus({ preventScroll: true });
  }
}
