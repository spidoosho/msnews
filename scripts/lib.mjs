// Pure parsing and merging helpers. No network or disk access, so they can be tested directly.
import { XMLParser } from 'fast-xml-parser';

const EXCERPT_LENGTH = 280;

const TOPIC_RULES = [
  ['Copilot', /copilot/i],
  ['Copilot Chat', /copilot chat/i],
  ['Copilot Studio', /copilot studio/i],
  ['Cowork', /\bco-?work\b/i],
  ['Agents', /\bagents?\b|\bagent 365\b/i],
  ['Teams', /\bTeams\b/],
  ['SharePoint', /sharepoint/i],
  ['Outlook', /\boutlook\b/i],
  ['Excel', /\bExcel\b/],
  ['Word', /\bWord\b/],
  ['PowerPoint', /powerpoint/i],
  ['OneDrive', /onedrive/i],
  ['Power Platform', /power platform|power automate|power apps/i],
  ['Security & Admin', /\bpurview\b|\bentra\b|\bdefender\b|admin center/i],
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  // Default entity-expansion limits trip on the large Tech Community feeds.
  entityExpansionLimit: 1_000_000,
});

const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

const text = (node) => {
  if (node == null) return '';
  if (typeof node === 'object') return text(node['#text']);
  return String(node);
};

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] !== '#') return NAMED_ENTITIES[code.toLowerCase()] ?? match;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

export function stripHtml(html) {
  const noBlocks = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  return decodeEntities(noBlocks.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function excerpt(value, length = EXCERPT_LENGTH) {
  if (value.length <= length) return value;
  const cut = value.slice(0, length);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > length * 0.6 ? lastSpace : length).trimEnd()}…`;
}

export function safeUrl(value) {
  try {
    const url = new URL(decodeEntities(String(value)).trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

// Removes tracking noise so the same article found through two feeds has one id.
export function canonicalUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.hostname = url.hostname.toLowerCase();
  return url.href.replace(/\/$/, '');
}

function firstImage(html) {
  const match = /<img\b[^>]*?\bsrc=["']([^"']+)["']/i.exec(String(html));
  return match ? safeUrl(match[1]) : null;
}

const toIso = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export function parseRss(xml, source) {
  const channel = parser.parse(xml)?.rss?.channel;
  if (!channel) throw new Error('Response is not an RSS feed');
  return asArray(channel.item).flatMap((item) => {
    const url = safeUrl(text(item.link));
    const publishedAt = toIso(text(item.pubDate));
    if (!url || !publishedAt) return [];
    const body = text(item['content:encoded']) || text(item.description);
    const summary = text(item.description) || body;
    return [{
      id: `blog:${canonicalUrl(url)}`,
      type: 'blog',
      sourceId: source.id,
      source: source.name,
      title: stripHtml(text(item.title)),
      text: excerpt(stripHtml(summary)),
      url,
      image: firstImage(body),
      publishedAt,
    }];
  });
}

function parseAtom(feed, source) {
  return asArray(feed.entry).flatMap((entry) => {
    const links = asArray(entry.link);
    const link = links.find((candidate) => !candidate['@rel'] || candidate['@rel'] === 'alternate') ?? links[0];
    const url = safeUrl(link?.['@href']);
    const publishedAt = toIso(text(entry.published) || text(entry.updated));
    if (!url || !publishedAt) return [];
    const body = text(entry.content) || text(entry.summary);
    return [{
      id: `blog:${canonicalUrl(url)}`,
      type: 'blog',
      sourceId: source.id,
      source: source.name,
      title: stripHtml(text(entry.title)),
      text: excerpt(stripHtml(text(entry.summary) || body)),
      url,
      image: firstImage(body),
      publishedAt,
    }];
  });
}

// Feeds people add themselves can be either format.
export function parseFeed(xml, source) {
  const parsed = parser.parse(xml);
  if (parsed?.feed) return parseAtom(parsed.feed, source);
  return parseRss(xml, source);
}

export function parseYouTube(xml, source) {
  const feed = parser.parse(xml)?.feed;
  if (!feed) throw new Error('Response is not a YouTube feed');
  return asArray(feed.entry).flatMap((entry) => {
    const videoId = text(entry['yt:videoId']);
    const publishedAt = toIso(text(entry.published));
    if (!videoId || !publishedAt) return [];
    return [{
      id: `youtube:${videoId}`,
      type: 'youtube',
      sourceId: source.id,
      source: source.name,
      title: stripHtml(text(entry.title)),
      text: excerpt(stripHtml(text(entry['media:group']?.['media:description']))),
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      image: `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`,
      publishedAt,
    }];
  });
}

export function parseReddit(xml, source) {
  const feed = parser.parse(xml)?.feed;
  if (!feed) throw new Error('Response is not a Reddit feed');
  return asArray(feed.entry).flatMap((entry) => {
    const url = safeUrl(asArray(entry.link)[0]?.['@href']);
    const publishedAt = toIso(text(entry.published) || text(entry.updated));
    if (!url || !publishedAt) return [];
    const html = text(entry.content);
    // Reddit appends its own "submitted by /u/x [link] [comments]" footer to every post.
    const body = stripHtml(html).replace(/\s*submitted by\s+\/u\/\S+.*$/i, '').trim();
    const subreddit = asArray(entry.category)[0]?.['@term'];
    const thumbnail = safeUrl(entry['media:thumbnail']?.['@url']);
    return [{
      id: `reddit:${text(entry.id) || canonicalUrl(url)}`,
      type: 'reddit',
      sourceId: source.id,
      source: subreddit ? `r/${subreddit}` : source.name,
      title: stripHtml(text(entry.title)),
      text: excerpt(body),
      url,
      image: thumbnail,
      publishedAt,
    }];
  });
}

function tweetText(tweet) {
  let value = tweet.full_text ?? tweet.text ?? '';
  for (const link of tweet.entities?.urls ?? []) {
    if (link.url) value = value.replaceAll(link.url, link.display_url ?? link.expanded_url ?? '');
  }
  // Media links point back at the tweet itself, and the image is shown separately.
  for (const media of tweet.entities?.media ?? []) {
    if (media.url) value = value.replaceAll(media.url, '');
  }
  return decodeEntities(value).trim();
}

export function parseXTimeline(html, source) {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error('X page has no timeline data');
  const entries = JSON.parse(match[1])?.props?.pageProps?.timeline?.entries ?? [];
  return entries.flatMap((entry) => {
    const tweet = entry?.type === 'tweet' ? entry.content?.tweet : null;
    if (!tweet?.id_str || tweet.in_reply_to_status_id_str) return [];
    const publishedAt = toIso(tweet.created_at);
    if (!publishedAt) return [];
    const original = tweet.retweeted_status;
    const shown = original ?? tweet;
    const author = shown.user?.screen_name ?? source.handle;
    const media = shown.extended_entities?.media?.[0] ?? shown.entities?.media?.[0];
    return [{
      // A repost shares the original's id, so one post seen from two accounts appears once.
      id: `x:${shown.id_str ?? tweet.id_str}`,
      type: 'x',
      sourceId: source.id,
      source: source.name,
      title: null,
      text: original ? `Reposted @${author}: ${tweetText(original)}` : tweetText(tweet),
      url: `https://x.com/${encodeURIComponent(author)}/status/${shown.id_str ?? tweet.id_str}`,
      image: safeUrl(media?.media_url_https),
      publishedAt,
    }];
  });
}

const searchable = (item) => `${item.title ?? ''} ${item.text ?? ''}`;

// "GitHub Copilot" is a different product and should not count as a Microsoft 365 Copilot mention.
const withoutGitHub = (value) => value.replace(/github copilot/gi, '');

export function isRelevant(item, pattern) {
  return pattern.test(withoutGitHub(searchable(item)));
}

export function topicsFor(item, sourceTopics = []) {
  const value = withoutGitHub(searchable(item));
  const topics = new Set(sourceTopics);
  for (const [topic, rule] of TOPIC_RULES) if (rule.test(value)) topics.add(topic);
  return TOPIC_RULES.map(([topic]) => topic).filter((topic) => topics.has(topic));
}

// Keeps the archive growing past what each feed currently exposes, newest first.
export function mergeItems(existing, incoming, { maxAgeDays, maxItems, now = new Date() }) {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = byId.get(item.id);
    // First source wins so items don't flip between feeds that carry the same article.
    byId.set(item.id, previous ? { ...item, sourceId: previous.sourceId, source: previous.source } : item);
  }
  return [...byId.values()]
    .filter((item) => new Date(item.publishedAt).getTime() >= cutoff)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.id.localeCompare(b.id))
    .slice(0, maxItems);
}
