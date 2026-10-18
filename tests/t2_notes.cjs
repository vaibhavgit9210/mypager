// Folders and notes: create, type, split, draw, reload, move, rename, delete.
// Runs after t1 (same profile: logged in as vaibhav).
const L = require('./lib.cjs');
const rows = page => page.$$eval('#tree .item', els => els.map(e => ({kind: e.dataset.f ? 'f' : 'n', name: e.querySelector('.name').textContent, d: getComputedStyle(e).getPropertyValue('--d').trim()})));
const saved = page => L.waitFor(page, () => S.open && !S.open.dirty && !S.open.saving && document.querySelector('#status').classList.contains('saved'), null, 20000);
(async () => {
  const browser = await L.launch('t2');
  const page = await browser.newPage();
  L.wire(page, 'notes');
  await L.login(page);
  await L.waitFor(page, () => S.open, null, 20000);
  await page.reload();
  await L.waitFor(page, () => typeof S !== 'undefined' && S.ready && S.open, null, 20000);
  L.check('a reload goes straight into the app (cookie + key kept on this device)', await page.$eval('#auth', a => a.hidden));

  // a folder, named inline
  await page.click('#newFolder');
  await L.waitFor(page, () => document.querySelector('#tree input.rename'));
  await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');
  await page.keyboard.type('Work');
  await page.keyboard.press('Enter');
  await L.waitFor(page, () => [...S.folders.values()].some(f => f.label === 'Work'));
  // a note inside it (the new folder is the current one)
  await page.click('#newNote');
  await L.waitFor(page, () => S.open && S.notes.get(S.open.id).label === '' && document.activeElement === document.querySelector('#title'));
  await page.keyboard.type('Plan');
  await page.keyboard.press('Enter');                 // Enter in the title jumps into the pane
  await page.keyboard.type('first line');
  await page.click('#splitH');
  const panes = await page.$$('#root .pane');
  await panes[1].click();
  await panes[1].$eval('.mini .md', b => b.click());
  const box = await (await panes[1].$('canvas')).boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 30 + i * 20, box.y + 30 + i * 6);
  await page.mouse.up();
  await saved(page);
  await L.sleep(900);                                  // the title saves on its own timer
  let t = await rows(page);
  L.check('Plan sits inside Work', t.some(r => r.kind === 'f' && r.name === 'Work') && t.some(r => r.kind === 'n' && r.name === 'Plan' && r.d === '1'), t);

  // reload: everything comes back
  await page.reload();
  await L.waitFor(page, () => typeof S !== 'undefined' && S.ready && S.open && S.notes.get(S.open.id).label === 'Plan', null, 20000);
  await L.sleep(800);
  const back = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#root .pane')], cv = ps[1] && ps[1].querySelector('canvas');
    let ink = 0;
    if (cv && cv._art) { const d = cv._art.getContext('2d').getImageData(0, 0, cv._art.width, cv._art.height).data; for (let i = 3; i < d.length; i += 4) if (d[i]) ink++; }
    return {title: document.querySelector('#title').value, n: ps.length, col: !!document.querySelector('#root > .split.col'), text: ps[0] && ps[0].innerText.trim(), draw: ps[1] && ps[1].classList.contains('draw'), ink};
  });
  L.check('after reload: title, layout, text and drawing are back', back.title === 'Plan' && back.n === 2 && back.col && back.text === 'first line' && back.draw && back.ink > 300, back);

  // gutter drag resizes and is saved
  const g = await (await page.$('#root .gutter')).boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y + 160, {steps: 8}); await page.mouse.up();
  await saved(page);
  const flex = await page.$$eval('#root > .split > .pane', ps => ps.map(p => parseFloat(p.style.flex)));
  L.check('dragging the divider moves it and keeps the total', flex[0] > flex[1] && Math.abs(flex[0] + flex[1] - 2) < 0.01, flex);

  // move Plan to the top level with the Move dialog
  const planRow = await page.$('#tree .item.note.on');
  await planRow.hover();
  await (await planRow.$('[data-act="menu"]')).click();
  await page.evaluate(() => [...document.querySelectorAll('#menu button')].find(b => /Move to/.test(b.textContent)).click());
  await L.waitFor(page, () => document.querySelector('.picker'));
  await page.evaluate(() => document.querySelector('.picker .item[data-t=""]').click());
  await page.evaluate(() => document.querySelector('[data-ok]').click());
  await L.waitFor(page, () => S.notes.get(S.open.id).folder === null);
  t = await rows(page);
  L.check('Move to… top level', t.some(r => r.kind === 'n' && r.name === 'Plan' && r.d === '0'), t);

  // rename the folder by double-click
  const fb = await (await page.$('#tree .item.folder .name')).boundingBox();
  await page.mouse.click(fb.x + 10, fb.y + fb.height / 2);
  await page.mouse.click(fb.x + 10, fb.y + fb.height / 2);
  await L.waitFor(page, () => document.querySelector('#tree input.rename'));
  await page.keyboard.down('Meta'); await page.keyboard.press('a'); await page.keyboard.up('Meta');
  await page.keyboard.type('Projects');
  await page.keyboard.press('Enter');
  await L.waitFor(page, () => [...S.folders.values()].some(f => f.label === 'Projects'));
  // drag the note back into the folder from the list
  const dropped = await page.evaluate(async () => {
    const note = document.querySelector('#tree .item.note.on'), folder = document.querySelector('#tree .item.folder');
    const dt = new DataTransfer();
    note.dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
    folder.dispatchEvent(new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: dt}));
    folder.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: dt}));
    await new Promise(r => setTimeout(r, 600));
    return S.notes.get(S.open.id).folder === folder.dataset.f;
  });
  L.check('drag a note onto a folder moves it', dropped);

  // split / delete bookkeeping: lone splits collapse, same-direction nesting merges, sizes hold
  const shape = await page.evaluate(async () => {
    const id = S.open.id;
    const panes = () => [...root.querySelectorAll('.pane')];
    const desc = el => el.classList.contains('pane') ? 'P' : (el.classList.contains('row') ? 'R' : 'C') + '[' + [...el.children].filter(c => !c.classList.contains('gutter')).map(desc).join(',') + ']';
    renderModel({v: 1, root: {t: 'pane', mode: 'text', html: 'A'}});
    setActive(panes()[0]); split('row');                 // R[P,P]
    setActive(panes()[1]); split('col');                 // R[P,C[P,P]]
    setActive(panes()[2]); split('row');                 // R[P,C[P,R[P,P]]]
    const deep = desc(root.firstElementChild);
    setActive(panes()[1]); deletePane();                 // C loses a pane -> its lone R merges into the outer R
    const merged = desc(root.firstElementChild);
    const grows = [...root.firstElementChild.children].filter(c => !c.classList.contains('gutter')).map(c => +parseFloat(c.style.flex).toFixed(3));
    const gutters = root.querySelectorAll('.gutter').length;
    await loadNote(id);                                  // put the real note back
    return {deep, merged, grows, gutters};
  });
  L.check('nested splits build as expected', shape.deep === 'R[P,C[P,R[P,P]]]', shape);
  L.check('deleting collapses the lone split and merges same-direction nesting', shape.merged === 'R[P,P,P]' && shape.gutters === 2, shape);
  L.check('merged panes keep their share of the width', JSON.stringify(shape.grows) === JSON.stringify([1, 0.5, 0.5]), shape);

  // a throwaway note, then delete it
  await page.click('#home');
  await page.click('#newNote');
  await L.waitFor(page, () => S.open && S.notes.get(S.open.id).folder === null && S.notes.size === 3);
  await page.keyboard.type('Scratch');
  await L.sleep(900);
  await page.click('#noteMenu');
  await page.evaluate(() => [...document.querySelectorAll('#menu button')].find(b => /Delete note/.test(b.textContent)).click());
  await L.waitFor(page, () => document.querySelector('.dialog .btn.danger'));
  await page.click('.dialog .btn.danger');
  await L.waitFor(page, () => !S.open && S.notes.size === 2 && !document.querySelector('#empty').hidden);
  L.check('deleted note is gone and the empty state shows', true);
  await page.screenshot({path: L.SHOTS + '/empty.png'});

  // the server agrees after a reload
  await page.reload();
  await L.waitFor(page, () => typeof S !== 'undefined' && S.ready && S.notes.size > 0, null, 20000);
  const names = await page.evaluate(() => [...S.notes.values()].map(n => n.label).sort());
  L.check('server has exactly the two notes', JSON.stringify(names) === JSON.stringify(['Old board (Chrome on Mac)', 'Plan']), names);
  await page.evaluate(() => openNote([...S.notes.values()].find(n => n.label === 'Plan').id));
  await L.waitFor(page, () => S.open && S.notes.get(S.open.id).label === 'Plan');
  await L.sleep(600);
  await page.screenshot({path: L.SHOTS + '/plan.png'});

  await browser.close();
  console.log(L.fails ? 'fails: ' + L.fails : 'all passed');
  process.exit(L.fails ? 1 : 0);
})().catch(e => { console.error('Error', e); process.exit(1); });
