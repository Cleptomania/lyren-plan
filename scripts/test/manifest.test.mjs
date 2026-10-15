// The Windows app's manifest (scripts/lib/manifest.mjs): consoleAllocationPolicy "detached" added,
// every byte of node.exe's own manifest kept.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addDetachedConsolePolicy,
  CONSOLE_POLICY_ELEMENT,
  processManifest,
  RT_MANIFEST,
  setDetachedConsolePolicy,
} from '../lib/manifest.mjs';
import { peLayout } from '../lib/pe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The official node.exe of this Node.js version, where scripts/package.mjs caches it. The release
// workflow (.github/workflows/release.yml) runs this file again after packaging the Windows app, with
// LYREN_TEST_REQUIRE_CACHED_NODE=1: there the test that needs it runs (and fails without it) instead
// of being skipped, as it is in `npm run check` on a fresh checkout.
const CACHED_NODE = path.join(ROOT, '.cache', 'node', process.version, 'win-x64-node.exe');
const REQUIRE_CACHED_NODE = process.env.LYREN_TEST_REQUIRE_CACHED_NODE === '1';

/** node.exe v24.19.0's manifest (RT_MANIFEST 1, 762 bytes), as the official binary carries it. */
const NODE_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <trustInfo>
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/>
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}"/>
      <supportedOS Id="{e2011457-1546-43c5-a5fe-008deee3d3f0}"/>
    </application>
  </compatibility>
</assembly>
`;

/** `after` is `before` with `inserted` at `offset` and nothing else changed. */
function expectOnlyInsertion(before, after, offset, inserted) {
  expect(after.length).toBe(before.length + inserted.length);
  expect(after.subarray(0, offset).equals(before.subarray(0, offset))).toBe(true);
  expect(after.subarray(offset, offset + inserted.length).equals(inserted)).toBe(true);
  expect(after.subarray(offset + inserted.length).equals(before.subarray(offset))).toBe(true);
}

describe('consoleAllocationPolicy in the manifest', () => {
  it("adds an asm.v3 application element before </assembly>, keeping node.exe's manifest byte for byte", () => {
    const before = Buffer.from(NODE_MANIFEST, 'utf8');
    expect(before.length).toBe(762);
    const { manifest, offset, inserted } = addDetachedConsolePolicy(before);
    expectOnlyInsertion(before, manifest, offset, inserted);
    expect(offset).toBe(NODE_MANIFEST.lastIndexOf('</assembly>'));
    const text = manifest.toString('utf8');
    expect(text).toContain(
      '  <application xmlns="urn:schemas-microsoft-com:asm.v3">\n    <windowsSettings>\n' +
        '      <consoleAllocationPolicy xmlns="http://schemas.microsoft.com/SMI/2024/WindowsSettings">detached</consoleAllocationPolicy>\n' +
        '    </windowsSettings>\n  </application>\n</assembly>\n',
    );
    // Nothing node.exe declares is lost.
    expect(text).toContain('<requestedExecutionLevel level="asInvoker" uiAccess="false"/>');
    expect(text.match(/<supportedOS Id=/g)).toHaveLength(5);
    expect(text.match(/<application[ >]/g)).toHaveLength(2); // compatibility's and the new one
  });

  it('goes into an existing windowsSettings (e.g. longPathAware), never a second asm.v3 application', () => {
    const withSettings = NODE_MANIFEST.replace(
      '</assembly>',
      '  <application xmlns="urn:schemas-microsoft-com:asm.v3">\n    <windowsSettings>\n' +
        '      <longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>\n' +
        '    </windowsSettings>\n  </application>\n</assembly>',
    );
    const before = Buffer.from(withSettings, 'utf8');
    const { manifest, offset, inserted } = addDetachedConsolePolicy(before);
    expectOnlyInsertion(before, manifest, offset, inserted);
    const text = manifest.toString('utf8');
    expect(text).toContain('<longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware>');
    expect(text).toMatch(/longPathAware>\n\s+<consoleAllocationPolicy [^>]+>detached<\/consoleAllocationPolicy>\n\s+<\/windowsSettings>/);
    expect(text.match(/asm\.v3/g)).toHaveLength(1);
    // A prefixed element (asmv3:windowsSettings) is found as well.
    const prefixed = Buffer.from(NODE_MANIFEST.replace('</assembly>', '<asmv3:application><asmv3:windowsSettings></asmv3:windowsSettings></asmv3:application></assembly>'));
    expect(addDetachedConsolePolicy(prefixed).manifest.toString()).toContain(`${CONSOLE_POLICY_ELEMENT}\n    </asmv3:windowsSettings>`);
  });

  it('keeps bytes that are not ASCII (and a byte-order mark) unchanged; refuses to add it twice', () => {
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(NODE_MANIFEST.replace('<trustInfo>', '<!-- Größe ✓ --><trustInfo>'), 'utf8')]);
    const { manifest, offset, inserted } = addDetachedConsolePolicy(before);
    expectOnlyInsertion(before, manifest, offset, inserted);
    expect(() => addDetachedConsolePolicy(manifest)).toThrow(/already has a consoleAllocationPolicy/);
    expect(() => addDetachedConsolePolicy(Buffer.from('<assembly>'))).toThrow(/no <\/assembly>/);
  });

  it('updates the resource entry resedit hands over', () => {
    const entries = [
      { type: 3, id: 1, lang: 1033, bin: new ArrayBuffer(4) },
      { type: RT_MANIFEST, id: 1, lang: 1033, bin: new Uint8Array(Buffer.from(NODE_MANIFEST)).buffer },
    ];
    const updated = setDetachedConsolePolicy(entries);
    expect(processManifest(entries).equals(updated)).toBe(true);
    expect(updated.toString()).toContain('>detached</consoleAllocationPolicy>');
    expect(() => setDetachedConsolePolicy([])).toThrow(/no application manifest/);
  });

  // The way scripts/package.mjs does it, on the real node.exe (when an earlier build has cached it):
  // the generated exe carries the new manifest and is still a CONSOLE program.
  it.runIf(REQUIRE_CACHED_NODE || fs.existsSync(CACHED_NODE))('in a generated exe: the manifest bytes read back, subsystem still CONSOLE', async () => {
    expect(fs.existsSync(CACHED_NODE), `${CACHED_NODE} is missing (scripts/package.mjs --target win-x64 downloads it)`).toBe(true);
    const ResEdit = await import('resedit');
    const exe = ResEdit.NtExecutable.from(fs.readFileSync(CACHED_NODE), { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(exe);
    const original = processManifest(res.entries);
    expect(original.toString('utf8')).toBe(NODE_MANIFEST);
    setDetachedConsolePolicy(res.entries);
    res.outputResource(exe);
    const built = Buffer.from(exe.generate());
    const reread = processManifest(ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(built)).entries);
    const { offset, inserted } = addDetachedConsolePolicy(original);
    expectOnlyInsertion(original, reread, offset, inserted);
    // IMAGE_SUBSYSTEM_WINDOWS_CUI (3): shells keep waiting for the commands.
    expect(built.readUInt16LE(peLayout(built).optional + 68)).toBe(3);
  }, 60_000);
});
