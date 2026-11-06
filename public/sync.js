// Talks to the sync code API and keeps a local copy of the profile, so saved posts and source choices appear
// straight away and the site still works if the API is unreachable.
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
const API_URL = LOCAL_HOSTS.includes(location.hostname) ? 'http://localhost:4174/api' : 'https://msnews-api.vercel.app/api';
const CODE_KEY = 'msnews:syncCode';
const PROFILE_KEY = 'msnews:profile';
// Saves are batched because the free storage plan allows about 2,000 writes a month.
const SAVE_DELAY_MS = 1200;

export class SyncError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStored(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* the code still works until the page closes */ }
}

function readStoredProfile() {
  try { return JSON.parse(readStored(PROFILE_KEY)); } catch { return null; }
}

function applyLocally(profile, op) {
  if (op.type === 'bookmark.add' && !profile.bookmarks.some((item) => item.id === op.item.id)) profile.bookmarks.push(op.item);
  if (op.type === 'bookmark.remove') profile.bookmarks = profile.bookmarks.filter((item) => item.id !== op.id);
  if (op.type === 'source.hide' && !profile.hiddenSources.includes(op.id)) profile.hiddenSources.push(op.id);
  if (op.type === 'source.show') profile.hiddenSources = profile.hiddenSources.filter((id) => id !== op.id);
  if (op.type === 'source.remove') profile.customSources = profile.customSources.filter((source) => source.key !== op.key);
}

export function createSync({ onChange, onError }) {
  let code = readStored(CODE_KEY);
  let profile = code ? readStoredProfile() : null;
  let pending = [];
  let timer = null;
  let saving = false;

  async function request(path, { method = 'GET', body, keepalive = false, withCode = code } = {}) {
    let response;
    try {
      response = await fetch(`${API_URL}/${path}`, {
        method,
        keepalive,
        headers: {
          // Headers can't carry characters such as č, so the code is percent-encoded.
          ...(withCode ? { Authorization: `Bearer ${encodeURIComponent(withCode)}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('The sync service could not be reached. Check your connection and try again.');
    }
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new SyncError(data.error ?? 'Something went wrong. Try again in a moment.', response.status);
    return data;
  }

  function setProfile(next) {
    profile = next;
    writeStored(PROFILE_KEY, next ? JSON.stringify(next) : null);
  }

  function setCode(next) {
    code = next;
    writeStored(CODE_KEY, next);
  }

  function clearLocal() {
    clearTimeout(timer);
    pending = [];
    setCode(null);
    setProfile(null);
  }

  async function refresh() {
    if (!code || pending.length || saving) return;
    try {
      const data = await request('profile');
      if (pending.length || saving) return;
      setProfile(data.profile);
      onChange();
    } catch (error) {
      if (error.status === 404) {
        clearLocal();
        onChange();
        onError('This sync code no longer exists, so the site is back to the default sources.');
      }
      // Otherwise the local copy stays in use until the service is reachable again.
    }
  }

  async function flush({ keepalive = false } = {}) {
    clearTimeout(timer);
    if (saving || !pending.length || !code) return;
    const batch = pending;
    pending = [];
    saving = true;
    try {
      const data = await request('profile', { method: 'POST', body: { ops: batch }, keepalive });
      const next = data.profile;
      // Changes made while this save was running stay visible until their own save finishes.
      for (const op of pending) applyLocally(next, op);
      setProfile(next);
      onChange();
    } catch (error) {
      onError(`Your last change wasn't saved. ${error.message}`);
      saving = false;
      await refresh();
      return;
    } finally {
      saving = false;
    }
    if (pending.length) schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush({ keepalive: true });
    else refresh();
  });

  return {
    get code() { return code; },
    get profile() { return profile; },
    get connected() { return Boolean(code); },
    refresh,

    change(op) {
      if (!profile) return;
      applyLocally(profile, op);
      writeStored(PROFILE_KEY, JSON.stringify(profile));
      pending.push(op);
      schedule();
      onChange();
    },

    // With no chosen code, the server makes a random one.
    async create(chosen) {
      const data = await request('codes', { method: 'POST', withCode: null, body: chosen ? { code: chosen } : undefined });
      setCode(data.code);
      setProfile(data.profile);
      onChange();
    },

    async connect(input) {
      const data = await request('profile', { withCode: input.trim() });
      setCode(data.code);
      setProfile(data.profile);
      onChange();
    },

    async changeCode(next) {
      await flush();
      const data = await request('profile', { method: 'PUT', body: { code: next } });
      setCode(data.code);
      setProfile(data.profile);
      onChange();
    },

    // Adding checks the source on the server and may return an error, so it doesn't wait in the batch.
    async addSource(sourceType, value) {
      await flush();
      const data = await request('profile', { method: 'POST', body: { ops: [{ type: 'source.add', sourceType, value }] } });
      setProfile(data.profile);
      onChange();
    },

    async forgetDevice() {
      await flush();
      clearLocal();
      onChange();
    },

    async deleteProfile() {
      await request('profile', { method: 'DELETE' });
      clearLocal();
      onChange();
    },
  };
}
