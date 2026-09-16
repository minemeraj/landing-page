import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ request }) => {
	const origin = new URL(request.url).origin;
	const res = await fetch(`${origin}/_emdash/api/plugins/seo/llms/txt`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	});
	const { enabled, body } = (await res.json()) as { enabled: boolean; body: string };
	if (!enabled) return new Response("Not found", { status: 404 });
	return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
