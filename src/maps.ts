// ============================================================
// Mind map admin handlers.
//
// Each mind map is one CMS page (page_type "mindmap"). Every node/branch is
// one lect ITEM under `node`, per the blueprint
// { node: [@id, @parent, @text, display_text] }:
//   lect.node = [ { id: "root", parent: "", text: "Central topic",
//                   display_text: { en: "…", "zh-hant": "…" }, _weight: 10 }, … ]
// The root's parent is "". `text` is the canonical label this plugin's editor
// works on; `display_text` is the localized value editors can update in the
// map or native editor (renderers show display_text for the viewer's language
// and fall back to text). Because nodes are blueprint items, the NATIVE page
// editor edits them with its stock item UI, while this plugin renders the same
// items as an interactive SVG mind map (views/assets/mindmap-editor.js) with a
// raw-JSON textarea fallback ({ nodes: [{ id, text, parent, displayText? }] },
// root parent null), so the map stays editable before the JS asset is approved.
//
// Two merge-semantics constraints shape this file (host utils/lect.ts
// deepMergeLect merges arrays BY INDEX, incoming length wins):
//   - Saves must write COMPLETE items (id/parent/text/display_text/_weight all
//     present) so a reordered/deleted row can never inherit stale keys from
//     whatever item previously sat at its index. Localized maps merge KEY-wise
//     on top of that, so display_text is written with every language key seen
//     anywhere in the map ('' when untranslated) — a missing key would
//     resurrect the previous index occupant's translation on the wrong node.
//   - Reads must be defensive: the native editor can produce empty seeded
//     items, duplicate ids, orphan parents or cycles; nodesFromLect normalizes
//     all of those onto the root instead of refusing to render.
// ============================================================

import {
  adminView,
  items,
  redirect,
  type CmsClient,
  type CmsPage,
} from '@lionrockjs/worker-cms-plugin';
import type { MindmapAccess } from './permissions';
import { forbidden } from './permissions';

export const PLUGIN_ID = 'mindmap';
export const ADMIN_BASE = `/admin/plugins/${PLUGIN_ID}`;
export const PAGE_TYPE = 'mindmap';
const EDITOR_ASSET_HREF = `${ADMIN_BASE}/assets/mindmap-editor.js`;

const MAX_NODES = 2000;
const MAX_TEXT_LENGTH = 500;
const MAX_ID_LENGTH = 64;
const MAX_RAW_BYTES = 256 * 1024;

export interface MindmapNode {
  id: string;
  text: string;
  parent: string | null;
  /** Locale code → translated display label. Omitted when no locale is set. */
  displayText?: Record<string, string>;
}

type ParsedMapData =
  | { ok: true; nodes: MindmapNode[]; nodeCount: number }
  | { ok: false; error: string };

export function defaultNodes(rootText: string): MindmapNode[] {
  const text = rootText.trim().slice(0, MAX_TEXT_LENGTH) || 'Central topic';
  return [{ id: 'root', text, parent: null }];
}

/**
 * Reads the `node` lect items into the editor's node list, normalizing
 * whatever the native structured editor may have produced: blueprint-seeded
 * empty items are dropped, duplicate ids keep their first row, and orphan
 * parents, self-parents and cycles are reattached to the root.
 */
export function nodesFromLect(lect: Record<string, unknown>): MindmapNode[] {
  const seen = new Set<string>();
  const rows: Array<{ id: string; parent: string; text: string; displayText: Record<string, string>; weight: number }> = [];
  for (const item of items(lect, 'node')) {
    const id = str(item.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      parent: str(item.parent).trim(),
      text: scalarText(item.text),
      displayText: displayTextMap(item.display_text),
      weight: Number(item._weight),
    });
  }
  if (!rows.length) return [];
  // Stable by-weight order: rows without a numeric weight sort last, ties keep
  // item order (matching how the host sorts items).
  rows.sort((a, b) => (Number.isFinite(a.weight) ? a.weight : Number.MAX_SAFE_INTEGER)
    - (Number.isFinite(b.weight) ? b.weight : Number.MAX_SAFE_INTEGER));

  const root = rows.find((row) => !row.parent) ?? rows[0];
  const nodes: MindmapNode[] = rows.map((row) => {
    const node: MindmapNode = {
      id: row.id,
      text: row.text,
      parent: row === root
        ? null
        : row.parent && row.parent !== row.id && seen.has(row.parent) ? row.parent : root.id,
    };
    if (Object.keys(row.displayText).length) node.displayText = row.displayText;
    return node;
  });

  // Break cycles: anything not reachable from the root becomes a root child.
  const childrenOf = new Map<string, MindmapNode[]>();
  for (const node of nodes) {
    if (node.parent === null) continue;
    const list = childrenOf.get(node.parent) ?? [];
    list.push(node);
    childrenOf.set(node.parent, list);
  }
  const reachable = new Set<string>([root.id]);
  const queue = [root.id];
  while (queue.length) {
    for (const child of childrenOf.get(queue.pop()!) ?? []) {
      if (reachable.has(child.id)) continue;
      reachable.add(child.id);
      queue.push(child.id);
    }
  }
  for (const node of nodes) {
    if (!reachable.has(node.id)) node.parent = root.id;
  }
  return nodes;
}

/**
 * Node list → complete `node` lect items. Every key is written on every item
 * (see the merge-semantics note in the header) and weights are re-issued in
 * editor order so the native editor lists nodes the way the map shows them.
 *
 * Translations from the editor document override stored values BY NODE ID;
 * old documents without `displayText` preserve their stored translations.
 * Every item is padded to the union of languages in use so the host's key-wise
 * map merge cannot leak another node's translation into this index.
 */
export function nodeItemsFromNodes(
  nodes: MindmapNode[],
  storedLect: Record<string, unknown> = {},
): Array<Record<string, unknown>> {
  const storedDisplay = new Map<string, Record<string, string>>();
  const languages = new Set<string>();
  for (const item of items(storedLect, 'node')) {
    const id = str(item.id).trim();
    const display = displayTextMap(item.display_text);
    if (id && !storedDisplay.has(id)) storedDisplay.set(id, display);
    for (const language of Object.keys(display)) languages.add(language);
  }
  for (const node of nodes) {
    for (const language of Object.keys(node.displayText ?? {})) languages.add(language);
  }

  return nodes.map((node, index) => {
    const stored = storedDisplay.get(node.id) ?? {};
    const submitted = node.displayText;
    const displayText: Record<string, string> = {};
    for (const language of languages) {
      displayText[language] = submitted && Object.hasOwn(submitted, language)
        ? submitted[language]
        : stored[language] ?? '';
    }
    return {
      id: node.id,
      parent: node.parent ?? '',
      text: node.text,
      display_text: displayText,
      _weight: (index + 1) * 10,
    };
  });
}

function displayTextMap(value: unknown): Record<string, string> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const [language, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') out[language] = entry;
    }
    return out;
  }
  // A bare string can appear if the field drifted through a scalar blueprint;
  // its language is unknown, so park it under the default language.
  if (typeof value === 'string' && value) return { en: value };
  return {};
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  // A localized record can appear if the field was ever edited under a
  // blueprint drift; coerce to the first language value.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const first = Object.values(value as Record<string, unknown>)[0];
    return typeof first === 'string' ? first : '';
  }
  return '';
}

/**
 * Validates and normalizes a submitted mind map JSON document. Output nodes
 * carry only validated node data so client-invented keys never reach the lect.
 */
export function parseMapData(raw: string): ParsedMapData {
  if (raw.length > MAX_RAW_BYTES) return { ok: false, error: 'Mind map data is too large (256 KB max).' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Mind map data is not valid JSON.' };
  }
  const nodesRaw = (parsed as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    return { ok: false, error: 'Mind map data must be an object with a non-empty "nodes" array.' };
  }
  if (nodesRaw.length > MAX_NODES) return { ok: false, error: `A mind map holds at most ${MAX_NODES} nodes.` };

  const nodes: MindmapNode[] = [];
  const ids = new Set<string>();
  for (const entry of nodesRaw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, error: 'Every node must be an object.' };
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || id.length > MAX_ID_LENGTH) return { ok: false, error: 'Every node needs a string "id" (64 chars max).' };
    if (ids.has(id)) return { ok: false, error: `Duplicate node id "${id}".` };
    ids.add(id);
    const text = typeof record.text === 'string' ? record.text.slice(0, MAX_TEXT_LENGTH) : '';
    const parent = record.parent == null ? null : typeof record.parent === 'string' ? record.parent : '';
    if (parent === '') return { ok: false, error: `Node "${id}" has an invalid parent reference.` };
    const displayText = parseDisplayText(record.displayText);
    if (displayText === null) {
      return { ok: false, error: `Node "${id}" has invalid display text translations.` };
    }
    const node: MindmapNode = { id, text, parent };
    if (Object.keys(displayText).length) node.displayText = displayText;
    nodes.push(node);
  }

  const roots = nodes.filter((node) => node.parent === null);
  if (roots.length !== 1) return { ok: false, error: 'Exactly one node must have "parent": null (the root).' };
  for (const node of nodes) {
    if (node.parent !== null && !ids.has(node.parent)) {
      return { ok: false, error: `Node "${node.id}" points at a missing parent "${node.parent}".` };
    }
    if (node.parent === node.id) return { ok: false, error: `Node "${node.id}" cannot be its own parent.` };
  }

  // Everything must be reachable from the root, or the document contains a
  // cycle (a → b → a) that the parent-exists check alone would let through.
  const children = new Map<string, MindmapNode[]>();
  for (const node of nodes) {
    if (node.parent === null) continue;
    const list = children.get(node.parent) ?? [];
    list.push(node);
    children.set(node.parent, list);
  }
  const reachable = new Set<string>();
  const queue = [roots[0]];
  while (queue.length) {
    const node = queue.pop()!;
    if (reachable.has(node.id)) continue;
    reachable.add(node.id);
    for (const child of children.get(node.id) ?? []) queue.push(child);
  }
  if (reachable.size !== nodes.length) {
    return { ok: false, error: 'Mind map contains nodes that are not connected to the root (cycle or orphan).' };
  }

  return { ok: true, nodes, nodeCount: nodes.length };
}

function parseDisplayText(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const displayText: Record<string, string> = {};
  for (const [language, translation] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,31}$/i.test(language) || typeof translation !== 'string') return null;
    displayText[language] = translation.slice(0, MAX_TEXT_LENGTH);
  }
  return displayText;
}

function pageNodes(page: CmsPage): MindmapNode[] {
  const nodes = nodesFromLect(page.lect ?? {});
  return nodes.length ? nodes : defaultNodes(page.name);
}

function docJson(nodes: MindmapNode[]): string {
  return JSON.stringify({ nodes }, null, 2);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function formatDate(value: string): string {
  return value ? value.replace('T', ' ').slice(0, 16) : '';
}

// ── Views ──────────────────────────────────────────────────────────────────

async function listView(
  cms: CmsClient,
  views: Fetcher,
  access: MindmapAccess,
  flash: string,
  jsonOnly: boolean,
): Promise<Response> {
  const { pages } = await cms.list(PAGE_TYPE, { limit: 200 });
  return adminView(views, 'Mind maps', 'maps', {
    title: 'Mind maps',
    flash,
    canEdit: access.canEdit,
    newAction: `${ADMIN_BASE}/maps/new`,
    maps: pages.map((page) => ({
      name: page.name,
      editHref: `/admin/pages/${page.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/maps`)}`,
      deleteAction: access.canEdit ? `${ADMIN_BASE}/maps/${page.id}/delete` : '',
      nodeCount: nodesFromLect(page.lect ?? {}).length,
      updated: formatDate(page.updated_at),
    })),
  }, jsonOnly);
}

interface EditorViewOptions {
  flash?: string;
  errors?: string[];
  /** Preserve the user's submitted (invalid) JSON instead of the stored one. */
  rawData?: string;
  /** CMS edit-view context. Omitted for the legacy plugin-admin form. */
  cmsPage?: {
    action: string;
    backHref: string;
    slug: string;
    weight: number;
    start: string | null;
    end: string | null;
    timezone: string | null;
    editors: string | null;
    language: string;
    languages: string[];
    fields: Array<{ name: string; value: string }>;
  };
}

function editorView(
  views: Fetcher,
  page: { id: number | string; name: string },
  nodes: MindmapNode[],
  access: MindmapAccess,
  jsonOnly: boolean,
  options: EditorViewOptions = {},
): Promise<Response> {
  const cmsPage = options.cmsPage;
  return adminView(views, page.name || 'Mind map', 'map-edit', {
    title: page.name || 'Mind map',
    name: page.name,
    data: options.rawData ?? docJson(nodes),
    action: cmsPage?.action ?? `${ADMIN_BASE}/maps/${page.id}`,
    backHref: cmsPage?.backHref ?? `${ADMIN_BASE}/maps`,
    deleteAction: access.canEdit
      ? cmsPage ? `/admin/pages/${page.id}/delete` : `${ADMIN_BASE}/maps/${page.id}/delete`
      : '',
    saveLabel: cmsPage ? 'Save changes' : 'Save',
    deleteLabel: cmsPage ? 'Delete' : 'Delete mind map',
    deleteConfirm: cmsPage
      ? 'Delete this mind map? It will be moved to trash and can be restored later.'
      : 'Delete this mind map? This cannot be undone.',
    cmsEditor: !!cmsPage,
    pageType: PAGE_TYPE,
    slug: cmsPage?.slug ?? '',
    weight: cmsPage?.weight ?? 0,
    start: cmsPage?.start ?? '',
    end: cmsPage?.end ?? '',
    timezone: cmsPage?.timezone ?? '',
    editors: cmsPage?.editors ?? '',
    language: cmsPage?.language ?? 'mis',
    languages: cmsPage?.languages ?? [cmsPage?.language ?? 'mis'],
    cmsFields: cmsPage?.fields ?? [],
    fallbackAction: cmsPage ? `${ADMIN_BASE}/maps/${page.id}` : '',
    readOnly: !access.canEdit,
    flash: options.flash ?? '',
    errors: options.errors ?? [],
    assetHref: EDITOR_ASSET_HREF,
  }, jsonOnly);
}

interface EditViewContext {
  mode: 'new' | 'edit';
  action: string;
  backHref: string;
  language: string;
  pageType: string;
  page: {
    id: number | string;
    name: string;
    slug: string;
    weight: number;
    start: string | null;
    end: string | null;
    timezone: string | null;
    editors: string | null;
    lect: string;
  };
  flash?: string;
  errors?: string[];
}

/** Renders the visual editor at the CMS's standard /admin/pages/:id/edit URL. */
export async function handleMindmapEditView(
  request: Request,
  views: Fetcher,
  loadLanguages?: () => Promise<string[]>,
): Promise<Response> {
  const context = await request.json().catch(() => null) as EditViewContext | null;
  if (!context || context.mode !== 'edit' || context.pageType !== PAGE_TYPE) {
    return new Response('not found', { status: 404 });
  }

  const requestedLanguage = context.language || 'mis';
  let languages = [requestedLanguage];
  if (loadLanguages) {
    try {
      languages = await loadLanguages();
    } catch (error) {
      console.error('Could not load CMS content languages:', error);
    }
  }
  const language = languages.includes(requestedLanguage) ? requestedLanguage : languages[0];

  const lect = parseLect(context.page.lect);
  const storedNodes = nodesFromLect(lect);
  const nodes = storedNodes.length ? storedNodes : defaultNodes(context.page.name);
  const fields = cmsNodeFields(nodes, lect);

  return editorView(
    views,
    context.page,
    nodes,
    { canView: true, canEdit: true },
    false,
    {
      flash: context.flash,
      errors: context.errors,
      cmsPage: {
        action: context.action,
        backHref: context.backHref || `${ADMIN_BASE}/maps`,
        slug: context.page.slug,
        weight: context.page.weight,
        start: context.page.start,
        end: context.page.end,
        timezone: context.page.timezone,
        editors: context.page.editors,
        language,
        languages,
        fields,
      },
    },
  );
}

/** Flattens node items into the field names parsed by Worker CMS postToLect. */
export function cmsNodeFields(
  nodes: MindmapNode[],
  storedLect: Record<string, unknown> = {},
): Array<{ name: string; value: string }> {
  const fields: Array<{ name: string; value: string }> = [];
  for (const [index, item] of nodeItemsFromNodes(nodes, storedLect).entries()) {
    const prefix = `.node[${index}]`;
    for (const attribute of ['id', 'parent', 'text', '_weight'] as const) {
      fields.push({ name: `${prefix}@${attribute}`, value: String(item[attribute] ?? '') });
    }
    const displayText = displayTextMap(item.display_text);
    for (const [language, value] of Object.entries(displayText)) {
      fields.push({ name: `${prefix}.display_text|${language}`, value });
    }
  }
  return fields;
}

function parseLect(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

// ── Admin routing: /admin/plugins/mindmap/maps/… ───────────────────────────

export async function handleMapsAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  segments: string[],
  url: URL,
  jsonOnly: boolean,
  access: MindmapAccess,
): Promise<Response> {
  const [idSegment, action] = segments;

  if (!idSegment) {
    return listView(cms, views, access, url.searchParams.get('flash') ?? '', jsonOnly);
  }

  if (idSegment === 'new') {
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/maps`);
    if (!access.canEdit) return forbidden();
    const form = await request.formData();
    const name = str(form.get('name')).trim().slice(0, 200) || 'Untitled mind map';
    const page = await cms.create({
      page_type: PAGE_TYPE,
      name,
      lect: { _type: PAGE_TYPE, node: nodeItemsFromNodes(defaultNodes(name)) },
    });
    return redirect(`/admin/pages/${page.id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/maps`)}`);
  }

  const id = Number.parseInt(idSegment, 10);
  if (!Number.isFinite(id) || id <= 0) return new Response('not found', { status: 404 });
  const page = await cms.get(id);
  if (page.page_type !== PAGE_TYPE) return new Response('not found', { status: 404 });

  if (action === 'delete') {
    if (request.method !== 'POST') return redirect(`${ADMIN_BASE}/maps/${id}`);
    if (!access.canEdit) return forbidden();
    await cms.remove(id);
    return redirect(`${ADMIN_BASE}/maps?flash=${encodeURIComponent('Mind map deleted')}`);
  }

  if (action) return new Response('not found', { status: 404 });

  if (request.method === 'POST') {
    if (!access.canEdit) return forbidden();
    const form = await request.formData();
    const name = str(form.get('name')).trim().slice(0, 200) || page.name;
    const slug = str(form.get('slug')).trim().slice(0, 200);
    const raw = str(form.get('data'));
    const parsed = parseMapData(raw);
    if (!parsed.ok) {
      return editorView(views, { ...page, name }, pageNodes(page), access, jsonOnly, {
        errors: [parsed.error],
        rawData: raw,
      });
    }
    await cms.update(id, {
      name,
      ...(slug ? { slug } : {}),
      lect: { node: nodeItemsFromNodes(parsed.nodes, page.lect ?? {}) },
    });
    return redirect(`/admin/pages/${id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/maps`)}&flash=${encodeURIComponent('Mind map saved')}`);
  }

  return redirect(`/admin/pages/${id}/edit?return_to=${encodeURIComponent(`${ADMIN_BASE}/maps`)}`);
}
