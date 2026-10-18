// Export to a standalone HTML file, import a board file saved from the old page,
// and the unlock screen (session still valid, this device's key gone).
const L = require('./lib.cjs');
const PW = process.env.MP_PW || 'new-pass-2026';

// What the old page's "Download a copy" saves: board.v2 = {iv, ct} under PBKDF2(pw, fixed salt, 200k).
async function oldBoardFile(pw, html) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({name: 'PBKDF2', salt: new TextEncoder().encode('board.v2.fixed-salt'), iterations: 200000, hash: 'SHA-256'}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, new TextEncoder().encode(html)));
  const board = JSON.stringify({iv: Buffer.from(iv).toString('base64'), ct: Buffer.from(ct).toString('base64')});
  return JSON.stringify({v: 1, kind: 'mypager-board', from: 'https://vaibhavkumar.is-a.dev', label: 'Safari on iPhone', at: Date.now(), board, boardPlain: null});
}

(async () => {
  const browser = await L.launch('t6');
  const page = await browser.newPage();
  L.wire(page, 'exp');
  await L.login(page, 'vaibhav', PW);
  await L.waitFor(page, () => S.open, null, 20000);

  // 1. export the Pictures note: one self-contained file, pictures inlined
  const dl = L.WORK + '/downloads';
  L.fs.rmSync(dl, {recursive: true, force: true}); L.fs.mkdirSync(dl, {recursive: true});
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', {behavior: 'allow', downloadPath: dl});
  await page.evaluate(() => exportNotes([[...S.notes.values()].find(n => n.label === 'Pictures').id]));
  for (let i = 0; i < 60 && !(L.fs.readdirSync(dl).find(f => f.endsWith('.html'))); i++) await L.sleep(250);
  const file = L.fs.readdirSync(dl).find(f => f.endsWith('.html'));
  const html = file ? L.fs.readFileSync(dl + '/' + file, 'utf8') : '';
  L.check('export downloads one HTML file', /^mypager-pictures-\d{4}-\d\d-\d\d\.html$/.test(file || ''), file);
  L.check('export has the title, text and all 5 pictures inlined', /<h2>Pictures<\/h2>/.test(html) && /AAA/.test(html) && (html.match(/src="data:image\//g) || []).length === 5 && !/blob:|data-pic/.test(html), html.length);
  const view = await browser.newPage();
  await view.goto('file://' + dl + '/' + file);
  const shown = await view.$$eval('img', ms => ms.filter(m => m.naturalWidth > 0).length);
  L.check('the exported file opens on its own with every picture', shown === 5, shown);
  await view.close();

  // 2. import a board file saved from the old page (asks for its old password)
  const boardHtml = '<div class="split col" style="flex:1"><div class="pane" style="flex: 1 1 0px;"><div class="mini"></div><div class="content"><div class="text" contenteditable="true">from the phone <b>bold</b></div><canvas></canvas></div></div><div class="gutter"></div><div class="pane" style="flex: 1 1 0px;"><div class="content"><div class="text" contenteditable="true"><ul><li>one</li><li>two</li></ul></div><canvas></canvas></div></div></div>';
  L.fs.writeFileSync(L.WORK + '/old-board.json', await oldBoardFile('phone-pass', boardHtml));
  await page.click('#acct');
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.evaluate(() => [...document.querySelectorAll('#menu button')].find(b => /Import an old board file/.test(b.textContent)).click())]);
  await chooser.accept([L.WORK + '/old-board.json']);
  await L.waitFor(page, () => document.querySelector('.dialog input[name=pw]'), null, 20000);
  await page.type('.dialog input[name=pw]', 'phone-pass');
  await page.click('.dialog [type=submit]');
  await L.waitFor(page, () => S.open && S.notes.get(S.open.id).label === 'Old board (Safari on iPhone)', null, 20000);
  const imp = await page.$$eval('#root .pane .text', ts => ts.map(t => t.innerHTML));
  L.check('board file imported: layout and formatting kept', imp.length === 2 && /from the phone <b>bold<\/b>/.test(imp[0]) && /<li>two<\/li>/.test(imp[1]) && !!(await page.$('#root > .split.col')), imp);

  // 3. this device loses its key but keeps the session: unlock with the password only
  await page.evaluate(() => keyDrop());
  await page.reload();
  await L.waitFor(page, () => !document.querySelector('#auth').hidden && document.querySelector('#aId').readOnly, null, 20000);
  L.check('unlock screen: ID fixed, password only', await page.$eval('#aId', e => e.value === 'vaibhav' && document.querySelector('#fInv').hidden));
  await page.type('#aPw', 'not-it');
  await page.click('#authGo');
  await L.waitFor(page, () => /Wrong password/.test(document.querySelector('#authErr').textContent), null, 20000);
  L.check('wrong password is caught locally', true);
  await page.$eval('#aPw', e => { e.value = ''; });
  await page.type('#aPw', PW);
  await page.click('#authGo');
  await L.waitFor(page, () => document.querySelector('#auth').hidden && S.open, null, 30000);
  L.check('unlocked', await page.evaluate(async () => !!(await keyLoad())));
  await page.screenshot({path: L.SHOTS + '/desktop.png'});

  await browser.close();
  console.log(L.fails ? 'fails: ' + L.fails : 'all passed');
  process.exit(L.fails ? 1 : 0);
})().catch(e => { console.error('Error', e); process.exit(1); });
