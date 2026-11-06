import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, createApi, createMemoryStorage } from './api.js';
import { generateCode, hashCode, LIMITS, normalizeCode, profilePath } from './core.js';
import { assertPublicUrl, guardedFetchText, parseSourceInput, validateStoredSource } from './sources.js';

const ORIGIN = 'https://spidoosho.github.io';
const post = { id: 'x:1', type: 'x', sourceId: 's', source: '@a', title: null, text: 'hello', url: 'https://x.com/a/status/1', image: null, publishedAt: '2026-11-06T10:00:00.000Z', topics: ['Copilot'] };

function setup() {
  const storage = createMemoryStorage();
  const api = createApi({ storage, allowedOrigins: [ORIGIN] });
  const call = (name, method, { code, body, origin } = {}) => api.handle(new Request(`https://api.test/${name}`, {
    method,
    headers: { ...(code ? { Authorization: `Bearer ${code}` } : {}), ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), name);
  const create = async () => (await (await call('codes', 'POST')).json()).code;
  const change = (code, ...ops) => call('profile', 'POST', { code, body: { ops } });
  return { storage, api, call, create, change };
}

test('generated codes are readable, unique and accepted when retyped loosely', () => {
  const code = generateCode();
  assert.match(code, /^[a-hjkmnp-z2-9i]{5}(-[a-hjkmnp-z2-9i]{5}){3}$/);
  assert.notEqual(code, generateCode());
  assert.equal(normalizeCode(` ${code.toUpperCase().replaceAll('-', ' ')} `), code);
  assert.equal(normalizeCode('too-short'), null);
});

test('a new code works, and the code itself is never stored', async () => {
  const { storage, call, create } = setup();
  const code = await create();
  const response = await call('profile', 'GET', { code });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).profile.bookmarks, []);
  assert.ok(storage.blobs.has(profilePath(hashCode(code))));
  assert.ok(![...storage.blobs.keys(), JSON.stringify([...storage.blobs.values()])].join().includes(code));
});

test('unknown and malformed codes are refused the same way', async () => {
  const { call } = setup();
  assert.equal((await call('profile', 'GET', { code: generateCode() })).status, 404);
  assert.equal((await call('profile', 'GET', { code: 'nonsense' })).status, 404);
  assert.equal((await call('profile', 'GET')).status, 404);
});

test('two codes keep separate data', async () => {
  const { call, create, change } = setup();
  const [a, b] = [await create(), await create()];
  await change(a, { type: 'bookmark.add', item: post });
  assert.equal((await (await call('profile', 'GET', { code: a })).json()).profile.bookmarks.length, 1);
  assert.equal((await (await call('profile', 'GET', { code: b })).json()).profile.bookmarks.length, 0);
});

test('bookmarks can be added once and removed', async () => {
  const { create, change } = setup();
  const code = await create();
  await change(code, { type: 'bookmark.add', item: post });
  const twice = await (await change(code, { type: 'bookmark.add', item: post })).json();
  assert.equal(twice.profile.bookmarks.length, 1);
  const removed = await (await change(code, { type: 'bookmark.remove', id: post.id })).json();
  assert.equal(removed.profile.bookmarks.length, 0);
});

test('bookmarks with unsafe links are rejected', async () => {
  const { create, change } = setup();
  const code = await create();
  const response = await change(code, { type: 'bookmark.add', item: { ...post, url: 'javascript:alert(1)' } });
  assert.equal(response.status, 400);
});

test('sources can be hidden and shown again', async () => {
  const { create, change } = setup();
  const code = await create();
  assert.deepEqual((await (await change(code, { type: 'source.hide', id: 'x-teams' })).json()).profile.hiddenSources, ['x-teams']);
  assert.deepEqual((await (await change(code, { type: 'source.show', id: 'x-teams' })).json()).profile.hiddenSources, []);
});

test('added sources are shared with the fetch job only while someone uses them', async () => {
  const { call, create, change } = setup();
  const [a, b] = [await create(), await create()];
  const list = async () => (await (await call('custom-sources', 'GET')).json()).sources.map((source) => source.key);
  await change(a, { type: 'source.add', sourceType: 'x', value: '@SomeOne' });
  await change(b, { type: 'source.add', sourceType: 'x', value: 'someone' });
  assert.deepEqual(await list(), ['x-someone']);
  await change(a, { type: 'source.remove', key: 'x-someone' });
  assert.deepEqual(await list(), ['x-someone']);
  await change(b, { type: 'source.remove', key: 'x-someone' });
  assert.deepEqual(await list(), []);
});

test('the public source list reveals nothing about who added what', async () => {
  const { call, create, change } = setup();
  const code = await create();
  await change(code, { type: 'source.add', sourceType: 'reddit', value: 'r/sharepoint' });
  const text = await (await call('custom-sources', 'GET')).text();
  assert.ok(!text.includes(hashCode(code)));
  assert.ok(!text.includes('users'));
});

test('deleting a profile removes it and its sources', async () => {
  const { call, create, change } = setup();
  const code = await create();
  await change(code, { type: 'source.add', sourceType: 'x', value: 'someone' });
  assert.equal((await call('profile', 'DELETE', { code })).status, 204);
  assert.equal((await call('profile', 'GET', { code })).status, 404);
  assert.deepEqual((await (await call('custom-sources', 'GET')).json()).sources, []);
});

test('per-person and site-wide source limits are enforced', async () => {
  const { create, change } = setup();
  const code = await create();
  for (let index = 0; index < LIMITS.customSources; index += 1) {
    assert.equal((await change(code, { type: 'source.add', sourceType: 'x', value: `user${index}` })).status, 200);
  }
  const over = await change(code, { type: 'source.add', sourceType: 'x', value: 'onemore' });
  assert.equal(over.status, 400);
  assert.match((await over.json()).error, /up to 10/);

  let added = LIMITS.customSources;
  while (added < LIMITS.globalCustomSources) {
    const other = await create();
    for (let index = 0; index < LIMITS.customSources && added < LIMITS.globalCustomSources; index += 1, added += 1) {
      await change(other, { type: 'source.add', sourceType: 'x', value: `extra${added}` });
    }
  }
  const late = await change(await create(), { type: 'source.add', sourceType: 'x', value: 'toomany' });
  assert.match((await late.json()).error, /limit for added sources/);
});

test('new codes stop at the site limit', async () => {
  const { storage, call } = setup();
  for (let index = 0; index < LIMITS.profiles; index += 1) await storage.write(`profiles/${index}.json`, {}, {});
  assert.equal((await call('codes', 'POST')).status, 503);
});

test('a write that loses a race is retried against the latest data', async () => {
  const { storage, api, create, change } = setup();
  const code = await create();
  await change(code, { type: 'source.hide', id: 'first' });
  const realWrite = storage.write;
  let interfered = false;
  storage.write = async (path, data, options) => {
    if (!interfered) {
      interfered = true;
      const stored = await storage.read(path);
      await realWrite(path, { ...stored.data, hiddenSources: [...stored.data.hiddenSources, 'other-device'] }, { etag: stored.etag });
      throw new ConflictError();
    }
    return realWrite(path, data, options);
  };
  const response = await api.handle(new Request('https://api.test/profile', {
    method: 'POST',
    headers: { Authorization: `Bearer ${code}` },
    body: JSON.stringify({ ops: [{ type: 'source.hide', id: 'second' }] }),
  }), 'profile');
  assert.deepEqual((await response.json()).profile.hiddenSources, ['first', 'other-device', 'second']);
});

test('only the site itself gets cross-origin access', async () => {
  const { call } = setup();
  const allowed = await call('custom-sources', 'OPTIONS', { origin: ORIGIN });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
  const denied = await call('custom-sources', 'GET', { origin: 'https://evil.example' });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('source input accepts the forms people paste', () => {
  assert.equal(parseSourceInput('x', 'https://x.com/MSFTCopilot/').handle, 'MSFTCopilot');
  assert.equal(parseSourceInput('x', '@MSFTCopilot').key, 'x-msftcopilot');
  assert.equal(parseSourceInput('reddit', 'https://www.reddit.com/r/Office365/').subreddit, 'Office365');
  assert.equal(parseSourceInput('reddit', 'r/Office365').name, 'r/Office365');
  assert.equal(parseSourceInput('youtube', 'https://www.youtube.com/channel/UCJ9905MRHxwLZ2jeNQGIWxA').channelId, 'UCJ9905MRHxwLZ2jeNQGIWxA');
  assert.equal(parseSourceInput('youtube', 'https://www.youtube.com/@MSFTMechanics').youtubeHandle, 'MSFTMechanics');
  assert.throws(() => parseSourceInput('x', 'not a handle!'), /X handle/);
  assert.throws(() => parseSourceInput('blog', 'http://example.com/feed'), /https/);
  assert.throws(() => parseSourceInput('other', 'x'), /source type/);
});

const publicDns = async () => [{ address: '93.184.216.34' }];

test('feed addresses cannot reach private networks', async () => {
  for (const url of ['https://localhost/feed', 'https://127.0.0.1/feed', 'https://[::1]/feed', 'https://169.254.169.254/latest', 'https://printer.local/feed']) {
    await assert.rejects(assertPublicUrl(url, publicDns), /not a public website/);
  }
  const rebinding = async () => [{ address: '10.0.0.5' }];
  await assert.rejects(assertPublicUrl('https://sneaky.example/feed', rebinding), /not a public website/);
  await assert.rejects(assertPublicUrl('https://user:pw@example.com/feed', publicDns), /user name/);
  await assert.doesNotReject(assertPublicUrl('https://example.com/feed', publicDns));
});

test('redirects to private addresses are refused', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } });
  await assert.rejects(guardedFetchText('https://example.com/feed', { fetchImpl, lookupImpl: publicDns }), /not a public website/);
});

test('oversized responses are refused', async () => {
  const fetchImpl = async () => new Response('x'.repeat(100));
  await assert.rejects(guardedFetchText('https://example.com/feed', { fetchImpl, lookupImpl: publicDns, maxBytes: 10 }), /too large/);
});

test('stored sources are rebuilt from their identifying field only', () => {
  const source = validateStoredSource({ type: 'x', handle: 'abc', name: 'ignored', extra: 'dropped' });
  assert.deepEqual(source, { key: 'x-abc', type: 'x', name: '@abc', handle: 'abc' });
  assert.equal(validateStoredSource({ type: 'x', handle: '../../etc' }), null);
  assert.equal(validateStoredSource({ type: 'blog', url: 'file:///etc/passwd' }), null);
  assert.equal(validateStoredSource({ type: 'unknown' }), null);
});
