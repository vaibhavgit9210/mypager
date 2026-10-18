// Pictures in panes: dropped / pasted / inserted at the text caret, the caret follows a drag,
// they fit the pane at their own ratio, never resize it, can be dragged elsewhere, survive reload.
const L = require('./lib.cjs');
const wide = L.png(L.WORK + '/wide.png', 1200, 800);
const tall = L.png(L.WORK + '/tall.png', 400, 1000);
const huge = L.png(L.WORK + '/huge.png', 3000, 2000);
const b64 = f => L.fs.readFileSync(f).toString('base64');

// Fire dragover (twice, like a moving pointer) then drop at (x, y) with a file or an existing picture.
async function dropAt(page, x, y, file, opts = {}) {
  return page.evaluate(async (x, y, data, name, moveSel) => {
    const dt = new DataTransfer();
    if (data) dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], name, {type: 'image/png'}));
    if (moveSel) document.querySelector(moveSel).dispatchEvent(new DragEvent('dragstart', {bubbles: true, dataTransfer: dt}));
    const fire = type => {
      const el = document.elementFromPoint(x, y);
      el.dispatchEvent(new DragEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt}));
    };
    fire('dragover'); fire('dragover');
    const c = document.querySelector('#dropCaret'), r = c.getBoundingClientRect();
    const caret = {shown: !c.hidden, x: r.left, y: r.top, h: r.height};
    fire('drop');
    if (moveSel) document.querySelector('#root').dispatchEvent(new DragEvent('dragend', {bubbles: true, dataTransfer: dt}));
    return caret;
  }, x, y, file ? b64(file) : null, file ? file.split('/').pop() : null, opts.move || null);
}
const paneBox = (page, i) => page.$$eval('#root .pane', (ps, i) => { const b = ps[i].querySelector('.content').getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; }, i);
const imgs = (page, i) => page.$$eval('#root .pane', (ps, i) => [...ps[i].querySelectorAll('.text img')].map(m => {
  const b = m.getBoundingClientRect();
  return {w: b.width, h: b.height, nw: m.naturalWidth, nh: m.naturalHeight, pic: m.dataset.pic, ar: m.style.getPropertyValue('--ar'), src: (m.getAttribute('src') || '').slice(0, 5)};
}), i);
const saved = page => L.waitFor(page, () => S.open && !S.open.dirty && !S.open.saving && document.querySelector('#status').classList.contains('saved'), null, 20000);

(async () => {
  const browser = await L.launch('t3');
  const page = await browser.newPage();
  L.wire(page, 'pics');
  await L.login(page);
  await page.click('#home');
  await page.click('#newNote');
  await L.waitFor(page, () => S.open && document.activeElement === document.querySelector('#title'));
  await page.keyboard.type('Pictures');
  await page.keyboard.press('Enter');
  await page.keyboard.type('AAA BBB');
  await page.click('#splitV');                                        // two panes side by side
  await L.sleep(200);

  // 1. drop a wide picture between "AAA" and " BBB": the caret shows there, the picture lands there
  const pt = await page.evaluate(() => {
    const t = document.querySelector('#root .pane .text'), node = [...t.childNodes].find(n => n.nodeType === 3) || t.firstChild.firstChild;
    const r = document.createRange(); r.setStart(node, 3); r.collapse(true);
    const b = r.getClientRects()[0];
    return {x: b.left + 1, y: b.top + b.height / 2, caretX: b.left};
  });
  const before = await paneBox(page, 0);
  const caret = await dropAt(page, pt.x, pt.y, wide);
  L.check('drop caret shows where the picture will land', caret.shown && Math.abs(caret.x - pt.caretX) < 6 && caret.h >= 16, {caret, pt});
  await L.waitFor(page, () => document.querySelector('#root .pane .text img'));
  await L.sleep(300);
  const order = await page.$eval('#root .pane .text', t => [...t.querySelectorAll('*'), ...t.childNodes].length && t.innerHTML.replace(/<img[^>]*>/, '[IMG]').replace(/<[^>]+>/g, ''));
  L.check('picture inserted exactly between AAA and BBB', /^AAA\[IMG\] BBB$/.test(order.trim()), order);
  const after = await paneBox(page, 0);
  L.check('pane keeps its size', Math.abs(after.w - before.w) < 1 && Math.abs(after.h - before.h) < 1, {before, after});
  let im = (await imgs(page, 0))[0];
  L.check('picture keeps its 3:2 ratio', Math.abs(im.w / im.h - 1.5) < 0.02, im);
  L.check('picture fills the pane width (inside the padding)', Math.abs(im.w - (after.w - 28)) < 2 && im.h <= after.h - 28 + 1, {im, after});
  L.check('stored as an encrypted picture, shown from memory', !!im.pic && im.src === 'blob:' && im.ar === '1.5000', im);

  // 2. a tall picture in a short pane: bounded by the height instead
  await page.click('#splitH');                                        // pane 0 is now half height
  await L.sleep(300);
  const p0 = await paneBox(page, 0);
  const end = await page.$eval('#root .pane .text', t => { const b = t.getBoundingClientRect(); return {x: b.left + b.width / 2, y: b.bottom - 6}; });
  await dropAt(page, end.x, end.y, tall);
  await L.waitFor(page, () => document.querySelectorAll('#root .pane')[0].querySelectorAll('.text img').length === 2);
  await L.sleep(300);
  im = (await imgs(page, 0)).find(m => m.nw === 400);
  L.check('tall picture is bounded by the pane height, ratio kept', Math.abs(im.h - (p0.h - 28)) < 2 && Math.abs(im.w / im.h - 0.4) < 0.02, {im, p0});
  // the first (wide) picture shrank with the pane, still at its ratio
  im = (await imgs(page, 0)).find(m => m.nw === 1200);
  L.check('wide picture re-fitted when the pane got shorter', im.w <= p0.w - 28 + 1 && im.h <= p0.h - 28 + 1 && Math.abs(im.w / im.h - 1.5) < 0.02, {im, p0});

  // 3. drag the wide picture into the other pane: it moves (not copies), at the drop point
  const p1 = await paneBox(page, 1);
  await page.$$eval('#root .pane', ps => { ps[1].querySelector('.text').innerHTML = '<div>CCC</div>'; });
  const c1 = await page.$$eval('#root .pane', ps => { const r = document.createRange(); const n = ps[1].querySelector('.text div').firstChild; r.setStart(n, 3); const b = r.getClientRects()[0]; return {x: b.left + 2, y: b.top + b.height / 2}; });
  await dropAt(page, c1.x, c1.y, null, {move: '#root .pane .text img[style*="1.5000"]'});
  await L.sleep(300);
  const moved = await page.$$eval('#root .pane', ps => ps.map(p => p.querySelectorAll('.text img').length));
  const text1 = await page.$$eval('#root .pane', ps => ps[1].querySelector('.text').innerHTML.replace(/<img[^>]*>/, '[IMG]').replace(/<[^>]+>/g, ''));
  L.check('dragging a picture moves it to the other pane', moved[0] === 1 && moved[1] === 1 && text1.trim() === 'CCC[IMG]', {moved, text1, p1});

  // 4. paste a picture at the caret
  await page.$$eval('#root .pane', ps => {
    const t = ps[2].querySelector('.text'); t.innerHTML = '<div>left right</div>'; t.focus();
    const r = document.createRange(); r.setStart(t.querySelector('div').firstChild, 4); r.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  await page.evaluate(data => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'paste.png', {type: 'image/png'}));
    document.activeElement.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  }, b64(wide));
  await L.waitFor(page, () => document.querySelectorAll('#root .pane')[2].querySelector('.text img'));
  const pasted = await page.$$eval('#root .pane', ps => ps[2].querySelector('.text').innerHTML.replace(/<img[^>]*>/, '[IMG]').replace(/<[^>]+>/g, ''));
  L.check('pasted picture lands at the caret', pasted.trim() === 'left[IMG] right', pasted);

  // 5. the toolbar button inserts at the caret too; a 3000x2000 photo is stored at 2000 px
  await page.$$eval('#root .pane', ps => {
    const t = ps[2].querySelector('.text'); t.focus();
    const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
    getSelection().removeAllRanges(); getSelection().addRange(r);
  });
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#pic')]);
  await chooser.accept([huge]);
  await L.waitFor(page, () => document.querySelectorAll('#root .pane')[2].querySelectorAll('.text img').length === 2, null, 20000);
  await L.sleep(400);
  im = (await imgs(page, 2))[1];
  L.check('big photo is shrunk to 2000 px on its long side', im.nw === 2000 && im.nh === 1333 || im.nh === 1334, im);

  // 6. a pane in draw mode still takes a dropped picture (into its text layer, under the ink)
  const panes = await page.$$('#root .pane');
  await panes[1].$eval('.mini .md', b => b.click());
  const p1b = await paneBox(page, 1);
  await dropAt(page, p1b.x + p1b.w / 2, p1b.y + p1b.h - 10, tall);
  await L.waitFor(page, () => document.querySelectorAll('#root .pane')[1].querySelectorAll('.text img').length === 2);
  L.check('drop works on a pane in draw mode', true);

  // 7. reload: every picture comes back from the server
  await saved(page);
  const id = await page.evaluate(() => S.open.id);
  await page.reload();
  await L.waitFor(page, (id) => typeof S !== 'undefined' && S.ready && S.open && S.open.id === id, id, 20000);
  await L.waitFor(page, () => [...document.querySelectorAll('#root .text img')].every(m => m.complete && m.naturalWidth > 0) && document.querySelectorAll('#root .text img').length === 5, null, 20000);
  const all = await page.$$eval('#root .text img', ms => ms.map(m => ({pic: !!m.dataset.pic, ar: m.style.getPropertyValue('--ar'), w: m.naturalWidth})));
  L.check('after reload all 5 pictures load, ratios kept', all.length === 5 && all.every(x => x.pic && x.ar && x.w > 0), all);
  const stored = await page.evaluate(() => /blob:|data:image/.test(JSON.stringify(readModel())));
  L.check('saved note holds picture ids, not picture bytes', !stored);
  await page.screenshot({path: L.SHOTS + '/pictures.png'});

  await browser.close();
  console.log(L.fails ? 'fails: ' + L.fails : 'all passed');
  process.exit(L.fails ? 1 : 0);
})().catch(e => { console.error('Error', e); process.exit(1); });
