# Picture Sorter

An Electron based desktop app for triaging large batches of phone photos. I take a lot of photos and I like being able to move everything roughly into folders. Then I ideally go back and sort them by what I want to keep and what I want to toss.

Hence the super creative name. 


Ergo, Picture Sorter has two modes:

- **Rough Sort** — thumbnails grouped couple different methods; drag photos or whole groups into a destination folder tree.
- **Fine Sort** — one photo at a time, keep / toss / delete with single keystrokes.

Built with [Electron](https://www.electronjs.org/). Targets Windows, theoretically also runs on macOS/Linux but I haven't tested yet. 

Technically 'works' with: .jpg, .jpeg, .png, .gif, .bmp, .webp, .tif, .tiff, .heic, .heif, and .avif

Recommended: .jpg/.jpeg, .png, .gif, .webp, .bmp

---

## Table of contents

- [Installing Node.js with nvm-windows (PowerShell)](#installing-nodejs-with-nvm-windows-powershell)
- [Running the app](#running-the-app)
- [Building a Windows installer](#building-a-windows-installer)
- [How it works](#how-it-works)
- [Keyboard shortcuts](#keyboard-shortcuts-fine-sort)
- [Location lookup & privacy](#location-lookup--privacy)
- [Notes & known limitations](#notes--known-limitations)
- [Project layout](#project-layout)
- [License](#license)

---

## Installing Node.js with nvm-windows (PowerShell)

You'll need [Node.js](https://nodejs.org) 18 or newer. 

These steps use **nvm for Windows**, which lets you install and switch Node versions cleanly.

1. Remove any existing Node install first. nvm-windows manages its own copies and a stray system install causes conflicts.

2. **Install nvm-windows.** Download `nvm-setup.exe` from the latest release at
   <https://github.com/coreybutler/nvm-windows/releases> and run it, keeping the default paths. (This part is a normal GUI installer, not PowerShell.)

3. **Open a *new* PowerShell as Administrator.** Close all existing windows. Made that mistake during testing, PATH didn't refresh. Admin rights matter. nvm-windows switches versions with a symlink, which needs elevation. 

4. **Confirm nvm is available:**

   ```powershell
   nvm version
   ```

    If you get *"nvm is not recognized"*, the window was open before install finished. Close it and open a new Administrator PowerShell. If it still fails, reload the PATH in the current session:
   
    ```powershell
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    ```

5. **Install and select the latest LTS Node (npm comes bundled):**

   ```powershell
   nvm install lts
   nvm use lts
   ```

   If your nvm-windows borks lts, go with hardcoded version

   ```powershell
   nvm list available
   nvm install 22.11.0
   nvm use 22.11.0
   ```

6. **Verify:**

   ```powershell
   node -v
   npm -v
   ```

   Both should print version numbers. You don't install npm separately — it ships with Node.

---

## Running the app

From the project folder:

```powershell
npm install
npm start
```

`npm install` downloads Electron and `exifr` dependency (for reading EXIF photo metadata). The first install can take a few minutes. `npm start` launches the app.

## Building a Windows installer

To produce a double-clickable `.exe` installer:

```powershell
npm run dist
```

This uses `electron-builder` to create an NSIS installer under a new `dist/` folder (run it **on Windows** for a Windows build). For a runnable folder without an installer, use `npm run pack`.

---

## How it works

**Main menu** — two large tiles (Rough Sort, Fine Sort) and a gear for Settings. Every subscreen has a back arrow.

### Rough Sort

- Choose a **photo folder** (top-right); photos appear as thumbnails on the right.
- They're **clustered by date/time** by default so a whole event is one draggable group. The dropdown also offers by day, by month, **by location**, by name, by file type, or none.
- The **↑/↓ toggle** flips ascending/descending order.
- Thumbnail size is adjustable (Small / Medium / Large).
- **Double-click** a thumbnail to view it full-screen; click anywhere or press Esc to close.
- Choose a **destination folder** (beside the *Destination* heading); it appears as an expandable tree on the left.
- The **New folder** button creates a folder inside whichever folder is selected.
- **Drag** a photo, a multi-selection (click, Ctrl-click, Shift-click), or a whole group header onto any folder to move those files there.
- **Drag a folder** onto another to reorganize it; **right-click** a folder to rename or delete it.

### Fine Sort

- Choose a folder. If it has no **Good** / **Bad** subfolders, a button creates them.
- One photo fills the screen. Use the buttons or keys to **Keep** (→ Good), **Toss** (→ Bad), or **Delete** (→ Recycle Bin). The photo moves and the next appears.
- **Undo** reverses the last action — including a delete (see limitations).
- The **left/right arrow keys browse between photos without moving them**, so you can check ahead for duplicates before deciding.
- A legend in the top bar shows the current keys, and the photo's metadata (dimensions, size, date, camera, ISO, aperture, GPS, etc.) shows along the bottom beside the buttons.

### Settings

- Rebind every Fine Sort key: Keep, Toss, Delete, Undo, and the two browse keys.
- Default thumbnail size, default grouping, and the time-cluster gap (minutes).
- **Location lookup** (off by default) — see below.
- Light or dark theme. Settings save automatically.

---

## Keyboard shortcuts (Fine Sort)

| Action | Default key |
| --- | --- |
| Keep (move to **Good**) | `A` |
| Toss (move to **Bad**) | `D` |
| Delete (move to **Recycle Bin**) | `E` |
| Undo last action | `Q` |
| Browse to previous photo (no move) | `←` |
| Browse to next photo (no move) | `→` |

All of these are rebindable in **Settings → Fine Sort keys**. Letter keys are case-insensitive.

---

## Location lookup & privacy

The **By location** grouping reads GPS coordinates embedded in your photos and turns them into place names (e.g. "Nashville, Tennessee").

- It's **off by default**. Enable it under *Settings → Photo locations*.
- When on, coordinates are sent to OpenStreetMap's free [Nominatim](https://nominatim.org/) service (no API key needed).
- Coordinates are rounded to ~1 km, and results are **cached on your computer** (`geocache.json` in your user-data folder) so each place is looked up only once.
- Lookups are rate-limited to one request per second per OpenStreetMap's usage policy, so the first pass over a new trip may take a moment.
- If it's off (or you're offline), "By location" simply groups everything under *Location not looked up* / *No location data*.

---

## Known limitations

- **HEIC/HEIF (iPhone default):** Because proprietary trash, Chromium can't decode them. So the thumbnails and previews show a "preview unavailable" placeholder. **Sorting and moving still work** — only the preview is affected. To see previews, set your phone to shoot JPEG ("Most Compatible") or convert them.
- **Delete & Undo:** deleting sends a photo to the Windows Recycle Bin. Because the OS Recycle Bin can't be reliably restored from with a simple API, delete is implemented so it stays undoable during your session: a deleted file is moved to a private staging area immediately (so it leaves the folder and Undo can bring it back), and staged files are flushed into the Recycle Bin when the session ends (all photos sorted, another folder chosen, or the next launch). Once flushed, restore it from the Recycle Bin as usual.
- Moves are real file moves. Across different drives the app copies then deletes. Should be fine.
- Name collisions are handled automatically by appending " (2)", " (3)", etc. Windows standard.
- Settings are stored in your OS user-data folder (on Windows: `%APPDATA%\Picture Sorter\`).

---

## Project layout

```
picture-sorter/
  main.js            Electron main process — file ops, EXIF, geocoding, settings, IPC
  preload.js         Secure bridge exposing a small API to the UI
  renderer/
    index.html       All four screens
    styles.css       Dark & light themes, layout
    app.js           UI logic — grouping, drag & drop, keyboard sorting
  assets/
    icon.ico / .png  App icon
  package.json
```

The app runs with Electron's recommended security settings (context isolation on, node integration off, sandboxed renderer). Local images are served to the UI through a small custom `media://` protocol rather than exposing the file system directly.

---

## License

Haven't decided what to use yet

---

## AI Slop

Vibe coding was heavily used here. It's a local app where security or speed wasn't important. Plus I was on vacation and just wanted something functional in a hurry. It's a photo sorting utility.

