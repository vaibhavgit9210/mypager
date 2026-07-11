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

- `serialize()` snapshots each canvas into `dataset.img` (PNG data URL), then returns `#root`'s HTML with transient classes (`active`, `dragging`, `dragover`) stripped from a clone.
- **Save**: `persist()` writes to localStorage key `board.v1`; `save()` is persist + button flash. Large drawings can exceed the quota — persist returns false and manual save flashes "Too big!".
- **Autosave**: `autosave()` is a debounced (800ms) `persist()`. It must be called after every content or structure mutation — typing fires it via the `input` listener on `#root`, but drawing strokes, split/delete/swap, clear, and gutter resize each call it explicitly. `beforeunload` does a final persist. If you add a new way to mutate the board, wire in `autosave()`.
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
