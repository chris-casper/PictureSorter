'use strict';

/* ========================================================================
   Picture Sorter — renderer
   ======================================================================== */

const $ = (sel) => document.querySelector(sel);
// NOTE: `api` is already a global here — preload.js does
// contextBridge.exposeInMainWorld('api', {...}), which creates window.api AND a
// bare global `api`. Declaring `const api = window.api` collides with it and throws
// "Identifier 'api' has already been declared", which aborts this whole file.
// So we reference the existing global `api` directly and never redeclare it.

const S = {
  settings: {},
  activeScreen: 'screen-main',
  rough: {
    srcFolder: null,
    destRoot: null,
    tree: null,
    photos: [],
    order: [],
    selected: new Set(),
    treeOpen: new Set(),
    selectedFolder: null,
    dragPayload: [],
    folderDrag: null,
    sortDir: 'asc',
    geoLabels: {},
    geoEnabled: false
  },
  fine: {
    folder: null,
    good: null,
    bad: null,
    queue: [],
    total: 0,
    index: 0,
    history: []
  }
};

let listeningBind = null;
let lastClickedPath = null;

/* ---------- small SVG snippets ---------- */
const CARET_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></svg>';

/* ---------- helpers ---------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function formatDate(v) {
  try { return new Date(v).toLocaleString(); } catch { return String(v); }
}

function formatShutter(e) {
  if (!e) return '';
  if (e >= 1) return e + 's';
  return '1/' + Math.round(1 / e) + 's';
}

function prettyKey(k) {
  const map = {
    ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓',
    ' ': 'Space', Backspace: '⌫', Enter: '↵', Escape: 'Esc', Delete: 'Del'
  };
  if (map[k]) return map[k];
  return k.length === 1 ? k.toUpperCase() : k;
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1900);
}

/* ---------- navigation ---------- */
function goto(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  S.activeScreen = id;
}

document.querySelectorAll('[data-goto]').forEach((b) =>
  b.addEventListener('click', () => goto(b.dataset.goto))
);
$('#btn-open-settings').addEventListener('click', () => { openSettings(); goto('screen-settings'); });

/* ========================================================================
   ROUGH SORT
   ======================================================================== */

$('#rough-pick-src').addEventListener('click', async () => {
  const f = await api.selectFolder('Select photo folder');
  if (!f) return;
  S.rough.srcFolder = f;
  await loadPhotos();
});

async function loadPhotos() {
  const res = await api.listImages(S.rough.srcFolder);
  if (res.error) { toast('Could not read that folder'); return; }
  S.rough.photos = res.items;
  S.rough.geoLabels = {};
  S.rough.selected.clear();
  if ($('#rough-grouping').value === 'location') await ensureGeoLabels();
  renderPhotos();
}

// key must match the rounding used by the main process (coordKey)
function geoKey(lat, lon) { return `${lat.toFixed(2)},${lon.toFixed(2)}`; }

async function ensureGeoLabels() {
  const coords = [];
  for (const p of S.rough.photos) {
    if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) coords.push({ lat: p.lat, lon: p.lon });
  }
  if (!coords.length) { S.rough.geoLabels = {}; return; }
  const anyGps = coords.length;
  const unresolved = coords.filter((c) => !(geoKey(c.lat, c.lon) in S.rough.geoLabels)).length;
  if (S.settings.geocodeEnabled && unresolved) toast('Looking up photo locations…');
  const res = await api.geocodeBatch(coords);
  S.rough.geoLabels = res.labels || {};
  S.rough.geoEnabled = res.enabled;
  if (!res.enabled && !Object.keys(S.rough.geoLabels).length && anyGps) {
    toast('Turn on location lookup in Settings to see place names');
  }
}

function groupPhotos(photos, mode, gapMin) {
  const sorted = [...photos];
  if (mode === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (mode === 'type') sorted.sort((a, b) => a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name));
  else sorted.sort((a, b) => a.ts - b.ts);

  if (mode === 'none') return [{ label: `All photos (${sorted.length})`, items: sorted }];

  const groups = [];
  const pushMap = (map) => {
    for (const [k, items] of map) groups.push({ label: `${k} (${items.length})`, items });
  };

  if (mode === 'name' || mode === 'type') {
    const map = new Map();
    for (const p of sorted) {
      const k = mode === 'name'
        ? (p.name[0] || '#').toUpperCase()
        : p.ext.replace('.', '').toUpperCase();
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    pushMap(map);
    return groups;
  }

  if (mode === 'location') {
    const map = new Map();
    const labels = S.rough.geoLabels || {};
    for (const p of sorted) {
      let k;
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
        k = labels[geoKey(p.lat, p.lon)] || 'Location not looked up';
      } else {
        k = 'No location data';
      }
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    pushMap(map);
    return groups;
  }

  if (mode === 'day' || mode === 'month') {
    const map = new Map();
    for (const p of sorted) {
      const d = new Date(p.ts);
      const k = mode === 'day'
        ? d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
        : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    pushMap(map);
    return groups;
  }

  // cluster by time gap
  const gapMs = (gapMin || 60) * 60000;
  let cur = null;
  for (const p of sorted) {
    if (!cur || (p.ts - cur._last) > gapMs) {
      cur = { items: [], _start: p.ts, _last: p.ts };
      groups.push(cur);
    }
    cur.items.push(p);
    cur._last = p.ts;
  }
  for (const g of groups) {
    const s = new Date(g._start);
    const e = new Date(g._last);
    const sameDay = s.toDateString() === e.toDateString();
    const dOpt = { month: 'short', day: 'numeric' };
    const tOpt = { hour: 'numeric', minute: '2-digit' };
    let label = s.toLocaleDateString(undefined, { ...dOpt, year: 'numeric' }) +
      '  ' + s.toLocaleTimeString(undefined, tOpt);
    if (!(s.getTime() === e.getTime())) {
      label += ' – ' + (sameDay
        ? e.toLocaleTimeString(undefined, tOpt)
        : e.toLocaleDateString(undefined, dOpt) + ' ' + e.toLocaleTimeString(undefined, tOpt));
    }
    g.label = `${label} (${g.items.length})`;
  }
  return groups;
}

function renderPhotos() {
  const host = $('#rough-photos');
  const photos = S.rough.photos;
  $('#rough-count').textContent = photos.length;
  S.rough.order = [];

  if (!photos.length) {
    host.innerHTML = '<div class="empty-state"><p>No photos in this folder.</p><p class="sub">Pick a folder that contains images.</p></div>';
    return;
  }

  const mode = $('#rough-grouping').value;
  const groups = groupPhotos(photos, mode, S.settings.clusterGapMinutes);
  if (S.rough.sortDir === 'desc') {
    groups.reverse();
    groups.forEach((g) => g.items.reverse());
  }
  host.innerHTML = '';

  for (const g of groups) {
    const gEl = document.createElement('div');
    gEl.className = 'group';

    const head = document.createElement('div');
    head.className = 'group-head';
    head.draggable = true;
    head.innerHTML =
      `<span class="group-grip">${GRIP_SVG}</span>` +
      `<span class="group-label"></span>` +
      `<button class="group-select">select all</button>`;
    head.querySelector('.group-label').textContent = g.label;

    const groupPaths = g.items.map((p) => p.path);
    head.addEventListener('dragstart', (ev) => startDrag(ev, groupPaths));
    head.querySelector('.group-select').addEventListener('click', (e) => {
      e.stopPropagation();
      groupPaths.forEach((p) => S.rough.selected.add(p));
      refreshSelectionUI();
    });
    gEl.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'grid';
    for (const p of g.items) {
      S.rough.order.push(p.path);
      grid.appendChild(makeThumb(p));
    }
    gEl.appendChild(grid);
    host.appendChild(gEl);
  }
  refreshSelectionUI();
}

function makeThumb(p) {
  const el = document.createElement('div');
  el.className = 'thumb';
  el.draggable = true;
  el.dataset.path = p.path;
  el.innerHTML =
    `<img loading="lazy" src="${api.mediaUrl(p.path)}" alt="">` +
    `<span class="badge">✓</span>` +
    `<span class="fname">${escapeHtml(p.name)}</span>`;
  el.addEventListener('click', (e) => onThumbClick(e, p));
  el.addEventListener('dblclick', (e) => { e.preventDefault(); openPhotoModal(p); });
  el.addEventListener('dragstart', (e) => {
    if (!S.rough.selected.has(p.path)) {
      if (!(e.ctrlKey || e.metaKey || e.shiftKey)) S.rough.selected.clear();
      S.rough.selected.add(p.path);
      refreshSelectionUI();
    }
    startDrag(e, Array.from(S.rough.selected));
  });
  return el;
}

function onThumbClick(e, p) {
  const sel = S.rough.selected;
  if (e.shiftKey && lastClickedPath) {
    const order = S.rough.order;
    const a = order.indexOf(lastClickedPath);
    const b = order.indexOf(p.path);
    if (a > -1 && b > -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) sel.add(order[i]);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (sel.has(p.path)) sel.delete(p.path); else sel.add(p.path);
    lastClickedPath = p.path;
  } else {
    sel.clear();
    sel.add(p.path);
    lastClickedPath = p.path;
  }
  refreshSelectionUI();
}

function refreshSelectionUI() {
  const sel = S.rough.selected;
  document.querySelectorAll('#rough-photos .thumb').forEach((t) => {
    t.classList.toggle('selected', sel.has(t.dataset.path));
  });
}

function startDrag(ev, paths) {
  S.rough.folderDrag = null;
  S.rough.dragPayload = paths.slice();
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', paths.join('\n'));
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.textContent = paths.length === 1 ? '1 photo' : `${paths.length} photos`;
  document.body.appendChild(ghost);
  ev.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

$('#rough-photos').addEventListener('click', (e) => {
  if (!e.target.closest('.thumb') && !e.target.closest('.group-head')) {
    S.rough.selected.clear();
    refreshSelectionUI();
  }
});

/* destination tree */
$('#rough-pick-dest').addEventListener('click', async () => {
  const f = await api.selectFolder('Select destination folder');
  if (!f) return;
  S.rough.destRoot = f;
  S.rough.selectedFolder = f;
  S.rough.treeOpen.clear();
  await loadTree();
});

async function loadTree() {
  const tree = await api.folderTree(S.rough.destRoot);
  S.rough.tree = tree;
  S.rough.treeOpen.add(tree.path);
  renderTree();
}

function renderTree() {
  const host = $('#rough-tree');
  host.innerHTML = '';
  if (S.rough.tree) host.appendChild(buildTreeNode(S.rough.tree, true));
}

function buildTreeNode(node, isRoot) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = node.path;
  const hasKids = node.children && node.children.length;
  const open = S.rough.treeOpen.has(node.path);
  row.innerHTML =
    `<span class="tree-caret ${hasKids ? '' : 'leaf'} ${open ? 'open' : ''}">${CARET_SVG}</span>` +
    `<span class="tree-ico">${FOLDER_SVG}</span>` +
    `<span class="tree-name">${escapeHtml(isRoot ? (node.name || node.path) : node.name)}</span>`;
  if (node.path === S.rough.selectedFolder) row.classList.add('selected');

  row.querySelector('.tree-caret').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hasKids) return;
    if (open) S.rough.treeOpen.delete(node.path);
    else S.rough.treeOpen.add(node.path);
    renderTree();
  });

  row.addEventListener('click', () => {
    S.rough.selectedFolder = node.path;
    document.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
  });

  // folders can be dragged to reorganize (root cannot be moved)
  if (!isRoot) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      S.rough.folderDrag = node.path;
      S.rough.dragPayload = [];
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.path);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      S.rough.folderDrag = null;
    });
  }

  // right-click → rename / delete
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openFolderMenu(e.clientX, e.clientY, node, isRoot);
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (S.rough.folderDrag === node.path) return; // don't highlight self
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drop-target');
    if (S.rough.folderDrag) {
      await moveFolderInto(S.rough.folderDrag, node.path);
    } else {
      await dropOnFolder(node.path);
    }
  });

  wrap.appendChild(row);

  if (hasKids && open) {
    const kids = document.createElement('div');
    kids.className = 'tree-children';
    node.children.forEach((c) => kids.appendChild(buildTreeNode(c, false)));
    wrap.appendChild(kids);
  }
  return wrap;
}

async function dropOnFolder(dest) {
  const payload = S.rough.dragPayload.slice();
  if (!payload.length) return;
  const res = await api.moveFiles(payload, dest);
  const okCount = res.filter((r) => r.ok).length;
  const movedSet = new Set(res.filter((r) => r.ok).map((r) => r.src));
  S.rough.photos = S.rough.photos.filter((p) => !movedSet.has(p.path));
  movedSet.forEach((p) => S.rough.selected.delete(p));
  S.rough.dragPayload = [];
  renderPhotos();
  toast(`Moved ${okCount} photo${okCount === 1 ? '' : 's'}`);
}

$('#rough-new-folder').addEventListener('click', async () => {
  if (!S.rough.destRoot) { toast('Choose a destination folder first'); return; }
  const parent = S.rough.selectedFolder || S.rough.destRoot;
  const name = await promptName('New folder', 'New Folder');
  if (name === null) return;
  const created = await api.createFolder(parent, name);
  S.rough.treeOpen.add(parent);
  S.rough.selectedFolder = created;
  await loadTree();
});

async function moveFolderInto(srcFolder, destFolder) {
  S.rough.folderDrag = null;
  if (srcFolder === destFolder) return;
  const res = await api.moveFolder(srcFolder, destFolder);
  if (!res.ok) {
    toast(/into itself/.test(res.error || '') ? "Can't move a folder into itself" : 'Could not move folder');
    return;
  }
  S.rough.treeOpen.add(destFolder);
  if (S.rough.selectedFolder === srcFolder) S.rough.selectedFolder = res.dest;
  await loadTree();
  toast('Folder moved');
}

/* folder right-click menu */
let ctxNode = null;
function openFolderMenu(x, y, node, isRoot) {
  ctxNode = { node, isRoot };
  const menu = $('#folder-ctx');
  menu.querySelectorAll('button').forEach((b) => { b.disabled = isRoot; });
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}
function closeFolderMenu() { $('#folder-ctx').classList.add('hidden'); ctxNode = null; }
document.addEventListener('click', () => { if (ctxNode) closeFolderMenu(); });
document.addEventListener('scroll', () => { if (ctxNode) closeFolderMenu(); }, true);
window.addEventListener('blur', () => { if (ctxNode) closeFolderMenu(); });

$('#folder-ctx').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn || !ctxNode) return;
  const { node, isRoot } = ctxNode;
  const act = btn.dataset.act;
  closeFolderMenu();
  if (act === 'rename') {
    if (isRoot) { toast("Can't rename the root destination folder"); return; }
    const name = await promptName('Rename folder', node.name, 'Rename');
    if (name === null) return;
    const res = await api.renameFolder(node.path, name);
    if (!res.ok) { toast('Could not rename folder'); return; }
    if (S.rough.selectedFolder === node.path) S.rough.selectedFolder = res.dest;
    await loadTree();
    toast('Folder renamed');
  } else if (act === 'delete') {
    if (isRoot) { toast("Can't delete the root destination folder"); return; }
    const ok = await confirmModal('Delete folder',
      `Delete “${node.name}” and everything inside it? This can’t be undone.`);
    if (!ok) return;
    const res = await api.deleteFolder(node.path);
    if (!res.ok) { toast('Could not delete folder'); return; }
    if (S.rough.selectedFolder === node.path) S.rough.selectedFolder = S.rough.destRoot;
    await loadTree();
    toast('Folder deleted');
  }
});

$('#rough-grouping').addEventListener('change', async (e) => {
  if (e.target.value === 'location') await ensureGeoLabels();
  renderPhotos();
});
$('#rough-size').addEventListener('change', (e) => applyThumbSize(e.target.value));

$('#rough-sortdir').addEventListener('click', () => {
  const btn = $('#rough-sortdir');
  S.rough.sortDir = S.rough.sortDir === 'asc' ? 'desc' : 'asc';
  btn.dataset.dir = S.rough.sortDir;
  renderPhotos();
});

/* double-click a thumbnail to preview it full-screen; single click closes */
function openPhotoModal(p) {
  const modal = $('#photo-modal');
  $('#photo-modal-img').src = api.mediaUrl(p.path);
  $('#photo-modal-name').textContent = p.name;
  modal.classList.remove('hidden');
}
$('#photo-modal').addEventListener('click', () => {
  $('#photo-modal').classList.add('hidden');
  $('#photo-modal-img').src = '';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#photo-modal').classList.contains('hidden')) {
    $('#photo-modal').classList.add('hidden');
    $('#photo-modal-img').src = '';
  }
});

/* ========================================================================
   FINE SORT
   ======================================================================== */

function showFineState(which) {
  ['fine-empty', 'fine-setup', 'fine-stage', 'fine-done'].forEach((id) => {
    $('#' + id).classList.toggle('hidden', id !== which);
  });
}

$('#fine-pick').addEventListener('click', pickFineFolder);
$('#fine-reload').addEventListener('click', pickFineFolder);

async function pickFineFolder() {
  const f = await api.selectFolder('Select folder to review');
  if (!f) return;
  await api.commitTrash(); // flush any deletes staged from a previous folder
  S.fine.folder = f;
  const gb = await api.ensureGoodBad(f);
  S.fine.good = gb.good;
  S.fine.bad = gb.bad;
  if (!(gb.goodExists && gb.badExists)) {
    showFineState('fine-setup');
  } else {
    await startFine();
  }
}

$('#fine-create-gb').addEventListener('click', async () => {
  const gb = await api.createGoodBad(S.fine.folder);
  S.fine.good = gb.good;
  S.fine.bad = gb.bad;
  await startFine();
});

async function startFine() {
  const res = await api.listImages(S.fine.folder);
  const items = (res.items || []).sort((a, b) => a.ts - b.ts);
  S.fine.queue = items;
  S.fine.total = items.length;
  S.fine.index = 0;
  S.fine.history = [];
  if (!items.length) { showFineState('fine-done'); return; }
  showFineState('fine-stage');
  showCurrent();
}

async function showCurrent() {
  const cur = S.fine.queue[S.fine.index];
  if (!cur) { showFineState('fine-done'); $('#fine-progress').textContent = `${S.fine.total} sorted`; api.commitTrash(); return; }
  showFineState('fine-stage');
  updateProgress();

  const img = $('#fine-image');
  const fb = $('#fine-fallback');
  fb.classList.add('hidden');
  img.style.display = '';
  S.fine.currentMeta = null;
  img.onerror = () => {
    img.style.display = 'none';
    $('#fine-fallback-name').textContent = cur.name;
    fb.classList.remove('hidden');
  };
  img.onload = () => {
    const m = S.fine.currentMeta;
    if (m && !m.width && img.naturalWidth) {
      m.width = img.naturalWidth;
      m.height = img.naturalHeight;
      renderMeta(m);
    }
  };
  img.src = api.mediaUrl(cur.path);

  const meta = await api.readMeta(cur.path);
  if (!meta.width && img.complete && img.naturalWidth) {
    meta.width = img.naturalWidth;
    meta.height = img.naturalHeight;
  }
  S.fine.currentMeta = meta;
  renderMeta(meta);
}

function updateProgress() {
  const left = S.fine.queue.length;
  const sorted = S.fine.total - left;
  if (!left) { $('#fine-progress').textContent = `${sorted} sorted`; return; }
  const pos = Math.min(S.fine.index + 1, left);
  $('#fine-progress').textContent = `${pos} of ${left} left · ${sorted} sorted`;
}

async function verdict(kind) {
  const cur = S.fine.queue[S.fine.index];
  if (!cur) return;
  const dest = kind === 'good' ? S.fine.good : S.fine.bad;
  const res = await api.moveFiles([cur.path], dest);
  if (res[0] && res[0].ok) {
    S.fine.history.push({ dest: res[0].dest, orig: cur.path, kind, at: S.fine.index });
    S.fine.queue.splice(S.fine.index, 1);
    if (S.fine.index >= S.fine.queue.length) S.fine.index = S.fine.queue.length - 1;
    showCurrent();
  } else {
    toast('Could not move that file');
  }
}

// browse forward/back through the queue WITHOUT moving anything
function navFine(dir) {
  const n = S.fine.queue.length;
  if (n === 0) return;
  const next = Math.max(0, Math.min(n - 1, S.fine.index + dir));
  if (next === S.fine.index) return;
  S.fine.index = next;
  showCurrent();
}

// delete the current photo to the Recycle Bin (undoably — see main process)
async function del() {
  const cur = S.fine.queue[S.fine.index];
  if (!cur) return;
  const res = await api.trashFile(cur.path);
  if (res && res.ok) {
    S.fine.history.push({ kind: 'delete', staged: res.staged, orig: cur.path, at: S.fine.index });
    S.fine.queue.splice(S.fine.index, 1);
    if (S.fine.index >= S.fine.queue.length) S.fine.index = S.fine.queue.length - 1;
    showCurrent();
  } else {
    toast('Could not delete that file');
  }
}

async function undo() {
  const last = S.fine.history.pop();
  if (!last) { toast('Nothing to undo'); return; }
  let ok = false;
  if (last.kind === 'delete') {
    const r = await api.untrashFile(last.staged, last.orig);
    ok = r && r.ok;
  } else {
    const r = await api.moveTo(last.dest, last.orig);
    ok = r && r.ok;
  }
  if (!ok) { toast('Could not undo'); S.fine.history.push(last); return; }
  const name = last.orig.split(/[\\/]/).pop();
  const at = Math.max(0, Math.min(S.fine.queue.length, last.at ?? S.fine.index));
  S.fine.queue.splice(at, 0, { path: last.orig, name, ts: 0 });
  S.fine.index = at;
  showCurrent();
}

$('#fine-good').addEventListener('click', () => verdict('good'));
$('#fine-bad').addEventListener('click', () => verdict('bad'));
$('#fine-delete').addEventListener('click', () => del());
$('#fine-undo').addEventListener('click', () => undo());

function renderMeta(m) {
  const strip = $('#fine-meta');
  if (!m || m.error) { strip.innerHTML = '<span class="meta-empty">no metadata available</span>'; return; }
  const parts = [];
  const add = (k, v) => {
    if (v === null || v === undefined || v === '') return;
    parts.push(`<span><span class="m-key">${k}</span> <span class="m-val">${escapeHtml(String(v))}</span></span>`);
  };
  add('file', m.name);
  if (m.width && m.height) add('dim', `${m.width}\u00d7${m.height}`);
  add('size', formatBytes(m.size));
  add('date', m.dateTaken ? formatDate(m.dateTaken) : (m.modified ? formatDate(m.modified) + ' (modified)' : null));
  if (m.make || m.model) add('camera', [m.make, m.model].filter(Boolean).join(' '));
  add('lens', m.lens);
  if (m.fNumber) add('aperture', 'f/' + m.fNumber);
  if (m.exposure) add('shutter', formatShutter(m.exposure));
  if (m.iso) add('ISO', m.iso);
  if (m.focalLength) add('focal', m.focalLength + 'mm');
  if (m.gpsLat != null && m.gpsLon != null) add('gps', `${m.gpsLat.toFixed(4)}, ${m.gpsLon.toFixed(4)}`);
  strip.innerHTML = parts.join('') || '<span class="meta-empty">no metadata available</span>';
}

/* ========================================================================
   SETTINGS
   ======================================================================== */

function openSettings() {
  document.querySelectorAll('.keycap').forEach((cap) => {
    cap.textContent = prettyKey(S.settings[cap.dataset.keybind] || '');
    cap.classList.remove('listening');
  });
  $('#set-thumb').value = S.settings.thumbSize;
  $('#set-grouping').value = S.settings.defaultGrouping;
  $('#set-gap').value = S.settings.clusterGapMinutes;
  $('#set-theme').value = S.settings.theme;
  $('#set-geocode').checked = !!S.settings.geocodeEnabled;
}

document.querySelectorAll('.keycap').forEach((cap) => {
  cap.addEventListener('click', () => {
    document.querySelectorAll('.keycap').forEach((c) => c.classList.remove('listening'));
    cap.classList.add('listening');
    cap.textContent = 'press a key…';
    listeningBind = { field: cap.dataset.keybind, el: cap };
  });
});

// capture-phase handler grabs the key before anything else
document.addEventListener('keydown', (e) => {
  if (!listeningBind) return;
  e.preventDefault();
  e.stopPropagation();
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  S.settings[listeningBind.field] = key;
  listeningBind.el.classList.remove('listening');
  listeningBind.el.textContent = prettyKey(key);
  listeningBind = null;
  persistSettings();
  updateFineKeyLabels();
}, true);

$('#set-thumb').addEventListener('change', (e) => {
  S.settings.thumbSize = e.target.value;
  $('#rough-size').value = e.target.value;
  applyThumbSize(e.target.value);
  persistSettings();
});
$('#set-grouping').addEventListener('change', (e) => {
  S.settings.defaultGrouping = e.target.value;
  $('#rough-grouping').value = e.target.value;
  persistSettings();
});
$('#set-gap').addEventListener('change', (e) => {
  const v = Math.max(1, Math.min(1440, parseInt(e.target.value, 10) || 60));
  S.settings.clusterGapMinutes = v;
  e.target.value = v;
  persistSettings();
});
$('#set-theme').addEventListener('change', (e) => {
  S.settings.theme = e.target.value;
  applyTheme(e.target.value);
  persistSettings();
});
$('#set-geocode').addEventListener('change', async (e) => {
  S.settings.geocodeEnabled = e.target.checked;
  await persistSettings();
  // if the user is currently viewing location grouping, refresh it
  if (S.activeScreen === 'screen-rough' && $('#rough-grouping').value === 'location') {
    await ensureGeoLabels();
    renderPhotos();
  }
});

async function persistSettings() {
  await api.setSettings(S.settings);
  const note = $('#settings-saved');
  note.classList.add('show');
  clearTimeout(note._t);
  note._t = setTimeout(() => note.classList.remove('show'), 1200);
}

/* ========================================================================
   SHARED
   ======================================================================== */

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
}

function applyThumbSize(size) {
  const map = { small: 'var(--thumb-small)', medium: 'var(--thumb-medium)', large: 'var(--thumb-large)' };
  document.documentElement.style.setProperty('--thumb', map[size] || map.medium);
}

function updateFineKeyLabels() {
  $('#fine-good-key').textContent = prettyKey(S.settings.goodKey);
  $('#fine-bad-key').textContent = prettyKey(S.settings.badKey);
  $('#fine-undo-key').textContent = prettyKey(S.settings.undoKey);
  const dk = $('#fine-delete-key');
  if (dk) dk.textContent = prettyKey(S.settings.deleteKey);
  const legend = $('#fine-legend');
  if (legend) {
    const browse = `${prettyKey(S.settings.prevKey)} ${prettyKey(S.settings.nextKey)}`;
    legend.innerHTML =
      `<b>${prettyKey(S.settings.goodKey)}</b> keep · ` +
      `<b>${prettyKey(S.settings.badKey)}</b> toss · ` +
      `<b>${prettyKey(S.settings.deleteKey)}</b> delete · ` +
      `<b>${prettyKey(S.settings.prevKey)}</b><b>${prettyKey(S.settings.nextKey)}</b> browse · ` +
      `<b>${prettyKey(S.settings.undoKey)}</b> undo`;
  }
}

/* case-insensitive for single-character keys (so 'a' matches 'A') */
function keyMatch(e, bound) {
  if (!bound) return false;
  if (bound.length === 1) return e.key.length === 1 && e.key.toLowerCase() === bound.toLowerCase();
  return e.key === bound;
}

/* global keyboard for fine sort */
document.addEventListener('keydown', (e) => {
  if (listeningBind) return;
  if (S.activeScreen !== 'screen-fine') return;
  if ($('#fine-stage').classList.contains('hidden')) return;
  if (keyMatch(e, S.settings.goodKey)) { e.preventDefault(); verdict('good'); }
  else if (keyMatch(e, S.settings.badKey)) { e.preventDefault(); verdict('bad'); }
  else if (keyMatch(e, S.settings.deleteKey)) { e.preventDefault(); del(); }
  else if (keyMatch(e, S.settings.undoKey)) { e.preventDefault(); undo(); }
  else if (keyMatch(e, S.settings.nextKey)) { e.preventDefault(); navFine(1); }
  else if (keyMatch(e, S.settings.prevKey)) { e.preventDefault(); navFine(-1); }
});

/* tiny modal prompt (Electron disables window.prompt) */
function promptName(title, initial, okLabel) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      `<div class="modal"><h4></h4>` +
      `<input type="text" class="modal-input" />` +
      `<div class="modal-actions">` +
      `<button class="modal-cancel">Cancel</button>` +
      `<button class="modal-ok primary-btn"></button></div></div>`;
    document.body.appendChild(back);
    back.querySelector('h4').textContent = title;
    back.querySelector('.modal-ok').textContent = okLabel || 'Create';
    const input = back.querySelector('.modal-input');
    input.value = initial || '';
    input.focus();
    input.select();
    const close = (val) => { back.remove(); resolve(val); };
    back.querySelector('.modal-cancel').addEventListener('click', () => close(null));
    back.querySelector('.modal-ok').addEventListener('click', () => close(input.value.trim() || initial));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') close(input.value.trim() || initial);
      if (e.key === 'Escape') close(null);
    });
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
  });
}

/* yes/no confirmation modal */
function confirmModal(title, message) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML =
      `<div class="modal"><h4></h4><p class="modal-msg"></p>` +
      `<div class="modal-actions">` +
      `<button class="modal-cancel">Cancel</button>` +
      `<button class="modal-ok primary-btn danger">Delete</button></div></div>`;
    document.body.appendChild(back);
    back.querySelector('h4').textContent = title;
    back.querySelector('.modal-msg').textContent = message;
    const close = (val) => { document.removeEventListener('keydown', onKey); back.remove(); resolve(val); };
    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter') close(true);
    }
    back.querySelector('.modal-cancel').addEventListener('click', () => close(false));
    back.querySelector('.modal-ok').addEventListener('click', () => close(true));
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(false); });
    document.addEventListener('keydown', onKey);
  });
}

/* ---------- boot ---------- */
async function init() {
  S.settings = await api.getSettings();
  applyTheme(S.settings.theme);
  $('#rough-grouping').value = S.settings.defaultGrouping;
  $('#rough-size').value = S.settings.thumbSize;
  applyThumbSize(S.settings.thumbSize);
  updateFineKeyLabels();
}
init();
