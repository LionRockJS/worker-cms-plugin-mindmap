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

  var host = document.querySelector('[data-mindmap]');
  if (!host) return;
  var source = host.querySelector('[data-mm-source]');
  var canvas = host.querySelector('[data-mm-canvas]');
  var toolbar = host.querySelector('[data-mm-toolbar]');
  var fallback = host.querySelector('[data-mm-fallback]');
  if (!source || !canvas || !toolbar || !fallback) return;

  var readOnly = host.getAttribute('data-readonly') === '1';
  var form = source.form || host.closest('form');
  var dirtyBadge = document.querySelector('[data-mm-dirty]');

  // ── Document state ───────────────────────────────────────────────────────
  var nodes = parseDocument(source.value);
  if (!nodes) return; // invalid JSON: leave the textarea as the editor

  var selectedId = rootNode().id;
  var dirty = false;

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
      list.push({ id: entry.id, text: typeof entry.text === 'string' ? entry.text : '', parent: parent });
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
  }

  function markDirty() {
    dirty = true;
    if (dirtyBadge) dirtyBadge.hidden = false;
  }

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

  var COLORS = {
    edge: 'var(--color-gray-300, #d1d5db)',
    rootFill: 'var(--color-indigo-600, #4f46e5)',
    rootText: '#ffffff',
    nodeFill: 'var(--color-white, #ffffff)',
    nodeStroke: 'var(--color-gray-300, #d1d5db)',
    nodeText: 'var(--color-gray-900, #111827)',
    selectedStroke: 'var(--color-indigo-600, #4f46e5)',
    selectedFill: 'var(--color-indigo-50, #eef2ff)',
    dropStroke: 'var(--color-indigo-600, #4f46e5)',
  };

  var boxes = {};

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
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

  // ── Inline rename ────────────────────────────────────────────────────────
  var editor = null;

  function startEditing(id, selectAll) {
    if (readOnly) return;
    var box = boxes[id];
    var node = nodeById(id);
    if (!box || !node) return;
    stopEditing(false);

    var input = document.createElement('input');
    input.type = 'text';
    input.value = node.text;
    input.maxLength = 500;
    input.setAttribute('data-mm-editing', id);
    var width = Math.max(box.w * view.scale, 140);
    input.style.cssText = 'position:absolute;z-index:10;transform:translate(-50%,-50%);text-align:center;'
      + 'font:13px ui-sans-serif,system-ui,sans-serif;padding:4px 8px;border:1px solid #4f46e5;'
      + 'border-radius:8px;background:#fff;color:#111827;width:' + Math.ceil(width) + 'px';
    input.style.left = (view.tx + box.x * view.scale) + 'px';
    input.style.top = (view.ty + box.y * view.scale) + 'px';

    input.addEventListener('keydown', function (event) {
      event.stopPropagation();
      var key = keyName(event);
      if (key === 'Enter') { event.preventDefault(); stopEditing(true); canvas.focus(); }
      if (key === 'Escape') { event.preventDefault(); stopEditing(false); canvas.focus(); }
    });
    input.addEventListener('blur', function () { stopEditing(true); });

    canvas.appendChild(input);
    editor = { input: input, id: id };
    input.focus();
    if (selectAll) input.select();
  }

  function stopEditing(save) {
    if (!editor) return;
    var current = editor;
    editor = null;
    if (save) {
      var node = nodeById(current.id);
      var value = current.input.value.replace(/\s+/g, ' ').trim();
      if (node && value && value !== node.text) {
        node.text = value.slice(0, 500);
        syncSource();
        markDirty();
      }
    }
    if (current.input.parentNode) current.input.parentNode.removeChild(current.input);
    render();
  }

  // ── Pointer interactions: select, pan, drag-to-reparent ─────────────────
  var pointer = null; // {mode: 'pan'|'node', id, startX, startY, moved, dropId}
  var DRAG_THRESHOLD = 6;

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
        selectedId = current.id;
        render();
      } else {
        // Background click: keep the selection but drop focus ring updates.
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
    svg.style.cursor = 'grab';
  });

  svg.addEventListener('dblclick', function (event) {
    var nodeId = nodeIdFromEvent(event);
    if (nodeId && !readOnly) {
      selectedId = nodeId;
      render();
      startEditing(nodeId, true);
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

  onClick('[data-mm-add-child]', function () { if (selectedId) addChild(selectedId); });
  onClick('[data-mm-add-sibling]', function () { if (selectedId) addSibling(selectedId); });
  onClick('[data-mm-rename]', function () { if (selectedId) startEditing(selectedId, true); });
  onClick('[data-mm-delete]', function () { if (selectedId) deleteNode(selectedId); });
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
      if (event.target && event.target.name === 'name') markDirty();
    });
    form.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (event) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  // ── Boot ─────────────────────────────────────────────────────────────────
  fallback.hidden = true;
  canvas.hidden = false;
  toolbar.hidden = false;
  syncSource();
  render();
  fitView();
}());
