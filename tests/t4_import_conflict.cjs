// The old Notepad comes in through an import link (asks for its PIN); two devices editing the
// same note keep both versions; a password change logs other devices out and they log back in.
const L = require('./lib.cjs');
const saved = page => L.waitFor(page, () => S.open && !S.open.dirty && !S.open.saving && document.querySelector('#status').classList.contains('saved'), null, 20000);
const menuItem = (page, re) => page.evaluate(re => [...document.querySelectorAll('#menu button')].find(b => new RegExp(re).test(b.textContent)).click(), re);

// The old Notepad's format: base64(salt16 | iv12 | AES-GCM(JSON notes)), key = PBKDF2-SHA256(PIN, salt, 100k).
async function notepadBlob(pin, notes) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(JSON.stringify(notes, null, 2))));
  return Buffer.concat([salt, iv, ct]).toString('base64');
}

(async () => {
  const {makeCarry} = await import('../tools/make-carry.mjs');
  const browser = await L.launch('t4');
  const page = await browser.newPage();
  L.wire(page, 'A');
  await L.login(page);
  await L.waitFor(page, () => S.notes.size > 0);

  // 1. notepad import link: wrong PIN, then the right one
  const blob = await notepadBlob('123456', [
    {id: 'a1', title: 'Shopping', content: 'Shopping\nmilk\n  eggs', createdAt: '2026-02-19T00:07:00.000Z', updatedAt: '2026-02-20T16:34:00.000Z'},
    {id: 'a2', title: 'Ideas', content: 'Ideas for the weekend\n\n1. hike', createdAt: '2026-01-31T04:18:43.000Z', updatedAt: '2026-02-26T07:25:42.000Z'},
    {id: 'a3', title: 'empty', content: '   ', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z'},
  ]);
  const carry = await makeCarry(L.APP, 'notepad', blob);
  await page.goto(L.APP + '#carry=' + carry);
  await L.waitFor(page, () => document.querySelector('.dialog input[name=pw]'), null, 20000);
  L.check('asks for the Notepad PIN', await page.$eval('.dialog h3', h => h.textContent) === 'Import your old Notepad');
  await page.type('.dialog input[name=pw]', '000000');
  await page.click('.dialog [type=submit]');
  await L.waitFor(page, () => /PIN doesn't open/.test(document.querySelector('#toast').textContent) && document.querySelector('.dialog input[name=pw]'));
  L.check('a wrong PIN asks again', true);
  await page.type('.dialog input[name=pw]', '123456');
  await page.click('.dialog [type=submit]');
  await L.waitFor(page, () => [...S.folders.values()].some(f => f.label === 'Notepad') && [...S.notes.values()].filter(n => n.label === 'Shopping' || n.label === 'Ideas for the weekend').length === 2, null, 20000);
  const np = await page.evaluate(() => {
    const f = [...S.folders.values()].find(f => f.label === 'Notepad');
    const ns = [...S.notes.values()].filter(n => n.folder === f.id);
    return {count: ns.length, dates: ns.map(n => [n.label, new Date(n.created).toISOString().slice(0, 10), new Date(n.updated).toISOString().slice(0, 10)]).sort(), pending: JSON.parse(localStorage.getItem('mp.carries')).length};
  });
  L.check('Notepad folder with its 2 non-empty notes', np.count === 2 && np.pending === 0, np);
  L.check('original dates kept', JSON.stringify(np.dates) === JSON.stringify([['Ideas for the weekend', '2026-01-31', '2026-02-26'], ['Shopping', '2026-02-19', '2026-02-20']]), np.dates);
  await page.evaluate(() => openNote([...S.notes.values()].find(n => n.label === 'Shopping').id));
  await L.waitFor(page, () => S.open && S.notes.get(S.open.id).label === 'Shopping');
  const shop = await page.$eval('#root .text', t => t.innerText);
  L.check('note text and its indentation came through', /^Shopping\nmilk\n  eggs|^Shopping\nmilk\n {1,2} ?eggs/.test(shop.replace(/  /g, '  ')) || /Shopping\s+milk\s+eggs/.test(shop), shop);

  // 2. two devices, one note: the second save keeps both versions
  await page.evaluate(() => openNote([...S.notes.values()].find(n => n.label === 'Plan').id));
  await L.waitFor(page, () => S.open && S.notes.get(S.open.id).label === 'Plan');
  const ctx = await browser.createBrowserContext();
  const other = await ctx.newPage();
  L.wire(other, 'B');
  await L.login(other);
  await other.evaluate(() => openNote([...S.notes.values()].find(n => n.label === 'Plan').id));
  await L.waitFor(other, () => S.open && S.notes.get(S.open.id).label === 'Plan');
  await other.click('#root .pane .text');
  await other.keyboard.press('End');
  await other.keyboard.type(' (edited on B)');
  await saved(other);
  await page.click('#root .pane .text');                 // A still has the old version open
  await page.keyboard.press('End');
  await page.keyboard.type(' (edited on A)');
  await L.waitFor(page, () => [...S.notes.values()].some(n => /^Plan \(my version, /.test(n.label)), null, 20000);
  await saved(page);
  const after = await page.evaluate(async () => {
    const copy = [...S.notes.values()].find(n => /^Plan \(my version, /.test(n.label));
    const r = await api('GET', 'notes/' + copy.id);
    const m = JSON.parse(td.decode(await unseal(new Uint8Array(await r.arrayBuffer()), 'note:' + copy.id)));
    return {open: S.notes.get(S.open.id).label, shown: document.querySelector('#root .pane .text').innerText, copy: JSON.stringify(m), copyFolder: copy.folder, planFolder: [...S.notes.values()].find(n => n.label === 'Plan').folder};
  });
  L.check("A now shows B's version", after.open === 'Plan' && /edited on B/.test(after.shown) && !/edited on A/.test(after.shown), after);
  L.check("A's version kept as a copy next to it", /edited on A/.test(after.copy) && after.copyFolder === after.planFolder, after);

  // 3. A changes the password: B is logged out and gets back in with the new one
  await page.click('#acct');
  await menuItem(page, 'Change password');
  await L.waitFor(page, () => document.querySelector('.dialog input[name=cur]'));
  await page.type('.dialog input[name=cur]', 'wrong-one');
  await page.type('.dialog input[name=n1]', 'new-pass-2026');
  await page.type('.dialog input[name=n2]', 'new-pass-2026');
  await page.click('.dialog [type=submit]');
  await L.waitFor(page, () => /wrong/.test(document.querySelector('.dialog .err').textContent));
  L.check('wrong current password is caught', true);
  await page.$eval('.dialog input[name=cur]', e => { e.value = ''; });
  await page.type('.dialog input[name=cur]', 'board-pass-1');
  await page.click('.dialog [type=submit]');
  await L.waitFor(page, () => document.querySelector('#modal').hidden && /Password changed/.test(document.querySelector('#toast').textContent), null, 20000);
  L.check('password changed', true);
  await other.click('#root .pane .text');
  await other.keyboard.type('!');
  await L.waitFor(other, () => !document.querySelector('#auth').hidden && /session ended/.test(document.querySelector('#authSub').textContent), null, 20000);
  L.check('B is asked to log in again, note still on screen', await other.$eval('#app', a => !a.hidden));
  await other.type('#aPw', 'board-pass-1');
  await other.click('#authGo');
  await L.waitFor(other, () => document.querySelector('#authErr').textContent.length > 0, null, 20000);
  L.check('B: the old password is refused', /Wrong ID or password/.test(await other.$eval('#authErr', e => e.textContent)));
  await other.$eval('#aPw', e => { e.value = ''; });
  await other.type('#aPw', 'new-pass-2026');
  await other.click('#authGo');
  await L.waitFor(other, () => document.querySelector('#auth').hidden && S.open && !S.open.dirty && !S.open.saving, null, 30000);
  L.check("B's pending edit was saved after logging back in", /edited on B\)!/.test(await other.$eval('#root .pane .text', t => t.innerText)));
  await ctx.close();

  // 4. log out, log in with the new password, notes still open
  await page.click('#acct');
  await menuItem(page, 'Log out');
  await L.waitFor(page, () => !document.querySelector('#auth').hidden && !document.querySelector('#authGo').disabled, null, 20000);
  L.check('logged out: key gone from this device', await page.evaluate(async () => !(await keyLoad())));
  await page.type('#aPw', 'new-pass-2026');
  await page.click('#authGo');
  await L.waitFor(page, () => document.querySelector('#auth').hidden && S.open, null, 30000);
  L.check('logs back in with the new password and opens notes', await page.evaluate(() => S.notes.size >= 6 && !!document.querySelector('#root .pane')));

  await browser.close();
  console.log(L.fails ? 'fails: ' + L.fails : 'all passed');
  process.exit(L.fails ? 1 : 0);
})().catch(e => { console.error('Error', e); process.exit(1); });
