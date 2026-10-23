// Shared helpers for the browser suites (puppeteer-core + the installed Chrome).
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
function findPuppeteer() {
  try { return require('puppeteer-core'); } catch { /* not installed here */ }
  const cache = path.join(os.homedir(), '.npm/_npx');
  for (const d of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const p = path.join(cache, d, 'node_modules/puppeteer-core');
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error('puppeteer-core not found: run `npx --yes puppeteer-core@latest --version` once');
}
const puppeteer = findPuppeteer();
const WORK = process.env.MP_WORK || path.join(os.tmpdir(), 'mypager-tests');
const SHOTS = path.join(WORK, 'shots');
fs.mkdirSync(SHOTS, {recursive: true});
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = 'http://localhost:8787/';
const SITE = 'http://localhost:8765/';     // the old URL: stub + the pre-move app (old.html)

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond || extra === undefined ? '' : ' :: ' + JSON.stringify(extra)));
  if (!cond) fails++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function launch(profile, viewport = {width: 1360, height: 860, deviceScaleFactor: 1}) {
  return puppeteer.launch({executablePath: CHROME, headless: true, defaultViewport: viewport,
    args: ['--window-size=' + viewport.width + ',' + viewport.height, '--hide-scrollbars'],
    userDataDir: path.join(WORK, 'prof-' + profile)});
}
function wire(page, tag = '') {
  page.on('console', m => { if (m.type() === 'error' && !/status of 401/.test(m.text())) console.log('  [console ' + tag + ']', m.text()); });
  page.on('pageerror', e => console.log('  [pageerror ' + tag + ']', e.message));
  page.on('dialog', d => d.dismiss());      // the old app asks for a GitHub token: Cancel
}
async function waitFor(page, fn, arg, timeout = 15000) {
  return page.waitForFunction(fn, {timeout, polling: 100}, arg);
}
// A real PNG on disk: w x h gradient with a dark diagonal band.
function png(file, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4, band = Math.abs(x / w - y / h) < 0.08;
      raw[o] = band ? 20 : Math.round(255 * x / w); raw[o + 1] = band ? 20 : Math.round(255 * y / h); raw[o + 2] = 160; raw[o + 3] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}
// Fresh profile per suite (reopening a profile a crashed run left behind hangs Chrome), so log in.
async function login(page, id = 'vaibhav', pw = 'board-pass-1') {
  await page.goto(APP);
  await waitFor(page, () => !document.querySelector('#auth').hidden && !document.querySelector('#authGo').disabled);
  await page.$eval('#aId', (e, v) => { e.value = v; }, id);
  await page.type('#aPw', pw);
  await page.click('#authGo');
  await waitFor(page, () => typeof S !== 'undefined' && S.ready && document.querySelector('#auth').hidden, null, 30000);
}
// Anything a pane draws over its text (every child but .content) must miss the text's lines.
// Returns the overlaps, so [] is a pass.
function textCovered(page) {
  return page.$$eval('#root .pane', ps => ps.flatMap((p, i) => {
    const r = document.createRange();
    r.selectNodeContents(p.querySelector('.text'));
    const lines = [...r.getClientRects()].filter(b => b.width && b.height), hits = [];
    for (const c of p.children) {
      const cs = getComputedStyle(c);
      if (c.classList.contains('content') || cs.display === 'none' || +cs.opacity === 0) continue;
      const b = c.getBoundingClientRect();
      for (const l of lines) if (b.left < l.right && b.right > l.left && b.top < l.bottom && b.bottom > l.top) hits.push({pane: i, el: c.className, line: Math.round(l.top)});
    }
    return hits;
  }));
}
module.exports = {login, textCovered, puppeteer, fs, path, WORK, SHOTS, APP, SITE, check, sleep, launch, wire, waitFor, png, get fails() { return fails; }};
