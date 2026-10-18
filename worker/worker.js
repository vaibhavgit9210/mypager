// mypager backend: a Worker that serves ../app as static assets and hands /api/* to one
// SQLite Durable Object (Store, instance "main") holding accounts, sessions, folders,
// notes and pictures.
//
// The browser encrypts everything before it gets here. Titles, folder names, note bodies
// and pictures are AES-GCM ciphertext under a per-account data key, and that key only
// leaves the browser wrapped by a key derived from the password. So this side stores and
// returns opaque bytes. To log in, the browser sends `auth`, a second value derived from
// the password (PBKDF2 600k + HKDF, useless for decrypting anything); the server keeps
// sha256(salt || auth) and compares against that.
//
// Routes, JSON unless noted. "session" = the session cookie. Every request that is not a
// GET must carry an Origin header equal to this site's origin, except POST /api/carry.
//   POST   /api/signup   {id, auth, wrapped, invite}  -> {id, wrapped} + cookie
//   POST   /api/login    {id, auth}                   -> {id, wrapped} + cookie
//   POST   /api/logout                                -> {ok}, clears the cookie
//   GET    /api/me                                    -> {id, wrapped}                 session
//   POST   /api/password {auth, newAuth, wrapped}     -> {ok}, ends the other sessions  session
//   GET    /api/tree                                  -> {folders, notes}              session
//   POST   /api/folders  {id, parent, name}           -> {ok}                          session
//   PATCH  /api/folders/<id> {name?, parent?}         -> {ok}                          session
//   DELETE /api/folders/<id>[?keep=1]                 -> {ok}, keep=1 lifts its contents a level
//   GET    /api/notes/<id>                            -> bytes + X-Rev                 session
//   PUT    /api/notes/<id>?rev=<n>   body = bytes     -> {rev, created, updated, size} session
//          rev=0 creates (X-Title required; X-Folder, X-Created, X-Updated optional).
//          Otherwise 409 {rev} unless <n> is the stored rev. X-Pics lists the picture ids
//          the note uses (comma separated) so pictures nothing uses can be swept later.
//   PATCH  /api/notes/<id> {title?, folder?}          -> {ok}                          session
//   DELETE /api/notes/<id>                            -> {ok}                          session
//   PUT    /api/pics/<id>  body = bytes               -> {ok}, write once              session
//   GET    /api/pics/<id>                             -> bytes, cacheable forever      session
//   POST   /api/carry  body = bytes  (public, CORS *) -> {id}
//   GET    /api/carry/<id>                            -> bytes                         session
//   DELETE /api/carry/<id>                            -> {ok}                          session
//
// A carry is an encrypted parcel the old mypager page drops here so the new app can
// import that browser's board. Its key travels only in the URL fragment, never here.

import { DurableObject } from 'cloudflare:workers';

const HOUR = 36e5, DAY = 864e5, MIN = 6e4;
const SESSION_MS = 30 * DAY;          // sliding: refreshed at most every TOUCH_MS of use
const TOUCH_MS = 6 * HOUR;
const CARRY_MS = 90 * DAY, CARRY_CAP = 200;
const PIC_GRACE = 7 * DAY, SWEEP_EVERY = 6 * HOUR;  // grace lets Undo bring a picture back
const CHUNK = 1000000;                // one SQLite value is capped at 2 MB
const MAX_NOTE = 24 << 20, MAX_PIC = 16 << 20, MAX_CARRY = 24 << 20, MAX_PICS = 500;
const LOGIN = /^[a-z0-9][a-z0-9._-]{2,31}$/;     // login IDs, lowercased by the app
const KEY = /^[A-Za-z0-9_-]{16,32}$/;             // folder, note, picture and carry ids
const SEALED = /^[A-Za-z0-9_-]{38,4096}$/;        // an encrypted title or folder name
const WRAPPED = /^[A-Za-z0-9_-]{60,200}$/;        // the wrapped data key
const te = new TextEncoder();

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

const sha = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const hex = u => Array.from(u, b => b.toString(16).padStart(2, '0')).join('');
const b64u = u => btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const randomKey = n => b64u(crypto.getRandomValues(new Uint8Array(n)));
function cat(a, b) { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
function authBytes(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s)) return null;
  const u = unb64u(s);
  return u.length === 32 ? u : null;
}
// A client-supplied timestamp, only ever in the past (imports keep their old dates).
const when = (v, now) => { const t = Number(v); return Number.isSafeInteger(t) && t > 946684800000 && t <= now ? t : now; };
function parsePics(h) {
  if (!h) return [];
  const ids = [...new Set(h.split(','))];
  return ids.length <= MAX_PICS && ids.every(x => KEY.test(x)) ? ids : null;
}

// Read and discard a body we are not using. Answering with it half read breaks the next
// request in wrangler dev (same trap as mycollage).
async function drain(req) {
  if (req.body && !req.bodyUsed) for await (const _ of req.body) { /* discard */ }
}
async function readJSON(req, max = 16384) {
  if (Number(req.headers.get('Content-Length') || 0) > max) return null;
  const raw = await req.text();
  if (raw.length > max) return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}
async function readBytes(req, max) {
  if (Number(req.headers.get('Content-Length') || 0) > max) return null;
  const buf = await req.arrayBuffer();
  return buf.byteLength > max ? null : buf;
}

// https gets a __Host- cookie (no subdomain of workers.dev can plant or read it);
// plain http only happens in wrangler dev.
const cookieName = url => url.protocol === 'https:' ? '__Host-mp' : 'mp';
const cookie = (url, value, maxAge) =>
  `${cookieName(url)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${url.protocol === 'https:' ? '; Secure' : ''}`;
function readCookie(req, name) {
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const sameOrigin = (req, url) => req.headers.get('Origin') === url.origin;

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const q of [
      'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, salt BLOB NOT NULL, verifier BLOB NOT NULL, wrapped TEXT NOT NULL, created INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user TEXT NOT NULL, expires INTEGER NOT NULL, seen INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user)',
      'CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, user TEXT NOT NULL, parent TEXT, name TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS folders_user ON folders(user)',
      'CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, user TEXT NOT NULL, folder TEXT, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, rev INTEGER NOT NULL, size INTEGER NOT NULL, parts INTEGER NOT NULL, body BLOB)',
      'CREATE INDEX IF NOT EXISTS notes_user ON notes(user)',
      'CREATE TABLE IF NOT EXISTS pics(id TEXT PRIMARY KEY, user TEXT NOT NULL, created INTEGER NOT NULL, size INTEGER NOT NULL, parts INTEGER NOT NULL, body BLOB)',
      'CREATE INDEX IF NOT EXISTS pics_created ON pics(created)',
      'CREATE TABLE IF NOT EXISTS refs(note TEXT NOT NULL, pic TEXT NOT NULL, PRIMARY KEY(note, pic))',
      'CREATE INDEX IF NOT EXISTS refs_pic ON refs(pic)',
      'CREATE TABLE IF NOT EXISTS carries(id TEXT PRIMARY KEY, created INTEGER NOT NULL, size INTEGER NOT NULL, parts INTEGER NOT NULL, body BLOB)',
      'CREATE TABLE IF NOT EXISTS parts(owner TEXT NOT NULL, n INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(owner, n))',
      'CREATE TABLE IF NOT EXISTS hits(k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v INTEGER NOT NULL)',
    ]) this.sql.exec(q);
  }

  one(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] || null; }
  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  tx(fn) { return this.ctx.storage.transactionSync(fn); }

  // ---- blobs: up to CHUNK bytes live in the row's own `body`, bigger ones in `parts` rows.
  // Call putBlob inside a transaction.
  putBlob(owner, buf) {
    this.sql.exec('DELETE FROM parts WHERE owner = ?', owner);
    if (buf.byteLength <= CHUNK) return { parts: 0, body: buf };
    let n = 0;
    for (let off = 0; off < buf.byteLength; off += CHUNK)
      this.sql.exec('INSERT INTO parts(owner, n, data) VALUES(?, ?, ?)', owner, n++, buf.slice(off, off + CHUNK));
    return { parts: n, body: null };
  }
  getBlob(owner, row) {
    if (!row.parts) return row.body;
    const out = new Uint8Array(row.size);
    let off = 0;
    for (const p of this.sql.exec('SELECT data FROM parts WHERE owner = ? ORDER BY n', owner)) {
      out.set(new Uint8Array(p.data), off);
      off += p.data.byteLength;
    }
    return out;
  }
  bytes(owner, row, headers = {}) {
    return new Response(this.getBlob(owner, row), {
      headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
    });
  }

  // ---- fixed-window rate limits
  limited(k, max) {
    const r = this.one('SELECT n, reset FROM hits WHERE k = ?', k);
    return !!r && r.reset > Date.now() && r.n >= max;
  }
  hit(k, windowMs) {
    const now = Date.now(), r = this.one('SELECT reset FROM hits WHERE k = ?', k);
    if (r && r.reset > now) this.sql.exec('UPDATE hits SET n = n + 1 WHERE k = ?', k);
    else this.sql.exec('INSERT OR REPLACE INTO hits(k, n, reset) VALUES(?, 1, ?)', k, now + windowMs);
  }

  // ---- sessions
  async session(req, url) {
    const token = readCookie(req, cookieName(url));
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = hex(await sha(te.encode(token)));
    const s = this.one('SELECT user, expires, seen FROM sessions WHERE hash = ?', hash);
    if (!s) return null;
    const now = Date.now();
    if (s.expires <= now) { this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash); return null; }
    let refresh = null;
    if (now - s.seen > TOUCH_MS) {
      this.sql.exec('UPDATE sessions SET seen = ?, expires = ? WHERE hash = ?', now, now + SESSION_MS, hash);
      refresh = cookie(url, token, SESSION_MS / 1000);
    }
    return { user: s.user, hash, refresh };
  }
  async startSession(user, url) {
    const token = randomKey(32), now = Date.now();
    this.sql.exec('DELETE FROM sessions WHERE expires <= ?', now);
    this.sql.exec('INSERT INTO sessions(hash, user, expires, seen) VALUES(?, ?, ?, ?)',
      hex(await sha(te.encode(token))), user, now + SESSION_MS, now);
    return cookie(url, token, SESSION_MS / 1000);
  }

  // ---- accounts
  async signup(req, url, ipk) {
    const b = await readJSON(req);
    if (this.limited('su:' + ipk, 10)) return fail(429, 'Too many tries. Wait a few minutes.');
    this.hit('su:' + ipk, 15 * MIN);
    const invite = this.env.INVITE_CODE;
    if (!invite) return fail(403, 'Sign-up is closed.');
    if (!b || typeof b.invite !== 'string' || !same(await sha(te.encode(b.invite)), await sha(te.encode(invite))))
      return fail(403, 'That invite code is not right.');
    const id = typeof b.id === 'string' ? b.id : '';
    if (!LOGIN.test(id)) return fail(400, 'IDs are 3 to 32 characters: lowercase letters, digits, dot, dash or underscore.');
    const auth = authBytes(b.auth);
    if (!auth || typeof b.wrapped !== 'string' || !WRAPPED.test(b.wrapped)) return fail(400, 'Bad request.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const verifier = await sha(cat(salt, auth));
    if (this.one('SELECT 1 FROM users WHERE id = ?', id)) return fail(409, 'That ID is taken.');
    this.sql.exec('INSERT INTO users(id, salt, verifier, wrapped, created) VALUES(?, ?, ?, ?, ?)',
      id, salt.buffer, verifier.buffer, b.wrapped, Date.now());
    return json({ id, wrapped: b.wrapped }, 201, { 'Set-Cookie': await this.startSession(id, url) });
  }

  async login(req, url, ipk) {
    const b = await readJSON(req);
    const id = b && typeof b.id === 'string' ? b.id : '';
    const kIp = 'li:' + ipk, kId = 'lu:' + id;
    if (this.limited(kIp, 30) || this.limited(kId, 8)) return fail(429, 'Too many wrong tries. Wait 15 minutes.');
    const auth = authBytes(b && b.auth);
    const u = LOGIN.test(id) ? this.one('SELECT salt, verifier, wrapped FROM users WHERE id = ?', id) : null;
    const salt = u ? new Uint8Array(u.salt) : new Uint8Array(16);
    const check = await sha(cat(salt, auth || new Uint8Array(32)));   // same work whether or not the ID exists
    if (!u || !auth || !same(check, new Uint8Array(u.verifier))) {
      this.hit(kIp, 15 * MIN);
      if (LOGIN.test(id)) this.hit(kId, 15 * MIN);
      return fail(401, 'Wrong ID or password.');
    }
    const now = Date.now();
    this.sql.exec('DELETE FROM hits WHERE k = ? OR reset <= ?', kId, now);
    return json({ id, wrapped: u.wrapped }, 200, { 'Set-Cookie': await this.startSession(id, url) });
  }

  async logout(req, url) {
    const token = readCookie(req, cookieName(url));
    if (token) this.sql.exec('DELETE FROM sessions WHERE hash = ?', hex(await sha(te.encode(token))));
    return json({ ok: true }, 200, { 'Set-Cookie': cookie(url, '', 0) });
  }

  async password(req, s) {
    const b = await readJSON(req);
    if (this.limited('lu:' + s.user, 8)) return fail(429, 'Too many wrong tries. Wait 15 minutes.');
    const auth = authBytes(b && b.auth), next = authBytes(b && b.newAuth);
    if (!auth || !next || typeof b.wrapped !== 'string' || !WRAPPED.test(b.wrapped)) return fail(400, 'Bad request.');
    const u = this.one('SELECT salt, verifier FROM users WHERE id = ?', s.user);
    if (!u || !same(await sha(cat(new Uint8Array(u.salt), auth)), new Uint8Array(u.verifier))) {
      this.hit('lu:' + s.user, 15 * MIN);
      return fail(401, 'Current password is wrong.', { field: 'current' });
    }
    const salt = crypto.getRandomValues(new Uint8Array(16)), verifier = await sha(cat(salt, next));
    this.tx(() => {
      this.sql.exec('UPDATE users SET salt = ?, verifier = ?, wrapped = ? WHERE id = ?', salt.buffer, verifier.buffer, b.wrapped, s.user);
      this.sql.exec('DELETE FROM sessions WHERE user = ? AND hash != ?', s.user, s.hash);
    });
    return json({ ok: true });
  }

  // ---- folders
  ownsFolder(user, id) { return KEY.test(id) && !!this.one('SELECT 1 FROM folders WHERE id = ? AND user = ?', id, user); }

  tree(s) {
    return json({
      folders: this.all('SELECT id, parent, name, created, updated FROM folders WHERE user = ?', s.user),
      notes: this.all('SELECT id, folder, title, created, updated, rev, size FROM notes WHERE user = ?', s.user),
    });
  }

  async addFolder(req, s) {
    const b = await readJSON(req);
    if (!b || typeof b.id !== 'string' || !KEY.test(b.id) || typeof b.name !== 'string' || !SEALED.test(b.name)) return fail(400, 'Bad folder.');
    const parent = b.parent ?? null;
    if (parent !== null && !this.ownsFolder(s.user, parent)) return fail(400, 'No such parent folder.');
    if (this.one('SELECT 1 FROM folders WHERE id = ?', b.id)) return fail(409, 'That folder already exists.');
    const now = Date.now();
    this.sql.exec('INSERT INTO folders(id, user, parent, name, created, updated) VALUES(?, ?, ?, ?, ?, ?)', b.id, s.user, parent, b.name, now, now);
    return json({ ok: true, created: now }, 201);
  }

  async editFolder(req, s, id) {
    const b = await readJSON(req);
    const all = this.all('SELECT id, parent FROM folders WHERE user = ?', s.user);
    if (!all.some(f => f.id === id)) return fail(404, 'No such folder.');
    if (!b) return fail(400, 'Bad request.');
    if ('name' in b && (typeof b.name !== 'string' || !SEALED.test(b.name))) return fail(400, 'Bad name.');
    if ('parent' in b) {
      const parent = b.parent ?? null;
      if (parent !== null) {
        if (!all.some(f => f.id === parent)) return fail(400, 'No such parent folder.');
        const up = new Map(all.map(f => [f.id, f.parent]));
        for (let p = parent, i = 0; p != null && i <= all.length; p = up.get(p), i++)
          if (p === id) return fail(400, "A folder can't go inside itself.");
      }
    }
    const now = Date.now();
    this.tx(() => {
      if ('name' in b) this.sql.exec('UPDATE folders SET name = ?, updated = ? WHERE id = ?', b.name, now, id);
      if ('parent' in b) this.sql.exec('UPDATE folders SET parent = ?, updated = ? WHERE id = ?', b.parent ?? null, now, id);
    });
    return json({ ok: true });
  }

  dropFolder(s, id, keep) {
    const all = this.all('SELECT id, parent FROM folders WHERE user = ?', s.user);
    const f = all.find(x => x.id === id);
    if (!f) return fail(404, 'No such folder.');
    this.tx(() => {
      if (keep) {
        this.sql.exec('UPDATE notes SET folder = ? WHERE user = ? AND folder = ?', f.parent, s.user, id);
        this.sql.exec('UPDATE folders SET parent = ? WHERE user = ? AND parent = ?', f.parent, s.user, id);
        this.sql.exec('DELETE FROM folders WHERE id = ?', id);
        return;
      }
      const doomed = new Set([id]);
      for (let grew = true; grew;) {
        grew = false;
        for (const x of all) if (x.parent && doomed.has(x.parent) && !doomed.has(x.id)) { doomed.add(x.id); grew = true; }
      }
      for (const fid of doomed) {
        for (const n of this.all('SELECT id FROM notes WHERE user = ? AND folder = ?', s.user, fid)) this.dropNote(n.id);
        this.sql.exec('DELETE FROM folders WHERE id = ?', fid);
      }
    });
    return json({ ok: true });
  }

  // ---- notes
  dropNote(id) {
    this.sql.exec('DELETE FROM parts WHERE owner = ?', 'n:' + id);
    this.sql.exec('DELETE FROM refs WHERE note = ?', id);
    this.sql.exec('DELETE FROM notes WHERE id = ?', id);
  }

  getNote(s, id) {
    const r = this.one('SELECT rev, updated, size, parts, body FROM notes WHERE id = ? AND user = ?', id, s.user);
    if (!r) return fail(404, 'That note no longer exists.');
    return this.bytes('n:' + id, r, { 'X-Rev': String(r.rev), 'X-Updated': String(r.updated) });
  }

  // Only rewrite the reference rows that changed: most saves change none.
  setRefs(note, pics) {
    const have = new Set(this.all('SELECT pic FROM refs WHERE note = ?', note).map(r => r.pic));
    for (const p of pics) if (!have.delete(p)) this.sql.exec('INSERT INTO refs(note, pic) VALUES(?, ?)', note, p);
    for (const p of have) this.sql.exec('DELETE FROM refs WHERE note = ? AND pic = ?', note, p);
  }

  async putNote(req, url, s, id) {
    const base = Number(url.searchParams.get('rev'));
    if (!Number.isSafeInteger(base) || base < 0) return fail(400, 'Bad rev.');
    const pics = parsePics(req.headers.get('X-Pics'));
    if (!pics) return fail(400, 'Bad picture list.');
    const title = req.headers.get('X-Title'), folder = req.headers.get('X-Folder') || null;
    const buf = await readBytes(req, MAX_NOTE);
    if (!buf) return fail(413, 'This note is too big to save (24 MB).');
    if (buf.byteLength < 28) return fail(400, 'Empty note.');
    const now = Date.now();
    const cur = this.one('SELECT user, rev FROM notes WHERE id = ?', id);
    if (base === 0) {
      if (cur) return cur.user === s.user ? fail(409, 'That note already exists.', { rev: cur.rev }) : fail(409, 'That id is in use.');
      if (!title || !SEALED.test(title)) return fail(400, 'Bad title.');
      if (folder !== null && !this.ownsFolder(s.user, folder)) return fail(400, 'No such folder.');
      const created = when(req.headers.get('X-Created'), now);
      const updated = Math.max(created, when(req.headers.get('X-Updated'), now));
      this.tx(() => {
        const b = this.putBlob('n:' + id, buf);
        this.sql.exec('INSERT INTO notes(id, user, folder, title, created, updated, rev, size, parts, body) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
          id, s.user, folder, title, created, updated, buf.byteLength, b.parts, b.body);
        this.setRefs(id, pics);
      });
      return json({ rev: 1, created, updated, size: buf.byteLength }, 201);
    }
    if (!cur || cur.user !== s.user) return fail(404, 'That note no longer exists.');
    if (cur.rev !== base) return fail(409, 'This note changed on another device.', { rev: cur.rev });
    this.tx(() => {
      const b = this.putBlob('n:' + id, buf);
      this.sql.exec('UPDATE notes SET rev = rev + 1, updated = ?, size = ?, parts = ?, body = ? WHERE id = ?',
        now, buf.byteLength, b.parts, b.body, id);
      this.setRefs(id, pics);
    });
    this.sweep(now);
    return json({ rev: base + 1, updated: now, size: buf.byteLength });
  }

  async editNote(req, s, id) {
    const b = await readJSON(req);
    if (!this.one('SELECT 1 FROM notes WHERE id = ? AND user = ?', id, s.user)) return fail(404, 'That note no longer exists.');
    if (!b) return fail(400, 'Bad request.');
    if ('title' in b && (typeof b.title !== 'string' || !SEALED.test(b.title))) return fail(400, 'Bad title.');
    const folder = b.folder ?? null;
    if ('folder' in b && folder !== null && !this.ownsFolder(s.user, folder)) return fail(400, 'No such folder.');
    this.tx(() => {
      if ('title' in b) this.sql.exec('UPDATE notes SET title = ? WHERE id = ?', b.title, id);
      if ('folder' in b) this.sql.exec('UPDATE notes SET folder = ? WHERE id = ?', folder, id);
    });
    return json({ ok: true });
  }

  // ---- pictures (write once; a new drawing or picture gets a new id)
  async putPic(req, s, id) {
    const buf = await readBytes(req, MAX_PIC);
    if (!buf) return fail(413, 'That picture is too big (16 MB).');
    if (buf.byteLength < 29) return fail(400, 'Empty picture.');
    const cur = this.one('SELECT user FROM pics WHERE id = ?', id);
    if (cur) return cur.user === s.user ? json({ ok: true }) : fail(409, 'That id is in use.');
    this.tx(() => {
      const b = this.putBlob('p:' + id, buf);
      this.sql.exec('INSERT INTO pics(id, user, created, size, parts, body) VALUES(?, ?, ?, ?, ?, ?)',
        id, s.user, Date.now(), buf.byteLength, b.parts, b.body);
    });
    return json({ ok: true }, 201);
  }

  getPic(s, id) {
    const r = this.one('SELECT size, parts, body FROM pics WHERE id = ? AND user = ?', id, s.user);
    if (!r) return fail(404, 'No such picture.');
    return this.bytes('p:' + id, r, { 'Cache-Control': 'private, max-age=31536000, immutable' });
  }

  // Pictures no note has referenced for a week. Runs at most every SWEEP_EVERY.
  sweep(now) {
    const last = this.one("SELECT v FROM kv WHERE k = 'sweep'");
    if (last && now - last.v < SWEEP_EVERY) return;
    this.sql.exec("INSERT OR REPLACE INTO kv(k, v) VALUES('sweep', ?)", now);
    const dead = this.all('SELECT id FROM pics WHERE created < ? AND NOT EXISTS (SELECT 1 FROM refs WHERE refs.pic = pics.id) LIMIT 200', now - PIC_GRACE);
    if (dead.length) this.tx(() => {
      for (const d of dead) {
        this.sql.exec('DELETE FROM parts WHERE owner = ?', 'p:' + d.id);
        this.sql.exec('DELETE FROM pics WHERE id = ?', d.id);
      }
    });
  }

  // ---- carries (parcels from the old mypager page)
  dropCarry(id) {
    this.sql.exec('DELETE FROM parts WHERE owner = ?', 'c:' + id);
    this.sql.exec('DELETE FROM carries WHERE id = ?', id);
  }

  async addCarry(req, ipk) {
    const now = Date.now();
    for (const c of this.all('SELECT id FROM carries WHERE created < ?', now - CARRY_MS)) this.dropCarry(c.id);
    if (this.limited('cy:' + ipk, 30)) return fail(429, 'Too many parcels from this network today.');
    if (this.one('SELECT COUNT(*) AS n FROM carries').n >= CARRY_CAP) return fail(503, 'The import inbox is full. Try again later.');
    const buf = await readBytes(req, MAX_CARRY);
    if (!buf) return fail(413, 'That is too big to carry (24 MB).');
    if (buf.byteLength < 29) return fail(400, 'Empty parcel.');
    this.hit('cy:' + ipk, DAY);
    const id = randomKey(16);
    this.tx(() => {
      const b = this.putBlob('c:' + id, buf);
      this.sql.exec('INSERT INTO carries(id, created, size, parts, body) VALUES(?, ?, ?, ?, ?)', id, now, buf.byteLength, b.parts, b.body);
    });
    return json({ id }, 201);
  }

  getCarry(id) {
    const r = this.one('SELECT size, parts, body FROM carries WHERE id = ?', id);
    return r ? this.bytes('c:' + id, r) : fail(404, 'That import link was already used or has expired.');
  }

  // ---- routing
  async fetch(req) {
    let res;
    try { res = await this.route(req); }
    catch (e) { console.error(e && e.stack || e); res = fail(500, 'Server error.'); }
    await drain(req);
    return res;
  }

  async route(req) {
    const url = new URL(req.url), p = url.pathname, m = req.method;
    const ipk = hex(await sha(te.encode('mypager|' + (req.headers.get('CF-Connecting-IP') || 'local')))).slice(0, 16);
    if (p === '/api/carry' && m === 'POST') return this.addCarry(req, ipk);
    if (m !== 'GET' && m !== 'HEAD' && !sameOrigin(req, url)) return fail(403, 'Cross-site request refused.');
    if (p === '/api/signup' && m === 'POST') return this.signup(req, url, ipk);
    if (p === '/api/login' && m === 'POST') return this.login(req, url, ipk);
    if (p === '/api/logout' && m === 'POST') return this.logout(req, url);
    const s = await this.session(req, url);
    if (!s) return fail(401, 'Your session ended. Log in again.');
    const res = await this.authed(req, url, s);
    if (s.refresh) res.headers.append('Set-Cookie', s.refresh);
    return res;
  }

  async authed(req, url, s) {
    const p = url.pathname, m = req.method;
    if (p === '/api/me' && m === 'GET') {
      const u = this.one('SELECT wrapped FROM users WHERE id = ?', s.user);
      return u ? json({ id: s.user, wrapped: u.wrapped }) : fail(401, 'Your session ended. Log in again.');
    }
    if (p === '/api/password' && m === 'POST') return this.password(req, s);
    if (p === '/api/tree' && m === 'GET') return this.tree(s);
    if (p === '/api/folders' && m === 'POST') return this.addFolder(req, s);
    const k = /^\/api\/(folders|notes|pics|carry)\/([A-Za-z0-9_-]{16,32})$/.exec(p);
    if (k) {
      const [, kind, id] = k;
      if (kind === 'folders') {
        if (m === 'PATCH') return this.editFolder(req, s, id);
        if (m === 'DELETE') return this.dropFolder(s, id, url.searchParams.get('keep') === '1');
      } else if (kind === 'notes') {
        if (m === 'GET') return this.getNote(s, id);
        if (m === 'PUT') return this.putNote(req, url, s, id);
        if (m === 'PATCH') return this.editNote(req, s, id);
        if (m === 'DELETE') {
          if (!this.one('SELECT 1 FROM notes WHERE id = ? AND user = ?', id, s.user)) return fail(404, 'That note no longer exists.');
          this.tx(() => this.dropNote(id));
          return json({ ok: true });
        }
      } else if (kind === 'pics') {
        if (m === 'GET') return this.getPic(s, id);
        if (m === 'PUT') return this.putPic(req, s, id);
      } else {
        if (m === 'GET') return this.getCarry(id);
        if (m === 'DELETE') { this.tx(() => this.dropCarry(id)); return json({ ok: true }); }
      }
      return fail(405, 'Method not allowed.');
    }
    return fail(404, 'Not found.');
  }
}

// Only POST /api/carry is open to other origins: the old mypager page (and file://
// copies of it) post their encrypted parcel there.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const store = env.STORE.get(env.STORE.idFromName('main'));
    if (url.pathname !== '/api/carry') return store.fetch(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const res = await store.fetch(req);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },
};
