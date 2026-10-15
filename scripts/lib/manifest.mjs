// The application manifest (RT_MANIFEST) of the Windows app: node.exe's own manifest plus
// consoleAllocationPolicy "detached", so that double-clicking the exe opens no console window
// (Windows 11 24H2, build 26100, and later) while it stays a console program: Command Prompt and
// PowerShell still wait for it and show its output. Older Windows versions ignore the element and
// allocate a console as before (server/src/desktop/mode.ts then hides it).
// https://learn.microsoft.com/windows/console/console-allocation-policy
//
// The element is inserted as bytes: everything node.exe's manifest declares (asInvoker, the
// supportedOS list, any other windowsSettings such as longPathAware) stays exactly as it was.
// Pure functions on Buffers, unit-tested in scripts/test/manifest.test.mjs.

/** RT_MANIFEST resource type, and the id Windows reads for an exe (CREATEPROCESS_MANIFEST_RESOURCE_ID). */
export const RT_MANIFEST = 24;
export const PROCESS_MANIFEST_ID = 1;

export const CONSOLE_POLICY_NS = 'http://schemas.microsoft.com/SMI/2024/WindowsSettings';
export const CONSOLE_POLICY_ELEMENT = `<consoleAllocationPolicy xmlns="${CONSOLE_POLICY_NS}">detached</consoleAllocationPolicy>`;

/**
 * The manifest with consoleAllocationPolicy "detached" added: inside an existing windowsSettings
 * element, else in a new asm.v3 application element before </assembly> (the form mt.exe writes and
 * powershell.exe's own manifest uses). Returns { manifest, offset, inserted } (the bytes inserted at
 * `offset`); throws when the manifest already has the element or has no </assembly>.
 */
export function addDetachedConsolePolicy(manifest) {
  // latin1 maps each byte to one character, so string offsets are byte offsets.
  const text = Buffer.from(manifest).toString('latin1');
  if (text.includes('consoleAllocationPolicy')) throw new Error('The manifest already has a consoleAllocationPolicy');
  const settingsEnd = /<\/(?:[\w.-]+:)?windowsSettings\s*>/.exec(text);
  let offset;
  let inserted;
  if (settingsEnd) {
    offset = settingsEnd.index;
    inserted = `  ${CONSOLE_POLICY_ELEMENT}\n    `;
  } else {
    const end = /<\/(?:[\w.-]+:)?assembly\s*>/.exec(text);
    if (!end) throw new Error('The manifest has no </assembly>');
    offset = end.index;
    inserted =
      `  <application xmlns="urn:schemas-microsoft-com:asm.v3">\n` +
      `    <windowsSettings>\n` +
      `      ${CONSOLE_POLICY_ELEMENT}\n` +
      `    </windowsSettings>\n` +
      `  </application>\n`;
  }
  const bytes = Buffer.from(inserted, 'utf8');
  const source = Buffer.from(manifest);
  return { manifest: Buffer.concat([source.subarray(0, offset), bytes, source.subarray(offset)]), offset, inserted: bytes };
}

/**
 * Apply addDetachedConsolePolicy to the exe's manifest among resedit's resource `entries` (in place).
 * Returns the new manifest bytes.
 */
export function setDetachedConsolePolicy(entries) {
  const entry = entries.find((e) => e.type === RT_MANIFEST && e.id === PROCESS_MANIFEST_ID);
  if (!entry) throw new Error('node.exe has no application manifest (RT_MANIFEST 1) to update');
  const { manifest } = addDetachedConsolePolicy(Buffer.from(entry.bin));
  entry.bin = manifest.buffer.slice(manifest.byteOffset, manifest.byteOffset + manifest.byteLength);
  return manifest;
}

/** The exe's manifest (RT_MANIFEST 1) from resedit's resource `entries`, or null. */
export function processManifest(entries) {
  const entry = entries.find((e) => e.type === RT_MANIFEST && e.id === PROCESS_MANIFEST_ID);
  return entry ? Buffer.from(entry.bin) : null;
}
