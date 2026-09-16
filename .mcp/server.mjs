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
  {
    name: 'write_project',
    description:
      'Create a new project on The Weekend Projects (projects collection) as a draft. Use the `publish` flag to publish it live in one step.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Project title' },
        description: {
          type: 'string',
          description: 'Short one-or-two sentence summary shown in cards and the hero',
        },
        fullContent: {
          type: 'string',
          description:
            'Long-form case study. Markdown-lite: lines starting with "## " become H2 headings, "### " become H3, "- " become bullet list items, "> " a blockquote; blank lines separate paragraphs.',
        },
        techStack: {
          type: 'array',
          items: { type: 'string' },
          description: 'Technologies used, shown as chips (e.g. ["Astro","Cloudflare Workers"])',
        },
        category: {
          type: 'string',
          enum: ['web', 'mobile', 'cli', 'library', 'api', 'design', 'other'],
          description: 'Project category',
        },
        githubUrl: { type: 'string', description: 'Source repository URL (optional)' },
        liveUrl: { type: 'string', description: 'Live/demo URL (optional)' },
        featured: {
          type: 'boolean',
          description: 'Show on the homepage featured rail (default false)',
        },
        slug: { type: 'string', description: 'Optional explicit slug; omit to auto-generate from the title' },
        publish: {
          type: 'boolean',
          description: 'Publish immediately after creating (default false — otherwise it stays a draft)',
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'get_projects',
    description: 'List projects with basic info',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of projects to return (default: 10)',
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
  {
    name: 'delete_blog_post',
    description: 'Delete a blog post by ID or slug',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The database ID (ULID) of the post to delete',
        },
        slug: {
          type: 'string',
          description: 'The slug of the post to delete (alternative to ID)',
        },
      },
    },
  },
  {
    name: 'clear_all_posts',
    description: 'Delete all blog posts (use with caution)',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'string',
          description: 'Type "yes" to confirm you want to delete all posts',
        },
      },
      required: ['confirm'],
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
 * - Otherwise parse a Markdown-lite string into blocks:
 *     "## "  -> h2 heading
 *     "### " -> h3 heading
 *     "- "   -> bullet list item
 *     "> "   -> blockquote
 *     blank line separates paragraphs; other lines are paragraph text.
 * Uses random block/span keys as EmDash expects.
 */
function toPortableText(content) {
  if (Array.isArray(content)) return content;
  const text = typeof content === 'string' ? content : String(content ?? '');
  const key = () => Math.random().toString(36).slice(2, 10);
  // Split a line into spans, turning **bold** segments into strong marks.
  const toSpans = (str) => {
    const spans = [];
    const re = /\*\*(.+?)\*\*/g;
    let last = 0;
    let m;
    while ((m = re.exec(str))) {
      if (m.index > last) spans.push({ _type: 'span', _key: key(), text: str.slice(last, m.index), marks: [] });
      spans.push({ _type: 'span', _key: key(), text: m[1], marks: ['strong'] });
      last = m.index + m[0].length;
    }
    if (last < str.length) spans.push({ _type: 'span', _key: key(), text: str.slice(last), marks: [] });
    return spans.length ? spans : [{ _type: 'span', _key: key(), text: str, marks: [] }];
  };
  const mk = (style, str, extra = {}) => ({
    _type: 'block',
    _key: key(),
    style,
    markDefs: [],
    ...extra,
    children: toSpans(str),
  });

  const blocks = [];
  // Split into logical lines; blank lines act as separators between paragraphs.
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push(mk('normal', paragraph.join(' ').trim()));
      paragraph = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('### ')) { flush(); blocks.push(mk('h3', line.slice(4).trim())); }
    else if (line.startsWith('## ')) { flush(); blocks.push(mk('h2', line.slice(3).trim())); }
    else if (line.startsWith('# ')) { flush(); blocks.push(mk('h2', line.slice(2).trim())); }
    else if (line.startsWith('- ') || line.startsWith('* ')) {
      flush();
      blocks.push(mk('normal', line.slice(2).trim(), { listItem: 'bullet', level: 1 }));
    }
    else if (line.startsWith('> ')) { flush(); blocks.push(mk('blockquote', line.slice(2).trim())); }
    else { paragraph.push(line); }
  }
  flush();

  return blocks.length ? blocks : [mk('normal', text)];
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

    case 'write_project': {
      const {
        title,
        description,
        fullContent,
        techStack = [],
        category,
        githubUrl,
        liveUrl,
        featured = false,
        slug,
        publish = false,
      } = args;

      const data = {
        title,
        description,
        ...(fullContent ? { full_content: toPortableText(fullContent) } : {}),
        ...(Array.isArray(techStack) && techStack.length ? { tech_stack: techStack } : {}),
        ...(category ? { category } : {}),
        ...(githubUrl ? { github_url: githubUrl } : {}),
        ...(liveUrl ? { live_url: liveUrl } : {}),
        featured: featured ? 1 : 0,
      };

      const created = await emdashRequest('POST', `/_emdash/api/content/projects`, {
        data,
        ...(slug ? { slug } : {}),
      });
      const item = created?.data?.item ?? created?.item ?? created;
      const id = item?.id;
      const projectSlug = item?.slug ?? slug ?? '';
      let status = item?.status ?? 'draft';

      if (publish && id) {
        const pub = await emdashRequest('POST', `/_emdash/api/content/projects/${id}/publish`, {});
        status = pub?.data?.item?.status ?? 'published';
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Project created${publish ? ' and published' : ' (draft)'}.\n\n` +
              `Title: ${item?.data?.title ?? title}\n` +
              `Slug: ${projectSlug}\n` +
              `Status: ${status}\n` +
              `ID: ${id ?? 'unknown'}\n\n` +
              (status === 'published'
                ? `Live: ${BASE_URL}/projects/${projectSlug}`
                : `Publish it from the EmDash admin. Once published: ${BASE_URL}/projects/${projectSlug}`),
          },
        ],
      };
    }

    case 'get_projects': {
      const limit = args?.limit || 10;
      const result = await emdashRequest('GET', `/_emdash/api/content/projects?limit=${limit}`);
      const items = result?.data?.items ?? result?.items ?? [];

      return {
        content: [
          {
            type: 'text',
            text:
              `Found ${items.length} project(s):\n\n` +
              items
                .map(
                  (p) =>
                    `- [${p.status ?? '?'}] ${p.data?.title ?? p.title ?? '(untitled)'} ` +
                    `(${p.slug ?? '?'})${p.data?.category ? ` · ${p.data.category}` : ''}`
                )
                .join('\n'),
          },
        ],
      };
    }

    case 'delete_blog_post': {
      const { id, slug } = args;

      if (!id && !slug) {
        throw new Error('Either id or slug is required to delete a post');
      }

      // First, get the post to confirm it exists and get its ID
      const listResult = await emdashRequest('GET', `/_emdash/api/content/${COLLECTION}`);
      const items = listResult?.data?.items ?? listResult?.items ?? [];
      
      let postId = id;
      if (!postId && slug) {
        const found = items.find((p) => p.slug === slug);
        if (!found) {
          throw new Error(`Post with slug "${slug}" not found`);
        }
        postId = found.id;
      }

      // Delete the post
      await emdashRequest('DELETE', `/_emdash/api/content/${COLLECTION}/${postId}`, undefined);

      return {
        content: [
          {
            type: 'text',
            text: `Post deleted successfully.\n\nID: ${postId}${slug ? `\nSlug: ${slug}` : ''}`,
          },
        ],
      };
    }

    case 'clear_all_posts': {
      const { confirm } = args;

      if (confirm !== 'yes') {
        throw new Error('To clear all posts, you must confirm by passing confirm: "yes"');
      }

      const listResult = await emdashRequest('GET', `/_emdash/api/content/${COLLECTION}`);
      const items = listResult?.data?.items ?? listResult?.items ?? [];

      if (items.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No posts found to delete.',
            },
          ],
        };
      }

      // Delete all posts
      const deletedIds = [];
      for (const item of items) {
        await emdashRequest('DELETE', `/_emdash/api/content/${COLLECTION}/${item.id}`, undefined);
        deletedIds.push(item.id);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Deleted ${deletedIds.length} post(s):\n\n${deletedIds.map((id) => `- ${id}`).join('\n')}`,
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
