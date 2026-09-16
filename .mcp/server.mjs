import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * EmDash Blog MCP Server
 *
 * Provides tools for writing and listing blog posts on The Weekend Projects.
 *
 * IMPORTANT: EmDash exposes a REST content API, NOT GraphQL. Content lives at
 *   GET  /_emdash/api/content/{collection}  -> list
 *   POST /_emdash/api/content/{collection}  -> create
 * Auth is a Personal Access Token (ec_pat_...) sent as `Authorization: Bearer`,
 * minted by an admin at /_emdash/admin (API tokens) with the `content:write`
 * scope (create) and `content:read` scope (list).
 *
 * Config via env:
 *   EMDASH_API_TOKEN  (required) ec_pat_... token
 *   EMDASH_BASE_URL   (optional) site origin; defaults to the live worker
 */

const BASE_URL = (process.env.EMDASH_BASE_URL || 'https://landing-page.mineme-shahriar.workers.dev').replace(/\/$/, '');
const API_TOKEN = process.env.EMDASH_API_TOKEN;
const COLLECTION = 'posts';

const server = new Server(
  {
    name: 'emdash-blog-mcp',
    version: '2.0.0',
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

const TOOLS = [
  {
    name: 'write_blog_post',
    description:
      'Create a new blog post on The Weekend Projects (posts collection). Created as a draft; publish it from the EmDash admin.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The title of the blog post' },
        excerpt: { type: 'string', description: 'A short excerpt/description of the post' },
        content: { type: 'string', description: 'The main content of the post (Markdown/plain text)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tag term slugs to assign (taxonomy: tag)',
        },
        featuredImage: { type: 'string', description: 'URL/ref for the featured image (optional)' },
        slug: { type: 'string', description: 'Optional explicit slug; omit to auto-generate from the title' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'get_blog_posts',
    description: 'List blog posts with basic info',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of posts to return (default: 10)',
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
];

const RESOURCES = [
  {
    uri: 'emdash://posts/schema',
    name: 'Posts Collection Schema',
    mimeType: 'application/json',
    description: 'Schema definition for blog posts in EmDash',
  },
];

/**
 * Call the EmDash REST content API. Returns parsed JSON on success, throws with
 * a readable message on any non-2xx (surfacing EmDash's error code/message).
 */
async function emdashRequest(method, path, body) {
  if (!API_TOKEN) {
    throw new Error('EMDASH_API_TOKEN environment variable is not set');
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object'
        ? payload.error?.message || payload.message || JSON.stringify(payload)
        : payload || response.statusText;
    throw new Error(`EmDash API ${response.status}: ${detail}`);
  }

  return payload;
}

/**
 * Convert caller-supplied content into EmDash Portable Text blocks.
 * - If it's already an array (Portable Text), pass through untouched.
 * - Otherwise split a string on blank lines into paragraph blocks, each with a
 *   single span child. Uses random block/span keys as EmDash expects.
 */
function toPortableText(content) {
  if (Array.isArray(content)) return content;
  const text = typeof content === 'string' ? content : String(content ?? '');
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const blocks = paragraphs.length ? paragraphs : [text];
  const key = () => Math.random().toString(36).slice(2, 10);
  return blocks.map((p) => ({
    _type: 'block',
    _key: key(),
    style: 'normal',
    markDefs: [],
    children: [{ _type: 'span', _key: key(), text: p, marks: [] }],
  }));
}

async function handleToolCall(request) {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'write_blog_post': {
      const { title, excerpt, content, tags = [], featuredImage, slug } = args;

      const body = {
        data: {
          title,
          excerpt: excerpt || '',
          // The `content` field is EmDash Portable Text (an array of blocks),
          // not a string. Accept a plain string or Markdown from the caller and
          // convert each blank-line-separated paragraph into a text block.
          content: toPortableText(content),
          ...(featuredImage ? { featured_image: featuredImage } : {}),
        },
        ...(slug ? { slug } : {}),
        ...(Array.isArray(tags) && tags.length ? { taxonomies: { tag: tags } } : {}),
      };

      const result = await emdashRequest('POST', `/_emdash/api/content/${COLLECTION}`, body);
      const item = result?.data?.item ?? result?.item ?? result;
      const postSlug = item?.slug ?? slug ?? '';

      return {
        content: [
          {
            type: 'text',
            text:
              `Blog post created (draft).\n\n` +
              `Title: ${item?.data?.title ?? title}\n` +
              `Slug: ${postSlug}\n` +
              `Status: ${item?.status ?? 'draft'}\n` +
              `ID: ${item?.id ?? 'unknown'}\n\n` +
              `Publish it from the EmDash admin. Once published: ${BASE_URL}/posts/${postSlug}`,
          },
        ],
      };
    }

    case 'get_blog_posts': {
      const limit = args?.limit || 10;
      const result = await emdashRequest('GET', `/_emdash/api/content/${COLLECTION}?limit=${limit}`);
      const items = result?.data?.items ?? result?.items ?? [];

      return {
        content: [
          {
            type: 'text',
            text:
              `Found ${items.length} post(s):\n\n` +
              items
                .map(
                  (p) =>
                    `- [${p.status ?? '?'}] ${p.data?.title ?? p.title ?? '(untitled)'} ` +
                    `(${p.slug ?? '?'})${p.publishedAt ? ` - ${p.publishedAt}` : ''}`
                )
                .join('\n'),
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleResourceRead(request) {
  const { uri } = request.params;

  switch (uri) {
    case 'emdash://posts/schema':
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                collection: 'posts',
                api: {
                  list: `GET ${BASE_URL}/_emdash/api/content/posts`,
                  create: `POST ${BASE_URL}/_emdash/api/content/posts`,
                  auth: 'Authorization: Bearer <ec_pat_...>',
                },
                createBody: {
                  data: { title: 'text', excerpt: 'text', content: 'portable-text/text', featured_image: 'media' },
                  slug: 'optional string',
                  taxonomies: { tag: ['term-slug'] },
                  status: 'draft (create is draft-only; publish via admin)',
                },
              },
              null,
              2
            ),
          },
        ],
      };

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, handleResourceRead);
server.setRequestHandler(CallToolRequestSchema, handleToolCall);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('EmDash Blog MCP server running on stdio');
}

main().catch((error) => {
  console.error(`Server error: ${error.message}`);
  process.exit(1);
});
