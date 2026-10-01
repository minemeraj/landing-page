---
name: cloudflare-performance
description: Make an EmDash + Astro site fast on Cloudflare Workers. Use when a page feels slow, when setting up or auditing edge caching, image optimization, CSS inlining, LCP/front-end delivery, D1/KV performance, or when diagnosing "why is this site slow" with wrangler tail, server-timing, curl, and headless-browser FCP measurement. Covers the exact gotchas these sites hit and fixed, and how to benchmark against a known-fast reference site.
---

# Cloudflare Performance for EmDash + Astro

This site (`landing-page`) runs EmDash on Astro's Cloudflare adapter: D1 (content), R2 (media), KV (object cache), Worker Loader (sandboxed plugins). "Page feels slow" has several distinct root causes that look identical from the outside but need different fixes — a hanging plugin hook, dead-weight plugins loaded on cold start, missing edge cache, images never optimizing, render-blocking CSS, or D1 round-trip cost. They split into two layers: **backend/edge** (what the Worker and caches do before the HTML leaves the edge) and **front-end delivery** (what the browser must fetch and run before it paints). Diagnose which layer, and which cause, before changing config.

## Diagnose first, always

Don't guess. Do both of these before touching any config:

1. **Tail live logs** while reproducing the slowness:
   ```bash
   # pnpm/wrangler need Node 22.13+; this machine's default node is often older.
   source ~/.nvm/nvm.sh && nvm use 22 >/dev/null 2>&1 && \
     pnpm --dir <site-dir> exec wrangler tail <worker-name> --format pretty
   ```
   Watch for `PluginBridge.storageGet - Exception Thrown` / `"Worker's code had hung"` —
   that means a plugin hook is hanging, not a caching problem. See "Broken plugin hooks" below.

2. **Time distinct pages, not repeats.** Hitting the same URL twice always looks fast once
   any cache is warm — that tells you nothing about what a real visitor navigating page to
   page experiences.
   ```bash
   for p in "/pages/about" "/posts/some-slug" "/category/some-cat" "/tag/some-tag"; do
     echo "=== $p ==="
     curl -s -o /dev/null -w "ttfb=%{time_starttransfer}s total=%{time_total}s\n" \
       "https://<domain>${p}?cb=$(date +%s%N)"
   done
   ```
   Then compare a **repeat** request to the same URL — if repeat is dramatically faster,
   the gap is cold-render cost (D1 + no object cache), not a hang.

3. **Check headers** (`cf-cache-status`, `cache-control`) with `curl -s -D - -o /dev/null`.
   `BYPASS`/`MISS` on every request to the same URL means the HTML route cache isn't
   covering that path — go fix the route rule, not the Worker code.

4. **Read `server-timing` to split cold vs warm and attribute the cost.** EmDash emits a
   rich `Server-Timing` header on cache MISS. The `rt.*` sub-phases (`rt.db`, `rt.plugins`,
   `rt.market`, `rt.sandbox`, `rt.hooks`, ...) are populated **only on a cold isolate** — on
   a warm call `rt;dur=0` and they're absent. `db.total` + `db.count` tell you D1 cost and
   how many queries ran (the count jumps on cold start because bootstrap fires extra
   queries). `render` is page-render time. This is how you tell "slow because cold-start
   plugin bootstrap" from "slow because D1 query" from "slow render" without guessing.
   ```bash
   curl -s -D - -o /dev/null "https://<domain>/?cb=$RANDOM" | grep -i server-timing
   ```

5. **Front-end timing needs a real browser, not curl.** curl measures the HTML document
   only (TTFB, bytes). It can't measure First Contentful Paint, which is what "feels fast"
   actually depends on — that's gated by render-blocking CSS, fonts, and the LCP image, all
   client-side. Use a headless browser and read the Navigation + Paint Timing APIs:
   ```js
   const nav = performance.getEntriesByType('navigation')[0];
   const fcp = performance.getEntriesByType('paint').find(p => p.name==='first-contentful-paint');
   // report: nav.responseStart (doc TTFB), fcp.startTime (FCP), nav.loadEventEnd,
   //         external stylesheet count, preload<as=image> presence, slowest resources
   ```
   This is also the **only** way to measure a site fronted by a Cloudflare WAF / managed
   challenge: plain curl gets a `403 "Attention Required! | Cloudflare"` block page (which
   returns in ~50ms and looks deceptively "fast" — it's the block, not the site). A real
   browser passes the challenge (sets the clearance cookie), so navigate once to clear it,
   then reload and measure. Watch the first post-challenge load — it includes the challenge
   round trip (inflated FCP); the *reload* is the clean number.

### Comparing against a known-fast reference site

When benchmarking one EmDash site against another, the delivery methods may not be
symmetric (one open to curl, one behind a WAF). Note that in your report and compare
*shapes*, not just absolute ms — absolute TTFB from an agent's network location carries
latency to whatever Cloudflare colo served it, and cache-busted samples land on different
colos (DUS/AMS/MAD/CDG...), so a handful of samples is noisy. For a latency delta that
survives the noise, hammer enough cache-busted requests to see the bimodal split (warm
cluster vs cold cluster) and report median + p95 per cluster, not a single mean.

## 1. Broken plugin hooks (check this before anything else)

A single misbehaving plugin hook (`page:metadata`, `page:fragments`, etc.) that hangs
instead of failing fast can add 1-2s+ to **every single page render**, site-wide, with no
caching fix able to help. Symptom in `wrangler tail`:
```
PluginBridge.storageGet - Exception Thrown
✘ The Workers runtime canceled this request because it detected that your Worker's
  code had hung and would never generate a response.
(error) [page:metadata] Plugin "<id>" error: Storage collection not declared: <name>
```
The request still returns 200 (EmDash catches hook errors), but the render pays the full
stall before EmDash's own hook timeout gives up. Fix: disable or update the offending
plugin from `/_emdash/admin/plugins`. This is an admin-console action, not a code fix —
don't try to patch around a third-party plugin's broken manifest in site code.

### 1b. Dead-weight plugins loaded on every cold start

A subtler cousin: a sandboxed/marketplace plugin that is *installed and active* but does
nothing useful still gets its bundle fetched from R2, instantiated in the sandbox, and its
hooks resolved on **every cold isolate** — pure cold-start overhead. `wrangler tail` makes
this visible. On this site the tail showed, on each cold render:
```
EmDash: Loaded marketplace plugin audit-log:0.1.0 with capabilities: [content:read]
[hooks] Plugin "audit-log" declares content:beforeSave hook without content:write capability — skipping
[hooks] Plugin "audit-log" declares media:afterUpload hook without media:read capability — skipping
```
So it paid to load a plugin whose hooks were then **skipped as miscapability'd** —
~150-200ms of wasted cold-init work (measured from the gap between consecutive plugin
load-log timestamps). Fix: disable it in `/_emdash/admin/plugins` if unused, or grant it
the capabilities its hooks actually need so the load isn't wasted. After disabling, the
tail should show only the plugins you actually rely on (here, just `webhook-notifier`).

**Clearing up a red herring while you're here:** `marketplace: "https://marketplace.emdashcms.com"`
in `astro.config.mjs` does **not** mean page loads phone the marketplace. The `rt.market`
`server-timing` entry is cold-init-only (populated once per fresh isolate, empty on warm
calls) and only does a D1 plugin-state read + R2 bundle load — confirmed via `wrangler tail`
showing zero outbound fetch to the marketplace host during page renders. The marketplace
URL is contacted only when an admin installs/updates a plugin.

## 2. Edge-cache HTML (Workers Cache)

Astro's `Astro.cache.set(cacheHint)` calls throughout EmDash's query helpers are no-ops
until you actually configure a cache provider. Without this, every page re-runs the full
Worker every time, even for anonymous, cacheable content.

```js
// astro.config.mjs
import { cacheCloudflare } from "@astrojs/cloudflare/cache";

export default defineConfig({
  adapter: cloudflare(),
  cache: { provider: cacheCloudflare() },
  routeRules: {
    "/": { maxAge: 300, swr: 86400 },
    "/posts/**": { maxAge: 300, swr: 86400 },
    // ...every public route pattern, using the same [param]/[...rest] syntax as file routing
  },
});
```

**Gotcha:** enabling `cache.provider` changes the *default* behavior for every route, not
just the ones you list. Any route without an explicit `routeRules` entry — including
routes injected by integrations (EmDash's own CMS media route, Astro's own `/_image`
endpoint) — gets downgraded to a conservative `Cache-Control: max-age=0, must-revalidate`,
even if that route already set its own long-lived header. You must add explicit rules for
those too, or you'll regress something that used to cache correctly:

```js
routeRules: {
  // ...page rules above...
  "/_emdash/api/media/file/[...key]": { maxAge: 31536000 }, // immutable ULID filenames
  "/_image": { maxAge: 31536000 }, // deterministic per unique href+w+h+format query
},
```
Without the `/_image` rule specifically, every responsive image variant recomputes via
Cloudflare Images on *every* request (1-2s each) instead of being cached after the first.

Verify: `curl -s -D - -o /dev/null <url> | grep cf-cache-status` — first hit `MISS`,
repeat hits `HIT`.

## 3. Image optimization actually running

EmDash's `<Image>` (`emdash/ui`) delegates to Astro's configured image service
(`astro:assets`). On Cloudflare with an `IMAGES` binding this means real WebP/AVIF +
responsive `srcset` — **but only for authorized origins**:

```js
image: {
  layout: "constrained",
  responsiveStyles: true,
  remotePatterns: [
    { protocol: "https", hostname: "<canonical-domain>" },
    { protocol: "https", hostname: "<workers.dev-host>" },
  ],
},
```
Without `remotePatterns` covering the site's own media origin, the image service silently
passes every image through unchanged — no error, no warning, just full-size raw PNGs
forever. This is the most common reason "images aren't optimizing" despite everything
else being wired up correctly.

Also set `priority` (eager load + high fetch priority) on the first/above-fold image on
every page — EmDash's `<Image>` defaults every image to `loading="lazy"`, including the
one visible the instant the page loads. That delays the browser from even starting the
LCP fetch. Thread a `priority` prop through any card/list component to the first item.

**LCP image preload is a safe, non-blocking add on top of `priority`.** `priority` gets
you `loading="eager"` + `fetchpriority="high"` on the `<img>`, which is most of the win.
A `<link rel="preload" as="image">` in the `<head>` is the remaining increment: it starts
the fetch during HTML parse, slightly before the parser reaches the `<img>`. A preload
does **not** block rendering or page load — it's a "fetch this early" hint, not a
dependency; HTML/CSS/text all paint without waiting on it (worst case: text paints on
time, image fills in). Only external `<link rel="stylesheet">` is render-blocking, not
image preloads. Note: Astro's `priority` is *supposed* to also emit the preload link, but
whether it does depends on the Astro version — verify in the live HTML
(`grep 'rel="preload".*as="image"'`); if it's missing, add it manually in the layout for
the known hero image. A reference EmDash site (everybittexas.com) ships exactly this: an
`as="image"` preload of the Cloudflare-transformed WebP hero.

## 3b. Inline all CSS (kill render-blocking stylesheets)

By default Astro emits component CSS as external `<link rel="stylesheet">` files. Those
are **render-blocking**: the browser must fetch each one before it can paint, adding a
round trip (or several) to the critical path of every page — even when the HTML itself is
served instantly from the edge cache (section 2). For a content site whose total CSS is
small (tens of KB), inlining it straight into each page's `<head>` is a clear win:

```js
// astro.config.mjs
export default defineConfig({
  build: {
    inlineStylesheets: "always",
  },
});
```

After this, the page paints directly from the HTML document with zero stylesheet fetches.
Verify by rebuilding and confirming **no** `.css` files land in `dist/client/_astro/`
(`find dist/client/_astro -name '*.css' | wc -l` → `0`), and that the live HTML has no
`<link rel="stylesheet">` (`curl ... | grep 'rel="stylesheet"'` → nothing). Before this
change, this site shipped 3 blocking stylesheets (`Base.css`, `index.css`,
`reading-time.css`); after, all CSS is inlined.

Trade-off: inlined CSS isn't shared/cached across pages the way an external file is, so
each HTML response carries its own copy. For a site with a handful of KB of CSS and
edge-cached HTML this is the right call. If the CSS ever grows large (hundreds of KB) or
is near-identical across every page, revisit — `"auto"` (Astro's default heuristic:
inline small sheets, link large ones) becomes the better setting at that scale.

The reference fast EmDash site (everybittexas.com) ships **0 external stylesheets** — all
CSS inlined — which is the single biggest reason its First Contentful Paint is so tight
(~400-570ms warm) despite the same EmDash/Astro/Cloudflare stack.

## 4. Real favicon, not just a CMS setting

EmDash renders a favicon from `siteSettings.favicon` if an admin sets one, but there's no
static fallback — an unconfigured site 404s on `/favicon.ico`. Ship one directly:
- `public/favicon.svg` — `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`
- A raster fallback (`public/favicon.png` + `public/favicon.ico`) for browsers that don't
  fully trust SVG-only favicons. Rasterize with `sharp` if you don't have a design asset:
  ```js
  const sharp = require("<path-to>/node_modules/.pnpm/sharp@<version>/node_modules/sharp");
  sharp(svgBuffer, { density: 384 }).resize(32, 32).png().toBuffer()
    .then(buf => { fs.writeFileSync("public/favicon.png", buf); fs.writeFileSync("public/favicon.ico", buf); });
  ```
  (`sharp` is often already present as a transitive dependency but not hoisted — resolve
  its real path under `node_modules/.pnpm/` rather than `npm install`-ing a new copy.)

## 5. Object cache (KV) in front of D1

Every page render does several D1 round trips (site settings, menus, content, taxonomy
terms, bylines). With no cache layer, each of those is a fresh query even on a warm
isolate. `objectCache` caches content/config reads in KV so most of that becomes a KV hit
instead of a D1 round trip:

```js
// astro.config.mjs
import { d1, r2, kvCache } from "@emdash-cms/cloudflare";

emdash({
  database: d1({ binding: "DB", session: "auto" }),
  storage: r2({ binding: "MEDIA" }),
  objectCache: kvCache({ binding: "CACHE" }),
});
```
```jsonc
// wrangler.jsonc
"kv_namespaces": [{ "binding": "CACHE", "id": "<namespace-id>" }],
```
Create the namespace with `wrangler kv namespace create CACHE` (needs your Cloudflare
account — this creates a real, billable-category resource, though KV's free tier covers
low-traffic sites comfortably). This is distinct from Workers Cache (section 2): a hit
here never runs the Worker's D1 queries, but it also doesn't skip the Worker like an
edge-cache HTML hit does — the two layers solve different problems and are meant to be
used together, not as alternatives.

## 6. Targeted Placement (D1 locality)

Cloudflare runs a Worker near the visitor by default, but EmDash makes several D1 round
trips per SSR request — if the Worker executes far from the D1 primary, every one of
those round trips pays a geography tax. Add `placement.mode: "targeted"` to
`wrangler.jsonc` with a `region`/`host`/`hostname` selector that targets the D1 primary's
location. Don't combine this with D1 read replicas; leave EmDash's `session` at its
default (`"disabled"`) or `"auto"` (Sessions API — routes anonymous reads to the nearest
replica when available) rather than manually juggling both.

## Local dev limitations (don't waste time debugging these as "bugs")

- `pnpm dev` / `pnpm preview` need `workerd`, which requires macOS 13.5+ or Linux. On an
  older macOS (common on a personal dev machine), these commands fail outright — this is
  an environment limitation, not a site bug. Use `pnpm deploy` (builds + `wrangler deploy`
  in one step) and test against the live Worker instead.
- `pnpm`/`wrangler` require Node 22.13+; if the shell's default `node` is older, every
  wrangler command fails with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`. Switch with nvm
  first (see the tail command at the top of this file).
- When running long-lived commands like `wrangler tail` via an agent's async terminal
  tooling, prefer a single command with `nvm use` chained via `&&` in one string — some
  terminal tools silently drop a leading `cd ...&&` prefix on compound commands.
