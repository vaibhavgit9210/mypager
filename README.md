# mypager

Private notes with an ID and password. Folders, single notes, and notes that split into panes like
tmux, where each pane is rich text or a drawing and can hold pictures.

Live at **https://mypager.vaibhavpro9210.workers.dev/**. The old address,
https://vaibhavkumar.is-a.dev/mypager/, forwards there.

## Features

- **ID + password**: log in from any device. No GitHub account or token involved.
- **Folders and notes**: nested folders, notes at the top level or inside folders. Drag rows onto a
  folder (or use *Move to…*), double-click to rename.
- **Panes**: split any note left/right or top/bottom, drag the dividers, drag the ✥ handle to swap
  two panes. A new note is a single pane.
- **Text and drawing per pane**: bold/italic/lists/colours/format painter, or a pen with an eraser.
- **Pictures**: drop an image file into a pane, paste one, or use the picture button. It lands at
  the text cursor, and while you drag, a cursor follows the pointer to show where. Drag a picture
  that is already in a pane to move it, even into another pane. Pictures fill the pane at their own
  aspect ratio, refit when the pane is resized, and never change the pane's size.
- **Autosave and sync**: every change saves within a couple of seconds. If two devices edit the same
  note at once, nothing is lost: the later one keeps its version as a separate note.
- **Export**: any note, a folder, or everything, as a standalone HTML file with pictures inlined.

## Privacy

Everything is encrypted in the browser before it is sent. The password never leaves the device. It
derives (PBKDF2, 600k rounds) a key that unlocks the account's data key, and that data key encrypts
every note, title, folder name and picture with AES-GCM. The server stores only ciphertext.

The catch: **there is no password reset.** Forget the password and the notes are unreadable, to
everyone. Export now and then if that worries you; the export file is *not* encrypted, so keep it
private.

## Moving in from the old mypager and Notepad

- **Old mypager boards** lived in each browser's storage. Open https://vaibhavkumar.is-a.dev/mypager/
  once in every browser you used and press *Move it to the new mypager*. The board arrives as a note
  named after that browser. You are asked for the old board password if it differs from the new one.
- **Old Notepad** (the Jan to Feb 2026 GitHub app) comes in through an import link; it asks for the
  Notepad's 6-digit PIN and recreates the notes, with their dates, in a *Notepad* folder.

## How it runs

A Cloudflare Worker (free plan) serves the page and an `/api` backed by one SQLite Durable Object.
The page is a single HTML file, `app/index.html`, with no build step and no dependencies. The repo's
root `index.html` is the forwarding page that GitHub Pages serves at the old address.

## Development

```bash
cd worker && npx wrangler dev --port 8787     # the app + API at http://localhost:8787
tests/run.sh                                   # API suite + 6 browser suites (Chrome + puppeteer-core)
cd worker && npx wrangler deploy               # ship app + worker together
```

Account creation needs the invite code (a wrangler secret). See `CLAUDE.md` for the internals.
