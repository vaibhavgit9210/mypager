// Phone layout: the list is a drawer, opening a note closes it, the toolbar scrolls sideways.
const L = require('./lib.cjs');
(async () => {
  const browser = await L.launch('t5', {width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true});
  const page = await browser.newPage();
  L.wire(page, 'phone');
  await page.goto(L.APP);
  await L.waitFor(page, () => !document.querySelector('#auth').hidden);
  await page.screenshot({path: L.SHOTS + '/phone-login.png'});
  await L.login(page, 'vaibhav', process.env.MP_PW || 'new-pass-2026');
  await L.waitFor(page, () => S.open, null, 20000);
  const side = () => page.$eval('#side', s => s.getBoundingClientRect().right > 10);
  L.check('list starts hidden on a phone', !(await side()));
  await page.tap('#sideBtn');
  await L.sleep(400);
  L.check('menu button slides the list in', await side());
  await page.screenshot({path: L.SHOTS + '/phone-list.png'});
  const row = await page.$('#tree .item.folder');
  await row.tap();
  await L.sleep(300);
  const note = await page.$('#tree .item.note:not(.on)');
  await note.tap();
  await L.waitFor(page, () => !document.body.classList.contains('side-open'));
  await L.sleep(500);
  L.check('opening a note closes the list', !(await side()));
  const bar = await page.$eval('#bar', b => ({sw: b.scrollWidth, cw: b.clientWidth}));
  L.check('toolbar scrolls sideways instead of wrapping', bar.sw > bar.cw, bar);
  const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  L.check('nothing spills off the side of the screen', noOverflow);
  await page.screenshot({path: L.SHOTS + '/phone-note.png'});
  // the screenshot that started this: buttons sat on a long first line. Nothing may now (no input event, so no save).
  await page.$eval('#root .pane .text', t => { t.innerHTML = '<ol><li>A Pylon rule moves some accounts\' US tickets away from the queue they came in on. The "Voice-IMP" automation sends tickets from accounts tagged</li></ol>'; });
  const covered = await L.textCovered(page);
  L.check('nothing on the pane covers its text', covered.length === 0, covered);
  L.check('a lone pane has no grabber, the toolbar has the pane switch', await page.evaluate(() =>
    getComputedStyle(document.querySelector('#root .pane .grab')).display === 'none' && !!document.querySelector('#bar #modeText')));
  await page.screenshot({path: L.SHOTS + '/phone-long-line.png'});
  await browser.close();
  console.log(L.fails ? 'fails: ' + L.fails : 'all passed');
  process.exit(L.fails ? 1 : 0);
})().catch(e => { console.error('Error', e); process.exit(1); });
