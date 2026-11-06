import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalUrl, excerpt, isRelevant, mergeItems, parseFeed, parseReddit, parseRss, parseXTimeline, parseYouTube, safeUrl, stripHtml, topicsFor } from './lib.mjs';

const source = { id: 's', name: 'Source', handle: 'acct' };

test('stripHtml removes tags and decodes entities', () => {
  assert.equal(stripHtml('<p>Copilot &amp; Teams</p><script>bad()</script> &#8217;ok'), 'Copilot & Teams ’ok');
});

test('excerpt cuts on a word boundary', () => {
  assert.equal(excerpt('alpha beta gamma', 12), 'alpha beta…');
  assert.equal(excerpt('short', 12), 'short');
});

test('safeUrl rejects non-web schemes', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('not a url'), null);
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
});

test('canonicalUrl drops tracking parameters and trailing slash', () => {
  assert.equal(canonicalUrl('https://Example.com/post/?utm_source=rss#top'), 'https://example.com/post');
});

test('parseRss reads items and skips undated ones', () => {
  const xml = `<rss><channel>
    <item><title>Hello &amp; welcome</title><link>https://example.com/a/?x=1</link><pubDate>Fri, 06 Nov 2026 12:00:00 GMT</pubDate>
      <description><![CDATA[<p>Body <img src="https://example.com/i.png"> text</p>]]></description></item>
    <item><title>No date</title><link>https://example.com/b</link></item>
  </channel></rss>`;
  const items = parseRss(xml, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'blog:https://example.com/a');
  assert.equal(items[0].title, 'Hello & welcome');
  assert.equal(items[0].text, 'Body text');
  assert.equal(items[0].image, 'https://example.com/i.png');
});

test('parseRss rejects a non-feed response', () => {
  assert.throws(() => parseRss('<html><body>Blocked</body></html>', source), /not an RSS feed/);
});

test('parseFeed reads both Atom and RSS', () => {
  const atom = `<feed><entry><title>Atom post</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/post"/>
    <updated>2026-11-06T10:00:00Z</updated><summary>Short summary</summary></entry></feed>`;
  const [entry] = parseFeed(atom, source);
  assert.equal(entry.url, 'https://example.com/post');
  assert.equal(entry.text, 'Short summary');
  const rss = '<rss><channel><item><title>RSS post</title><link>https://example.com/r</link><pubDate>Fri, 06 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>';
  assert.equal(parseFeed(rss, source)[0].title, 'RSS post');
  assert.throws(() => parseFeed('<html></html>', source), /not an RSS feed/);
});

test('parseYouTube builds watch links and thumbnails', () => {
  const xml = `<feed xmlns:yt="y" xmlns:media="m"><entry><yt:videoId>abc</yt:videoId><title>Demo</title>
    <published>2026-11-06T10:00:00+00:00</published><media:group><media:description>About it</media:description></media:group></entry></feed>`;
  const [item] = parseYouTube(xml, source);
  assert.equal(item.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(item.image, 'https://i.ytimg.com/vi/abc/hqdefault.jpg');
  assert.equal(item.text, 'About it');
});

test('parseReddit removes the footer and names the subreddit', () => {
  const xml = `<feed><entry><id>t3_1</id><title>A post</title><link href="https://www.reddit.com/r/x/comments/1/"/>
    <published>2026-11-06T10:00:00+00:00</published><category term="microsoft365"/>
    <content type="html">&lt;p&gt;Real text&lt;/p&gt; submitted by /u/someone [link] [comments]</content></entry></feed>`;
  const [item] = parseReddit(xml, source);
  assert.equal(item.source, 'r/microsoft365');
  assert.equal(item.text, 'Real text');
});

const timeline = (entries) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { timeline: { entries } } } })}</script>`;
const tweet = (fields) => ({ type: 'tweet', content: { tweet: { id_str: '1', created_at: 'Fri Nov 06 10:00:00 +0000 2026', ...fields } } });

test('parseXTimeline expands links and skips replies', () => {
  const html = timeline([
    tweet({ full_text: 'Read https://t.co/a now https://t.co/m', entities: { urls: [{ url: 'https://t.co/a', display_url: 'aka.ms/x' }], media: [{ url: 'https://t.co/m' }] }, user: { screen_name: 'acct' } }),
    tweet({ id_str: '2', full_text: 'reply', in_reply_to_status_id_str: '1' }),
  ]);
  const items = parseXTimeline(html, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Read aka.ms/x now');
  assert.equal(items[0].url, 'https://x.com/acct/status/1');
});

test('parseXTimeline gives a repost the original id', () => {
  const html = timeline([tweet({ id_str: '5', full_text: 'RT @a: hi', retweeted_status: { id_str: '4', full_text: 'hi', user: { screen_name: 'a' } } })]);
  const [item] = parseXTimeline(html, source);
  assert.equal(item.id, 'x:4');
  assert.equal(item.text, 'Reposted @a: hi');
});

test('parseXTimeline fails loudly when the page changes', () => {
  assert.throws(() => parseXTimeline('<html></html>', source), /no timeline data/);
});

test('relevance ignores GitHub Copilot', () => {
  const pattern = /copilot/i;
  assert.equal(isRelevant({ title: 'GitHub Copilot update', text: '' }, pattern), false);
  assert.equal(isRelevant({ title: 'GitHub Copilot and Copilot Chat', text: '' }, pattern), true);
});

test('topics are case-aware and keep source defaults', () => {
  assert.deepEqual(topicsFor({ title: 'Copilot Chat in Teams', text: '' }), ['Copilot', 'Copilot Chat', 'Teams']);
  assert.deepEqual(topicsFor({ title: 'how teams work with a word of caution', text: '' }), []);
  assert.deepEqual(topicsFor({ title: 'Update', text: 'Copilot Cowork' }, ['Teams']), ['Copilot', 'Cowork', 'Teams']);
});

test('mergeItems dedupes, sorts, prunes and keeps the first source', () => {
  const now = new Date('2026-11-06T00:00:00Z');
  const item = (id, publishedAt, sourceId = 'a') => ({ id, publishedAt, sourceId, source: sourceId });
  const merged = mergeItems(
    [item('old', '2020-01-01T00:00:00.000Z'), item('kept', '2026-11-01T00:00:00.000Z')],
    [item('kept', '2026-11-01T00:00:00.000Z', 'b'), item('new', '2026-11-05T00:00:00.000Z', 'b')],
    { maxAgeDays: 180, maxItems: 10, now },
  );
  assert.deepEqual(merged.map((entry) => entry.id), ['new', 'kept']);
  assert.equal(merged[1].sourceId, 'a');
});
