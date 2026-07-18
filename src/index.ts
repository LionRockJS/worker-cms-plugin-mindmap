// ============================================================
// Worker CMS plugin — mind maps.
//
// Each mind map is a CMS page (page_type "mindmap") whose nodes are lect
// items ({ node: [@id, @parent, @text] }), so the NATIVE page editor edits
// them with its stock item UI while this Worker's admin views render the same
// items as an interactive SVG mind map (list + editor).
//
// Host → plugin: the CMS proxies /admin/plugins/mindmap/<rest> to
// /__plugin/admin/<rest> with x-plugin-secret + x-cms-user. Plugin → host:
// pages are read/written through the Plugin API at {CMS_URL}/__cms/*.
// ============================================================

import {
  adminView,
  CmsApiError,
  CmsClient,
  CmsNotConfiguredError,
  redirect,
  requireTenant,
  serveViewAsset,
  tenantClientEnv,
} from '@lionrockjs/worker-cms-plugin';
import { handleMapsAdmin, handleMindmapEditView } from './maps';
import { forbidden, mindmapAccessForRequest } from './permissions';
// The plugin manifest (content type, nav, permissions, assets, editViews) is
// plain data, served verbatim at /__plugin/manifest.
import MANIFEST from './manifest.json';

interface PluginEnv {
  PLUGIN_SECRET?: string;
  /** Base URL of the CMS Worker (Plugin API), e.g. https://cms.example.com */
  CMS_URL?: string;
  /** Multi-tenant registry: `tenant:<cms origin>` → TenantConfig JSON. When
   *  unbound, CMS_URL + PLUGIN_SECRET form the single legacy tenant. */
  TENANTS?: KVNamespace;
  /** Plugin-owned Liquid templates and the editor JS asset. */
  VIEWS: Fetcher;
  /** Deploy identifier exposed in the manifest to invalidate cached views. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}

export default {
  async fetch(request: Request, baseEnv: PluginEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Secret-authenticated host calls resolve their tenant (x-cms-tenant +
    // x-plugin-secret verified against the SAME registry row), then all
    // downstream code runs against a tenant-scoped env.
    let env = baseEnv;
    const secretRequired = path.startsWith('/__plugin/admin') || path === '/__plugin/edit';
    if (secretRequired) {
      const tenant = await requireTenant(request, baseEnv);
      if (tenant instanceof Response) return tenant;
      env = tenantClientEnv(baseEnv, tenant);
    }

    if (path === '/__plugin/manifest') {
      return Response.json({
        ...MANIFEST,
        ...(baseEnv.CF_VERSION_METADATA ? { workerVersion: baseEnv.CF_VERSION_METADATA } : {}),
      });
    }

    // Plugin-owned view templates, served to the CMS's composite view resolver.
    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    // Static assets declared in the manifest. The bare /assets/ path is what
    // the CMS fetches for asset approval and every hash-verified serve — it
    // must answer here even though run_worker_first routes it to the Worker.
    if (path.startsWith('/assets/')) {
      return serveViewAsset(env.VIEWS, path);
    }

    if (path === '/__plugin/edit' && request.method === 'POST') {
      const access = mindmapAccessForRequest(request);
      if (!access.canEdit) return forbidden();
      return handleMindmapEditView(request, env.VIEWS);
    }

    if (path.startsWith('/__plugin/admin')) {
      return handleAdmin(request, env, url);
    }

    return new Response('not found', { status: 404 });
  },
};

async function handleAdmin(request: Request, env: PluginEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'maps';
  const jsonOnly = wantsJson(url);

  if (section === 'assets') {
    return serveViewAsset(env.VIEWS, `/assets/${segments.slice(1).join('/')}`);
  }
  if (section === 'views') {
    return serveViewAsset(env.VIEWS, `/${segments.slice(1).join('/')}`, { bareLiquidSnippets: true });
  }

  let cms: CmsClient;
  try {
    cms = new CmsClient(env, 'mindmap');
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) return errorPanel(env.VIEWS, error.message, jsonOnly);
    throw error;
  }

  const access = mindmapAccessForRequest(request);
  if (!access.canView) return forbidden();

  // Each handler is awaited so a CmsApiError it throws is rendered as an
  // error panel rather than escaping as an unhandled 500.
  try {
    if (section === 'maps') {
      return await handleMapsAdmin(request, cms, env.VIEWS, segments.slice(1), url, jsonOnly, access);
    }
    return redirect('/admin/plugins/mindmap/maps');
  } catch (error) {
    if (error instanceof CmsApiError) {
      return errorPanel(env.VIEWS, `CMS responded ${error.status} (${error.code}).`, jsonOnly);
    }
    throw error;
  }
}

function errorPanel(views: Fetcher, message: string, jsonOnly = false): Promise<Response> {
  return adminView(views, 'Error', 'error', { heading: 'Something went wrong', message }, jsonOnly);
}

function wantsJson(url: URL): boolean {
  const json = url.searchParams.get('json')?.trim().toLowerCase();
  const format = url.searchParams.get('format')?.trim().toLowerCase();
  return format === 'json' || (url.searchParams.has('json') && json !== '0' && json !== 'false');
}
