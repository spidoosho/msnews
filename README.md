# MS News

A personal news river for Microsoft 365 and Copilot (Copilot Chat, Copilot Studio, Cowork, agents and more), built from Microsoft blogs, YouTube, Reddit and X, newest first.

It runs entirely on free services:

- **GitHub Actions** fetches every source once an hour and adds new posts to `public/data/feed.json`.
- **GitHub Pages** hosts the static site in `public/`.
- **Vercel** (`server/`) runs the optional sync code API, with a private Vercel Blob store behind it.

## Sync codes

The news can be read without a code. A sync code lets someone save posts, hide default sources and add their own, with the same result on every device. There are no accounts or emails.

- Codes are random by default, or chosen by the person, from 4 to 64 characters. Case, spaces and hyphens are ignored. Only a SHA-256 hash is stored.
- A lost code can't be recovered, and anyone holding or guessing a code can read and change that profile. Nothing limits how many guesses someone can make, so short chosen codes are weak, and each guess also uses up the free read allowance.
- Posts from added sources are fetched by the hourly job, after the default sources, into `public/data/custom/`. These files and the list of added sources are public, but nothing links a source to the person who added it.
- Each person can add 10 sources, and the site allows 40 added sources and 100 codes in total. Change these in `LIMITS` in `server/lib/core.js`.
- The free Blob plan allows about 2,000 writes and 10,000 reads a month. Vercel never charges for going over, but the store stops working until the 30-day period resets. Until then the news keeps working and only sync features fail.

To deploy the API after changing `server/`, run this from that folder:

```bash
npx vercel deploy --prod
```

The API address appears in `public/sync.js` and `sources.json`. Its allowed site address is in `server/lib/vercel.js`.

## Change the default sources

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

Then open http://localhost:4173. To try sync codes locally, also run `node scripts/dev-api.mjs`, which keeps its data in memory.
