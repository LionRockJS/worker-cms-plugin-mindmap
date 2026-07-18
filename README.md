# worker-cms-plugin-mindmap

A Workers CMS plugin that stores each mind map as a CMS page (page_type
`mindmap`) and edits it visually: an interactive SVG mind map editor in the
admin, with a raw-JSON textarea as the no-JS fallback.

## What you get

- **Mind Maps admin section** (`/admin/plugins/mindmap/maps`): list, create,
  open, delete.
- **Visual editor**: two-sided auto-layout tree, pan/zoom, click to select,
  Tab = add child, Enter = add sibling, double-click/F2 = rename,
  Delete = remove a branch, drag a node onto another node to move it.
- **Native editing too**: every node is a lect *item*, so the CMS's own page
  editor edits the same nodes with its stock structured item UI ("Open in
  page editor" from the mind map view).

## Data model

Every node/branch is one lect item under `node`, per the blueprint
`{ "node": ["@id", "@parent", "@text", "display_text"] }`:

```json
{
  "node": [
    { "id": "root", "parent": "", "text": "Central topic",
      "display_text": { "en": "Central topic", "zh-hant": "中心主題" }, "_weight": 10 },
    { "id": "n1", "parent": "root", "text": "First idea",
      "display_text": {}, "_weight": 20 }
  ]
}
```

The root's `parent` is empty; every other node points at an existing node id;
`_weight` orders siblings. `text` is the canonical label the mind map editor
works on; `display_text` is the localized value translators fill in through
the native page editor — renderers should show `display_text` for the
viewer's language and fall back to `text`. The plugin's editor exchanges the
tree as JSON (`{ "nodes": [{ "id", "text", "parent" }] }`, root parent
`null`) in its fallback textarea; translations never pass through it and are
carried over by node id on save.

Saves through the plugin are validated (single root, no cycles/orphans, size
caps — [src/maps.ts](src/maps.ts) `parseMapData`) and always write complete
items, because the host merges item arrays by index. Reads are defensive:
whatever the native editor produced (seeded empty items, duplicate ids,
orphan parents, cycles) is normalized onto the root instead of failing
(`nodesFromLect`). Node `text` is deliberately a scalar attribute, and
`display_text` is written padded to the union of languages in use (`""` when
untranslated) — under the host's index-based array merge and key-wise map
merge, a missing language key would leak another node's translation into
this index.

## Architecture

This is a separate Cloudflare Worker from the host CMS:

- **Host → plugin**: the CMS proxies `/admin/plugins/mindmap/<rest>` to this
  Worker's `/__plugin/admin/<rest>` with `x-plugin-secret` + `x-cms-user`,
  and wraps `x-cms-chrome: 1` fragments in the admin shell.
- **Plugin → host**: pages are read/written through the Plugin API at
  `{CMS_URL}/__cms/*`.
- Views are LiquidJS fragments styled with the host's compiled Tailwind
  subset; the editor JS ships through the manifest asset pipeline
  (declare → admin approval → SRI-pinned serving).

## Setup

1. Deploy: `npm install && npm run deploy`, then
   `wrangler secret put PLUGIN_SECRET` (must match the secret the CMS holds
   for this plugin).
2. Host CMS `wrangler.toml`:
   ```toml
   [[services]]
   binding = "PLUGIN_MINDMAP"
   service = "worker-cms-plugin-mindmap"
   ```
   and add the binding name to the `PLUGINS` var.
3. In the CMS admin, register the plugin, then **approve the editor asset**
   under Plugins → mindmap → assets (`/assets/mindmap-editor.js`). Until it is
   approved — and again after every deploy that changes the file — the admin
   falls back to the raw-JSON editor.

Local dev: copy `.dev.vars.example` to `.dev.vars`, point `CMS_URL` at the
local CMS dev server, and run both `wrangler dev`s.

## Development

- `npm run typecheck && npm test` — unit tests drive the Worker with a mocked
  Plugin API (no host needed).
- [dev/harness.html](dev/harness.html) — standalone page for iterating on the
  editor without a CMS: serve the repo root (`python3 -m http.server`) and
  open `/dev/harness.html`.
