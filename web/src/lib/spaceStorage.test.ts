import { describe, expect, it } from 'vitest';
import { claimDrafts, DRAFTS_ACCOUNT, forgetDrafts, LEGACY_KEYS_MOVED, moveLegacyKeys, spaceKey } from './spaceStorage';
import { memoryStorage } from './storage.test-utils';

const A = '7k2m9q4w8x1c3v5b';
const B = '0123456789abcdef';

/** What the client before spaces left in a browser, ids of the upgraded space included. */
const OLD_LOCAL = {
  'lyren.palette.recent': '[{"kind":"board","id":1,"name":"All","at":1}]',
  'lyren.lastProjectId': '3',
  'lyren.projectBoard.3': '7',
  'lyren.overview.3': '{"m:1":true}',
};
const OLD_SESSION = {
  'lyren.createTaskDraft': '{"title":"x"}',
  'lyren.draft.comment.12': 'half a comment',
  'lyren.draft.worklog.12': '{"duration":"1h"}',
};
/** Device preferences: global, never moved. */
const DEVICE = {
  'lyren.theme': 'dark',
  'lyren.sidebar.collapsed': 'true',
  'lyren.sidebar.projectsOpen': 'false',
  'lyren.board.listOnPhone': 'true',
  'lyren.project.showDescription': 'true',
  'lyren.trayHint.dismissed': 'true',
  'lyren.chunkReloadAt': '1',
  'lyren.lastSpace': A,
};

function browser() {
  return { local: memoryStorage({ ...OLD_LOCAL, ...DEVICE }), session: memoryStorage({ ...OLD_SESSION }) };
}

describe('spaceKey', () => {
  it('names a space’s key', () => {
    expect(spaceKey(A, 'palette.recent')).toBe(`lyren.s.${A}.palette.recent`);
  });
});

describe('moveLegacyKeys (§12.6)', () => {
  // A is the space the upgrade made of the old data (AuthStatusDTO.legacySpaceId).
  it('moves the old keys into the upgraded space, then sets the flag', () => {
    const storage = browser();
    expect(moveLegacyKeys(A, A, storage)).toBe(7);
    for (const [key, value] of Object.entries(OLD_LOCAL)) {
      expect(storage.local.map.has(key), key).toBe(false);
      expect(storage.local.getItem(spaceKey(A, key.slice('lyren.'.length)))).toBe(value);
    }
    for (const [key, value] of Object.entries(OLD_SESSION)) {
      expect(storage.session.map.has(key), key).toBe(false);
      expect(storage.session.getItem(spaceKey(A, key.slice('lyren.'.length)))).toBe(value);
    }
    expect(storage.local.getItem(LEGACY_KEYS_MOVED)).toBe('1');
  });

  it('leaves the global device keys alone', () => {
    const storage = browser();
    moveLegacyKeys(A, A, storage);
    for (const [key, value] of Object.entries(DEVICE)) expect(storage.local.getItem(key), key).toBe(value);
  });

  it('another space never gets the old keys, and they wait for the upgraded one', () => {
    const storage = browser();
    // The account entered another space of its own first (it created one, or this browser is new).
    expect(moveLegacyKeys(B, A, storage)).toBe(0);
    expect(storage.local.getItem(spaceKey(B, 'lastProjectId'))).toBeNull();
    expect(storage.local.getItem(LEGACY_KEYS_MOVED)).toBeNull();
    expect(moveLegacyKeys(A, A, storage)).toBe(7);
    expect(storage.local.getItem(spaceKey(A, 'lastProjectId'))).toBe('3');
    // Once moved, old-looking keys that appear again (another tab of the old client) stay where they are.
    storage.local.setItem('lyren.lastProjectId', '9');
    expect(moveLegacyKeys(A, A, storage)).toBe(0);
    expect(storage.local.getItem(spaceKey(A, 'lastProjectId'))).toBe('3');
  });

  it('an account that is no member of the upgraded space gets nothing, whatever its spaces (legacySpaceId null)', () => {
    const storage = browser();
    expect(moveLegacyKeys(B, null, storage)).toBe(0);
    expect(storage.local.getItem(spaceKey(B, 'palette.recent'))).toBeNull();
    expect(storage.session.getItem(spaceKey(B, 'draft.comment.12'))).toBeNull();
    expect(storage.local.getItem('lyren.palette.recent')).toBe(OLD_LOCAL['lyren.palette.recent']);
    expect(storage.local.getItem(LEGACY_KEYS_MOVED)).toBeNull();
  });

  it('sets the flag even when there was nothing to move', () => {
    const storage = { local: memoryStorage(DEVICE), session: memoryStorage() };
    expect(moveLegacyKeys(A, A, storage)).toBe(0);
    expect(storage.local.getItem(LEGACY_KEYS_MOVED)).toBe('1');
  });

  it('keeps what the space already has', () => {
    const storage = browser();
    storage.local.setItem(spaceKey(A, 'lastProjectId'), '5');
    moveLegacyKeys(A, A, storage);
    expect(storage.local.getItem(spaceKey(A, 'lastProjectId'))).toBe('5');
    expect(storage.local.getItem('lyren.lastProjectId')).toBeNull();
  });

  it('works without session storage, and does nothing without local storage', () => {
    const local = memoryStorage({ ...OLD_LOCAL });
    expect(moveLegacyKeys(A, A, { local, session: null })).toBe(4);
    const session = memoryStorage({ ...OLD_SESSION });
    expect(moveLegacyKeys(A, A, { local: null, session })).toBe(0);
    expect(session.getItem('lyren.createTaskDraft')).toBe(OLD_SESSION['lyren.createTaskDraft']);
  });
});

describe('unsent drafts and the account (§12.6)', () => {
  /** A tab's sessionStorage: drafts in two spaces, one of the client before spaces, and other keys. */
  function tab(owner?: number) {
    return memoryStorage({
      [spaceKey(A, 'draft.comment.1')]: 'A private note I never sent',
      [spaceKey(A, 'draft.worklog.1')]: '{"duration":"1h"}',
      [spaceKey(B, 'createTaskDraft')]: '{"title":"x"}',
      'lyren.draft.comment.12': 'half a comment',
      'lyren.chunkReloadAt': '1',
      [spaceKey(A, 'something.else')]: 'kept',
      ...(owner === undefined ? {} : { [DRAFTS_ACCOUNT]: String(owner) }),
    });
  }
  const drafts = (session: ReturnType<typeof tab>) => [...session.map.keys()].filter((k) => k.includes('raft') && k !== DRAFTS_ACCOUNT);

  it('signing out drops every draft of the tab, and nothing else', () => {
    const session = tab(1);
    forgetDrafts(session);
    expect(drafts(session)).toEqual([]);
    expect(session.getItem(DRAFTS_ACCOUNT)).toBeNull();
    expect(session.getItem('lyren.chunkReloadAt')).toBe('1');
    expect(session.getItem(spaceKey(A, 'something.else'))).toBe('kept');
  });

  it('another account never gets them: signed in here, or in another tab sharing the cookie', () => {
    for (const signedIn of [true, false]) {
      const session = tab(1);
      claimDrafts(2, { signedIn }, session);
      expect(drafts(session), String(signedIn)).toEqual([]);
      expect(session.getItem(DRAFTS_ACCOUNT)).toBe('2');
    }
  });

  it('the same account keeps them, after its session ended and it signed in again too', () => {
    const session = tab(1);
    claimDrafts(1, { signedIn: true }, session);
    claimDrafts(1, {}, session);
    expect(drafts(session)).toHaveLength(4);
  });

  it('drafts no account claimed are kept by an account still signed in, dropped at a sign-in', () => {
    const kept = tab();
    claimDrafts(1, {}, kept);
    expect(drafts(kept)).toHaveLength(4);
    expect(kept.getItem(DRAFTS_ACCOUNT)).toBe('1');
    const dropped = tab();
    claimDrafts(1, { signedIn: true }, dropped);
    expect(drafts(dropped)).toEqual([]);
    expect(dropped.getItem(DRAFTS_ACCOUNT)).toBe('1');
  });

  it('does nothing without session storage', () => {
    expect(() => forgetDrafts(null)).not.toThrow();
    expect(() => claimDrafts(1, { signedIn: true }, null)).not.toThrow();
  });
});
