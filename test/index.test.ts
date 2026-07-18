import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { defaultNodes, nodeItemsFromNodes, nodesFromLect, parseMapData } from '../src/maps';
import { renderView } from '../src/templates/liquid';

interface PluginEnv {
  CMS_URL?: string;
  PLUGIN_SECRET?: string;
  VIEWS: Fetcher;
}

const plugin = worker as {
  fetch(request: Request, env: PluginEnv): Promise<Response>;
};

const SECRET = 'test-secret';

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

function env(overrides: Partial<PluginEnv> = {}): PluginEnv {
  return { VIEWS: views(), CMS_URL: 'https://cms.example.com', PLUGIN_SECRET: SECRET, ...overrides };
}

function adminRequest(path: string, init: RequestInit = {}, user?: Record<string, unknown>): Request {
  const headers = new Headers(init.headers);
  headers.set('x-plugin-secret', SECRET);
  if (user) headers.set('x-cms-user', JSON.stringify(user));
  return new Request(`https://plugin.example.com${path}`, { ...init, headers });
}

async function renderedText(response: Response): Promise<string> {
  if (response.headers.get('x-cms-client-view') !== '1') return response.text();
  const viewPath = response.headers.get('x-cms-view-path');
  if (!viewPath) throw new Error('Missing x-cms-view-path');
  const data = await response.clone().json() as Record<string, unknown>;
  return renderView(views(), viewPath, data);
}

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

function mockCms(handler: (method: string, url: URL, body: unknown) => unknown | Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, body });
    const result = handler(init?.method ?? 'GET', url, body);
    if (result instanceof Response) return result;
    return Response.json(result);
  });
  return calls;
}

const STORED_ITEMS = [
  { id: 'root', parent: '', text: 'Launch plan', _weight: 10 },
  { id: 'a', parent: 'root', text: 'Marketing', _weight: 20 },
  { id: 'b', parent: 'root', text: 'Engineering', _weight: 30 },
];

function mindmapPage(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    uuid: 'uuid-42',
    page_type: 'mindmap',
    name: 'Launch plan',
    slug: 'launch-plan',
    weight: 0,
    start: null,
    end: null,
    timezone: null,
    page_id: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-17T10:30:00Z',
    lect: { _type: 'mindmap', node: STORED_ITEMS },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('manifest', () => {
  it('serves the manifest with node items in the mindmap blueprint', async () => {
    const response = await plugin.fetch(new Request('https://plugin.example.com/__plugin/manifest'), env());
    expect(response.status).toBe(200);
    const manifest = await response.json() as Record<string, unknown>;
    expect(manifest.id).toBe('mindmap');
    // The native page editor handles mindmap pages with its stock structured
    // item UI, so there is deliberately no editViews override.
    expect(manifest.editViews).toBeUndefined();
    const blueprint = (manifest.contentTypes as { blueprint: Record<string, unknown> }).blueprint.mindmap as unknown[];
    expect(blueprint).toContainEqual({ node: ['@id', '@parent', '@text', 'display_text'] });
    expect(manifest.assets).toEqual([{ path: '/assets/mindmap-editor.js', label: 'Interactive mind map editor' }]);
  });
});

describe('view + asset serving', () => {
  it('serves the editor asset at the bare /assets path (approval fetch)', async () => {
    const response = await plugin.fetch(new Request('https://plugin.example.com/assets/mindmap-editor.js'), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toContain('data-mindmap');
  });

  it('serves the editor asset through the admin proxy path', async () => {
    const response = await plugin.fetch(adminRequest('/__plugin/admin/assets/mindmap-editor.js'), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
  });

  it('serves view templates for the composite resolver', async () => {
    const response = await plugin.fetch(new Request('https://plugin.example.com/__plugin/views/templates/map-edit.json'), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sections: { main: { type: 'map-edit' } }, order: ['main'] });
  });

  it('rejects admin calls without the plugin secret', async () => {
    const response = await plugin.fetch(new Request('https://plugin.example.com/__plugin/admin/maps'), env());
    expect(response.status).toBe(403);
  });
});

describe('maps list', () => {
  it('lists mindmap pages with node counts', async () => {
    mockCms((method, url) => {
      expect(method).toBe('GET');
      expect(url.pathname).toBe('/__cms/pages');
      expect(url.searchParams.get('page_type')).toBe('mindmap');
      return { pages: [mindmapPage()], total: 1 };
    });
    const response = await plugin.fetch(adminRequest('/__plugin/admin/maps'), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('Launch plan');
    expect(html).toContain('/admin/plugins/mindmap/maps/42');
    expect(html).toContain('>3</td>');
    expect(html).toContain('Create mind map');
  });

  it('hides create and delete from view-only users', async () => {
    mockCms(() => ({ pages: [mindmapPage()], total: 1 }));
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps', {}, { role: 'author', permissions: ['mindmap:view'] }),
      env(),
    );
    const html = await renderedText(response);
    expect(html).not.toContain('Create mind map');
    expect(html).not.toContain('/maps/42/delete');
  });

  it('forbids users without any mindmap access', async () => {
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps', {}, { role: 'author', permissions: [] }),
      env(),
    );
    expect(response.status).toBe(403);
  });
});

describe('create', () => {
  it('creates a page with a single root node item and redirects to the editor', async () => {
    const calls = mockCms((method, url) => {
      if (method === 'POST' && url.pathname === '/__cms/pages') {
        return { page: mindmapPage({ id: 77, name: 'Roadmap' }) };
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps/new', { method: 'POST', body: new URLSearchParams({ name: 'Roadmap' }) }),
      env(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/plugins/mindmap/maps/77');
    const created = calls[0].body as { page_type: string; name: string; lect: { node: unknown[] } };
    expect(created.page_type).toBe('mindmap');
    expect(created.name).toBe('Roadmap');
    expect(created.lect.node).toEqual([{ id: 'root', parent: '', text: 'Roadmap', display_text: {}, _weight: 10 }]);
  });

  it('forbids create for view-only users', async () => {
    mockCms(() => ({}));
    const response = await plugin.fetch(
      adminRequest(
        '/__plugin/admin/maps/new',
        { method: 'POST', body: new URLSearchParams({ name: 'Nope' }) },
        { role: 'author', permissions: ['mindmap:view'] },
      ),
      env(),
    );
    expect(response.status).toBe(403);
  });
});

describe('editor view', () => {
  it('renders the editor with the item-derived document, hooks and the script tag', async () => {
    mockCms((method, url) => {
      expect(`${method} ${url.pathname}`).toBe('GET /__cms/pages/42');
      return { page: mindmapPage() };
    });
    const response = await plugin.fetch(adminRequest('/__plugin/admin/maps/42'), env());
    expect(response.status).toBe(200);
    const data = await response.clone().json() as { data: string };
    expect(JSON.parse(data.data)).toEqual({
      nodes: [
        { id: 'root', text: 'Launch plan', parent: null },
        { id: 'a', text: 'Marketing', parent: 'root' },
        { id: 'b', text: 'Engineering', parent: 'root' },
      ],
    });
    const html = await renderedText(response);
    expect(html).toContain('data-mindmap');
    expect(html).toContain('name="data"');
    expect(html).toContain('/admin/plugins/mindmap/assets/mindmap-editor.js');
    expect(html).toContain('/admin/pages/42/edit?return_to=');
    expect(html).toContain('data-confirm');
    // No double-escaping: the JSON survives one HTML-escape round-trip.
    expect(html).toContain('&#34;root&#34;');
    expect(html).not.toContain('&amp;#34;');
  });

  it('falls back to a default root when the page has no node items yet', async () => {
    mockCms(() => ({ page: mindmapPage({ lect: { _type: 'mindmap', node: [{}] } }) }));
    const response = await plugin.fetch(adminRequest('/__plugin/admin/maps/42'), env());
    const data = await response.clone().json() as { data: string };
    expect(JSON.parse(data.data)).toEqual({ nodes: [{ id: 'root', text: 'Launch plan', parent: null }] });
  });

  it('returns 404 for a non-mindmap page', async () => {
    mockCms(() => ({ page: mindmapPage({ page_type: 'event' }) }));
    const response = await plugin.fetch(adminRequest('/__plugin/admin/maps/42'), env());
    expect(response.status).toBe(404);
  });

  it('renders read-only for view-only users (no toolbar buttons, disabled form)', async () => {
    mockCms(() => ({ page: mindmapPage() }));
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps/42', {}, { role: 'author', permissions: ['mindmap:view'] }),
      env(),
    );
    const html = await renderedText(response);
    expect(html).toContain('data-readonly="1"');
    expect(html).toContain('<fieldset disabled');
    expect(html).not.toContain('data-mm-add-child');
  });

  it('renders an error panel (HTTP 200) when the CMS call fails', async () => {
    mockCms(() => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));
    const response = await plugin.fetch(adminRequest('/__plugin/admin/maps/42'), env());
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('CMS responded 404 (not_found)');
  });
});

describe('save', () => {
  it('validates the document and stores it as complete node items', async () => {
    const calls = mockCms((method, url) => {
      if (method === 'GET') return { page: mindmapPage() };
      if (method === 'PUT' && url.pathname === '/__cms/pages/42') return { page: mindmapPage() };
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    const submitted = JSON.stringify({
      nodes: [
        { id: 'root', text: 'Launch plan v2', parent: null },
        { id: 'b', text: 'Engineering', parent: 'root' },
        { id: 'a', text: 'Marketing', parent: 'b', junk: 'dropped' },
      ],
    });
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps/42', {
        method: 'POST',
        body: new URLSearchParams({ name: 'Launch plan v2', data: submitted }),
      }),
      env(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/mindmap/maps/42');
    const put = calls.find((call) => call.method === 'PUT')!;
    const body = put.body as { name: string; lect: { node: unknown[] } };
    expect(body.name).toBe('Launch plan v2');
    // Complete items in editor order, weights re-issued: the host merges item
    // arrays by index, so every key must be present on every item.
    expect(body.lect.node).toEqual([
      { id: 'root', parent: '', text: 'Launch plan v2', display_text: {}, _weight: 10 },
      { id: 'b', parent: 'root', text: 'Engineering', display_text: {}, _weight: 20 },
      { id: 'a', parent: 'b', text: 'Marketing', display_text: {}, _weight: 30 },
    ]);
  });

  it('carries display_text translations by node id, padded to the languages in use', async () => {
    const calls = mockCms((method, url) => {
      if (method === 'GET') {
        return {
          page: mindmapPage({
            lect: {
              _type: 'mindmap',
              node: [
                { id: 'root', parent: '', text: 'Launch plan', display_text: { en: 'Launch', 'zh-hant': '發佈' }, _weight: 10 },
                { id: 'a', parent: 'root', text: 'Marketing', display_text: { en: 'Mkt' }, _weight: 20 },
                { id: 'b', parent: 'root', text: 'Engineering', _weight: 30 },
              ],
            },
          }),
        };
      }
      if (method === 'PUT' && url.pathname === '/__cms/pages/42') return { page: mindmapPage() };
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    // Reorder branches and add a new node; the editor JSON knows nothing
    // about display_text.
    const submitted = JSON.stringify({
      nodes: [
        { id: 'root', text: 'Launch plan', parent: null },
        { id: 'b', text: 'Engineering', parent: 'root' },
        { id: 'a', text: 'Marketing', parent: 'root' },
        { id: 'new1', text: 'Fresh idea', parent: 'a' },
      ],
    });
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps/42', {
        method: 'POST',
        body: new URLSearchParams({ name: 'Launch plan', data: submitted }),
      }),
      env(),
    );
    expect(response.status).toBe(302);
    const put = calls.find((call) => call.method === 'PUT')!;
    const body = put.body as { lect: { node: Array<Record<string, unknown>> } };
    // Translations follow their node, and every item carries every language
    // in use ('' when untranslated) so the host's index/key-wise merge cannot
    // leak a translation from a previous index occupant.
    expect(body.lect.node).toEqual([
      { id: 'root', parent: '', text: 'Launch plan', display_text: { en: 'Launch', 'zh-hant': '發佈' }, _weight: 10 },
      { id: 'b', parent: 'root', text: 'Engineering', display_text: { en: '', 'zh-hant': '' }, _weight: 20 },
      { id: 'a', parent: 'root', text: 'Marketing', display_text: { en: 'Mkt', 'zh-hant': '' }, _weight: 30 },
      { id: 'new1', parent: 'a', text: 'Fresh idea', display_text: { en: '', 'zh-hant': '' }, _weight: 40 },
    ]);
  });

  it('re-renders the editor with the submitted JSON on validation errors', async () => {
    const calls = mockCms(() => ({ page: mindmapPage() }));
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps/42', {
        method: 'POST',
        body: new URLSearchParams({ name: 'Launch plan', data: '{"nodes": []}' }),
      }),
      env(),
    );
    expect(response.status).toBe(200);
    const html = await renderedText(response);
    expect(html).toContain('non-empty');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('forbids saving for view-only users', async () => {
    mockCms(() => ({ page: mindmapPage() }));
    const response = await plugin.fetch(
      adminRequest(
        '/__plugin/admin/maps/42',
        { method: 'POST', body: new URLSearchParams({ data: '{"nodes": []}' }) },
        { role: 'author', permissions: ['mindmap:view'] },
      ),
      env(),
    );
    expect(response.status).toBe(403);
  });
});

describe('delete', () => {
  it('removes the page and redirects to the list', async () => {
    const calls = mockCms((method, url) => {
      if (method === 'GET') return { page: mindmapPage() };
      if (method === 'DELETE' && url.pathname === '/__cms/pages/42') return { ok: true };
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    const response = await plugin.fetch(
      adminRequest('/__plugin/admin/maps/42/delete', { method: 'POST' }),
      env(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/plugins/mindmap/maps?flash=');
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });
});

describe('nodesFromLect (defensive reads of native edits)', () => {
  it('reads items ordered by weight and maps the root to parent null', () => {
    expect(nodesFromLect({ node: STORED_ITEMS })).toEqual([
      { id: 'root', text: 'Launch plan', parent: null },
      { id: 'a', text: 'Marketing', parent: 'root' },
      { id: 'b', text: 'Engineering', parent: 'root' },
    ]);
  });

  it('drops blueprint-seeded empty items and duplicate ids', () => {
    const nodes = nodesFromLect({
      node: [
        {},
        { id: 'root', parent: '', text: 'Root' },
        { id: 'root', parent: '', text: 'Duplicate' },
        { id: 'a', parent: 'root', text: 'Child' },
      ],
    });
    expect(nodes).toEqual([
      { id: 'root', text: 'Root', parent: null },
      { id: 'a', text: 'Child', parent: 'root' },
    ]);
  });

  it('reattaches orphans, self-parents, extra roots and cycles to the root', () => {
    const nodes = nodesFromLect({
      node: [
        { id: 'root', parent: '', text: 'Root', _weight: 10 },
        { id: 'orphan', parent: 'missing', text: 'Orphan', _weight: 20 },
        { id: 'selfie', parent: 'selfie', text: 'Self', _weight: 30 },
        { id: 'x', parent: 'y', text: 'X', _weight: 40 },
        { id: 'y', parent: 'x', text: 'Y', _weight: 50 },
        { id: 'root2', parent: '', text: 'Second root', _weight: 60 },
      ],
    });
    expect(nodes.find((node) => node.id === 'orphan')?.parent).toBe('root');
    expect(nodes.find((node) => node.id === 'selfie')?.parent).toBe('root');
    expect(nodes.find((node) => node.id === 'x')?.parent).toBe('root');
    expect(nodes.find((node) => node.id === 'root2')?.parent).toBe('root');
    expect(nodes.filter((node) => node.parent === null)).toHaveLength(1);
  });

  it('coerces a drifted localized text record to its first value', () => {
    const nodes = nodesFromLect({ node: [{ id: 'root', parent: '', text: { en: 'Hello', 'zh-hant': '你好' } }] });
    expect(nodes[0].text).toBe('Hello');
  });

  it('returns an empty list when only seeded items exist', () => {
    expect(nodesFromLect({ node: [{}] })).toEqual([]);
    expect(nodesFromLect({})).toEqual([]);
  });
});

describe('parseMapData + item building', () => {
  it('accepts a valid document and strips unknown keys', () => {
    const result = parseMapData(JSON.stringify({
      nodes: [
        { id: 'root', text: 'Root', parent: null, x: 1 },
        { id: 'a', text: 'Child', parent: 'root' },
      ],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nodeCount).toBe(2);
      expect(result.nodes[0]).toEqual({ id: 'root', text: 'Root', parent: null });
      expect(nodeItemsFromNodes(result.nodes)).toEqual([
        { id: 'root', parent: '', text: 'Root', display_text: {}, _weight: 10 },
        { id: 'a', parent: 'root', text: 'Child', display_text: {}, _weight: 20 },
      ]);
    }
  });

  it.each([
    ['not json', 'not valid JSON'],
    ['{"nodes": []}', 'non-empty'],
    ['{"nodes": [{"id": "a", "text": "", "parent": null}, {"id": "a", "text": "", "parent": "a"}]}', 'Duplicate'],
    ['{"nodes": [{"id": "a", "text": "", "parent": "b"}]}', 'parent'],
    ['{"nodes": [{"id": "a", "text": "", "parent": null}, {"id": "b", "text": "", "parent": null}]}', 'Exactly one'],
    [
      JSON.stringify({
        nodes: [
          { id: 'root', text: '', parent: null },
          { id: 'a', text: '', parent: 'b' },
          { id: 'b', text: '', parent: 'a' },
        ],
      }),
      'not connected',
    ],
  ])('rejects invalid input %#', (raw, message) => {
    const result = parseMapData(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it('builds a default document from the map name', () => {
    expect(defaultNodes('My map')).toEqual([{ id: 'root', text: 'My map', parent: null }]);
  });
});
