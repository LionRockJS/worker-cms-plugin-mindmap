# worker-cms-plugin-mindmap

A Workers CMS plugin that stores each mind map as a CMS page (page_type
`mindmap`) and edits it visually: an interactive SVG mind map editor in the
admin, with a raw-JSON textarea as the no-JS fallback.

## What you get

- **Mind Maps admin section** (`/admin/plugins/mindmap/maps`): list, create,
  open, delete. Existing maps open at the standard CMS page-edit URL, where
  this plugin overrides the edit view with the visual editor.
- **Visual editor**: two-sided auto-layout tree, pan/zoom, click to select,
  Tab = add child, Enter = add sibling, double-click/F2 = edit the label and
  translations, Delete = remove a branch, drag a node onto another node to
  move it.
- **Native editing too**: every node is a lect *item*, so `?native=1` on the
  standard page-edit URL opens the CMS stock structured item UI for the same
  data.

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
works on; `display_text` is the localized value editors can update in the
mind-map dialog or native page editor — renderers should show `display_text`
for the viewer's language and fall back to `text`. The plugin's editor
exchanges the tree as JSON (`{ "nodes": [{ "id", "text", "parent",
"displayText" }] }`, root parent `null`) in its fallback textarea. Existing
locale keys appear in the dialog's CMS-style Language selector, and editors
can add another locale code.

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
- **Page edit override**: `editViews: ["mindmap"]` makes the CMS request
  `/__plugin/edit` for existing mind-map pages. The enhanced form posts to the
  normal CMS page-update action using native field names such as
  `.node[0]@text` and `.node[0].display_text|mis`, preserving its version and
  hook behavior.
- **Plugin → host**: pages are read/written through the Plugin API at
  `{CMS_URL}/__cms/*`.
- Views are LiquidJS fragments styled with the host's compiled Tailwind
  subset; the editor JS ships through the manifest asset pipeline
  (declare → admin approval → SRI-pinned serving).

### Reusable UI pattern: Inline Page Identity Header

Use this name for the Event-style editable page identity: a large borderless
title input with a slash-prefixed monospace slug directly underneath. The slug
tracks title edits until the editor manually changes it. This pattern suits
focused create/edit views where the page identity should replace a separate
static heading and boxed Name field.

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
