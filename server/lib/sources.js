// Turns what a person typed into a source the hourly job can fetch. Shared by the API and scripts/fetch.mjs,
// because everything here starts as untrusted input and the job checks it again before using it.
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_REDIRECTS = 3;
const MAX_NAME_LENGTH = 80;
export const MAX_FEED_BYTES = 5 * 1024 * 1024;

const X_INPUT = /^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?@?([A-Za-z0-9_]{1,15})\/?$/;
const REDDIT_INPUT = /^(?:https?:\/\/(?:www\.|old\.)?reddit\.com)?\/?(?:r\/)?([A-Za-z0-9_]{2,21})\/?$/;
const YOUTUBE_ID = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_ID_INPUT = /(?:^|\/channel\/)(UC[A-Za-z0-9_-]{22})(?:[/?]|$)/;
const YOUTUBE_HANDLE_INPUT = /^(?:https?:\/\/(?:www\.|m\.)?youtube\.com\/)?@?([A-Za-z0-9._-]{3,30})\/?$/;

// Messages on this error are written for the person using the site.
export class InputError extends Error {}

const clean = (value) => String(value ?? '').trim();

function xSource(handle) {
  return { key: `x-${handle.toLowerCase()}`, type: 'x', name: `@${handle}`, handle };
}

function redditSource(subreddit) {
  return { key: `reddit-${subreddit.toLowerCase()}`, type: 'reddit', name: `r/${subreddit}`, subreddit };
}

function youtubeSource(channelId, name) {
  return { key: `youtube-${channelId}`, type: 'youtube', name: name || channelId, channelId };
}

function blogSource(url, name) {
  const key = `blog-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
  return { key, type: 'blog', name: name || new URL(url).hostname, url };
}

function parseBlogUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError('Enter the full address of an RSS or Atom feed, starting with https://');
  }
  if (url.protocol !== 'https:') throw new InputError('Feed addresses must start with https://');
  return url.href;
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7));
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

// Feed addresses come from visitors, so they must not be able to point this code at internal services.
export async function assertPublicUrl(value, lookupImpl = lookup) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:') throw new InputError('Feed addresses must start with https://');
  if (url.username || url.password) throw new InputError('Feed addresses cannot contain a user name or password');
  if (isIP(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new InputError('That address is not a public website');
  }
  let addresses;
  try {
    addresses = await lookupImpl(hostname, { all: true });
  } catch {
    throw new InputError('That website could not be found');
  }
  if (addresses.some(({ address }) => isPrivateAddress(address))) throw new InputError('That address is not a public website');
}

async function readLimited(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Response is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Follows redirects one hop at a time so every destination gets the same public-address check.
export async function guardedFetchText(startUrl, { fetchImpl = fetch, lookupImpl = lookup, maxBytes = MAX_FEED_BYTES } = {}) {
  let url = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(url, lookupImpl);
    const response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url).href;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return readLimited(response, maxBytes);
  }
  throw new Error('Too many redirects');
}

function feedTitle(xml) {
  const match = /<title[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i.exec(xml);
  if (!match) return '';
  return match[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

// Checks the shape of the input only. Anything needing the network happens in resolveSource.
export function parseSourceInput(type, value) {
  const input = clean(value);
  if (!input) throw new InputError('Enter a source to add');
  if (type === 'x') {
    const match = X_INPUT.exec(input);
    if (!match) throw new InputError('Enter an X handle such as @MSFTCopilot');
    return xSource(match[1]);
  }
  if (type === 'reddit') {
    const match = REDDIT_INPUT.exec(input);
    if (!match) throw new InputError('Enter a subreddit such as r/microsoft365');
    return redditSource(match[1]);
  }
  if (type === 'youtube') {
    const id = YOUTUBE_ID_INPUT.exec(input);
    if (id) return youtubeSource(id[1]);
    const handle = YOUTUBE_HANDLE_INPUT.exec(input);
    if (handle) return { type: 'youtube', youtubeHandle: handle[1] };
    throw new InputError('Enter a YouTube channel address or handle such as @MSFTMechanics');
  }
  if (type === 'blog') return blogSource(parseBlogUrl(input));
  throw new InputError('Choose a source type');
}

// X and Reddit are not checked here because both limit or block cloud servers. The hourly job reports failures.
export async function resolveSource(type, value, options = {}) {
  const parsed = parseSourceInput(type, value);
  if (parsed.type === 'youtube') {
    let { channelId } = parsed;
    if (parsed.youtubeHandle) {
      const page = await guardedFetchText(`https://www.youtube.com/@${parsed.youtubeHandle}`, options).catch(() => '');
      channelId = /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})"/.exec(page)?.[1];
      if (!channelId) throw new InputError('That YouTube channel could not be found. Try pasting its channel address instead.');
    }
    const feed = await guardedFetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, options).catch(() => '');
    if (!feed) throw new InputError('That YouTube channel could not be read');
    return youtubeSource(channelId, feedTitle(feed));
  }
  if (parsed.type === 'blog') {
    let feed;
    try {
      feed = await guardedFetchText(parsed.url, options);
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError('That feed could not be read');
    }
    if (!/<(rss|feed)[\s>]/i.test(feed.slice(0, 4096))) throw new InputError("That address isn't an RSS or Atom feed");
    return blogSource(parsed.url, feedTitle(feed));
  }
  return parsed;
}

// Rebuilds a stored source from its identifying field, discarding anything else it carries.
export function validateStoredSource(entry) {
  const name = clean(entry?.name).slice(0, MAX_NAME_LENGTH);
  if (entry?.type === 'x' && /^[A-Za-z0-9_]{1,15}$/.test(entry.handle ?? '')) return xSource(entry.handle);
  if (entry?.type === 'reddit' && /^[A-Za-z0-9_]{2,21}$/.test(entry.subreddit ?? '')) return redditSource(entry.subreddit);
  if (entry?.type === 'youtube' && YOUTUBE_ID.test(entry.channelId ?? '')) return youtubeSource(entry.channelId, name);
  if (entry?.type === 'blog') {
    try {
      return blogSource(parseBlogUrl(entry.url), name);
    } catch {
      return null;
    }
  }
  return null;
}
