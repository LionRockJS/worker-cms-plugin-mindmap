// Interactive mind map editor for the Workers CMS mindmap plugin.
//
// Progressive enhancement over the raw-JSON textarea ([data-mm-source]): this
// script parses the document, unhides the SVG canvas + toolbar, and writes
// every change back to the textarea so the surrounding form submits the same
// field with or without JavaScript. If the document does not parse, the
// textarea stays visible and this script backs off.
//
// No dependencies, no inline handlers (the host admin runs a strict CSP).
(function () {
  'use strict';

  var flash = document.querySelector('[data-mm-flash]');
  if (flash) {
    window.setTimeout(function () {
      flash.remove();
    }, 4000);
  }

  var host = document.querySelector('[data-mindmap]');
  if (!host) return;
  var source = host.querySelector('[data-mm-source]');
  var canvas = host.querySelector('[data-mm-canvas]');
  var toolbar = host.querySelector('[data-mm-toolbar]');
  var fallback = host.querySelector('[data-mm-fallback]');
  if (!source || !canvas || !toolbar || !fallback) return;

  var readOnly = host.getAttribute('data-readonly') === '1';
  var activeLanguage = host.getAttribute('data-mm-language') || 'mis';
  var form = source.form || host.closest('form');
  var cmsFields = form && form.querySelector('[data-mm-cms-fields]');
  var dirtyBadge = document.querySelector('[data-mm-dirty]');
  var nameInput = document.getElementById('mindmap-name');
  var slugInput = document.getElementById('mindmap-slug');

  // Inline Page Identity Header: mirror the Event create view. The slug tracks
  // the title until the editor explicitly changes the slug in this session.
  if (nameInput && slugInput) {
    var slugEdited = false;
    slugInput.addEventListener('input', function () { slugEdited = true; });
    nameInput.addEventListener('input', function () {
      if (slugEdited) return;
      slugInput.value = nameInput.value.toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    });
  }

  // ── Document state ───────────────────────────────────────────────────────
  var nodes = parseDocument(source.value);
  if (!nodes) return; // invalid JSON: leave the textarea as the editor

  var selectedId = rootNode().id;
  var dirty = false;

  // When this approved asset is unavailable, the Save button posts the raw
  // document to the legacy plugin handler. Once enhancement succeeds, submit
  // through the CMS action so normal versions/hooks are preserved.
  var saveButton = form && form.querySelector('[data-mm-save]');
  if (saveButton) saveButton.removeAttribute('formaction');

  function parseDocument(raw) {
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    if (!parsed || !Array.isArray(parsed.nodes) || !parsed.nodes.length) return null;
    var seen = {};
    var list = [];
    var rootCount = 0;
    for (var i = 0; i < parsed.nodes.length; i++) {
      var entry = parsed.nodes[i];
      if (!entry || typeof entry.id !== 'string' || !entry.id || seen[entry.id]) return null;
      seen[entry.id] = true;
      var parent = entry.parent == null ? null : String(entry.parent);
      if (parent === null) rootCount++;
      var displayText = {};
      if (entry.displayText !== undefined) {
        if (!entry.displayText || typeof entry.displayText !== 'object' || Array.isArray(entry.displayText)) return null;
        for (var language in entry.displayText) {
          if (!/^[a-z][a-z0-9-]{0,31}$/i.test(language) || typeof entry.displayText[language] !== 'string') return null;
          displayText[language] = entry.displayText[language].slice(0, 500);
        }
      }
      var node = { id: entry.id, text: typeof entry.text === 'string' ? entry.text : '', parent: parent };
      if (Object.keys(displayText).length) node.displayText = displayText;
      list.push(node);
    }
    if (rootCount !== 1) return null;
    for (var j = 0; j < list.length; j++) {
      if (list[j].parent !== null && !seen[list[j].parent]) return null;
    }
    return list;
  }

  function rootNode() {
    for (var i = 0; i < nodes.length; i++) if (nodes[i].parent === null) return nodes[i];
    return nodes[0];
  }

  function nodeById(id) {
    for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
    return null;
  }

  function childrenOf(id) {
    var out = [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].parent === id) out.push(nodes[i]);
    return out;
  }

  function isDescendant(candidateId, ancestorId) {
    var node = nodeById(candidateId);
    while (node && node.parent !== null) {
      if (node.parent === ancestorId) return true;
      node = nodeById(node.parent);
    }
    return false;
  }

  function newId() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // Older engines (and some automation drivers) report legacy key names.
  var LEGACY_KEYS = {
    Return: 'Enter', '\r': 'Enter', Esc: 'Escape', Del: 'Delete',
    Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  };

  function keyName(event) {
    return LEGACY_KEYS[event.key] || event.key;
  }

  function syncSource() {
    source.value = JSON.stringify({ nodes: nodes }, null, 2);
    syncCmsFields();
  }

  function syncCmsFields() {
    if (!cmsFields) return;
    while (cmsFields.firstChild) cmsFields.removeChild(cmsFields.firstChild);
    var languages = {};
    for (var i = 0; i < nodes.length; i++) {
      var translations = nodes[i].displayText || {};
      for (var language in translations) languages[language] = true;
    }
    var languageList = Object.keys(languages);
    for (var nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      var node = nodes[nodeIndex];
      var prefix = '.node[' + nodeIndex + ']';
      appendCmsField(prefix + '@id', node.id);
      appendCmsField(prefix + '@parent', node.parent === null ? '' : node.parent);
      appendCmsField(prefix + '@text', node.text);
      appendCmsField(prefix + '@_weight', String((nodeIndex + 1) * 10));
      for (var languageIndex = 0; languageIndex < languageList.length; languageIndex++) {
        var languageCode = languageList[languageIndex];
        var displayText = node.displayText && Object.prototype.hasOwnProperty.call(node.displayText, languageCode)
          ? node.displayText[languageCode]
          : '';
        appendCmsField(prefix + '.display_text|' + languageCode, displayText);
      }
    }
  }

  function appendCmsField(name, value) {
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    cmsFields.appendChild(input);
  }

  function markDirty() {
    dirty = true;
    if (dirtyBadge) dirtyBadge.hidden = false;
  }

  if (form) form.addEventListener('submit', syncSource);

  // ── Text measurement ─────────────────────────────────────────────────────
  var FONT = '13px ui-sans-serif, system-ui, -apple-system, sans-serif';
  var ROOT_FONT = '600 14px ui-sans-serif, system-ui, -apple-system, sans-serif';
  var LINE_H = 18;
  var PAD_X = 12;
  var PAD_Y = 8;
  var MAX_TEXT_W = 220;
  var MAX_LINES = 8;
  var H_GAP = 56;
  var V_GAP = 14;

  var measureCtx = document.createElement('canvas').getContext('2d');

  function wrapText(text, font) {
    measureCtx.font = font;
    var label = String(text || '').replace(/\s+/g, ' ').trim() || ' ';
    var words = label.split(' ');
    var lines = [];
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var candidate = line ? line + ' ' + words[i] : words[i];
      if (measureCtx.measureText(candidate).width <= MAX_TEXT_W || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = words[i];
      }
      if (lines.length === MAX_LINES) break;
    }
    if (lines.length < MAX_LINES && line) lines.push(line);
    else if (lines.length === MAX_LINES) lines[MAX_LINES - 1] += '…';
    var width = 0;
    for (var j = 0; j < lines.length; j++) {
      width = Math.max(width, measureCtx.measureText(lines[j]).width);
    }
    return { lines: lines, w: Math.min(Math.ceil(width), MAX_TEXT_W) + PAD_X * 2, h: lines.length * LINE_H + PAD_Y * 2 };
  }

  // ── Layout: two-sided tidy tree ──────────────────────────────────────────
  // Root at (0,0); first-level branches are assigned greedily to the lighter
  // side, subtrees stack outward. Returns {id → {x, y, w, h, lines, side}}.
  function layoutMap() {
    var out = {};
    var root = rootNode();
    var rootSize = wrapText(root.text, ROOT_FONT);
    out[root.id] = { x: 0, y: 0, w: rootSize.w, h: rootSize.h, lines: rootSize.lines, side: 0 };

    var branches = childrenOf(root.id);
    var sides = { '1': [], '-1': [] };
    var weights = { '1': 0, '-1': 0 };
    for (var i = 0; i < branches.length; i++) {
      var side = weights['1'] <= weights['-1'] ? '1' : '-1';
      sides[side].push(branches[i]);
      weights[side] += leafCount(branches[i].id);
    }

    layoutSide(sides['1'], 1, out, root);
    layoutSide(sides['-1'], -1, out, root);
    return out;
  }

  function leafCount(id) {
    var children = childrenOf(id);
    if (!children.length) return 1;
    var total = 0;
    for (var i = 0; i < children.length; i++) total += leafCount(children[i].id);
    return total;
  }

  function layoutSide(branches, dir, out, root) {
    if (!branches.length) return;
    var cursor = { y: 0 };
    for (var i = 0; i < branches.length; i++) placeSubtree(branches[i], dir, out, cursor);
    // Center the side's vertical span on the root.
    var min = Infinity;
    var max = -Infinity;
    for (var j = 0; j < branches.length; j++) {
      var span = subtreeSpan(branches[j].id, out);
      min = Math.min(min, span[0]);
      max = Math.max(max, span[1]);
    }
    var shift = (min + max) / 2;
    for (var k = 0; k < branches.length; k++) shiftSubtree(branches[k].id, out, -shift);
    // Horizontal positions relative to each node's parent.
    for (var m = 0; m < branches.length; m++) placeX(branches[m], out[root.id], dir, out);
  }

  function placeSubtree(node, dir, out, cursor) {
    var size = wrapText(node.text, FONT);
    var children = childrenOf(node.id);
    if (!children.length) {
      out[node.id] = { x: 0, y: cursor.y + size.h / 2, w: size.w, h: size.h, lines: size.lines, side: dir };
      cursor.y += size.h + V_GAP;
      return;
    }
    for (var i = 0; i < children.length; i++) placeSubtree(children[i], dir, out, cursor);
    var first = out[children[0].id];
    var last = out[children[children.length - 1].id];
    out[node.id] = {
      x: 0,
      y: (first.y + last.y) / 2,
      w: size.w,
      h: size.h,
      lines: size.lines,
      side: dir,
    };
  }

  function subtreeSpan(id, out) {
    var box = out[id];
    var min = box.y - box.h / 2;
    var max = box.y + box.h / 2;
    var children = childrenOf(id);
    for (var i = 0; i < children.length; i++) {
      var span = subtreeSpan(children[i].id, out);
      min = Math.min(min, span[0]);
      max = Math.max(max, span[1]);
    }
    return [min, max];
  }

  function shiftSubtree(id, out, delta) {
    out[id].y += delta;
    var children = childrenOf(id);
    for (var i = 0; i < children.length; i++) shiftSubtree(children[i].id, out, delta);
  }

  function placeX(node, parentBox, dir, out) {
    var box = out[node.id];
    box.x = parentBox.x + dir * (parentBox.w / 2 + H_GAP + box.w / 2);
    var children = childrenOf(node.id);
    for (var i = 0; i < children.length; i++) placeX(children[i], box, dir, out);
  }

  // ── SVG rendering ────────────────────────────────────────────────────────
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var view = { tx: 0, ty: 0, scale: 1 };

  var svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.display = 'block';
  svg.style.cursor = 'grab';
  svg.style.touchAction = 'none';
  var world = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(world);
  canvas.appendChild(svg);
  canvas.setAttribute('tabindex', '0');
  canvas.style.outline = 'none';

  function colorsForTheme() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return {
      edge: 'var(--color-gray-300, ' + (light ? '#d1d5db' : '#323d4e') + ')',
      rootFill: 'var(--color-indigo-600, ' + (light ? '#4f46e5' : '#cbef34') + ')',
      // The dark CMS theme maps indigo to bright lime, which needs dark ink.
      rootText: light ? '#ffffff' : '#0a0e17',
      // Pair the theme's inverted gray text token with its actual card surface.
      nodeFill: light ? '#ffffff' : '#141a26',
      nodeStroke: 'var(--color-gray-300, ' + (light ? '#d1d5db' : '#323d4e') + ')',
      nodeText: 'var(--color-gray-900, ' + (light ? '#111827' : '#eef2f9') + ')',
      selectedStroke: 'var(--color-indigo-600, ' + (light ? '#4f46e5' : '#cbef34') + ')',
      selectedFill: 'var(--color-indigo-50, ' + (light ? '#eef2ff' : '#1b240c') + ')',
      dropStroke: 'var(--color-indigo-600, ' + (light ? '#4f46e5' : '#cbef34') + ')',
      dangerFill: 'var(--color-red-600, ' + (light ? '#dc2626' : '#f1566f') + ')',
      dangerText: light ? '#ffffff' : '#0a0e17',
    };
  }

  var COLORS = colorsForTheme();

  var boxes = {};

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function nodeActionButton(kind, nodeId, x, label, fill, ink) {
    var button = el('g', {
      transform: 'translate(' + x + ' 0)',
      role: 'button',
      tabindex: '0',
      'aria-label': label,
      'data-mm-node-action': kind,
    });
    button.style.cursor = 'pointer';

    var title = el('title', {});
    title.textContent = label;
    button.appendChild(title);
    button.appendChild(el('rect', {
      width: 22,
      height: 22,
      rx: 6,
      fill: fill,
      stroke: COLORS.nodeFill,
      'stroke-width': '1.5',
    }));

    if (kind === 'add-child') {
      button.appendChild(el('path', {
        d: 'M 7 11 H 15 M 11 7 V 15',
        fill: 'none',
        stroke: ink,
        'stroke-width': '1.8',
        'stroke-linecap': 'round',
      }));
    } else {
      button.appendChild(el('path', {
        d: 'M 6.5 7.5 H 15.5 M 9 7.5 V 6 H 13 V 7.5 M 8 9.5 L 8.7 16 H 13.3 L 14 9.5',
        fill: 'none',
        stroke: ink,
        'stroke-width': '1.5',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }));
    }

    function activate(event) {
      event.preventDefault();
      event.stopPropagation();
      if (kind === 'add-child') addChild(nodeId);
      else deleteNode(nodeId);
    }

    button.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    button.addEventListener('click', activate);
    button.addEventListener('dblclick', function (event) { event.stopPropagation(); });
    button.addEventListener('keydown', function (event) {
      var key = keyName(event);
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') activate(event);
    });
    return button;
  }

  function appendNodeActions(group, node, box) {
    var canDelete = node.parent !== null;
    var count = canDelete ? 2 : 1;
    var size = 22;
    var gap = 4;
    var width = count * size + (count - 1) * gap;
    var actions = el('g', {
      transform: 'translate(' + (box.w / 2 - width) + ' ' + (-box.h / 2 - 28) + ')',
      'data-mm-node-actions': node.id,
    });
    actions.appendChild(nodeActionButton('add-child', node.id, 0, 'Add child', COLORS.selectedStroke, COLORS.rootText));
    if (canDelete) {
      actions.appendChild(nodeActionButton('delete', node.id, size + gap, 'Delete node', COLORS.dangerFill, COLORS.dangerText));
    }
    group.appendChild(actions);
  }

  function applyView() {
    world.setAttribute('transform', 'translate(' + view.tx + ' ' + view.ty + ') scale(' + view.scale + ')');
  }

  function render() {
    boxes = layoutMap();
    while (world.firstChild) world.removeChild(world.firstChild);

    var edges = el('g', {});
    var items = el('g', {});
    world.appendChild(edges);
    world.appendChild(items);

    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var box = boxes[node.id];
      if (!box) continue;

      if (node.parent !== null && boxes[node.parent]) {
        var parentBox = boxes[node.parent];
        var dir = box.side || 1;
        var x1 = parentBox.x + dir * parentBox.w / 2;
        var y1 = parentBox.y;
        var x2 = box.x - dir * box.w / 2;
        var y2 = box.y;
        var mid = (x1 + x2) / 2;
        edges.appendChild(el('path', {
          d: 'M ' + x1 + ' ' + y1 + ' C ' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2,
          fill: 'none',
          stroke: COLORS.edge,
          'stroke-width': '1.5',
        }));
      }

      var isRoot = node.parent === null;
      var selected = node.id === selectedId;
      var group = el('g', { transform: 'translate(' + box.x + ' ' + box.y + ')' });
      group.setAttribute('data-node-id', node.id);
      group.style.cursor = 'pointer';

      var rect = el('rect', {
        x: -box.w / 2,
        y: -box.h / 2,
        width: box.w,
        height: box.h,
        rx: 9,
        fill: isRoot ? COLORS.rootFill : selected ? COLORS.selectedFill : COLORS.nodeFill,
        stroke: selected ? COLORS.selectedStroke : isRoot ? COLORS.rootFill : COLORS.nodeStroke,
        'stroke-width': selected ? '2' : '1',
      });
      rect.setAttribute('data-node-rect', node.id);
      group.appendChild(rect);

      var text = el('text', {
        'text-anchor': 'middle',
        fill: isRoot ? COLORS.rootText : COLORS.nodeText,
        style: 'font:' + (isRoot ? ROOT_FONT : FONT) + ';user-select:none;pointer-events:none',
      });
      var startY = -((box.lines.length - 1) * LINE_H) / 2;
      for (var j = 0; j < box.lines.length; j++) {
        var span = el('tspan', { x: 0, y: startY + j * LINE_H, 'dominant-baseline': 'central' });
        span.textContent = box.lines[j];
        text.appendChild(span);
      }
      group.appendChild(text);
      if (selected && !readOnly) appendNodeActions(group, node, box);
      items.appendChild(group);
    }
    applyView();
  }

  // ── Mutations ────────────────────────────────────────────────────────────
  function commit() {
    syncSource();
    markDirty();
    render();
  }

  function addChild(parentId) {
    var node = { id: newId(), text: 'New idea', parent: parentId };
    nodes.push(node);
    selectedId = node.id;
    commit();
    startEditing(node.id, true);
  }

  function addSibling(id) {
    var node = nodeById(id);
    if (!node) return;
    addChild(node.parent === null ? node.id : node.parent);
  }

  function deleteNode(id) {
    var node = nodeById(id);
    if (!node || node.parent === null) return; // the root stays
    var doomed = { };
    doomed[id] = true;
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].parent !== null && doomed[nodes[i].parent] && !doomed[nodes[i].id]) {
          doomed[nodes[i].id] = true;
          changed = true;
        }
      }
    }
    var parentId = node.parent;
    nodes = nodes.filter(function (entry) { return !doomed[entry.id]; });
    selectedId = parentId;
    commit();
  }

  function reparent(id, newParentId) {
    var node = nodeById(id);
    if (!node || node.parent === null) return;
    if (id === newParentId || isDescendant(newParentId, id)) return;
    // Move the entry to the end of the array so it becomes the last sibling.
    nodes = nodes.filter(function (entry) { return entry.id !== id; });
    node.parent = newParentId;
    nodes.push(node);
    commit();
  }

  // ── Node editor ──────────────────────────────────────────────────────────
  var editor = null;

  function applyEditorColors(element) {
    element.style.background = COLORS.nodeFill;
    element.style.color = COLORS.nodeText;
    element.style.borderColor = COLORS.selectedStroke;
    var inputs = element.querySelectorAll('[data-mm-editor-input]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].style.background = COLORS.selectedFill;
      inputs[i].style.color = COLORS.nodeText;
      inputs[i].style.borderColor = COLORS.nodeStroke;
      inputs[i].style.caretColor = COLORS.selectedStroke;
    }
    var save = element.querySelector('[data-mm-editor-save]');
    if (save) {
      save.style.background = COLORS.selectedStroke;
      save.style.color = COLORS.rootText;
    }
  }

  function editorInput(value, label, placeholder) {
    var input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.maxLength = 500;
    input.placeholder = placeholder || '';
    input.setAttribute('aria-label', label);
    input.setAttribute('data-mm-editor-input', '1');
    input.style.cssText = 'display:block;box-sizing:border-box;width:100%;padding:7px 9px;border:1px solid;'
      + 'border-radius:6px;font:13px ui-sans-serif,system-ui,sans-serif;';
    return input;
  }

  function knownDisplayLanguages() {
    var languages = {};
    languages[activeLanguage] = true;
    for (var i = 0; i < nodes.length; i++) {
      var displayText = nodes[i].displayText || {};
      for (var language in displayText) languages[language] = true;
    }
    return Object.keys(languages).sort();
  }

  function selectOption(select, language) {
    var option = document.createElement('option');
    option.value = language;
    option.textContent = language;
    select.appendChild(option);
  }

  function startEditing(id, selectAll) {
    if (readOnly) return;
    var node = nodeById(id);
    if (!node) return;
    stopEditing(false);

    var dialog = document.createElement('div');
    dialog.setAttribute('data-mm-editing', id);
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Edit node text');
    dialog.style.cssText = 'position:absolute;z-index:20;left:50%;top:50%;transform:translate(-50%,-50%);'
      + 'box-sizing:border-box;width:min(32rem,calc(100% - 2rem));max-height:calc(100% - 2rem);overflow:auto;'
      + 'padding:16px;border:1px solid;border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,.32)';

    var heading = document.createElement('h2');
    heading.textContent = 'Edit node';
    heading.style.cssText = 'margin:0 0 12px;font:600 15px ui-sans-serif,system-ui,sans-serif';
    dialog.appendChild(heading);
    var primaryLabel = document.createElement('label');
    primaryLabel.textContent = 'Text';
    primaryLabel.style.cssText = 'display:block;font:600 12px ui-sans-serif,system-ui,sans-serif;margin-bottom:5px';
    dialog.appendChild(primaryLabel);
    var textInput = editorInput(node.text, 'Text');
    dialog.appendChild(textInput);

    var translationHeader = document.createElement('div');
    translationHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px';
    var translationHeading = document.createElement('span');
    translationHeading.textContent = 'Display text';
    translationHeading.style.cssText = 'font:600 12px ui-sans-serif,system-ui,sans-serif';
    translationHeader.appendChild(translationHeading);

    var languageLabel = document.createElement('label');
    languageLabel.textContent = 'Language';
    languageLabel.style.cssText = 'display:flex;min-width:0;align-items:center;gap:8px;font:12px ui-sans-serif,system-ui,sans-serif;opacity:.78';
    var languageSelect = document.createElement('select');
    languageSelect.setAttribute('aria-label', 'Display text language');
    languageSelect.setAttribute('data-mm-editor-input', '1');
    languageSelect.style.cssText = 'min-width:5.25rem;padding:4px 8px;border:1px solid;border-radius:8px;font:12px ui-sans-serif,system-ui,sans-serif';
    var languages = knownDisplayLanguages();
    for (var i = 0; i < languages.length; i++) {
      selectOption(languageSelect, languages[i]);
    }
    languageSelect.value = languages.indexOf(activeLanguage) >= 0 ? activeLanguage : languages[0];
    languageLabel.appendChild(languageSelect);
    translationHeader.appendChild(languageLabel);
    dialog.appendChild(translationHeader);

    var translationValues = {};
    var storedDisplayText = node.displayText || {};
    for (var storedLanguage in storedDisplayText) translationValues[storedLanguage] = storedDisplayText[storedLanguage];
    var translationInput = editorInput(translationValues[languageSelect.value] || '', 'Display text', 'Uses Text when blank');
    translationInput.style.marginTop = '8px';
    dialog.appendChild(translationInput);
    var translationHint = document.createElement('p');
    translationHint.textContent = 'Leave blank to use the main text for this language.';
    translationHint.style.cssText = 'margin:4px 0 0;font:12px ui-sans-serif,system-ui,sans-serif;opacity:.78';
    dialog.appendChild(translationHint);

    function storeSelectedTranslation() {
      translationValues[languageSelect.value] = translationInput.value.slice(0, 500);
    }

    languageSelect.addEventListener('change', function () {
      var previousLanguage = languageSelect.getAttribute('data-previous-language') || activeLanguage;
      translationValues[previousLanguage] = translationInput.value.slice(0, 500);
      translationInput.value = translationValues[languageSelect.value] || '';
      languageSelect.setAttribute('data-previous-language', languageSelect.value);
      translationInput.setAttribute('aria-label', 'Display text for ' + languageSelect.value);
    });
    languageSelect.setAttribute('data-previous-language', languageSelect.value);
    languageSelect.addEventListener('keydown', function (event) { event.stopPropagation(); });

    var addLanguage = document.createElement('button');
    addLanguage.type = 'button';
    addLanguage.textContent = '+ Add language';
    addLanguage.style.cssText = 'margin-top:10px;padding:0;border:0;background:transparent;color:inherit;font:600 12px ui-sans-serif,system-ui,sans-serif;text-decoration:underline;cursor:pointer';
    addLanguage.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var language = window.prompt('Language code (for example: en or zh-hant)');
      if (!language) return;
      language = language.trim().toLowerCase();
      if (!/^[a-z][a-z0-9-]{0,31}$/i.test(language)) return;
      storeSelectedTranslation();
      var exists = false;
      for (var optionIndex = 0; optionIndex < languageSelect.options.length; optionIndex++) {
        if (languageSelect.options[optionIndex].value === language) exists = true;
      }
      if (!exists) selectOption(languageSelect, language);
      languageSelect.value = language;
      languageSelect.setAttribute('data-previous-language', language);
      translationInput.value = translationValues[language] || '';
      translationInput.setAttribute('aria-label', 'Display text for ' + language);
      translationInput.focus();
    });
    dialog.appendChild(addLanguage);

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px';
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:7px 10px;border:1px solid;border-radius:6px;background:transparent;color:inherit;font:600 12px ui-sans-serif,system-ui,sans-serif;cursor:pointer';
    cancel.addEventListener('click', function () { stopEditing(false); canvas.focus(); });
    actions.appendChild(cancel);
    var save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.setAttribute('data-mm-editor-save', '1');
    save.style.cssText = 'padding:7px 10px;border:1px solid transparent;border-radius:6px;font:600 12px ui-sans-serif,system-ui,sans-serif;cursor:pointer';
    save.addEventListener('click', function () { stopEditing(true); canvas.focus(); });
    actions.appendChild(save);
    dialog.appendChild(actions);

    dialog.addEventListener('keydown', function (event) {
      event.stopPropagation();
      var key = keyName(event);
      if (key === 'Enter') { event.preventDefault(); stopEditing(true); canvas.focus(); }
      if (key === 'Escape') { event.preventDefault(); stopEditing(false); canvas.focus(); }
    });
    dialog.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
    canvas.appendChild(dialog);
    editor = {
      element: dialog,
      id: id,
      textInput: textInput,
      languageSelect: languageSelect,
      translationInput: translationInput,
      translationValues: translationValues,
    };
    applyEditorColors(dialog);
    textInput.focus();
    if (selectAll) textInput.select();
  }

  function stopEditing(save) {
    if (!editor) return;
    var current = editor;
    if (save) {
      var node = nodeById(current.id);
      var value = current.textInput.value.replace(/\s+/g, ' ').trim();
      if (!value) {
        current.textInput.focus();
        return;
      }
      if (node) {
        var before = JSON.stringify(node);
        node.text = value.slice(0, 500);
        current.translationValues[current.languageSelect.value] = current.translationInput.value.slice(0, 500);
        var displayText = {};
        for (var language in current.translationValues) {
          if (/^[a-z][a-z0-9-]{0,31}$/i.test(language)) {
            displayText[language] = current.translationValues[language].slice(0, 500);
          }
        }
        if (Object.keys(displayText).length) node.displayText = displayText;
        else delete node.displayText;
        if (before !== JSON.stringify(node)) {
          syncSource();
          markDirty();
        }
      }
    }
    editor = null;
    if (current.element.parentNode) current.element.parentNode.removeChild(current.element);
    render();
  }

  // ── Pointer interactions: select, pan, drag-to-reparent ─────────────────
  var pointer = null; // {mode: 'pan'|'node', id, startX, startY, moved, dropId}
  var DRAG_THRESHOLD = 6;
  var DOUBLE_CLICK_MS = 450;
  var lastNodeClick = null; // {id, at}; survives the node re-render after click one

  function worldPoint(event) {
    var bounds = svg.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - view.tx) / view.scale,
      y: (event.clientY - bounds.top - view.ty) / view.scale,
    };
  }

  function nodeAtPoint(point, excludeId) {
    for (var i = nodes.length - 1; i >= 0; i--) {
      var id = nodes[i].id;
      var box = boxes[id];
      if (!box) continue;
      if (excludeId && (id === excludeId || isDescendant(id, excludeId))) continue;
      if (Math.abs(point.x - box.x) <= box.w / 2 && Math.abs(point.y - box.y) <= box.h / 2) return id;
    }
    return null;
  }

  function nodeIdFromEvent(event) {
    var target = event.target;
    while (target && target !== svg) {
      if (target.getAttribute && target.getAttribute('data-node-id')) return target.getAttribute('data-node-id');
      target = target.parentNode;
    }
    return null;
  }

  svg.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    stopEditing(true);
    var nodeId = nodeIdFromEvent(event);
    pointer = {
      mode: nodeId ? 'node' : 'pan',
      id: nodeId,
      startX: event.clientX,
      startY: event.clientY,
      viewTx: view.tx,
      viewTy: view.ty,
      moved: false,
      dropId: null,
    };
    svg.setPointerCapture(event.pointerId);
  });

  svg.addEventListener('pointermove', function (event) {
    if (!pointer) return;
    var dx = event.clientX - pointer.startX;
    var dy = event.clientY - pointer.startY;
    if (!pointer.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
    pointer.moved = true;
    lastNodeClick = null;

    if (pointer.mode === 'pan') {
      view.tx = pointer.viewTx + dx;
      view.ty = pointer.viewTy + dy;
      applyView();
      return;
    }

    // Dragging a node: root and read-only maps only pan.
    var node = nodeById(pointer.id);
    if (readOnly || !node || node.parent === null) {
      view.tx = pointer.viewTx + dx;
      view.ty = pointer.viewTy + dy;
      applyView();
      return;
    }

    svg.style.cursor = 'grabbing';
    var dropId = nodeAtPoint(worldPoint(event), pointer.id);
    if (dropId !== pointer.dropId) {
      setDropHighlight(pointer.dropId, false);
      pointer.dropId = dropId;
      setDropHighlight(dropId, true);
    }
    setDragOpacity(pointer.id, true);
  });

  svg.addEventListener('pointerup', function (event) {
    if (!pointer) return;
    var current = pointer;
    pointer = null;
    svg.style.cursor = 'grab';
    setDragOpacity(current.id, false);
    setDropHighlight(current.dropId, false);

    if (!current.moved) {
      if (current.id) {
        var now = Date.now();
        var doubleClick = !readOnly && lastNodeClick
          && lastNodeClick.id === current.id
          && now - lastNodeClick.at <= DOUBLE_CLICK_MS;
        lastNodeClick = doubleClick ? null : { id: current.id, at: now };
        selectedId = current.id;
        render();
        // A normal SVG dblclick is unreliable here because render() replaces
        // the clicked node after the first click. Detect the two pointer-up
        // events by node id so selected and unselected nodes behave alike.
        if (doubleClick) startEditing(current.id, true);
      } else {
        // Background click: keep the selection but drop focus ring updates.
        lastNodeClick = null;
      }
      canvas.focus();
      return;
    }
    if (current.mode === 'node' && current.dropId && !readOnly) {
      reparent(current.id, current.dropId);
    }
  });

  svg.addEventListener('pointercancel', function () {
    if (!pointer) return;
    setDragOpacity(pointer.id, false);
    setDropHighlight(pointer.dropId, false);
    pointer = null;
    lastNodeClick = null;
    svg.style.cursor = 'grab';
  });

  svg.addEventListener('dblclick', function (event) {
    var nodeId = nodeIdFromEvent(event);
    if (nodeId && !readOnly) {
      lastNodeClick = null;
      selectedId = nodeId;
      render();
      if (!editor || editor.id !== nodeId) startEditing(nodeId, true);
    }
  });

  function setDropHighlight(id, on) {
    if (!id) return;
    var rect = svg.querySelector('[data-node-rect="' + id + '"]');
    if (!rect) return;
    if (on) {
      rect.setAttribute('stroke', COLORS.dropStroke);
      rect.setAttribute('stroke-width', '3');
      rect.setAttribute('stroke-dasharray', '6 3');
    } else {
      rect.removeAttribute('stroke-dasharray');
      render();
    }
  }

  function setDragOpacity(id, on) {
    if (!id) return;
    var group = svg.querySelector('[data-node-id="' + id + '"]');
    if (group) group.setAttribute('opacity', on ? '0.5' : '1');
  }

  // ── Zoom ─────────────────────────────────────────────────────────────────
  var MIN_SCALE = 0.25;
  var MAX_SCALE = 2.5;

  function zoomAt(clientX, clientY, factor) {
    var bounds = svg.getBoundingClientRect();
    var px = clientX - bounds.left;
    var py = clientY - bounds.top;
    var next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    var ratio = next / view.scale;
    view.tx = px - (px - view.tx) * ratio;
    view.ty = py - (py - view.ty) * ratio;
    view.scale = next;
    applyView();
  }

  svg.addEventListener('wheel', function (event) {
    event.preventDefault();
    var factor = Math.pow(1.0015, -event.deltaY);
    zoomAt(event.clientX, event.clientY, factor);
  }, { passive: false });

  function fitView() {
    var min = [Infinity, Infinity];
    var max = [-Infinity, -Infinity];
    for (var id in boxes) {
      var box = boxes[id];
      min[0] = Math.min(min[0], box.x - box.w / 2);
      min[1] = Math.min(min[1], box.y - box.h / 2);
      max[0] = Math.max(max[0], box.x + box.w / 2);
      max[1] = Math.max(max[1], box.y + box.h / 2);
    }
    if (min[0] === Infinity) return;
    var bounds = svg.getBoundingClientRect();
    var margin = 48;
    var scaleX = (bounds.width - margin * 2) / Math.max(1, max[0] - min[0]);
    var scaleY = (bounds.height - margin * 2) / Math.max(1, max[1] - min[1]);
    view.scale = Math.min(1.25, Math.max(MIN_SCALE, Math.min(scaleX, scaleY)));
    view.tx = bounds.width / 2 - ((min[0] + max[0]) / 2) * view.scale;
    view.ty = bounds.height / 2 - ((min[1] + max[1]) / 2) * view.scale;
    applyView();
  }

  // ── Toolbar ──────────────────────────────────────────────────────────────
  function onClick(selector, handler) {
    var button = host.querySelector(selector);
    if (button) button.addEventListener('click', handler);
  }

  onClick('[data-mm-zoom-in]', function () {
    var bounds = svg.getBoundingClientRect();
    zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, 1.2);
  });
  onClick('[data-mm-zoom-out]', function () {
    var bounds = svg.getBoundingClientRect();
    zoomAt(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, 1 / 1.2);
  });
  onClick('[data-mm-zoom-fit]', fitView);

  // ── Keyboard ─────────────────────────────────────────────────────────────
  canvas.addEventListener('keydown', function (event) {
    if (editor) return;
    var node = selectedId ? nodeById(selectedId) : null;
    if (!node) return;
    var key = keyName(event);

    if (!readOnly) {
      if (key === 'Tab') { event.preventDefault(); addChild(node.id); return; }
      if (key === 'Enter') { event.preventDefault(); addSibling(node.id); return; }
      if (key === 'F2') { event.preventDefault(); startEditing(node.id, true); return; }
      if (key === 'Delete' || key === 'Backspace') { event.preventDefault(); deleteNode(node.id); return; }
    }

    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      var box = boxes[node.id];
      var outward = box && box.side === -1 ? 'ArrowLeft' : 'ArrowRight';
      if (key === outward) {
        var children = childrenOf(node.id);
        if (children.length) { selectedId = children[0].id; render(); }
      } else if (node.parent !== null) {
        selectedId = node.parent;
        render();
      }
      return;
    }
    if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      if (node.parent === null) return;
      var siblings = childrenOf(node.parent);
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i].id !== node.id) continue;
        var next = key === 'ArrowUp' ? siblings[i - 1] : siblings[i + 1];
        if (next) { selectedId = next.id; render(); }
        return;
      }
    }
  });

  // ── Dirty tracking + unsaved-changes guard ───────────────────────────────
  if (form && !readOnly) {
    form.addEventListener('input', function (event) {
      if (event.target && (event.target.name === 'name' || event.target.name === 'slug')) markDirty();
    });
    form.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  // The shell switches themes without reloading, so repaint SVG attributes
  // when its data-theme value changes.
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(function () {
      COLORS = colorsForTheme();
      if (editor) applyEditorColors(editor.element);
      render();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  fallback.hidden = true;
  canvas.hidden = false;
  toolbar.hidden = false;
  syncSource();
  render();
  fitView();
}());
