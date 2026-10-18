// Pack old data into an import link for the new mypager.
//   node tools/make-carry.mjs <base-url> notepad <file with notepad's data/notes.json>
//   node tools/make-carry.mjs <base-url> board   <file with a board.v2 value>
// The data goes up still locked with its old password (the app asks for it on import),
// inside a parcel encrypted under a fresh key. Prints the link; the key exists only in it,
// so treat the link like a secret until it has been opened once.
import {readFileSync} from 'node:fs';

export async function makeCarry(base, kind, text) {
  const payload = kind === 'notepad'
    ? {v: 1, kind: 'notepad', from: 'github.com/vaibhavgit9210/notepad', at: Date.now(), notepad: text.trim()}
    : {v: 1, kind: 'mypager-board', from: 'file', label: 'saved copy', at: Date.now(), board: text.trim()};
  const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(payload))));
  const body = new Uint8Array(12 + ct.length);
  body.set(iv); body.set(ct, 12);
  // a browser UA: Cloudflare's edge turns some script user agents away (error 1010)
  const r = await fetch(new URL('/api/carry', base), {method: 'POST', body,
    headers: {'Content-Type': 'application/octet-stream', 'User-Agent': 'Mozilla/5.0 (Macintosh) mypager-tools'}});
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'carry failed: ' + r.status);
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', key)).toString('base64url');
  return j.id + '.' + raw;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  const [base, kind, file] = process.argv.slice(2);
  if (!base || !['notepad', 'board'].includes(kind) || !file) {
    console.error('usage: node tools/make-carry.mjs <base-url> notepad|board <file>');
    process.exit(2);
  }
  const carry = await makeCarry(base, kind, readFileSync(file, 'utf8'));
  console.log(new URL('/', base).href + '#carry=' + carry);
}
