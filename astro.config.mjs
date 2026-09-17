import cloudflare from "@astrojs/cloudflare";
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
