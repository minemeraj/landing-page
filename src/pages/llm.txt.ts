import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";

export const GET: APIRoute = async ({ request, site }) => {
	const origin = new URL(request.url).origin;
	const settings = await getSiteSettings();
	const siteUrl = site?.toString() || settings.url || origin;
	
	// Fetch all published content from collections with urlPattern
	const collections = await getEmDashCollection("posts", { limit: 1000 });
	const pages = await getEmDashCollection("pages", { limit: 1000 });
	const projects = await getEmDashCollection("projects", { limit: 1000 });

	const entries: Array<{ title: string; url: string; description?: string }> = [];

	// Add posts
	collections.entries.forEach((post) => {
		if (post.data.publishedAt) {
			entries.push({
				title: post.data.title || "Untitled",
				url: `${siteUrl}/posts/${post.id}`,
				description: post.data.excerpt || undefined,
			});
		}
	});

	// Add pages
	pages.entries.forEach((page) => {
		const slug = page.data.slug || page.id;
		entries.push({
			title: page.data.title || "Untitled",
			url: `${siteUrl}/pages/${slug}`,
		});
	});

	// Add projects
	projects.entries.forEach((project) => {
		entries.push({
			title: project.data.title || "Untitled",
			url: `${siteUrl}/projects/${project.id}`,
			description: project.data.description || undefined,
		});
	});

	// Build llms.txt content
	const lines: string[] = [];
	lines.push(`# ${settings.title || "Site"}`, "");
	if (settings.tagline) {
		lines.push(`> ${settings.tagline}`, "");
	}
	lines.push(`## Posts`, "");
	entries
		.filter((e) => e.url.includes("/posts/"))
		.forEach((e) => {
			lines.push(`- [${e.title}](${e.url})${e.description ? `: ${e.description}` : ""}`);
		});
	lines.push("");
	lines.push(`## Pages`, "");
	entries
		.filter((e) => e.url.includes("/pages/"))
		.forEach((e) => {
			lines.push(`- [${e.title}](${e.url})`);
		});
	lines.push("");
	lines.push(`## Projects`, "");
	entries
		.filter((e) => e.url.includes("/projects/"))
		.forEach((e) => {
			lines.push(`- [${e.title}](${e.url})${e.description ? `: ${e.description}` : ""}`);
		});
	lines.push("");

	const body = lines.join("\n").replace(/\n+$/, "\n");

	return new Response(body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=86400",
		},
	});
};
