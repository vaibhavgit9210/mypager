// The old URL hands a browser's old board to the new app: build a board with the real
// pre-move app (old.html), let the forwarding page carry it, sign up, check the import.
const L = require('./lib.cjs');
(async () => {
  const browser = await L.launch('main');
  const page = await browser.newPage();
  L.wire(page, 'old');

  // 1. the old app, exactly as it shipped: password twice, text, a split, a drawing, a pasted picture
  await page.goto(L.SITE + 'old.html');
  await page.type('#pw', 'board-pass-1'); await page.click('#unlockBtn');
  await L.waitFor(page, () => /retype/.test(document.querySelector('#lockMsg').textContent));
  await page.type('#pw', 'board-pass-1'); await page.click('#unlockBtn');
  await L.waitFor(page, () => document.querySelector('#lock').classList.contains('hidden'));
  await page.click('.pane .text');
  await page.keyboard.type('hello from the old board');
  await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    const x = c.getContext('2d'); x.fillStyle = '#e33'; x.fillRect(0, 0, 120, 80);
    document.execCommand('insertHTML', false, '<img src="' + c.toDataURL() + '">');
  });
  await page.click('#splitV');
  const panes = await page.$$('.pane');
  const second = panes[1];
  await second.click();
  await second.$eval('.mini .md', b => b.click());
  const box = await (await second.$('canvas')).boundingBox();
  await page.mouse.move(box.x + 40, box.y + 60); await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 40 + i * 15, box.y + 60 + i * 8);
  await page.mouse.up();
  await L.sleep(1500);
  const saved = await page.evaluate(() => !!localStorage.getItem('board.v2'));
  L.check('old app saved an encrypted board.v2', saved);
  await page.evaluate(() => localStorage.setItem('board.token', 'github_pat_dummy'));

  // 2. the forwarding page offers to move it
  await page.goto(L.SITE + '?to=' + encodeURIComponent(L.APP) + '#invite=dev-invite');
  await L.waitFor(page, () => !document.querySelector('#found').hidden);
  L.check('stub forgets the old GitHub token', await page.evaluate(() => localStorage.getItem('board.token') === null));
  await page.screenshot({path: L.SHOTS + '/stub.png'});
  await Promise.all([page.waitForNavigation({timeout: 20000}), page.click('#move')]);
  L.check('landed on the new app', page.url().startsWith(L.APP));
  L.wire(page, 'app');
  await L.waitFor(page, () => !document.querySelector('#auth').hidden && !document.querySelector('#fInv').hidden);
  const state = await page.evaluate(() => ({hash: location.hash, invite: document.querySelector('#aInv').value,
    note: !document.querySelector('#authNote').hidden, pending: JSON.parse(localStorage.getItem('mp.carries') || '[]').length}));
  L.check('fragment taken out of the address bar', state.hash === '', state);
  L.check('sign-up form, invite filled in, import announced', state.invite === 'dev-invite' && state.note && state.pending === 1, state);
  await page.screenshot({path: L.SHOTS + '/signup.png'});

  // 3. sign up with the same password: the board comes in by itself
  await page.type('#aId', 'Vaibhav');
  await page.type('#aPw', 'board-pass-1');
  await page.type('#aPw2', 'board-pass-1');
  await page.click('#authGo');
  await L.waitFor(page, () => document.querySelector('#auth').hidden && typeof S !== "undefined" && S.open && S.notes.size === 1, null, 30000);
  await L.sleep(800);
  const got = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#root .pane')];
    const img = ps[0] && ps[0].querySelector('.text img');
    const cv = ps[1] && ps[1].querySelector('canvas');
    let ink = 0;
    if (cv && cv._art) { const d = cv._art.getContext('2d').getImageData(0, 0, cv._art.width, cv._art.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) ink++; }
    return {user: S.user, title: S.notes.get(S.open.id).label, panes: ps.length, text: ps[0] && ps[0].innerText,
      img: img && {pic: !!img.dataset.pic, loaded: img.naturalWidth}, draw: ps[1] && ps[1].classList.contains('draw'), ink,
      pending: JSON.parse(localStorage.getItem('mp.carries') || '[]').length, rows: document.querySelectorAll('#tree .row').length};
  });
  L.check('ID was lowercased', got.user === 'vaibhav', got);
  L.check('imported note named after the browser', /^Old board \(Chrome on Mac\)$/.test(got.title), got);
  L.check('two panes, text intact', got.panes === 2 && /hello from the old board/.test(got.text), got);
  L.check('pasted picture became a stored picture and loads', got.img && got.img.pic && got.img.loaded === 120, got);
  L.check('drawing pane stays in draw mode with its ink', got.draw && got.ink > 200, got);
  L.check('import used up', got.pending === 0, got);
  await page.screenshot({path: L.SHOTS + '/imported.png'});

  // 4. coming back through the old URL just forwards (no second copy)
  await page.goto(L.SITE + '?to=' + encodeURIComponent(L.APP));
  await L.waitFor(page, () => location.port === '8787' && typeof S !== "undefined" && S.ready, null, 20000);
  await L.sleep(500);
  L.check('second visit forwards without re-importing', await page.evaluate(() => S.notes.size === 1 && !S.open.dirty));

  await browser.close();
  console.log(L.fails ? 'fails: ' + L.fails : 'all passed');
  process.exit(L.fails ? 1 : 0);
})().catch(e => { console.error('Error', e); process.exit(1); });
