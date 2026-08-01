'use strict';

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const exifr = require('exifr');

// ---------------------------------------------------------------------------
// Settings persistence (stored in the OS user-data folder as JSON)
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  goodKey: 'a',        // Keep  -> Good folder
  badKey: 'd',         // Toss  -> Bad folder
  deleteKey: 'e',      // Delete -> Recycle Bin
  undoKey: 'q',        // Undo last action
  prevKey: 'ArrowLeft',   // browse previous (no move)
  nextKey: 'ArrowRight',  // browse next (no move)
  thumbSize: 'medium', // small | medium | large
  clusterGapMinutes: 60,
  defaultGrouping: 'cluster',
  theme: 'dark',
  geocodeEnabled: false // reverse-geocode photo GPS via OpenStreetMap (opt-in)
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const merged = { ...loadSettings(), ...patch };
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2));
  return merged;
}

// ---------------------------------------------------------------------------
// Reverse geocoding (OpenStreetMap Nominatim) with an on-disk cache.
// Nominatim is free and needs no key, but its usage policy requires a
// descriptive User-Agent and no more than ~1 request/second. We honor both,
// and round coordinates so nearby photos reuse one lookup.
// ---------------------------------------------------------------------------
function geocachePath() {
  return path.join(app.getPath('userData'), 'geocache.json');
}
let _geocache = null;
function loadGeocache() {
  if (_geocache) return _geocache;
  try {
    _geocache = JSON.parse(fs.readFileSync(geocachePath(), 'utf-8'));
  } catch {
    _geocache = {};
  }
  return _geocache;
}
let _geoSaveTimer = null;
function saveGeocacheSoon() {
  clearTimeout(_geoSaveTimer);
  _geoSaveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(geocachePath(), JSON.stringify(_geocache || {}));
    } catch {
      /* ignore write errors */
    }
  }, 400);
}
function coordKey(lat, lon) {
  // ~2 decimals ≈ 1.1 km: nearby photos collapse to one cache entry / lookup
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}
function labelFromNominatim(j) {
  const a = (j && j.address) || {};
  const place =
    a.city || a.town || a.village || a.hamlet || a.suburb ||
    a.municipality || a.county;
  const region = a.state || a.region || a.country;
  if (place && region && place !== region) return `${place}, ${region}`;
  if (place) return place;
  if (region) return region;
  if (j && j.display_name) return j.display_name.split(',').slice(0, 2).join(',').trim();
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ipcMain.handle('geocode:batch', async (_e, coords) => {
  const cache = loadGeocache();
  const settings = loadSettings();
  const labels = {};
  const toFetch = [];
  for (const c of coords || []) {
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const key = coordKey(c.lat, c.lon);
    if (key in cache) {
      labels[key] = cache[key];
    } else if (settings.geocodeEnabled && !toFetch.some((t) => t.key === key)) {
      toFetch.push({ key, lat: c.lat, lon: c.lon });
    }
  }
  for (const t of toFetch) {
    try {
      const url =
        'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&addressdetails=1' +
        `&lat=${encodeURIComponent(t.lat)}&lon=${encodeURIComponent(t.lon)}`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'PictureSorter/1.0 (desktop photo organizer)',
          'Accept-Language': 'en'
        }
      });
      if (resp.ok) {
        const j = await resp.json();
        const label = labelFromNominatim(j) || 'Unknown location';
        cache[t.key] = label;
        labels[t.key] = label;
        saveGeocacheSoon();
      }
    } catch {
      /* offline or blocked — leave unresolved */
    }
    await sleep(1100); // stay under Nominatim's 1 req/sec policy
  }
  return { labels, enabled: !!settings.geocodeEnabled };
});

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------
const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp',
  '.tif', '.tiff', '.heic', '.heif', '.avif'
]);

function isImage(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

// Cross-device safe move that also avoids overwriting existing files.
async function safeMove(src, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let target = path.join(destDir, base);
  let i = 2;
  while (fs.existsSync(target)) {
    target = path.join(destDir, `${stem} (${i++})${ext}`);
  }
  try {
    await fsp.rename(src, target);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, target);
      await fsp.unlink(src);
    } else {
      throw err;
    }
  }
  return target;
}

async function moveToExact(src, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try {
    await fsp.rename(src, target);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, target);
      await fsp.unlink(src);
    } else {
      throw err;
    }
  }
  return target;
}

async function readTree(dir, depth) {
  const node = { name: path.basename(dir) || dir, path: dir, children: [] };
  if (depth <= 0) return node;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return node;
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      node.children.push(await readTree(path.join(dir, e.name), depth - 1));
    }
  }
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  return node;
}

// ---------------------------------------------------------------------------
// Custom protocol so <img> can load local files under contextIsolation.
// Registered as privileged BEFORE app is ready.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
]);

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    backgroundColor: '#17181c',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

app.whenReady().then(() => {
  protocol.handle('media', (request) => {
    try {
      const u = new URL(request.url);
      const p = decodeURIComponent(u.pathname.replace(/^\//, ''));
      return net.fetch(pathToFileURL(p).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  createWindow();

  // Flush any deletes left staged by a previous session into the Recycle Bin.
  commitPendingTrash();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  // Best effort: send still-staged deletes to the Recycle Bin on exit.
  commitPendingTrash();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, patch) => saveSettings(patch || {}));

ipcMain.handle('dialog:selectFolder', async (_e, title) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: title || 'Select folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('images:list', async (_e, folder) => {
  let entries = [];
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true });
  } catch (err) {
    return { error: String(err), items: [] };
  }
  const files = entries.filter((d) => d.isFile() && isImage(d.name));
  const out = [];
  for (const f of files) {
    const full = path.join(folder, f.name);
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    let taken = null;
    try {
      const ex = await exifr.parse(full, { pick: ['DateTimeOriginal', 'CreateDate'] });
      if (ex) taken = ex.DateTimeOriginal || ex.CreateDate || null;
    } catch {
      /* ignore unreadable EXIF */
    }
    let lat = null;
    let lon = null;
    try {
      const g = await exifr.gps(full);
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
        lat = g.latitude;
        lon = g.longitude;
      }
    } catch {
      /* no GPS / unreadable */
    }
    const takenMs = taken ? new Date(taken).getTime() : null;
    out.push({
      name: f.name,
      path: full,
      size: stat.size,
      mtime: stat.mtimeMs,
      taken: takenMs,
      ts: takenMs || stat.mtimeMs,
      ext: path.extname(f.name).toLowerCase(),
      lat,
      lon
    });
  }
  return { items: out };
});

ipcMain.handle('folders:tree', async (_e, root) => readTree(root, 8));

ipcMain.handle('folders:create', async (_e, parent, name) => {
  const cleaned = String(name || 'New Folder').replace(/[<>:"/\\|?*]/g, '_').trim() || 'New Folder';
  let target = path.join(parent, cleaned);
  let i = 2;
  while (fs.existsSync(target)) target = path.join(parent, `${cleaned} (${i++})`);
  await fsp.mkdir(target, { recursive: true });
  return target;
});

ipcMain.handle('folders:rename', async (_e, folderPath, newName) => {
  try {
    const cleaned = String(newName || '').replace(/[<>:"/\\|?*]/g, '_').trim();
    if (!cleaned) return { ok: false, error: 'Empty name' };
    const parent = path.dirname(folderPath);
    let target = path.join(parent, cleaned);
    if (path.resolve(target) === path.resolve(folderPath)) return { ok: true, dest: folderPath };
    let i = 2;
    while (fs.existsSync(target)) target = path.join(parent, `${cleaned} (${i++})`);
    await fsp.rename(folderPath, target);
    return { ok: true, dest: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('folders:delete', async (_e, folderPath) => {
  try {
    await fsp.rm(folderPath, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('folders:move', async (_e, srcFolder, destParent) => {
  try {
    const src = path.resolve(srcFolder);
    const dest = path.resolve(destParent);
    // Guard: cannot drop a folder into itself or one of its own descendants.
    if (dest === src || dest.startsWith(src + path.sep)) {
      return { ok: false, error: 'Cannot move a folder into itself' };
    }
    if (path.dirname(src) === dest) return { ok: true, dest: src }; // already there
    const base = path.basename(src);
    let target = path.join(dest, base);
    let i = 2;
    while (fs.existsSync(target)) target = path.join(dest, `${base} (${i++})`);
    try {
      await fsp.rename(src, target);
    } catch (err) {
      if (err.code === 'EXDEV') {
        await fsp.cp(src, target, { recursive: true });
        await fsp.rm(src, { recursive: true, force: true });
      } else throw err;
    }
    return { ok: true, dest: target };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('files:move', async (_e, srcList, destDir) => {
  const results = [];
  for (const s of srcList) {
    try {
      const dest = await safeMove(s, destDir);
      results.push({ src: s, dest, ok: true });
    } catch (err) {
      results.push({ src: s, ok: false, error: String(err) });
    }
  }
  return results;
});

ipcMain.handle('files:moveTo', async (_e, src, target) => {
  try {
    const dest = await moveToExact(src, target);
    return { ok: true, dest };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------------------------------------------------------------------------
// Delete = move to the Windows Recycle Bin, but undoably.
// A "delete" first moves the file to a private staging folder (instant, so it
// leaves the working folder right away and Undo can move it back). Staged files
// are flushed to the OS Recycle Bin via shell.trashItem when the session ends
// (all photos sorted / another folder picked / next launch), which is the only
// way to have BOTH a real Recycle Bin destination AND a working Undo.
// ---------------------------------------------------------------------------
function pendingTrashDir() {
  return path.join(app.getPath('userData'), 'pending-trash');
}

ipcMain.handle('files:trash', async (_e, src) => {
  try {
    const dir = pendingTrashDir();
    await fsp.mkdir(dir, { recursive: true });
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}__${path.basename(src)}`;
    const staged = path.join(dir, uniq);
    await moveToExact(src, staged);
    return { ok: true, staged, orig: src };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('files:untrash', async (_e, staged, orig) => {
  try {
    const dest = await moveToExact(staged, orig);
    return { ok: true, dest };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

async function commitPendingTrash() {
  const dir = pendingTrashDir();
  let entries = [];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { ok: true, count: 0 };
  }
  let count = 0;
  for (const name of entries) {
    try {
      await shell.trashItem(path.join(dir, name));
      count++;
    } catch {
      /* leave it staged; will retry next commit */
    }
  }
  return { ok: true, count };
}
ipcMain.handle('trash:commit', async () => commitPendingTrash());

ipcMain.handle('meta:read', async (_e, file) => {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch (err) {
    return { error: String(err) };
  }
  let ex = {};
  try {
    ex = (await exifr.parse(file, { tiff: true, ifd0: true, exif: true, gps: true })) || {};
  } catch {
    /* ignore */
  }
  return {
    name: path.basename(file),
    path: file,
    size: stat.size,
    modified: stat.mtimeMs,
    width: ex.ExifImageWidth || ex.ImageWidth || null,
    height: ex.ExifImageHeight || ex.ImageHeight || null,
    make: ex.Make || null,
    model: ex.Model || null,
    lens: ex.LensModel || null,
    dateTaken: ex.DateTimeOriginal || ex.CreateDate || null,
    iso: ex.ISO || null,
    fNumber: ex.FNumber || null,
    exposure: ex.ExposureTime || null,
    focalLength: ex.FocalLength || null,
    gpsLat: typeof ex.latitude === 'number' ? ex.latitude : null,
    gpsLon: typeof ex.longitude === 'number' ? ex.longitude : null,
    orientation: ex.Orientation || null
  };
});

ipcMain.handle('finesort:ensure', async (_e, folder) => {
  const good = path.join(folder, 'Good');
  const bad = path.join(folder, 'Bad');
  return {
    good,
    bad,
    goodExists: fs.existsSync(good),
    badExists: fs.existsSync(bad)
  };
});

ipcMain.handle('finesort:createGoodBad', async (_e, folder) => {
  const good = path.join(folder, 'Good');
  const bad = path.join(folder, 'Bad');
  await fsp.mkdir(good, { recursive: true });
  await fsp.mkdir(bad, { recursive: true });
  return { good, bad };
});
