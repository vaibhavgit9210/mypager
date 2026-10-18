# mypager

Private notes behind an ID + password: folders, notes that split into text/drawing panes, pictures.
User-facing overview in `README.md`.

- **Live app:** https://mypager.vaibhavpro9210.workers.dev/ is the `mypager` Cloudflare Worker on the
  **vaibhavpro9210** account (Durable Object `Store`, static assets from `app/`). Deploy app + API together:
  `cd worker && npx wrangler deploy`. A git push does NOT update it.
- **Repo:** `vaibhavgit9210/mypager` (public; it holds code, never content). Push BOTH `main` and
  `main:gh-pages`. GitHub Pages only matters for the root `index.html`: the **forwarding page** at
  the old URL https://vaibhavkumar.is-a.dev/mypager/.
- **The old private data repo** `vaibhavgit9210/mypager-data` was always empty (GitHub sync never
  stored anything). The old Notepad app's encrypted notes are in `vaibhavgit9210/notepad` (a **public**
  repo, 6-digit PIN) and mirrored in `../notepad-backup.git`.

## Files

| Path | What |
|---|---|
| `app/index.html` | The whole app: markup, CSS, JS in one file. `app/_headers` = CSP and friends. |
| `worker/worker.js` | Worker + `Store` DO: auth, sessions, folders, notes, pictures, carries. Route list at the top. |
| `index.html` | Forwarding page for the old URL; carries a browser's old board across (see Imports). |
| `tools/make-carry.mjs` | Packs old data (Notepad file or a board.v2 value) into an import link. |
| `tests/` | `run.sh` = API suite + 6 puppeteer suites. |

## Secrets

- `INVITE_CODE` (wrangler secret): needed to create an account. Value is in `.invite-code`
  (gitignored, never commit or print it in a public place). Unset = sign-up closed, login still works.
- `worker/.dev.vars` (gitignored) holds `INVITE_CODE=dev-invite` for `wrangler dev`.
- There is no admin key and no way to read anyone's notes server-side, by design.

## Crypto model (`app/index.html`, "crypto")

- `PBKDF2-SHA256(password, salt "mypager/v3/" + id, 600k)` → HKDF → `auth` (sent at login/sign-up)
  and a KEK (never leaves). The server stores `sha256(salt16 || auth)` and the **wrapped DEK**.
- The DEK (random AES-GCM-256) encrypts everything. It's kept per device in IndexedDB `mypager/kv`
  as a **non-extractable** CryptoKey; log out deletes it. A password change only re-wraps the DEK
  (`/api/password`), so nothing is re-encrypted, and it ends the account's other sessions.
- Formats: note body = `iv12 || ct` of the note JSON (AAD `note:<id>`); title / folder name =
  base64url of `iv || ct` (AAD `title:<id>` / `folder:<id>`); picture = `iv || ct` of
  `[mime length][mime][bytes]` (AAD `pic:<id>`). AAD stops the server swapping blobs between ids.
- No password reset is possible. Don't add one that weakens this; export is the backup.

## Server (`worker/worker.js`)

- One DO instance (`main`). Tables: users, sessions, folders, notes, pics, refs (note→picture),
  carries, parts (chunks), hits (rate limits), kv. Values over 1 MB go to `parts` rows: a SQLite
  value is capped at 2 MB.
- Saves are optimistic: `PUT /api/notes/<id>?rev=<n>` succeeds only if `n` is the stored rev,
  else 409. rev=0 creates.
- Pictures are write-once. Each note save sends `X-Pics` (the ids it uses); refs are diffed so most
  saves write no ref rows. Pictures unreferenced for 7 days are swept (at most every 6 h).
- Cookie: `__Host-mp` on https (plain `mp` in wrangler dev), HttpOnly, SameSite=Lax, 30 days
  sliding. Every non-GET must carry `Origin` equal to the site's origin: sibling
  `*.vaibhavpro9210.workers.dev` workers are *same-site*, so SameSite alone doesn't stop them.
- Only `POST /api/carry` is cross-origin (CORS *, also from `file://`): capped at 30/day/IP and 200
  pending, expires after 90 days.
- Rate limits: 8 wrong logins per ID and 30 per IP per 15 min; 10 sign-up tries per IP.
- Free-plan budget: keep per-request CPU tiny (no server-side KDF; the client does PBKDF2), and keep
  rows written low (note saves are one row; autosave is debounced 1.2 s, 3 s for big notes).

## App (`app/index.html`)

- Note JSON: `{v:1, root}`. A node is `{t:'split', dir:'row'|'col', flex, kids}` or
  `{t:'pane', mode:'text'|'draw', flex, html, draw?, dw?, dh?}`. `draw` is a picture id holding the
  pane's drawing; `dw/dh` give its size in CSS px.
- **Pictures** live in pane HTML as `<img data-pic="id" style="--ar:w/h">`. The `src` is a blob: URL
  filled in at load (`hydratePics`) and stripped on save (`storedHTML`), so note JSON stays small.
  Sizing is pure CSS: `.content` is a size container, and `img[style*="--ar"]` gets
  `width:min(100cqw-28px, (100cqh-28px)*ar, 100%)`, so it fills the pane at its ratio and refits on
  resize without ever pushing the pane. Pictures without `--ar` (imported or pasted HTML) keep their
  own size, capped at the pane. Over 2000 px on the long side (or 1.5 MB) they are re-encoded
  (JPEG if opaque). Drop and drag land at `caretAt()` (caretPositionFromPoint /
  caretRangeFromPoint), and `#dropCaret` draws the insertion point while dragging.
- **Drawings**: each canvas has an offscreen `_art` canvas whose CSS-px size only grows, so a small
  screen never crops a big-screen drawing. Changed drawings upload as new pictures before each
  save (`flushDrawings`).
- **Saving**: `changed()` → debounced `save()` → `PUT` with the rev. On 409 the local version is
  saved as "<title> (my version, <time>)" and the server's is loaded. On 404 the note is re-created
  (deleted elsewhere while being edited). `flush()` must succeed before switching notes. A 401 shows
  the log-in card over the app (`needLogin`) and the failed call retries afterwards.
- Pane HTML always passes through `clean()`/`scrub()` on load and after paste. It drops scripts,
  frames, `on*`, **and `id`/`name`**: named elements would clobber `document.*` lookups.
- `S` is a top-level `const`: tests read it as `S`, not `window.S`.

## Imports (moving off the old apps)

- **Old board**: the old app saved `localStorage['board.v2']`, `{iv, ct}` under
  `PBKDF2(pw, "board.v2.fixed-salt", 200k)`, holding the HTML of its pane tree (maybe also
  `board.v1`, plaintext). That storage belongs to the **vaibhavkumar.is-a.dev** origin, so only a page
  there can read it. The forwarding page does: it encrypts `{board, boardPlain, label}` under a fresh
  key, posts it to `/api/carry`, and redirects to `/#carry=<id>.<key>`. `mypager.moved` in that
  browser stops it re-offering an unchanged board (`#move` forces the card). It also deletes the
  old `board.token`. **Keep that page alive**: it's the only bridge to boards still in browsers.
- Boards saved 12 to 14 Jul 2026 lived under `vaibhavgit9210.github.io`, which now 301s to is-a.dev,
  so no page can reach them any more.
- **Notepad**: `data/notes.json` = base64(`salt16 | iv12 | ct`), `PBKDF2(PIN, salt, 100k)`, an array
  of `{title, content, createdAt, updatedAt}`. Use `node tools/make-carry.mjs <app-url> notepad
  <file>` to make a link. Notes land in a *Notepad* folder with their dates.
- The app reads `#carry=` (and `#invite=`) on load **and on hashchange**, stores pending carries in
  localStorage `mp.carries`, and imports after login. It first tries the password just used, then
  asks (Later keeps it pending; the account menu offers *Finish imports*). Carries are deleted
  server-side once imported.

## Gotchas already hit

- Class names: the board's containers are `.split.row` / `.split.col`, so list rows are `.item`. A
  generic `.row` rule once squashed every pane to 0 px.
- List rows re-render on click, so the browser's `dblclick` lands on a detached row. Double-click is
  detected by hand (`lastTap`), and `renderTree()` holds off while a rename box is open.
- An import link opened in a tab that's already on the app changes only the hash: `hashchange`
  handles it.
- `connect-src` needs `blob:`: export reads pictures back through `fetch(blob:)`.
- The beacon reports the page as `/mypager/` (workers.dev serves the app at `/`, which would
  collide with the portfolio homepage in site-analytics).

## Testing

`tests/run.sh` restarts `wrangler dev` on :8787 with fresh state, serves the forwarding page plus the
**pre-move app** (`git show cee34e7:index.html` → `old.html`) on :8765 as the old origin, then runs:
`api.test.mjs` (54 checks) and t1 migrate (real old app → move → sign up → import), t2 notes/folders,
t3 pictures, t4 Notepad import + conflict + password change, t5 phone layout, t6 export + board file +
unlock. Order matters (t1 makes the account, t4 changes its password). Each suite uses a fresh
Chrome profile and logs in: reopening a profile that a crashed run left behind hangs Chrome.
`?to=http://localhost:PORT/` on the forwarding page is honoured only on localhost. Never point the
suites at production; the API suite refuses non-local bases.
