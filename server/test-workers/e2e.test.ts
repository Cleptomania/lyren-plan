// End to end through the Worker (design §14.5): requests to https://plan.example.com through SELF.fetch,
// the real Worker, DirectoryDO and SpaceDOs (entry.ts counts what reached them). One instance for the
// whole file, in order: what the Worker answers itself, first-run setup, sign-in, spaces, a task round
// trip, conditional reads, roles, an invitation without mail (the link in the answer) accepted by a new
// account, an admin's reset link, the logout lag, the export, a used-up daily limit and the static
// assets. Sign-up and the forgotten password need mail, which wrangler.test.jsonc's log transport does
// not deliver: they run on a DirectoryDO of their own with a recording EMAIL binding. The imports are
// archive.test.ts's (a file of their own: fresh storage, and so their own day of import budget).

import { runInDurableObject, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '@shared/constants';
import type {
  AuthStatusDTO,
  InvitationCreatedDTO,
  InvitationPreviewDTO,
  ResetLinkDTO,
  SpaceSummaryDTO,
  TaskDTO,
  TaskQueryResult,
  TaskTimelineDTO,
} from '@shared/types';
import { DAILY_LIMIT_MESSAGE } from '../src/core/db';
import { encodeMeta, META_HEADER } from '../src/core/meta';
import { DirectoryDO as WorkerDirectoryDO } from '../src/runtime/cloudflare/directoryDo';
import { doDbTestHooks } from '../src/runtime/cloudflare/doDb';
import type { Env } from '../src/runtime/cloudflare/env';
import { downloadArchive } from '../test/support/archive';
import { settle } from '../test/support/heldBody';
import { UNPREFIXED_SPACE_PATHS } from '../test/gateway/cases';
import { callsOf, directoryCalls } from './entry';
import { addAccount, inDirectory, ORIGIN, OWNER_EMAIL, PASSWORD, WorkerClient, within } from './support';

const NOT_SIGNED_IN = { error: { code: 'unauthorized', message: 'Not signed in' } };
const AUTH_CACHE_MS = Number(env.AUTH_CACHE_SECONDS) * 1000;

let owner: WorkerClient;
let spaceId: string;

/** Directory requests and space requests that reached an object so far. */
const reached = () => directoryCalls.fetch;

describe('what the Worker answers itself (no Durable Object request)', () => {
  it('health', async () => {
    const before = reached();
    const res = await SELF.fetch(`${ORIGIN}/api/health`);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(reached()).toBe(before);
  });

  it('another host: 421 with PUBLIC_URL, for the SPA to move there', async () => {
    const res = await SELF.fetch('https://lyren-plan.example.workers.dev/api/auth/status');
    expect(res.status).toBe(421);
    expect(await res.json()).toEqual({
      error: { code: 'wrong_host', message: `This Lyren Plan instance is at ${ORIGIN}`, details: [{ path: 'publicUrl', message: ORIGIN }] },
    });
    expect(reached()).toBe(0);
  });

  it('CSRF, encoded paths and space calls without a session', async () => {
    const csrf = await SELF.fetch(`${ORIGIN}/api/auth/login`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect(csrf.status).toBe(403);
    const space = '7k2m9q4w8x1c3v5b';
    expect((await SELF.fetch(`${ORIGIN}/api/s/${space}/%74asks`, { headers: { Cookie: `__Host-lyren_session=${'k'.repeat(43)}` } })).status).toBe(404);
    const cookieless = await SELF.fetch(`${ORIGIN}/api/s/${space}/bootstrap`);
    expect(cookieless.status).toBe(401);
    expect(await cookieless.json()).toEqual(NOT_SIGNED_IN);
    expect(callsOf(space).fetch).toBe(0);
    expect(reached()).toBe(0);
  });
});

describe('through the objects', () => {
  beforeAll(() => {
    owner = new WorkerClient();
  });

  it('first-run setup with SETUP_TOKEN, then status with the default space', async () => {
    const status = await owner.get<AuthStatusDTO>('/api/auth/status');
    expect(status.body).toMatchObject({ setupRequired: true, user: null, instance: { runtime: 'cloudflare', passwordMinLength: 12 } });
    const wrong = await owner.post('/api/auth/setup', { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode: 'nope' });
    expect(wrong.status).toBe(403);
    const setup = await owner.post('/api/auth/setup', { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode: 'test' });
    expect(setup.status).toBe(201);
    // HTTPS: the __Host- cookie only.
    expect([...owner.jar.keys()].sort()).toEqual(['__Host-lyren_device', '__Host-lyren_session']);
    const after = await owner.get<AuthStatusDTO>('/api/auth/status');
    expect(after.body.user?.email).toBe(OWNER_EMAIL);
    expect(after.body.spaces.map((s) => s.name)).toEqual(["Owner's space"]);
    spaceId = after.body.spaces[0]!.id;
    expect(callsOf(spaceId).init).toBe(1);
  });

  it('the space paths of the client before spaces are the directory’s: 401 signed out, 404 signed in', async () => {
    const before = callsOf(spaceId).fetch;
    for (const path of UNPREFIXED_SPACE_PATHS) {
      const signedOut = await SELF.fetch(`${ORIGIN}${path}`);
      expect(signedOut.status, path).toBe(401);
      expect(await signedOut.json()).toEqual(NOT_SIGNED_IN);
      const signedIn = await owner.get(path);
      expect(signedIn.status, path).toBe(404);
      expect(signedIn.body).toEqual({ error: { code: 'not_found', message: 'Lyren Plan has been updated. Reload the page to continue.' } });
    }
    expect(callsOf(spaceId).fetch).toBe(before);
  });

  it('a client-sent x-lyren-meta is replaced by the Worker’s own', async () => {
    const forged = encodeMeta({
      clientIp: '203.0.113.66',
      secure: true,
      requestId: 'forged',
      userAgent: 'forged',
      sessionTokenHash: null,
      sessionCookie: null,
    });
    const login = await new WorkerClient('198.51.100.7').request(
      'POST',
      '/api/auth/login',
      { identifier: OWNER_EMAIL, password: PASSWORD },
      { [META_HEADER]: forged, 'User-Agent': 'e2e-agent' },
    );
    expect(login.status).toBe(200);
    const event = await inDirectory((db) =>
      db.get<{ ip: string; user_agent: string }>("SELECT ip, user_agent FROM security_events WHERE type = 'login' ORDER BY id DESC LIMIT 1"),
    );
    expect(event).toEqual({ ip: '198.51.100.7', user_agent: 'e2e-agent' });
  });

  it('login, logout and login again', async () => {
    expect((await owner.post('/api/auth/logout')).status).toBe(200);
    expect(owner.jar.has('__Host-lyren_session')).toBe(false);
    expect((await owner.get(`/api/s/${spaceId}/bootstrap`)).status).toBe(401);
    const wrong = await owner.post('/api/auth/login', { identifier: OWNER_EMAIL, password: 'not the password' });
    expect(wrong.status).toBe(401);
    expect((await owner.post('/api/auth/login', { identifier: OWNER_EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('creates a space and lists it', async () => {
    const created = await owner.post<SpaceSummaryDTO>('/api/spaces', { name: 'Team' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Team', role: 'owner', status: 'active' });
    expect(callsOf(created.body.id).init).toBe(1);
    const spaces = await owner.get<SpaceSummaryDTO[]>('/api/spaces');
    expect(spaces.body.map((s) => s.name)).toEqual(["Owner's space", 'Team']);
    const bootstrap = await owner.get(`/api/s/${created.body.id}/bootstrap`);
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.body.space).toEqual({ id: created.body.id, name: 'Team', role: 'owner' });
  });

  it('a task round trip: create, read, edit, comment, list, delete', async () => {
    const s = (path: string) => `/api/s/${spaceId}${path}`;
    const project = await owner.post<{ id: number }>(s('/projects'), { name: 'Website', key: 'WEB' });
    expect(project.status).toBe(201);
    const task = await owner.post<TaskDTO>(s('/tasks'), { projectId: project.body.id, title: 'Write the copy' });
    expect(task.status).toBe(201);
    expect(task.body).toMatchObject({ ref: 'WEB-1', title: 'Write the copy' });
    expect((await owner.get<TaskDTO>(s(`/tasks/${task.body.id}`))).body.title).toBe('Write the copy');
    const edited = await owner.patch<TaskDTO>(s(`/tasks/${task.body.id}`), { title: 'Write the landing page copy' });
    expect(edited.body.title).toBe('Write the landing page copy');
    expect((await owner.post(s(`/tasks/${task.body.id}/comments`), { body: 'Draft is in the doc' })).status).toBe(201);
    const timeline = await owner.get<TaskTimelineDTO>(s(`/tasks/${task.body.id}/timeline`));
    expect(timeline.body.comments.map((comment) => comment.body)).toEqual(['Draft is in the doc']);
    const listed = await owner.post<TaskQueryResult>(s('/tasks/query'), { filter: { projectIds: [project.body.id] } });
    expect(listed.body.tasks.map((t) => t.ref)).toEqual(['WEB-1']);
    expect((await owner.delete(s(`/tasks/${task.body.id}`))).body).toEqual({ ok: true });
    expect((await owner.get(s(`/tasks/${task.body.id}`))).status).toBe(404);
  });

  it('a re-read of unchanged data answers 304; after an edit, 200 with a new ETag', async () => {
    const path = `/api/s/${spaceId}/bootstrap`;
    const first = await owner.get(path);
    const etag = first.headers.get('ETag')!;
    expect(etag).toMatch(/^"\d+\.\d+\.\d+\.[0-9a-f]{12}"$/);
    const again = await owner.get(path, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.body).toBeNull();
    expect((await owner.get(path, { 'If-None-Match': `W/${etag}` })).status).toBe(304);
    await owner.post(`/api/s/${spaceId}/tags`, { name: 'urgent' });
    const changed = await owner.get(path, { 'If-None-Match': etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('ETag')).not.toBe(etag);
  });

  it('a viewer reads but cannot write; a role change takes effect', async () => {
    const viewer = await addAccount({ email: 'viewer@example.com', role: 'viewer', spaceId, ip: '192.0.2.20' });
    expect((await viewer.client.get(`/api/s/${spaceId}/tags`)).status).toBe(200);
    const refused = await viewer.client.post(`/api/s/${spaceId}/tags`, { name: 'mine' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe('You have view-only access to this space.');

    // Promoted: the directory pushes an invalidate; a push can fail and leave the TTL, so poll (§14.5).
    const userId = viewer.user.id;
    expect((await owner.patch(`/api/spaces/${spaceId}/members/${userId}`, { role: 'member' })).status).toBe(200);
    await within(3000, async () => (await viewer.client.post(`/api/s/${spaceId}/tags`, { name: `mine-${Date.now()}` })).status === 201);
    // Demoted again: refused at once (the push is awaited for a demotion).
    expect((await owner.patch(`/api/spaces/${spaceId}/members/${userId}`, { role: 'viewer' })).status).toBe(200);
    expect((await viewer.client.post(`/api/s/${spaceId}/tags`, { name: 'too late' })).status).toBe(403);
  });

  it('an invitation without mail: the link is in the answer, a new account accepts it and works in the space', async () => {
    const created = await owner.post<InvitationCreatedDTO>(`/api/spaces/${spaceId}/invitations`, { email: 'Invitee@Example.com', role: 'member' });
    expect(created.status).toBe(201);
    expect(created.body.invitation).toMatchObject({ email: 'Invitee@example.com', role: 'member', delivery: 'link', status: 'pending' });
    expect(created.body.link).toMatch(/^https:\/\/plan\.example\.com\/invite#t=[A-Za-z0-9_-]{43}$/);
    const token = created.body.link!.slice(created.body.link!.indexOf('#t=') + 3);
    expect((await owner.get(`/api/spaces/${spaceId}/invitations`)).body).toEqual([created.body.invitation]);

    const invitee = new WorkerClient('192.0.2.30');
    const preview = await invitee.post<InvitationPreviewDTO>('/api/invitations/inspect', { token });
    expect(preview.body).toMatchObject({ kind: 'space', spaceName: "Owner's space", inviterName: 'Owner', role: 'member', account: 'unknown', signedIn: null });
    const accepted = await invitee.post('/api/invitations/accept', { token, displayName: 'Invitee', password: PASSWORD });
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ spaceId, user: { email: 'Invitee@example.com', emailVerified: false } });
    expect([...invitee.jar.keys()].sort()).toEqual(['__Host-lyren_device', '__Host-lyren_session']);
    const status = await invitee.get<AuthStatusDTO>('/api/auth/status');
    expect(status.body.spaces.map((s) => [s.name, s.role]).sort()).toEqual([
      ["Invitee's space", 'owner'],
      ["Owner's space", 'member'],
    ]);
    const boot = await invitee.get(`/api/s/${spaceId}/bootstrap`);
    expect(boot.status).toBe(200);
    expect(boot.body.space).toMatchObject({ id: spaceId, role: 'member' });
    expect(boot.body.people.map((p: { displayName: string }) => p.displayName)).toContain('Invitee');
    expect((await invitee.post(`/api/s/${spaceId}/tags`, { name: 'from-invitee' })).status).toBe(201);
    expect((await new WorkerClient('192.0.2.31').post('/api/invitations/accept', { token, displayName: 'Again', password: PASSWORD })).body.error.code).toBe(
      'invalid_token',
    );
    expect((await owner.get(`/api/spaces/${spaceId}/invitations`)).body).toEqual([]);
  });

  it('an admin’s reset link without mail: handed to the admin, used once, the account signed out; a notice at its next sign-in', async () => {
    const user = await addAccount({ email: 'forgetful@example.com', ip: '192.0.2.32' });
    const res = await owner.post<ResetLinkDTO>(`/api/admin/users/${user.user.id}/reset-link`);
    expect(res.status).toBe(200);
    if (res.body.sent) throw new Error('expected a link without mail');
    expect(res.body.link).toMatch(/^https:\/\/plan\.example\.com\/reset#t=[A-Za-z0-9_-]{43}$/);
    const token = res.body.link.slice(res.body.link.indexOf('#t=') + 3);
    const browser = new WorkerClient('192.0.2.33');
    expect((await browser.post('/api/auth/password/reset/inspect', { token })).body).toEqual({
      email: 'forgetful@example.com',
      username: null,
      hasPassword: true,
      // Passkeys are on (PUBLIC_URL is https): the link could set up a passkey instead (passkeys.test.ts),
      // which would replace the password (an admin can make the account a reset link).
      canUsePasskey: true,
      passkeyKeepsPassword: null,
    });
    expect(await browser.post('/api/auth/password/reset', { token, password: 'a password chosen anew' })).toMatchObject({ status: 200, body: { ok: true } });
    expect((await user.client.get('/api/account')).status).toBe(401);
    expect((await browser.post('/api/auth/password/reset', { token, password: 'and once more again' })).body.error.code).toBe('invalid_token');
    expect((await browser.post('/api/auth/login', { identifier: 'forgetful@example.com', password: 'a password chosen anew' })).status).toBe(200);
    const status = await browser.get<AuthStatusDTO>('/api/auth/status');
    expect(status.body.notices).toMatchObject([{ type: 'admin_reset_link', actorName: 'Owner' }]);
    // Forgot without mail answers alike and mints nothing (§5.8.9).
    expect(await browser.post('/api/auth/password/forgot', { email: 'forgetful@example.com' })).toMatchObject({ status: 202, body: { ok: true } });
  });

  it(`a logged-out session keeps working against a space for at most AUTH_CACHE_SECONDS (${AUTH_CACHE_MS / 1000} s here)`, async () => {
    const member = await addAccount({ email: 'member@example.com', role: 'member', spaceId, ip: '192.0.2.21' });
    const cookie = member.client.cookieHeader();
    const read = () => SELF.fetch(`${ORIGIN}/api/s/${spaceId}/tags`, { headers: { Cookie: cookie } });
    expect((await read()).status).toBe(200);
    expect((await member.client.post('/api/auth/logout')).status).toBe(200);
    const loggedOutAt = Date.now();
    // The directory knows at once; the space may answer from its cache until the entry runs out.
    const status = (await (await SELF.fetch(`${ORIGIN}/api/auth/status`, { headers: { Cookie: cookie } })).json()) as AuthStatusDTO;
    expect(status.user).toBeNull();
    await within(AUTH_CACHE_MS + 1000, async () => (await read()).status === 401);
    expect(Date.now() - loggedOutAt).toBeLessThanOrEqual(AUTH_CACHE_MS + 1000);
    const after = await read();
    expect(await after.json()).toEqual(NOT_SIGNED_IN);
  });

  it('the export (archive v2): owners only, inside the re-auth window', async () => {
    const res = await downloadArchive(owner, `/api/s/${spaceId}/data/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/attachment/);
    expect(res.archive).toMatchObject({ format: 'lyren-plan-space', formatVersion: 2 });
    expect(res.archive!.projects.map((p) => p.key)).toEqual(['WEB']);
    expect(res.archive!.tags.map((t) => t.name)).toContain('urgent');
    const viewer = await addAccount({ email: 'viewer2@example.com', role: 'viewer', spaceId, ip: '192.0.2.22' });
    expect((await viewer.client.get(`/api/s/${spaceId}/data/export`)).status).toBe(403);
  });

  it('a used-up daily limit answers 503 with the daily-limit message, in a space and in the directory', async () => {
    doDbTestHooks.beforeExec = (sql) => {
      if (/\bFROM (tags|memberships)\b/.test(sql)) throw new Error('Exceeded allowed rows read in Durable Objects free tier.');
    };
    try {
      const space = await owner.get(`/api/s/${spaceId}/tags`);
      expect(space.status).toBe(503);
      expect(space.body).toEqual({ error: { code: 'unavailable', message: DAILY_LIMIT_MESSAGE } });
      expect(space.headers.get('Cache-Control')).toBe('no-store');
      const directory = await owner.get('/api/spaces');
      expect(directory.status).toBe(503);
      expect(directory.body).toEqual({ error: { code: 'unavailable', message: DAILY_LIMIT_MESSAGE } });
    } finally {
      doDbTestHooks.beforeExec = null;
    }
    expect((await owner.get(`/api/s/${spaceId}/tags`)).status).toBe(200);
  });

  it('a write is sent with the CSRF header only', async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/s/${spaceId}/tags`, {
      method: 'POST',
      headers: { Cookie: owner.cookieHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no header' }),
    });
    expect(res.status).toBe(403);
    expect((await owner.request('POST', `/api/s/${spaceId}/tags`, { name: 'with header' }, { [CSRF_HEADER]: '1' })).status).toBe(201);
  });
});

describe('sign-up and the forgotten password, with mail (a DirectoryDO of their own, its EMAIL binding recording)', () => {
  /** What MAIL_TRANSPORT=cloudflare hands the EMAIL binding (mail/cloudflare.ts). */
  interface Sent {
    to: string;
    subject: string;
    text: string;
  }

  it('signs up through the emailed link, then resets the password through another one', async () => {
    const sent: Sent[] = [];
    const email = { send: async (m: Sent) => (sent.push(m), { messageId: `cf-${sent.length}` }) };
    const vars = { ...(env as unknown as Env), MAIL_TRANSPORT: 'cloudflare', MAIL_FROM: 'no-reply@plan.example.com', SIGNUP_POLICY: 'open', EMAIL: email as unknown as SendEmail };
    await runInDurableObject(env.TEST_DB.getByName('flows-directory'), async (_instance, state) => {
      const directory = new WorkerDirectoryDO(state, vars);
      await settle();
      const jar = new Map<string, string>();
      const call = async (method: string, path: string, body?: unknown, ip = '192.0.2.60') => {
        const meta = { clientIp: ip, secure: true, requestId: crypto.randomUUID(), userAgent: 'vitest', sessionTokenHash: null, sessionCookie: null };
        const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
        const res = await directory.fetch(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: { [META_HEADER]: encodeMeta(meta), 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        );
        for (const c of res.headers.getSetCookie()) {
          const [pair = ''] = c.split(';');
          const eq = pair.indexOf('=');
          if (/Max-Age=0/i.test(c)) jar.delete(pair.slice(0, eq));
          else jar.set(pair.slice(0, eq), pair.slice(eq + 1));
        }
        return { status: res.status, body: (await res.json()) as any };
      };
      /** The token of the newest message to `to` whose subject starts with `subject`, once it has arrived (deferred mail). */
      const tokenOf = async (to: string, subject: string) => {
        await within(3000, async () => sent.some((m) => m.to === to && m.subject.startsWith(subject)));
        const message = sent.filter((m) => m.to === to && m.subject.startsWith(subject)).at(-1)!;
        return message.text.match(/#t=([A-Za-z0-9_-]{43})/)![1]!;
      };

      expect((await call('POST', '/api/auth/setup', { email: OWNER_EMAIL, password: PASSWORD, displayName: 'Owner', setupCode: 'test' })).status).toBe(201);
      jar.clear();
      expect((await call('GET', '/api/auth/status')).body.instance).toMatchObject({ mail: true, signupPolicy: 'open' });

      expect(await call('POST', '/api/auth/signup', { email: 'newcomer@example.com' })).toMatchObject({ status: 202, body: { ok: true } });
      const signup = await tokenOf('newcomer@example.com', 'Confirm your email');
      expect((await call('POST', '/api/auth/signup/inspect', { token: signup })).body).toEqual({ email: 'newcomer@example.com' });
      const created = await call('POST', '/api/auth/signup/complete', { token: signup, displayName: 'Newcomer', password: PASSWORD });
      expect(created).toMatchObject({ status: 201, body: { user: { email: 'newcomer@example.com', emailVerified: true } } });
      const status = await call('GET', '/api/auth/status');
      expect(status.body.spaces.map((s: SpaceSummaryDTO) => s.name)).toEqual(["Newcomer's space"]);
      // The address with an account gets the other message, after the same answer.
      expect(await call('POST', '/api/auth/signup', { email: 'newcomer@example.com' }, '192.0.2.61')).toMatchObject({ status: 202, body: { ok: true } });
      await within(3000, async () => sent.some((m) => m.subject.startsWith('You already have an account')));

      jar.clear();
      expect(await call('POST', '/api/auth/password/forgot', { email: 'newcomer@example.com' }, '192.0.2.62')).toMatchObject({ status: 202 });
      const reset = await tokenOf('newcomer@example.com', 'Reset your password');
      expect((await call('POST', '/api/auth/password/reset', { token: reset, password: 'the newcomer’s new password' })).body).toEqual({ ok: true });
      expect((await call('POST', '/api/auth/login', { identifier: 'newcomer@example.com', password: PASSWORD })).status).toBe(401);
      expect((await call('POST', '/api/auth/login', { identifier: 'newcomer@example.com', password: 'the newcomer’s new password' })).status).toBe(200);
      await within(3000, async () => sent.some((m) => m.subject === 'Your password was changed'));
      // No token reached a subject, and no message carried another address's link.
      expect(sent.every((m) => !/#t=/.test(m.subject))).toBe(true);
      // The directory set its first maintenance alarm on this bare object, which has no alarm handler.
      await state.storage.deleteAlarm();
    });
  });
});

describe('static assets', () => {
  it('the SPA fallback: unknown paths get index.html with 200, from env.ASSETS and through the Worker', async () => {
    for (const path of ['/projects/3', '/invite', '/reset']) {
      const direct = await env.ASSETS.fetch(`${ORIGIN}${path}`);
      expect(direct.status, path).toBe(200);
      expect(await direct.text()).toContain('Lyren Plan test SPA');
      const viaWorker = await SELF.fetch(`${ORIGIN}${path}`);
      expect(viaWorker.status, path).toBe(200);
      expect(await viaWorker.text()).toContain('Lyren Plan test SPA');
      expect(viaWorker.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    }
  });

  it('/api alone is an API path, the directory’s, as on Node (Appendix D 45)', async () => {
    // SELF.fetch reaches the Worker without the asset router; scripts/test/wrangler-config.test.mjs checks that
    // run_worker_first sends /api to the Worker on Cloudflare.
    const res = await SELF.fetch(`${ORIGIN}/api`, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(NOT_SIGNED_IN);
  });
});
