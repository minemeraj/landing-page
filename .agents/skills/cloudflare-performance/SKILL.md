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

## 4b. Preconnect to cross-origin third-party resources

Any script/style/font/widget loaded from a *different* origin (an analytics tag, an
embedded search/chat widget, a font CDN) makes the browser pay a cold DNS + TLS handshake
the first time it reaches that resource's URL in the markup. On a real site that handshake
was the single longest leg of the request graph (~300ms) even though the resource itself
was small and deferred. A `<link rel="preconnect" href="https://<third-party-origin>"
crossorigin>` in `<head>` warms that connection in parallel with earlier work, so when the
resource is actually requested the socket is already open.

Key points:
- A preconnect (like a preload) is a hint, not a dependency — it never blocks paint. Pure
  upside for a known third-party origin that *will* be used on the page.
- Add `crossorigin` when the eventual fetch is CORS (e.g. a `type="module"` script or a
  font), so the warmed connection actually matches and gets reused.
- Only preconnect origins you're confident the page uses — each one holds a connection
  open, so don't spray preconnects at origins that might not be hit.
- Prefer emitting it from whatever *owns* the third-party resource (e.g. the plugin that
  injects the widget, deriving the origin from its own configured endpoint) rather than
  hardcoding the host in the site layout — that keeps it correct across config changes and
  benefits every site using that plugin. Hardcoding in the layout works as a quick test but
  goes stale if the endpoint changes (a stale preconnect is harmless, just ignored).
- Measure it in PageSpeed Insights / Lighthouse under the network-dependency-tree /
  "Maximum critical path latency" diagnostic — a correct preconnect shows the third-party
  leg shrink and the origin listed under "Preconnected origins".

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

**Measuring it correctly (two traps that make it look like a no-op):**

1. **It only helps WARM isolates.** The cache is epoch-keyed: the *first* render of a
   given key on a cold isolate is always a MISS and runs the full DB queries; only
   subsequent renders on that same warm isolate (or any render sharing already-cached
   settings/menus/taxonomy/entry keys) skip D1. So a benchmark of only cache-busted,
   cross-colo, cold-isolate requests will show ZERO improvement by construction — that's
   exactly the one case the cache can't help. To see the win, hit origin renders rapidly
   enough to reuse a warm isolate (`rt;dur=0` in `server-timing`) and compare `db.count`
   there.
2. **Watch `db.count`, NOT `cache.hit`/`cache.miss`.** The `server-timing` `cache.hit` /
   `cache.miss` counters measure EmDash's *in-request dedupe*, not this object cache — they
   stay flat regardless of whether KV is working, so they're useless for verifying it. The
   only observable signal of a working object cache is `db.count` (and `db.total`) dropping
   on warm renders. Measured on a real site: a warm render went from ~14 D1 queries to ~2–3
   once the cache was active, with `db.total` dropping from ~500ms to ~60ms.

If `db.count` never drops even on warm isolates, the cache is silently a no-op. Most likely
cause: the KV binding named in `kvCache({ binding })` isn't present at runtime — if
`createObjectCache` can't find `env[binding]` it throws, the runtime swallows it to a
null (passthrough) backend, and only warns in DEV. Confirm the binding shows in the
`wrangler deploy` output (`env.CACHE  KV Namespace`) and that `objectCacheConfig` is baked
into the build.

**Reality check on impact:** this speeds warm *origin* renders and cuts D1 load, but your
most common real traffic is edge-HTML HITs (section 2) that skip the Worker entirely and
never touch D1 or KV — those see no change. The object cache's payoff is the in-between
(cache-miss renders on warm isolates, and routes without edge rules), plus lower D1
row-read pressure as traffic grows. Treat it as D1-offload + tail-latency, not an FCP/LCP
win.

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
