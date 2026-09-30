import cloudflare from "@astrojs/cloudflare";
import { cacheCloudflare } from "@astrojs/cloudflare/cache";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import webhookNotifier from "@emdash-cms/plugin-webhook-notifier";
import { betterAuthProvider, betterAuthSettingsPlugin } from "emdash-better-auth";
import { seoPlugin } from "@jdevalk/emdash-plugin-seo";
import aiSearch from "emdash-ai-search";
import { defineConfig, fontProviders } from "astro/config";
import emdash from "emdash/astro";
import emdashSmtp from "emdash-smtp";

export default defineConfig({
	output: "server",
	// Canonical public origin of the site. Set this to the real domain, NOT the
	// *.workers.dev deploy URL. Astro uses it for canonical links, RSS and
	// sitemaps, and the emdash-better-auth plugin reads it (via
	// context.site) to build absolute verification / password-reset email links
	// — so those links point at the real domain even when a request happens to
	// arrive on the raw *.workers.dev host.
	site: "https://theweekendprojects.com",
	adapter: cloudflare(),
	// Fronts the Worker with Cloudflare's Workers Cache so cacheable GET
	// responses (HTML with a route rule below, plus any response that already
	// sets a public Cache-Control, e.g. the CMS media route) are served from
	// the edge without invoking the Worker. EmDash's own admin/API responses
	// already send `private, no-store` and are never cached by this.
	cache: {
		provider: cacheCloudflare(),
	},
	routeRules: {
		"/": { maxAge: 300, swr: 86400 },
		"/posts": { maxAge: 300, swr: 86400 },
		"/posts/**": { maxAge: 300, swr: 86400 },
		"/projects": { maxAge: 300, swr: 86400 },
		"/projects/**": { maxAge: 300, swr: 86400 },
		"/pages/**": { maxAge: 300, swr: 86400 },
		"/category/**": { maxAge: 300, swr: 86400 },
		"/tag/**": { maxAge: 300, swr: 86400 },
	},
	// Tailwind v4 is required to compile the Better Auth UI (HeroUI) styles used
	// by the emdash-better-auth plugin's auth pages. Its output is
	// scoped to the auth island (imported only there), so it doesn't affect the
	// site's own token/theme styling.
	vite: {
		plugins: [tailwindcss()],
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
		// Authorizes EmDash's own media URLs (both the canonical domain and the
		// workers.dev deploy host) so <Image> can actually resize/reformat CMS
		// media through the Cloudflare Images binding instead of passing the
		// original file through unchanged. See emdash's media/responsive.ts.
		remotePatterns: [
			{ protocol: "https", hostname: "theweekendprojects.com" },
			{ protocol: "https", hostname: "landing-page.mineme-shahriar.workers.dev" },
		],
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			authProviders: [betterAuthProvider()],
			// betterAuthSettingsPlugin() adds the admin settings form for Better
			// Auth (verification toggles, canonical URL, Google + Better Auth
			// secrets). The auth provider reads those values at request time with
			// env-var fallback.
			//
			// aiSearch() = emdash-ai-search as a NATIVE (trusted/internal) plugin.
			// It runs in the host Worker isolate and reaches Cloudflare directly
			// through bindings — tokenless. The default backend is Cloudflare AI
			// Search (the "easy path"), which needs the AI_SEARCH + R2 bindings in
			// wrangler.jsonc. Non-secret settings (instance/bucket/collections) are
			// set in Admin → Plugins → AI Search; no API token is stored.
			plugins: [formsPlugin(), emdashSmtp(), betterAuthSettingsPlugin(), seoPlugin(), aiSearch()],
			sandboxed: [webhookNotifier],
			sandboxRunner: sandbox(),
			marketplace: "https://marketplace.emdashcms.com",
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-body",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
