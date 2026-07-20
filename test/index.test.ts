import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  headers: Headers;
  body: unknown;
}

function mockCms(handler: (method: string, url: URL, body: unknown) => unknown | Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      headers: new Headers(init?.headers),
      body,
    });
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
    expect(manifest.editViews).toEqual(['mindmap']);
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
    const script = await response.text();
    expect(script).toContain('data-mindmap');
    expect(script).toContain("document.querySelector('[data-mm-flash]')");
    expect(script).toContain('}, 4000);');
    expect(script).toContain("rootText: light ? '#ffffff' : '#0a0e17'");
    expect(script).toContain("nodeFill: light ? '#ffffff' : '#141a26'");
    expect(script).toContain('inputs[i].style.background = COLORS.selectedFill');
    expect(script).toContain('inputs[i].style.color = COLORS.nodeText');
    expect(script).toContain("translationHeading.textContent = 'Display text'");
    expect(script).toContain("languageLabel.textContent = 'Language'");
    expect(script).toContain("languageSelect.setAttribute('aria-label', 'Display text language')");
    expect(script).toContain("host.getAttribute('data-mm-languages')");
    expect(script).toContain('var languages = supportedLanguages');
    expect(script).not.toContain('+ Add language');
    expect(script).not.toContain('window.prompt');
    expect(script).toContain('entry.displayText');
    expect(script).toContain("form.querySelector('[data-mm-cms-fields]')");
    expect(script).toContain("prefix + '.display_text|' + languageCode");
    expect(script).toContain("document.getElementById('mindmap-name')");
    expect(script).toContain("document.getElementById('mindmap-slug')");
    expect(script).toContain('var slugEdited = false');
    expect(script).toContain(".replace(/[^a-z0-9]+/g, '-')");
    expect(script).toContain("saveButton.removeAttribute('formaction')");
    expect(script).toContain("'data-mm-node-action': kind");
    expect(script).toContain("nodeActionButton('add-child'");
    expect(script).toContain("nodeActionButton('delete'");
    expect(script).toContain('var canDelete = node.parent !== null');
    expect(script).toContain('if (selected && !readOnly) appendNodeActions');
    expect(script).toContain('var DOUBLE_CLICK_MS = 450');
    expect(script).toContain('lastNodeClick.id === current.id');
    expect(script).toContain('if (doubleClick) startEditing(current.id, true)');
    expect(script).toContain("attributeFilter: ['data-theme']");
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

  it('serves the English locale through public and admin view paths', async () => {
    const publicResponse = await plugin.fetch(
      new Request('https://plugin.example.com/__plugin/views/locales/en.json?r=worker-version'),
      env(),
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toEqual({ plugins: { mindmap: { nav: { maps: 'Mind Maps' } } } });

    const adminResponse = await plugin.fetch(
      adminRequest('/__plugin/admin/views/locales/en.json?r=worker-version'),
      env(),
    );
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toEqual({ plugins: { mindmap: { nav: { maps: 'Mind Maps' } } } });
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
    expect(html).toContain('/admin/pages/42/edit?return_to=%2Fadmin%2Fplugins%2Fmindmap%2Fmaps');
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
    expect(response.headers.get('location')).toBe('/admin/pages/77/edit?return_to=%2Fadmin%2Fplugins%2Fmindmap%2Fmaps');
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

describe('editor view override', () => {
  let metadataCalls: RecordedCall[];

  beforeEach(() => {
    metadataCalls = mockCms((method, url) => {
      if (method === 'GET' && url.pathname === '/__cms/content-meta') {
        expect(url.searchParams.get('types')).toBe('mindmap');
        return { languages: ['mis', 'en', 'zh-hant', 'zh-hans'], default_language: 'mis' };
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
  });

  function editViewRequest(
    overrides: Record<string, unknown> = {},
    user?: Record<string, unknown>,
  ): Request {
    return adminRequest('/__plugin/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'edit',
        action: '/admin/pages/42',
        backHref: '/admin/plugins/mindmap/maps',
        language: 'mis',
        pageType: 'mindmap',
        page: {
          id: 42,
          name: 'Launch plan',
          slug: 'launch-plan',
          pageType: 'mindmap',
          weight: 7,
          start: null,
          end: null,
          timezone: '+0800',
          editors: '2,3',
          lect: JSON.stringify({
            _type: 'mindmap',
            description: { mis: 'Plan' },
            node: [
              { ...STORED_ITEMS[0], display_text: { mis: 'Launch plan' } },
              ...STORED_ITEMS.slice(1),
            ],
          }),
        },
        versions: [],
        ...overrides,
      }),
    }, user);
  }

  it('renders the visual editor for the standard CMS edit route', async () => {
    const response = await plugin.fetch(editViewRequest(), env());
    expect(response.status).toBe(200);
    const data = await response.clone().json() as {
      data: string;
      action: string;
      languages: string[];
      cmsFields: Array<{ name: string; value: string }>;
    };
    expect(JSON.parse(data.data)).toEqual({
      nodes: [
        { id: 'root', text: 'Launch plan', parent: null, displayText: { mis: 'Launch plan' } },
        { id: 'a', text: 'Marketing', parent: 'root' },
        { id: 'b', text: 'Engineering', parent: 'root' },
      ],
    });
    expect(data.action).toBe('/admin/pages/42');
    expect(data.languages).toEqual(['mis', 'en', 'zh-hant', 'zh-hans']);
    expect(metadataCalls.map((call) => call.path)).toContain('/__cms/content-meta?types=mindmap');
    const metadataCall = metadataCalls.find((call) => call.path.startsWith('/__cms/content-meta'))!;
    expect(metadataCall.headers.get('x-plugin-id')).toBe('mindmap');
    expect(metadataCall.headers.get('x-plugin-secret')).toBe(SECRET);
    expect(Object.fromEntries(data.cmsFields.map((field) => [field.name, field.value]))).toMatchObject({
      '.node[0]@id': 'root',
      '.node[0]@parent': '',
      '.node[0]@text': 'Launch plan',
      '.node[0]@_weight': '10',
      '.node[0].display_text|mis': 'Launch plan',
      '.node[1]@id': 'a',
    });
    const html = await renderedText(response);
    expect(html).toContain('data-mindmap');
    expect(html).toContain('data-mm-language="mis"');
    expect(html).toContain('data-mm-languages="mis,en,zh-hant,zh-hans"');
    expect(html).not.toContain('data-mm-add-child');
    expect(html).not.toContain('data-mm-add-sibling');
    expect(html).not.toContain('data-mm-rename');
    expect(html).not.toContain('data-mm-delete');
    expect(html).toContain('name="data"');
    expect(html).not.toContain('name="lect_json"');
    expect(html).toContain('name=".node[0]@id" value="root"');
    expect(html).toContain('name=".node[0].display_text|mis" value="Launch plan"');
    expect(html).toContain('id="mindmap-name"');
    expect(html).toContain('text-2xl font-bold');
    expect(html).toContain('id="mindmap-slug"');
    expect(html).toContain('name="slug" value="launch-plan"');
    expect(html).not.toContain('<input type="hidden" name="slug"');
    expect(html).toContain('name="weight" value="7"');
    expect(html).toContain('name="editors" value="2,3"');
    expect(html).toContain('action="/admin/pages/42"');
    expect(html).toContain('formaction="/admin/plugins/mindmap/maps/42"');
    expect(html).toContain('action="/admin/pages/42/delete"');
    expect(html).toContain('Save changes');
    expect(html).toMatch(/>\s*Cancel\s*<\/a>/);
    expect(html).toContain('form="mindmap-delete-form"');
    expect(html).toMatch(/>\s*Delete\s*<\/button>/);
    expect(html).toContain('sticky bottom-4');
    expect(html).toContain('/admin/plugins/mindmap/assets/mindmap-editor.js');
    expect(html).toContain('data-confirm');
    // No double-escaping: the JSON survives one HTML-escape round-trip.
    expect(html).toContain('&#34;root&#34;');
    expect(html).not.toContain('&amp;#34;');
  });

  it('falls back to a default root when the page has no node items yet', async () => {
    const response = await plugin.fetch(editViewRequest({
      page: {
        id: 42,
        name: 'Launch plan',
        slug: 'launch-plan',
        pageType: 'mindmap',
        weight: 0,
        start: null,
        end: null,
        timezone: null,
        editors: null,
        lect: JSON.stringify({ _type: 'mindmap', node: [{}] }),
      },
    }), env());
    const data = await response.clone().json() as { data: string };
    expect(JSON.parse(data.data)).toEqual({ nodes: [{ id: 'root', text: 'Launch plan', parent: null }] });
  });

  it('marks flash messages for automatic dismissal', async () => {
    const response = await plugin.fetch(editViewRequest({ flash: 'Changes saved' }), env());
    const html = await renderedText(response);
    expect(html).toContain('data-mm-flash');
    expect(html).toContain('Changes saved');
  });

  it('declines new and non-mindmap views so the CMS can use its built-in editor', async () => {
    const response = await plugin.fetch(editViewRequest({ mode: 'new' }), env());
    expect(response.status).toBe(404);
    const wrongType = await plugin.fetch(editViewRequest({ pageType: 'event' }), env());
    expect(wrongType.status).toBe(404);
  });

  it('forbids the override for view-only users', async () => {
    const response = await plugin.fetch(
      editViewRequest({}, { role: 'author', permissions: ['mindmap:view'] }),
      env(),
    );
    expect(response.status).toBe(403);
  });

  it('redirects the old plugin editor URL to the standard CMS edit URL', async () => {
    mockCms(() => ({ page: mindmapPage() }));
    const response = await plugin.fetch(adminRequest('/__plugin/admin/maps/42'), env());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/pages/42/edit?return_to=%2Fadmin%2Fplugins%2Fmindmap%2Fmaps');
  });

  it('requires plugin authentication for the edit-view endpoint', async () => {
    const response = await plugin.fetch(new Request('https://plugin.example.com/__plugin/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }), env());
    expect(response.status).toBe(403);
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
        body: new URLSearchParams({ name: 'Launch plan v2', slug: 'launch-plan-v2', data: submitted }),
      }),
      env(),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/admin/pages/42/edit');
    const put = calls.find((call) => call.method === 'PUT')!;
    const body = put.body as { name: string; slug: string; lect: { node: unknown[] } };
    expect(body.name).toBe('Launch plan v2');
    expect(body.slug).toBe('launch-plan-v2');
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

  it('updates display_text translations submitted by the visual editor', async () => {
    const calls = mockCms((method, url) => {
      if (method === 'GET') {
        return {
          page: mindmapPage({
            lect: {
              _type: 'mindmap',
              node: [
                { id: 'root', parent: '', text: 'Launch plan', display_text: { en: 'Launch', 'zh-hant': '發佈' }, _weight: 10 },
                { id: 'a', parent: 'root', text: 'Marketing', display_text: { en: 'Mkt', 'zh-hant': '行銷' }, _weight: 20 },
              ],
            },
          }),
        };
      }
      if (method === 'PUT' && url.pathname === '/__cms/pages/42') return { page: mindmapPage() };
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    const submitted = JSON.stringify({
      nodes: [
        { id: 'root', text: 'Launch plan', parent: null, displayText: { en: 'Launch v2', 'zh-hant': '新版發佈' } },
        { id: 'a', text: 'Marketing', parent: 'root', displayText: { en: '', 'zh-hant': '市場推廣' } },
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
    const body = put.body as { lect: { node: unknown[] } };
    expect(body.lect.node).toEqual([
      { id: 'root', parent: '', text: 'Launch plan', display_text: { en: 'Launch v2', 'zh-hant': '新版發佈' }, _weight: 10 },
      { id: 'a', parent: 'root', text: 'Marketing', display_text: { en: '', 'zh-hant': '市場推廣' }, _weight: 20 },
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

  it('exposes each node display_text map to the visual editor', () => {
    expect(nodesFromLect({
      node: [{ id: 'root', parent: '', text: 'Root', display_text: { en: 'Root', 'zh-hant': '根節點' } }],
    })).toEqual([{ id: 'root', text: 'Root', parent: null, displayText: { en: 'Root', 'zh-hant': '根節點' } }]);
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

  it('accepts validated display text translations', () => {
    const result = parseMapData(JSON.stringify({
      nodes: [
        { id: 'root', text: 'Root', parent: null, displayText: { en: 'Root', 'zh-hant': '根節點' } },
        { id: 'a', text: 'Child', parent: 'root', displayText: { en: '' } },
      ],
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nodes).toEqual([
        { id: 'root', text: 'Root', parent: null, displayText: { en: 'Root', 'zh-hant': '根節點' } },
        { id: 'a', text: 'Child', parent: 'root', displayText: { en: '' } },
      ]);
      expect(nodeItemsFromNodes(result.nodes)).toEqual([
        { id: 'root', parent: '', text: 'Root', display_text: { en: 'Root', 'zh-hant': '根節點' }, _weight: 10 },
        { id: 'a', parent: 'root', text: 'Child', display_text: { en: '', 'zh-hant': '' }, _weight: 20 },
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
