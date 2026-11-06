# MS News

A personal news river for Microsoft 365 and Copilot (Copilot Chat, Copilot Studio, Cowork, agents and more), built from Microsoft blogs, YouTube, Reddit and X, newest first.

It runs entirely on free services, with no server or database:

- **GitHub Actions** fetches every source once an hour and adds new posts to `public/data/feed.json`.
- **GitHub Pages** hosts the static site in `public/`.

## Change the sources

Edit [`sources.json`](sources.json) and push. The site rebuilds automatically.

| Type | Required field | Example |
| --- | --- | --- |
| `blog` | `url` of an RSS feed | `"url": "https://devblogs.microsoft.com/microsoft365dev/feed/"` |
| `youtube` | `channelId` (starts with `UC`) | `"channelId": "UCJ9905MRHxwLZ2jeNQGIWxA"` |
| `reddit` | `subreddits` list | `"subreddits": ["microsoft365", "Office365"]` |
| `x` | `handle` without the `@` | `"handle": "MSFTCopilot"` |

Every source also needs a unique `id`, a `type` and a display `name`. Two options are available:

- `"filter": true` keeps only posts matching the `relevance` pattern at the top of the file. Use it for broad sources that post about many topics.
- `"topics": ["Teams"]` tags every post from the source with those topics.

## Source limits

- **X:** the official API has no useful free tier, so posts come from X's public embed endpoint. It is unofficial and can stop working or lag behind the live account. Some accounts return old posts or nothing.
- **Reddit:** anonymous RSS is heavily rate-limited, so subreddits are grouped into combined requests. Each group shows the week's top posts, which filters out most help questions but not all.

One failing source never stops a refresh. Its existing posts stay, and the **Updated** link at the top of the site shows the state of every source.

## Run it locally

Requires Node.js 24.

```bash
npm install
npm test
npm run fetch
npm run serve
```

Then open http://localhost:4173.
