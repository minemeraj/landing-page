---
name: emdash-content-api
description: Create, update, publish, and delete EmDash content (posts, projects, pages) and media programmatically via the REST API and the custom .mcp/ blog MCP server. Use when writing/editing entries from scripts or MCP, embedding images in Portable Text, minting API tokens, or debugging 500/403/409/stale-render issues on this site. Captures the non-obvious gotchas learned the hard way — read it before touching content or media through the API.
---

# EmDash Content & Media via API / MCP

How to manage content on this EmDash site (theweekendprojects.com, deployed to
`landing-page.mineme-shahriar.workers.dev`) from scripts and the custom MCP
server, without repeating the mistakes that already cost real time.

This is about **programmatic** content management. For building the Astro site
itself (pages, queries, rendering) use `building-emdash-site`. For CLI content
work use `emdash-cli`.

## Read this first — the gotchas that silently break things

1. **EmDash has NO GraphQL API.** The content API is REST, rooted at
   `/_emdash/api/content/{collection}`. Any code POSTing to
   `/_emdash/api/graphql` is wrong — that path 403s because it doesn't exist.
   (An early version of `.mcp/server.mjs` and `scripts/write-blog-post.mjs` made
   this mistake; the 403 looks like an auth problem but isn't.)

2. **Auth is a Personal Access Token (`ec_pat_...`) as `Authorization: Bearer`.**
   Not a session cookie. Mint it in the admin (see "Tokens" below). Scopes are
   enforced: `content:read`/`content:write` for entries, **`media:write` for
   uploads** (a content-only token 403s on media with `INSUFFICIENT_SCOPE`).

3. **PUT updates the DRAFT revision; the public page renders the LIVE revision.**
   After a create or update, the change is invisible on the site until you
   publish. Symptom: the API returns your new content but the page shows the old
   version, and `liveRevisionId !== draftRevisionId`. Fix: `POST
   /_emdash/api/content/{collection}/{id}/publish` with body `{}`.

4. **DELETE soft-deletes to trash and RESERVES the slug.** Re-creating an entry
   with the same slug returns `409 Slug ... already exists`. To truly remove it:
   `DELETE /_emdash/api/content/{collection}/{id}/permanent`.

5. **Content fields are Portable Text (arrays of blocks), NOT strings.** Sending
   a string for `content`/`full_content` fails with `400 expected array,
   received string`. See "Portable Text" below for the exact block shapes.

6. **Media upload: the admin UI is the reliable path.** On this R2 setup the
   signed-URL flow (`POST /media/upload-url`) returns `501 NOT_SUPPORTED`, and
   the direct provider upload (`POST /media/providers/local`) returns
   `500 PROVIDER_UPLOAD_ERROR` over the API. **Uploading via the admin Media
   Library (`/_emdash/admin/media`) works** — the admin UI falls back to a
   working internal path after the 501. Confirmed working: select/upload images
   in the admin panel, then reference them by storageKey.

7. **Inline images: OMIT `width`/`height` from the image block.** Including them
   makes the Portable Text `Image.astro` take the `astro:assets` optimizer path,
   which fetches the remote media at render time, throws, and **blanks the whole
   page** (curl still 200s but the body is a near-empty ~8KB shell; the browser
   shows `ERR_HTTP_RESPONSE_CODE_FAILURE`). Without dimensions it renders a plain
   `<img>` pointing at `/_emdash/api/media/file/{storageKey}`, which works.
   Multiple images per post are fully supported — the "one image per post" idea
   is a myth; only `featured_image` is a single slot.

8. **Edge cache serves stale renders.** After publishing, the live page can keep
   serving the old render (or old 500s) for a short window. The custom domain
   and the `*.workers.dev` URL cache separately, so they can disagree. A
   query-string cache-buster does not always bypass it. Wait and re-check, or
   verify via the API (source of truth) rather than the rendered HTML.

## The REST API cheat-sheet

Base: `https://landing-page.mineme-shahriar.workers.dev`
Every request: header `Authorization: Bearer ec_pat_...`

| Action | Method + path | Body |
| --- | --- | --- |
| List entries | `GET /_emdash/api/content/{collection}?limit=N` | — |
| Get one | `GET /_emdash/api/content/{collection}/{slug\|id}` | — |
| Create | `POST /_emdash/api/content/{collection}` | `{ data, slug?, taxonomies? }` |
| Update | `PUT /_emdash/api/content/{collection}/{id}` | `{ data }` (updates draft) |
| Publish | `POST /_emdash/api/content/{collection}/{id}/publish` | `{}` |
| Delete (trash) | `DELETE /_emdash/api/content/{collection}/{id}` | — |
| Delete (purge) | `DELETE /_emdash/api/content/{collection}/{id}/permanent` | — |

- `create` body: fields go inside `data` (e.g. `data: { title, excerpt, content }`).
  Taxonomy assignment is `taxonomies: { tag: ["slug"] }` (NOT `terms`). On create,
  `status` may only be `"draft"` — you publish separately.
- Responses wrap the entry as `{ data: { item } }` (create/get) or
  `{ data: { items } }` (list).
- An entry created via `create` is a **draft**; call `publish` to make it live.

## Collection field shapes (this site)

- **posts** `data`: `title`, `excerpt` (text), `content` (Portable Text),
  `featured_image` (media). Taxonomies: `category`, `tag`.
- **projects** `data`: `title`, `description` (text), `full_content` (Portable
  Text), `featured_image` (media), `tech_stack` (array of string), `github_url`,
  `live_url`, `category` (select: `web|mobile|cli|library|api|design|other`),
  `featured` (0/1).

## Portable Text block shapes

A content field is an array of blocks. Keys are arbitrary short unique strings.

```js
// paragraph
{ _type: "block", _key, style: "normal", markDefs: [], children: [{ _type: "span", _key, text, marks: [] }] }
// heading (h2 / h3) — same but style: "h2" | "h3"
// blockquote — same but style: "blockquote"
// bullet list item — normal block + listItem: "bullet", level: 1
// bold inline — a span with marks: ["strong"]  (mix bold + plain spans in one block's children)
// image — OMIT width/height (see gotcha 7):
{ _type: "image", _key, asset: { _ref: "<storageKeyULID>", url: "<storageKeyULID>.png", provider: "local" }, alt, caption? }
```

The renderer (`emdash/ui` PortableText) only renders known block types; a
malformed block is silently dropped (no error), so a wrong shape = missing
content, not a crash — except the image width/height case, which blanks the page.

## Media: getting an image into content

1. Upload via the **admin Media Library** (`/_emdash/admin/media` → Upload files).
   API upload paths are broken on this deployment (see gotcha 6).
2. Get each image's **storageKey** (the `.png` ULID). From the admin media grid,
   the thumbnail `img` src contains `/_emdash/api/media/file/{STORAGEKEY}.png`.
   `GET /_emdash/api/media/{id}` is 403 with a normal token; the media
   `providers/local` list returns 0 (local provider doesn't enumerate the DB) —
   so read the storageKey from the admin grid, not those endpoints.
3. Build an image block with `asset._ref = "<ULID>"` and
   `asset.url = "<ULID>.png"`, `provider: "local"`, and NO width/height.
4. Insert into the content array, PUT, then publish.

## Tokens (Personal Access Tokens)

- Create at `/_emdash/admin/settings/api-tokens` → Create Token. Pick scopes
  (`content:read`, `content:write`, and `media:write` if uploading), name it, Save.
- The raw `ec_pat_...` is shown **once**. Click "Show token" to reveal, copy it.
  If you navigate away without copying, it's unrecoverable — revoke and remake.
- Store it in `.env` as `EMDASH_API_TOKEN` (gitignored). Never commit it. It's a
  real credential; revoke from the same page if it leaks.

## The custom MCP server (`.mcp/server.mjs`)

This site ships a **custom, homegrown** MCP server at `.mcp/server.mjs` — NOT an
official EmDash product. (`emdash-docs` in `.mcp.json` is the official hosted
docs server; EmDash also ships an official built-in content MCP in
`node_modules/emdash/src/mcp/server.ts` that this site does not use.)

- It wraps the REST API. Tools: `write_blog_post`, `get_blog_posts`,
  `write_project` (has a `publish` flag), `get_projects`.
- It reads `EMDASH_API_TOKEN` from the env (wired via `.mcp.json`), and
  `EMDASH_BASE_URL` (defaults to the workers.dev URL).
- Its `toPortableText()` accepts Markdown-lite: `## `/`### ` headings, `- `
  bullets, `> ` blockquote, blank-line paragraphs, and inline `**bold**`.
- Requires Node 22+ (`nvm use 22`), same as build/deploy. Deps live in
  `.mcp/node_modules` (`@modelcontextprotocol/sdk`).
- To test it standalone: pipe JSON-RPC (`initialize`, `notifications/initialized`,
  `tools/call`) into `node .mcp/server.mjs` with the env set.

## Verify like this, not by trusting a 200

- After create/update: check `liveRevisionId` vs `draftRevisionId` via
  `GET .../{slug}` — if they differ, you forgot to publish.
- After publish: fetch the rendered page and grep for real content
  (`grep -c "some heading" page.html`) and, for images, count `emdash-image`
  figures — don't assume a 200 means the body rendered (see gotcha 7/8).
- A near-empty ~8KB page body = a render error (bad block). Full page ~30KB+.

## Environment notes

- The default `node` here is v20; pnpm/wrangler/this MCP need v22.13+. Always
  `source "$HOME/.nvm/nvm.sh" && nvm use 22` first (mirrors `scripts/deploy.sh`).
- `.env`, `.mcp/node_modules`, and `tmp/` are gitignored. Keep tokens and scratch
  files there.
