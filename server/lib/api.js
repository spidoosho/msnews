// Request handling. Storage and network access are passed in so this can run in tests and in a local dev server.
import {
  applyOps, generateCode, hashCode, LIMITS, MAX_CODE_LENGTH, MIN_CODE_LENGTH, newProfile, normalizeCode, profilePath, publicSourceList,
  renameSourceUser, sourcesChanged, updateSourceIndex,
} from './core.js';
import { InputError, resolveSource } from './sources.js';

const INDEX_PATH = 'index/custom-sources.json';
const WRITE_ATTEMPTS = 4;
const CODE_RULE = `Codes need ${MIN_CODE_LENGTH} to ${MAX_CODE_LENGTH} characters, not counting spaces and hyphens`;
const CODE_TAKEN = 'That code is already taken. Try a different one.';

export class ConflictError extends Error {}

class NotFoundError extends Error {}

async function withRetry(attempt) {
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof ConflictError) || tries >= WRITE_ATTEMPTS) throw error;
    }
  }
}

export function createApi({ storage, resolveOptions = {}, allowedOrigins = [] }) {
  function corsHeaders(request) {
    const origin = request.headers.get('origin');
    if (!origin || !allowedOrigins.includes(origin)) return { Vary: 'Origin' };
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }

  // The site percent-encodes the code, because request headers can't carry characters such as č.
  function requireCode(request) {
    const sent = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    let decoded = sent;
    try {
      decoded = decodeURIComponent(sent);
    } catch { /* not encoded, so it is used as it arrived */ }
    const code = normalizeCode(decoded);
    if (!code) throw new NotFoundError();
    return code;
  }

  async function readJsonBody(request) {
    const body = await request.text();
    if (body.length > LIMITS.bodyBytes) throw new InputError('That change is too large');
    try {
      return JSON.parse(body);
    } catch {
      throw new InputError('That change could not be read');
    }
  }

  async function saveIndexChange(hash, before, after) {
    if (!sourcesChanged(before, after)) return;
    await withRetry(async () => {
      const current = await storage.read(INDEX_PATH);
      const next = updateSourceIndex(current?.data, hash, before, after);
      await storage.write(INDEX_PATH, next, { etag: current?.etag });
    });
  }

  // Fails rather than overwrites, so choosing a code that exists can never replace someone's data.
  async function claimCode(code, profile) {
    const path = profilePath(hashCode(code));
    if (await storage.read(path)) throw new InputError(CODE_TAKEN);
    try {
      await storage.write(path, profile, {});
    } catch (error) {
      if (error instanceof ConflictError) throw new InputError(CODE_TAKEN);
      throw error;
    }
  }

  function parseChosenCode(value) {
    const code = normalizeCode(value);
    if (!code) throw new InputError(CODE_RULE);
    return code;
  }

  async function createCode(request) {
    const hasBody = request.headers.get('content-type')?.includes('json');
    const chosen = hasBody ? (await readJsonBody(request))?.code : null;
    if (await storage.count('profiles/') >= LIMITS.profiles) {
      return Response.json({ error: 'This site is not accepting new sync codes right now' }, { status: 503 });
    }
    const code = chosen ? parseChosenCode(chosen) : generateCode();
    const profile = newProfile();
    await claimCode(code, profile);
    return Response.json({ code, profile }, { status: 201 });
  }

  async function changeCode(request, oldCode) {
    const code = parseChosenCode((await readJsonBody(request))?.code);
    const oldHash = hashCode(oldCode);
    const stored = await readProfile(oldHash);
    if (code === oldCode) return Response.json({ code, profile: stored.data });
    await claimCode(code, stored.data);
    if (stored.data.customSources.length) {
      await withRetry(async () => {
        const current = await storage.read(INDEX_PATH);
        await storage.write(INDEX_PATH, renameSourceUser(current?.data, oldHash, hashCode(code)), { etag: current?.etag });
      });
    }
    await storage.remove(profilePath(oldHash));
    return Response.json({ code, profile: stored.data });
  }

  async function readProfile(hash) {
    const stored = await storage.read(profilePath(hash));
    if (!stored) throw new NotFoundError();
    return stored;
  }

  // Adding a source needs the network, so it happens once, before the read-change-write loop that may repeat.
  async function resolveOps(ops) {
    return Promise.all(ops.map(async (op) => (op?.type === 'source.add'
      ? { type: 'source.add', source: await resolveSource(op.sourceType, op.value, resolveOptions) }
      : op)));
  }

  async function changeProfile(request, hash) {
    const body = await readJsonBody(request);
    const ops = Array.isArray(body?.ops) ? body.ops : null;
    if (!ops || !ops.length || ops.length > LIMITS.opsPerRequest) throw new InputError('That change could not be read');
    await readProfile(hash);
    const resolved = await resolveOps(ops);
    const profile = await withRetry(async () => {
      const stored = await readProfile(hash);
      const next = applyOps(stored.data, resolved);
      await saveIndexChange(hash, stored.data, next);
      await storage.write(profilePath(hash), next, { etag: stored.etag });
      return next;
    });
    return Response.json({ profile });
  }

  async function deleteProfile(hash) {
    const stored = await readProfile(hash);
    await saveIndexChange(hash, stored.data, { customSources: [] });
    await storage.remove(profilePath(hash));
    return new Response(null, { status: 204 });
  }

  async function route(request, name) {
    const { method } = request;
    if (name === 'codes' && method === 'POST') return createCode(request);
    if (name === 'custom-sources' && method === 'GET') {
      const index = await storage.read(INDEX_PATH);
      return Response.json({ sources: publicSourceList(index?.data) }, { headers: { 'Cache-Control': 'public, s-maxage=60' } });
    }
    if (name === 'profile') {
      const code = requireCode(request);
      if (method === 'GET') return Response.json({ code, profile: (await readProfile(hashCode(code))).data });
      if (method === 'POST') return changeProfile(request, hashCode(code));
      if (method === 'PUT') return changeCode(request, code);
      if (method === 'DELETE') return deleteProfile(hashCode(code));
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  async function handle(request, name) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      response = await route(request, name);
    } catch (error) {
      if (error instanceof InputError) response = Response.json({ error: error.message }, { status: 400 });
      else if (error instanceof NotFoundError) response = Response.json({ error: 'That sync code was not found' }, { status: 404 });
      else {
        // Requests carry sync codes in a header, so only the error itself is logged.
        console.error(`${name} failed:`, error?.message);
        response = Response.json({ error: 'Something went wrong. Try again in a moment.' }, { status: 500 });
      }
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }

  return { handle };
}

// Behaves like the real store, including failed conditional writes. Used by tests and the local dev server.
export function createMemoryStorage() {
  const blobs = new Map();
  let version = 0;
  return {
    blobs,
    async read(path) {
      const blob = blobs.get(path);
      return blob ? { data: structuredClone(blob.data), etag: blob.etag } : null;
    },
    async write(path, data, { etag }) {
      const existing = blobs.get(path);
      if (etag ? existing?.etag !== etag : existing) throw new ConflictError();
      version += 1;
      blobs.set(path, { data: structuredClone(data), etag: `v${version}` });
    },
    async remove(path) {
      blobs.delete(path);
    },
    async count(prefix) {
      return [...blobs.keys()].filter((path) => path.startsWith(prefix)).length;
    },
  };
}
