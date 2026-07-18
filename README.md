# mypager

A splittable whiteboard in a single HTML file. The workspace is a tree of resizable panes — split any pane horizontally or vertically, drag the gutters to resize, drag-swap panes — and each pane toggles between rich-text editing and freehand drawing. Boards are encrypted at rest, autosaved to localStorage, optionally synced across devices via a private GitHub repo, and exportable as a standalone HTML snapshot.

Live at https://vaibhavgit9210.github.io/mypager/

## Features

- **Split panes**: recursive row/column layout with draggable dividers; splitting in the same direction adds a sibling, splitting the other direction nests.
- **Two modes per pane**: a `contenteditable` rich-text layer (bold/italic/lists via the toolbar) and a `<canvas>` drawing layer with an eraser, toggled per pane.
- **Password lock**: the board opens locked. The password is never stored — it derives an AES-GCM key (PBKDF2, 200k iterations) that decrypts the board; a wrong password simply fails to decrypt.
- **Autosave**: every edit is debounced into an encrypted save to localStorage.
- **Cross-device sync (optional)**: the encrypted blob is pushed to a private GitHub repo via the contents API, using a per-device fine-grained token you paste on unlock. Cancel the prompt to stay local-only. Last write wins — there is no merging.
- **Export**: downloads the whole board as a self-contained `board.html` you can open anywhere (note: the export is plaintext and skips the lock screen — treat the file as sensitive).

## How it works

Everything — markup, CSS, and vanilla JS — lives in `index.html`. No framework, no build step, no dependencies. Saving serializes the pane DOM (canvases snapshotted as PNG data URLs), encrypts it with the password-derived key, and writes it locally plus (if a token is set) to GitHub. Loading tries the remote copy first, then the local cache. Exported snapshots embed the same script and rehydrate themselves on open.

## Running locally

Open `index.html` in a browser. That's it — set a password on first run (you'll be asked twice) and start splitting panes.
