# Board

A splittable whiteboard: a workspace of resizable panes, each toggling between rich-text editing and freehand drawing. Saves to localStorage, exports as a standalone HTML snapshot.

## Running

No build, no dependencies, no server. Open `index.html` in a browser. The entire app — CSS, markup, and JS — lives in that one file; keep it that way unless asked otherwise.

## Architecture

Everything is in `index.html`:

- **Layout tree**: `#root` holds a recursive tree of `.split.row` / `.split.col` containers whose children are `.pane` elements separated by draggable `.gutter` dividers. Splitting in the same direction as the parent adds a sibling (and re-equalizes); splitting the other direction nests a new container in the pane's footprint (`split()`).
- **Panes**: each `.pane` has a `contenteditable` `.text` layer and a `<canvas>` drawing layer; the `draw` class on the pane decides which one receives input (`toggleMode`). Eraser state is per-pane via `dataset.erase`.
- **Active pane**: module-global `active`, set on mousedown; toolbar actions (split, delete, clear, eraser) apply to it. `setActive` also syncs the eraser button state.
- **Canvas sizing**: canvases are bitmap-sized to their rect by `fitCanvas` (which preserves the existing drawing by copying through a temp canvas). Call `refitAll()` after any layout change; canvas restores are wrapped in double `requestAnimationFrame` so layout settles first.

## Persistence — the part that's easy to break

Everything is **encrypted at rest** and **synced to GitHub**. Live at https://vaibhavgit9210.github.io/mypager/ (repo `vaibhavgit9210/mypager`, served from `gh-pages` — push BOTH `main` and `main:gh-pages` after changes).

- **Lock screen**: the board opens locked. The password is never stored or hardcoded anywhere — it derives an AES-GCM key (PBKDF2, fixed salt, 200k iterations) that decrypts the board. Wrong password = decryption failure = re-prompt. A brand-new board asks for the password twice (typo protection); the first password used becomes THE password for all devices.
- `serialize()` snapshots each canvas into `dataset.img` (PNG data URL), then returns `#root`'s HTML with transient classes (`active`, `dragging`, `dragover`) stripped from a clone.
- **Save**: `persist()` = serialize → encrypt → localStorage `board.v2` + `remoteSave()`. It's async and a no-op while locked (`key === null`).
- **Sync**: encrypted blob is PUT as `board.json` to the **private** repo `vaibhavgit9210/mypager-data` via the GitHub contents API. Per-device fine-grained token (contents:rw on that repo only) lives in localStorage `board.token`; prompted on unlock if absent, Cancel = local-only. `remoteSha` tracks the file SHA; stale-sha (409/422) refreshes and retries once; concurrent PUTs are queued (`pushing`/`pushPending`). Last write wins across devices — no merge.
- **Load order** (in `unlock()`): remote `board.json` → local `board.v2` cache → migrate plaintext `board.v1` (pre-encryption saves) → fresh pane.
- **Autosave**: debounced (800ms) `persist()`. Must be called after every content/structure mutation — typing fires via the `input` listener on `#root`; drawing strokes, split/delete/swap, clear, and gutter resize call it explicitly. `beforeunload` + `visibilitychange(hidden)` do best-effort final persists (async, so the last <800ms can be lost on a hard close). If you add a new way to mutate the board, wire in `autosave()`.
- **Export** downloads a **plaintext** standalone snapshot (it skips the lock screen on open) — it's a user-initiated backup; treat the file as sensitive.
- GitHub contents API reads cap at ~1MB via JSON — heavy drawings can exceed it and break sync before localStorage quota does.
- **Restore order matters** (`restore()`): if `#root` already contains panes, this is an exported snapshot — rehydrate the embedded DOM and do *not* touch localStorage. Otherwise load `board.v1`, else create one blank pane.
- **Rehydration**: DOM loaded from a saved string has no event listeners. `rehydrate()` re-wires gutters and calls `wirePane()` on every pane. `wirePane` must stay backward-compatible with older saved boards (e.g. it creates the `✥` drag handle if missing) — saved HTML in users' localStorage never migrates itself.
- **Export**: `exportFile()` serializes, strips transient classes from the live DOM, and downloads the whole document as `board.html`. That file is self-contained and re-runs this same script on open (taking the embedded-panes branch of `restore()`).

## Conventions

- Vanilla JS, no framework, no modules — script at the bottom of the file, `$` = `document.querySelector`.
- Text formatting uses `document.execCommand` (deprecated but intentional — it matches the contenteditable model; don't swap it out casually).
- Toolbar buttons that act on a text selection call `preventDefault()` on `mousedown` to keep the selection alive.
- Dark theme via CSS variables in `:root`; new UI should use `--panel`, `--line`, `--fg`, `--muted`, `--accent`.

## Testing

No test setup. Verify changes manually in a browser; the flows that regress most are: split/delete/resize panes, draw → save → reload, drag-swap two panes, and open an exported `board.html`.
