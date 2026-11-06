// Sync codes and profile changes. Pure logic with no storage or network access.
import { createHash, randomBytes } from 'node:crypto';
import { InputError } from './sources.js';

export const LIMITS = {
  bookmarks: 500,
  hiddenSources: 100,
  customSources: 10,
  // Every added source costs requests on each hourly run, and X and Reddit allow very few.
  globalCustomSources: 40,
  profiles: 100,
  opsPerRequest: 50,
  bodyBytes: 64 * 1024,
};

// Leaves out l, o, 0 and 1, which are easy to misread. Exactly 32 characters keep the random pick unbiased.
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const CODE_LENGTH = 20;
export const MIN_CODE_LENGTH = 4;
export const MAX_CODE_LENGTH = 64;
const ITEM_TYPES = new Set(['blog', 'youtube', 'x', 'reddit']);
const TEXT_LIMITS = { id: 300, source: 80, title: 400, text: 1200 };

const formatCode = (raw) => raw.match(/.{5}/g).join('-');

export function generateCode() {
  const bytes = randomBytes(CODE_LENGTH);
  return formatCode(Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join(''));
}

// Case, spaces and hyphens don't matter, so a code still works when retyped from memory.
export function normalizeCode(input) {
  const raw = String(input ?? '').normalize('NFC').toLowerCase().replace(/[\s-]/g, '');
  const length = [...raw].length;
  if (length < MIN_CODE_LENGTH || length > MAX_CODE_LENGTH || /\p{C}/u.test(raw)) return null;
  // Generated codes keep their grouped form, so codes created before custom ones were allowed still match.
  if (length === CODE_LENGTH && [...raw].every((char) => CODE_ALPHABET.includes(char))) return formatCode(raw);
  return raw;
}

// Only the hash is stored, so reading the store does not reveal anyone's code.
export function hashCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

export const profilePath = (hash) => `profiles/${hash}.json`;

export function newProfile(now = new Date()) {
  const timestamp = now.toISOString();
  return { version: 1, createdAt: timestamp, updatedAt: timestamp, bookmarks: [], hiddenSources: [], customSources: [] };
}

const webUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
};

const limitedText = (value, field) => (typeof value === 'string' ? value.slice(0, TEXT_LIMITS[field]) : '');

// A copy is stored so saved posts stay readable after the public archive drops them.
export function sanitizeBookmark(item) {
  const url = webUrl(item?.url);
  const published = new Date(item?.publishedAt);
  if (!item?.id || typeof item.id !== 'string' || item.id.length > TEXT_LIMITS.id) throw new InputError('That post could not be saved');
  if (!url || !ITEM_TYPES.has(item.type) || Number.isNaN(published.getTime())) throw new InputError('That post could not be saved');
  return {
    id: item.id,
    type: item.type,
    sourceId: limitedText(item.sourceId, 'id'),
    source: limitedText(item.source, 'source'),
    title: item.title ? limitedText(item.title, 'title') : null,
    text: limitedText(item.text, 'text'),
    url,
    image: webUrl(item.image),
    publishedAt: published.toISOString(),
    topics: Array.isArray(item.topics) ? item.topics.filter((topic) => typeof topic === 'string').slice(0, 20).map((topic) => topic.slice(0, 40)) : [],
  };
}

function applyOp(profile, op) {
  switch (op?.type) {
    case 'bookmark.add':
      if (profile.bookmarks.some((item) => item.id === op.item?.id)) return;
      if (profile.bookmarks.length >= LIMITS.bookmarks) throw new InputError(`You can save up to ${LIMITS.bookmarks} posts`);
      profile.bookmarks.push(sanitizeBookmark(op.item));
      return;
    case 'bookmark.remove':
      profile.bookmarks = profile.bookmarks.filter((item) => item.id !== op.id);
      return;
    case 'source.hide':
      if (typeof op.id !== 'string' || op.id.length > 80) throw new InputError('Unknown source');
      if (profile.hiddenSources.includes(op.id)) return;
      if (profile.hiddenSources.length >= LIMITS.hiddenSources) throw new InputError('Too many hidden sources');
      profile.hiddenSources.push(op.id);
      return;
    case 'source.show':
      profile.hiddenSources = profile.hiddenSources.filter((id) => id !== op.id);
      return;
    case 'source.add':
      if (profile.customSources.some((source) => source.key === op.source.key)) throw new InputError('You already added that source');
      if (profile.customSources.length >= LIMITS.customSources) throw new InputError(`You can add up to ${LIMITS.customSources} sources`);
      profile.customSources.push(op.source);
      return;
    case 'source.remove':
      profile.customSources = profile.customSources.filter((source) => source.key !== op.key);
      return;
    default:
      throw new InputError('Unknown change');
  }
}

export function applyOps(profile, ops, now = new Date()) {
  const next = structuredClone(profile);
  for (const op of ops) applyOp(next, op);
  next.updatedAt = now.toISOString();
  return next;
}

const sourceKeys = (profile) => new Set((profile?.customSources ?? []).map((source) => source.key));

export function sourcesChanged(before, after) {
  const a = sourceKeys(before);
  const b = sourceKeys(after);
  return a.size !== b.size || [...a].some((key) => !b.has(key));
}

// Records who uses each added source, so one person removing it doesn't affect another and unused ones stop being fetched.
export function updateSourceIndex(index, hash, before, after) {
  const next = { sources: { ...(index?.sources ?? {}) } };
  const previous = sourceKeys(before);
  const current = sourceKeys(after);
  for (const key of previous) {
    if (current.has(key) || !next.sources[key]) continue;
    const users = next.sources[key].users.filter((user) => user !== hash);
    if (users.length) next.sources[key] = { ...next.sources[key], users };
    else delete next.sources[key];
  }
  for (const source of after?.customSources ?? []) {
    if (previous.has(source.key)) continue;
    const entry = next.sources[source.key];
    if (!entry && Object.keys(next.sources).length >= LIMITS.globalCustomSources) {
      throw new InputError('This site has reached its limit for added sources');
    }
    next.sources[source.key] = { source: entry?.source ?? source, users: [...new Set([...(entry?.users ?? []), hash])] };
  }
  return next;
}

export function renameSourceUser(index, oldHash, newHash) {
  const sources = Object.fromEntries(Object.entries(index?.sources ?? {}).map(([key, entry]) => [
    key,
    { ...entry, users: entry.users.map((user) => (user === oldHash ? newHash : user)) },
  ]));
  return { sources };
}

export const publicSourceList = (index) => Object.values(index?.sources ?? {}).map((entry) => entry.source);
