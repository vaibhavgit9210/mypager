// API suite for the mypager worker. Run against `wrangler dev` only (it creates accounts):
//   node tests/api.test.mjs [http://localhost:8787]
import {randomBytes} from 'node:crypto';
const BASE = process.argv[2] || 'http://localhost:8787';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) { console.error('refusing: not a local base'); process.exit(2); }
const INVITE = process.env.INVITE || 'dev-invite';

let fails = 0;
const check = (name, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  if (!cond) fails++;
};
const b64u = u => Buffer.from(u).toString('base64url');
const rnd = n => new Uint8Array(randomBytes(n));
const id16 = () => b64u(rnd(12));
const sealedLike = n => b64u(rnd(n));           // stands in for an encrypted title / name

function client(origin = BASE) {
  let cookie = '';
  async function req(method, path, {json, body, headers = {}, noOrigin} = {}) {
    const h = {...headers};
    if (!noOrigin && method !== 'GET') h.Origin = origin;
    if (cookie) h.Cookie = cookie;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(BASE + '/api/' + path, {method, headers: h, body});
    const set = r.headers.get('set-cookie');
    if (set) { const m = /(?:^|,\s*)(mp=[^;]*)/.exec(set); if (m) cookie = m[1] === 'mp=' ? '' : m[1]; }
    const type = r.headers.get('content-type') || '';
    const data = type.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer());
    return {status: r.status, data, headers: r.headers};
  }
  return {req, get cookie() { return cookie; }, set cookie(v) { cookie = v; }};
}

const userA = 'tester' + Date.now().toString(36).slice(-4), userB = 'other' + Date.now().toString(36).slice(-4);
const authA = b64u(rnd(32)), authB = b64u(rnd(32)), wrapped = sealedLike(60);
const A = client(), B = client();

// ---- sign up
let r = await A.req('POST', 'signup', {json: {id: userA, auth: authA, wrapped, invite: 'nope'}});
check('signup with a wrong invite is refused', r.status === 403, r);
r = await A.req('POST', 'signup', {json: {id: 'X!', auth: authA, wrapped, invite: INVITE}});
check('signup with a bad ID is refused', r.status === 400, r);
r = await A.req('POST', 'signup', {json: {id: userA, auth: authA, wrapped, invite: INVITE}, noOrigin: true});
check('signup without an Origin header is refused', r.status === 403, r);
r = await A.req('POST', 'signup', {json: {id: userA, auth: authA, wrapped, invite: INVITE}});
check('signup works', r.status === 201 && r.data.id === userA && !!A.cookie, r);
r = await B.req('POST', 'signup', {json: {id: userA, auth: authB, wrapped, invite: INVITE}});
check('a taken ID is refused', r.status === 409, r);
r = await B.req('POST', 'signup', {json: {id: userB, auth: authB, wrapped, invite: INVITE}});
check('second account works', r.status === 201, r);

// ---- me / login / logout
r = await A.req('GET', 'me');
check('me returns id + wrapped key', r.status === 200 && r.data.id === userA && r.data.wrapped === wrapped, r);
const anon = client();
r = await anon.req('GET', 'me');
check('me without a session is 401', r.status === 401, r);
r = await anon.req('POST', 'login', {json: {id: userA, auth: authB}});
check('login with the wrong password is 401', r.status === 401, r);
r = await anon.req('POST', 'login', {json: {id: userA, auth: authA}});
check('login works', r.status === 200 && r.data.wrapped === wrapped && !!anon.cookie, r);
r = await anon.req('POST', 'logout');
check('logout clears the cookie', r.status === 200 && !anon.cookie, r);
const evil = client('https://evil.example');
evil.cookie = A.cookie;
r = await evil.req('POST', 'folders', {json: {id: id16(), parent: null, name: sealedLike(40)}});
check('a write from another origin is refused even with the cookie', r.status === 403, r);

// ---- folders
const f1 = id16(), f2 = id16(), f3 = id16();
r = await A.req('POST', 'folders', {json: {id: f1, parent: null, name: sealedLike(40)}});
check('create folder', r.status === 201, r);
r = await A.req('POST', 'folders', {json: {id: f2, parent: f1, name: sealedLike(40)}});
check('create subfolder', r.status === 201, r);
r = await A.req('POST', 'folders', {json: {id: f3, parent: f2, name: sealedLike(40)}});
check('create sub-subfolder', r.status === 201, r);
r = await A.req('PATCH', 'folders/' + f1, {json: {parent: f3}});
check('moving a folder into its own descendant is refused', r.status === 400, r);
r = await A.req('PATCH', 'folders/' + f1, {json: {parent: f1}});
check('moving a folder into itself is refused', r.status === 400, r);
r = await B.req('POST', 'folders', {json: {id: id16(), parent: f1, name: sealedLike(40)}});
check("another account can't use my folder as a parent", r.status === 400, r);

// ---- notes
const n1 = id16(), body1 = rnd(500), title = sealedLike(40);
r = await A.req('PUT', 'notes/' + n1 + '?rev=0', {body: body1, headers: {'X-Title': title, 'X-Folder': f2, 'X-Created': '1700000000000'}});
check('create note', r.status === 201 && r.data.rev === 1 && r.data.created === 1700000000000, r);
r = await A.req('PUT', 'notes/' + n1 + '?rev=0', {body: body1, headers: {'X-Title': title}});
check('creating the same note twice is 409', r.status === 409 && r.data.rev === 1, r);
r = await A.req('GET', 'notes/' + n1);
check('read note back byte for byte', r.status === 200 && Buffer.from(r.data).equals(Buffer.from(body1)) && r.headers.get('x-rev') === '1', r.status);
r = await A.req('PUT', 'notes/' + n1 + '?rev=1', {body: rnd(600)});
check('save at the current rev', r.status === 200 && r.data.rev === 2, r);
r = await A.req('PUT', 'notes/' + n1 + '?rev=1', {body: rnd(600)});
check('save from a stale rev is 409 with the current rev', r.status === 409 && r.data.rev === 2, r);
r = await B.req('GET', 'notes/' + n1);
check("another account can't read my note", r.status === 404, r);
r = await B.req('PUT', 'notes/' + n1 + '?rev=2', {body: rnd(600)});
check("another account can't write my note", r.status === 404, r);
r = await A.req('PATCH', 'notes/' + n1, {json: {title: sealedLike(50), folder: null}});
check('rename + move a note to the top level', r.status === 200, r);
r = await A.req('GET', 'tree');
check('tree lists folders and notes', r.status === 200 && r.data.folders.length === 3 && r.data.notes.length === 1 && r.data.notes[0].folder === null && r.data.notes[0].rev === 2, r.data);

// big bodies are split into parts
const big = rnd(3_300_000);
const n2 = id16();
r = await A.req('PUT', 'notes/' + n2 + '?rev=0', {body: big, headers: {'X-Title': title, 'X-Folder': f3}});
check('create a 3.3 MB note', r.status === 201, r);
r = await A.req('GET', 'notes/' + n2);
check('3.3 MB note comes back intact', r.status === 200 && Buffer.from(r.data).equals(Buffer.from(big)), r.status);
const small = rnd(1000);
r = await A.req('PUT', 'notes/' + n2 + '?rev=1', {body: small});
r = await A.req('GET', 'notes/' + n2);
check('shrinking it back to one row works', r.status === 200 && Buffer.from(r.data).equals(Buffer.from(small)), r.status);

// ---- pictures
const p1 = id16(), pic = rnd(1_500_000);
r = await A.req('PUT', 'pics/' + p1, {body: pic});
check('upload picture (chunked)', r.status === 201, r);
r = await A.req('PUT', 'pics/' + p1, {body: pic});
check('re-uploading the same picture is fine', r.status === 200, r);
r = await A.req('GET', 'pics/' + p1);
check('picture comes back intact and cacheable', r.status === 200 && Buffer.from(r.data).equals(Buffer.from(pic)) && /immutable/.test(r.headers.get('cache-control')), r.status);
r = await B.req('GET', 'pics/' + p1);
check("another account can't read my picture", r.status === 404, r);
r = await A.req('PUT', 'notes/' + n1 + '?rev=2', {body: rnd(100), headers: {'X-Pics': p1 + ',bad id'}});
check('a malformed picture list is refused', r.status === 400, r);
r = await A.req('PUT', 'notes/' + n1 + '?rev=2', {body: rnd(100), headers: {'X-Pics': p1}});
check('save with a picture reference', r.status === 200 && r.data.rev === 3, r);

// ---- folder deletion
r = await A.req('DELETE', 'folders/' + f2 + '?keep=1');
check('delete folder, keep contents', r.status === 200, r);
r = await A.req('GET', 'tree');
const t2 = r.data;
check('its subfolder moved up to the parent', t2.folders.find(f => f.id === f3)?.parent === f1 && !t2.folders.find(f => f.id === f2), t2.folders);
r = await A.req('DELETE', 'folders/' + f1);
check('delete folder with everything in it', r.status === 200, r);
r = await A.req('GET', 'tree');
check('folders and the note inside are gone; the top-level note stays', r.data.folders.length === 0 && r.data.notes.length === 1 && r.data.notes[0].id === n1, r.data);
r = await A.req('GET', 'notes/' + n2);
check('deleted note is 404', r.status === 404, r);

// ---- carry (public drop box used by the old page)
let pre = await fetch(BASE + '/api/carry', {method: 'OPTIONS', headers: {Origin: 'https://vaibhavkumar.is-a.dev', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type'}});
check('carry preflight allows any origin', pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*', pre.status);
const parcel = rnd(2_100_000);
let cr = await fetch(BASE + '/api/carry', {method: 'POST', headers: {Origin: 'null', 'Content-Type': 'application/octet-stream'}, body: parcel});
const cj = await cr.json();
check('carry accepts a parcel from file://', cr.status === 201 && /^[A-Za-z0-9_-]{22}$/.test(cj.id) && cr.headers.get('access-control-allow-origin') === '*', cj);
r = await anon.req('GET', 'carry/' + cj.id);
check('reading a carry needs a session', r.status === 401, r);
r = await A.req('GET', 'carry/' + cj.id);
check('carry comes back intact', r.status === 200 && Buffer.from(r.data).equals(Buffer.from(parcel)), r.status);
r = await A.req('DELETE', 'carry/' + cj.id);
r = await A.req('GET', 'carry/' + cj.id);
check('a used carry is gone', r.status === 404, r);

// ---- password change ends the other sessions
const A2 = client();
await A2.req('POST', 'login', {json: {id: userA, auth: authA}});
const authA2 = b64u(rnd(32)), wrapped2 = sealedLike(60);
r = await A.req('POST', 'password', {json: {auth: authB, newAuth: authA2, wrapped: wrapped2}});
check('password change with the wrong current password is 401', r.status === 401, r);
r = await A.req('POST', 'password', {json: {auth: authA, newAuth: authA2, wrapped: wrapped2}});
check('password change works', r.status === 200, r);
r = await A2.req('GET', 'me');
check('the other session ended', r.status === 401, r);
r = await A.req('GET', 'me');
check('this session lives on with the new wrapped key', r.status === 200 && r.data.wrapped === wrapped2, r);
r = await anon.req('POST', 'login', {json: {id: userA, auth: authA}});
check('the old password no longer logs in', r.status === 401, r);
r = await anon.req('POST', 'login', {json: {id: userA, auth: authA2}});
check('the new password logs in', r.status === 200 && r.data.wrapped === wrapped2, r);

// ---- login rate limit (per ID)
const bad = client();
let last;
for (let i = 0; i < 9; i++) last = await bad.req('POST', 'login', {json: {id: userB, auth: authA}});
check('9th wrong try in a row is rate limited', last.status === 429, last);
r = await bad.req('POST', 'login', {json: {id: userB, auth: authB}});
check('...even with the right password, until the window passes', r.status === 429, r);

console.log(fails ? `${fails} failure(s)` : 'all passed');
process.exit(fails ? 1 : 0);
