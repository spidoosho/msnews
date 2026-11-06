// Pulls every source in sources.json and updates public/data/. One failing source never stops the run:
// its old items stay in the archive and the failure is reported in status.json.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isRelevant, mergeItems, parseReddit, parseRss, parseXTimeline, parseYouTube, topicsFor } from './lib.mjs';

const ROOT = new URL('../', import.meta.url);
const DATA_DIR = new URL('public/data/', ROOT);
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BOT_UA = 'web:msnews-aggregator:v1.0 (personal news reader)';

const FETCHERS = {
  blog: { url: (s) => s.url, parse: parseRss, userAgent: BROWSER_UA, delayMs: 0 },
  youtube: {
    url: (s) => `https://www.youtube.com/feeds/videos.xml?channel_id=${s.channelId}`,
    parse: parseYouTube,
    userAgent: BROWSER_UA,
    delayMs: 0,
  },
  // Reddit rate-limits anonymous reads hard, so each group of subreddits is one combined request.
  // Top of the week favours posts people upvoted over the help questions that dominate "new" and "hot".
  reddit: {
    url: (s) => `https://www.reddit.com/r/${s.subreddits.join('+')}/top/.rss?t=week&limit=40`,
    parse: parseReddit,
    userAgent: BOT_UA,
    delayMs: 15_000,
  },
  x: {
    url: (s) => `https://syndication.twitter.com/srv/timeline-profile/screen-name/${s.handle}`,
    parse: parseXTimeline,
    userAgent: BROWSER_UA,
    delayMs: 3_000,
    download: downloadWithCurl,
  },
};

// X answers Node's HTTP client with 429 and remaining=0 however few calls it has made, while curl gets the
// published allowance of 30 calls per 15 minutes. An hourly refresh stays far below that, and a 429 is never retried.
async function downloadWithCurl(url, userAgent) {
  const { stdout } = await promisify(execFile)(
    'curl',
    ['-sS', '-L', '--compressed', '-m', '30', '-A', userAgent, '-w', '\n%{http_code}', url],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const statusStart = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(statusStart + 1));
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return stdout.slice(0, statusStart);
}

async function download(url, userAgent) {
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt += 1) {
    let failure;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return await response.text();
      failure = new Error(`HTTP ${response.status}`);
      // Reddit sends seconds in x-ratelimit-reset. X sends an epoch time under a different name and is not waited on.
      const retryAfter = Number(response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset'));
      const canWaitOut = response.status === 429 && retryAfter > 0 && retryAfter <= 60;
      // Retrying a 4xx won't help, and repeating a rate-limited call only burns more of the quota.
      if (response.status < 500 && !canWaitOut) throw Object.assign(failure, { final: true });
      if (canWaitOut) await sleep(retryAfter * 1000);
    } catch (error) {
      failure = error;
      if (error.final) throw error;
    }
    if (attempt >= maxAttempts) throw failure;
    await sleep(5_000 * attempt);
  }
}

async function readSource(source, relevance) {
  const fetcher = FETCHERS[source.type];
  if (!fetcher) throw new Error(`Unknown source type "${source.type}"`);
  const body = await (fetcher.download ?? download)(fetcher.url(source), fetcher.userAgent);
  const parsed = fetcher.parse(body, source);
  const newest = parsed.reduce((latest, item) => (item.publishedAt > latest ? item.publishedAt : latest), '');
  const kept = parsed
    .filter((item) => !source.filter || isRelevant(item, relevance))
    .map((item) => ({ ...item, topics: topicsFor(item, source.topics) }));
  return { items: kept, fetched: parsed.length, newest: newest || null };
}

async function readExisting(url) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function main() {
  const config = JSON.parse(await readFile(new URL('sources.json', ROOT), 'utf8'));
  const relevance = new RegExp(config.relevance, 'i');
  const feedFile = new URL('feed.json', DATA_DIR);
  const existing = await readExisting(feedFile);
  const incoming = [];
  const report = [];

  // Sources of one type run in sequence to stay polite. The types themselves run side by side.
  const byType = Object.groupBy(config.sources, (source) => source.type);
  await Promise.all(Object.values(byType).map(async (group) => {
    for (const [index, source] of group.entries()) {
      if (index > 0) await sleep(FETCHERS[source.type]?.delayMs ?? 0);
      const base = { id: source.id, name: source.name, type: source.type };
      try {
        const result = await readSource(source, relevance);
        incoming.push(...result.items);
        report.push({ ...base, ok: true, fetched: result.fetched, kept: result.items.length, newest: result.newest });
        console.log(`ok   ${source.id}: ${result.items.length}/${result.fetched} kept, newest ${result.newest ?? 'n/a'}`);
      } catch (error) {
        const newest = existing.filter((item) => item.sourceId === source.id).map((item) => item.publishedAt).sort().at(-1) ?? null;
        report.push({ ...base, ok: false, error: error.message, newest });
        console.error(`FAIL ${source.id}: ${error.message}`);
      }
    }
  }));

  const items = mergeItems(existing, incoming, config.settings);
  const order = new Map(config.sources.map((source, index) => [source.id, index]));
  report.sort((a, b) => order.get(a.id) - order.get(b.id));

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(feedFile, `${JSON.stringify(items, null, 1)}\n`);
  // Changes every run, so it is deployed with the site but not committed.
  await writeFile(new URL('status.json', DATA_DIR), `${JSON.stringify({ generatedAt: new Date().toISOString(), sources: report }, null, 1)}\n`);

  const failed = report.filter((entry) => !entry.ok).length;
  console.log(`\n${items.length} items in archive, ${report.length - failed}/${report.length} sources ok`);
  if (failed === report.length) throw new Error('Every source failed');
}

await main();
