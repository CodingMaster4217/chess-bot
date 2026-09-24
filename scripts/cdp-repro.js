/**
 * Real-browser reproduction via Chrome DevTools Protocol (headless Chrome).
 * Captures console output, failed network requests, computed CSS hit-testing,
 * bound handlers, and exercises the reported broken flows.
 *
 * Usage: node scripts/cdp-repro.js [port]
 * Requires: uvicorn app.main:app --port <port> running locally, a local
 * Chrome with --remote-debugging-port=9222, and dev-only npm packages:
 *   npm install --no-save chrome-remote-interface
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const CDP = require('chrome-remote-interface');

const PORT = parseInt(process.argv[2] || '8123', 10);
const URL_BASE = `http://127.0.0.1:${PORT}`;

const log = [];
const L = (k, v) => { log.push([k, v]); console.log(k + ':', JSON.stringify(v)); };

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findChromePort(start) {
  for (let p = start; p < start + 20; p++) {
    try { return { port: p, data: await getJson(`http://127.0.0.1:${p}/json/version`) }; }
    catch (e) { /* try next */ }
  }
  throw new Error('No Chrome debug port found');
}

(async () => {
  const { port: chromePort } = await findChromePort(9222);
  L('chromePort', chromePort);

  const client = await CDP({ port: chromePort });
  const { Runtime, Page, Console, Network, DOM, CSS } = client;

  const consoleMessages = [];
  const failedRequests = [];

  Runtime.consoleAPICalled((e) => {
    const text = (e.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
    consoleMessages.push(`[${e.type}] ${text}`);
  });
  Runtime.exceptionThrown((e) => {
    const d = e.exceptionDetails;
    consoleMessages.push(`[EXCEPTION] ${d.text} ${d.exception && d.exception.description ? d.exception.description : ''} @${d.url || ''}:${d.lineNumber}`);
  });
  Network.responseReceived((e) => {
    if (e.response.status >= 400) failedRequests.push(`${e.response.status} ${e.response.url}`);
  });
  Network.loadingFailed((e) => failedRequests.push(`FAILED ${e.errorText} (blocked=${e.blockedReason || 'n/a'})`));

  await Runtime.enable();
  await Page.enable();
  await Network.enable();
  await Console.enable();
  await DOM.enable();
  await CSS.enable();

  // Fresh profile: disable cache explicitly.
  await Network.setCacheDisabled({ cacheDisabled: true });

  await Page.navigate({ url: URL_BASE + '/' });
  await Page.loadEventFired();
  await sleep(1200); // app.js uses setTimeout(0) resize; allow layout

  // ---- 1. Console / network state -------------------------------------------
  L('consoleMessages', consoleMessages.slice());
  L('failedRequests', failedRequests.slice());

  // ---- 2. Did app.js finish init? -------------------------------------------
  const init = await Runtime.evaluate({
    expression: `(() => ({
      jquery: typeof window.jQuery !== 'undefined',
      chess: typeof window.Chess !== 'undefined',
      chessboard: typeof window.Chessboard !== 'undefined',
      squares: document.querySelectorAll('#board .square-55d63').length,
      boardChildCount: document.getElementById('board') ? document.getElementById('board').childElementCount : -1,
      statusText: (document.getElementById('statusText')||{}).textContent || null,
      boardHTMLSnippet: (document.getElementById('board')||{}).innerHTML ? document.getElementById('board').innerHTML.slice(0,120) : null
    }))()`,
    returnByValue: true,
  });
  L('init', init.result.value);

  // ---- 3. jQuery-bound handlers on #board and document ----------------------
  const handlers = await Runtime.evaluate({
    expression: `(() => {
      const out = {};
      const b = document.getElementById('board');
      const bev = window.jQuery._data(b, 'events') || {};
      out.board = Object.fromEntries(Object.keys(bev).map(k => [k, bev[k].length]));
      const dev = window.jQuery._data(document, 'events') || {};
      out.document = Object.fromEntries(Object.keys(dev).map(k => [k, dev[k].length]));
      const clickCount = (id) => {
        const el = document.getElementById(id);
        if (!el) return 'missing';
        const ev = (window.jQuery._data(el, 'events') || {}).click || [];
        return ev.length;
      };
      out.buttons = {};
      ['btnNewGame','btnFlipBoard','btnResign','btnReviewGame','btnReviewExit','btnReviewFirst','btnReviewPrev','btnReviewNext','btnReviewLast','btnReviewMovePrev','btnReviewMoveNext'].forEach(id => out.buttons[id] = clickCount(id));
      return out;
    })()`,
    returnByValue: true,
  });
  L('handlers', handlers.result.value);

  // ---- 4. Button states ------------------------------------------------------
  const btns = await Runtime.evaluate({
    expression: `(() => {
      const o = {};
      ['btnNewGame','btnFlipBoard','btnResign','btnReviewGame'].forEach(id => {
        const b = document.getElementById(id);
        o[id] = b ? { disabled: b.disabled, display: getComputedStyle(b).display, pointerEvents: getComputedStyle(b).pointerEvents } : 'missing';
      });
      const cb = document.getElementById('showLegalMoves');
      o.showLegalMoves = cb ? { checked: cb.checked, display: getComputedStyle(cb).display } : 'missing';
      return o;
    })()`,
    returnByValue: true,
  });
  L('buttons', btns.result.value);

  // ---- 5. CSS hit-testing: what element is on top of the e2 square? ---------
  const hit = await Runtime.evaluate({
    expression: `(() => {
      const sq = document.querySelector('#board .square-e2');
      if (!sq) return 'no e2 square';
      const img = sq.querySelector('img');
      const r = sq.getBoundingClientRect();
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      const topEl = document.elementFromPoint(cx, cy);
      const topAtImg = img ? document.elementFromPoint(r.left + Math.min(img.getBoundingClientRect().width/2, r.width/2), cy) : null;
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        topElementAtCenter: topEl ? (topEl.tagName + '.' + (topEl.className.baseVal !== undefined ? 'svg' : topEl.className)) : null,
        topIsSquareOrChild: topEl ? (sq === topEl || sq.contains(topEl)) : false,
        imgPresent: !!img,
        imgPosition: img ? getComputedStyle(img).position : null,
        imgOffsetParent: img ? (img.offsetParent ? img.offsetParent.className : 'null') : null,
        imgLeft: img ? getComputedStyle(img).left : null,
        imgTop: img ? getComputedStyle(img).top : null,
        squareOverflow: getComputedStyle(sq).overflow,
        notationEl: !!sq.querySelector('.notation-322f9')
      };
    })()`,
    returnByValue: true,
  });
  L('hitTesting', hit.result.value);

  // ---- 6. Piece geometry: are images 0x0? -----------------------------------
  const geo = await Runtime.evaluate({
    expression: `(() => {
      const img = document.querySelector('#board .square-e2 img');
      const sq = document.querySelector('#board .square-e2');
      if (!img) return 'no img';
      const ir = img.getBoundingClientRect(), sr = sq.getBoundingClientRect();
      return {
        imgRect: { w: ir.width, h: ir.height, x: ir.x, y: ir.y },
        squareRect: { w: sr.width, h: sr.height },
        imgNatural: { w: img.naturalWidth, h: img.naturalHeight },
        imgComplete: img.complete,
        imgCurrentSrc: (img.currentSrc || '').split('/').pop()
      };
    })()`,
    returnByValue: true,
  });
  L('pieceGeometry', geo.result.value);

  // ---- 7. Click-to-move: click e2 then e4 (real mouse events) ---------------
  const clickResult = await Runtime.evaluate({
    expression: `(async () => {
      const $ = window.jQuery;
      const e2 = document.querySelector('#board .square-e2');
      const fire = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      fire(e2);
      await new Promise(r => setTimeout(r, 80));
      const selAfter = e2.className;
      const hints = [...document.querySelectorAll('#board .legal-move-hint, #board .legal-capture-hint')].map(el => el.className.match(/square-([a-h][1-8])/)[1]);
      const e4 = document.querySelector('#board .square-e4');
      fire(e4);
      await new Promise(r => setTimeout(r, 150));
      return {
        selAfter,
        hints,
        e4PieceAfter: !!document.querySelector('#board .square-e4 img'),
        statusText: document.getElementById('statusText').textContent
      };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  L('clickToMove', clickResult.result.value);

  await sleep(2500); // allow engine request/response
  const afterMove = await Runtime.evaluate({
    expression: `(() => ({
      statusText: document.getElementById('statusText').textContent,
      historyRows: document.querySelectorAll('#historyBody tr').length
    }))()`,
    returnByValue: true,
  });
  L('afterEngineMove', afterMove.result.value);

  // ---- 8. Resign flow --------------------------------------------------------
  // Override confirm BEFORE clicking.
  await Runtime.evaluate({ expression: `window.confirm = () => true;` });
  await Runtime.evaluate({ expression: `document.getElementById('btnNewGame').click();` });
  await sleep(600);
  const resignState = await Runtime.evaluate({
    expression: `(async () => {
      const b = document.getElementById('btnResign');
      const before = { disabled: b.disabled };
      b.click();
      await new Promise(r => setTimeout(r, 150));
      return { before, statusText: document.getElementById('statusText').textContent,
               reviewDisabled: document.getElementById('btnReviewGame').disabled };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  L('resignFlow', resignState.result.value);

  // ---- 9. Review flow --------------------------------------------------------
  const reviewState = await Runtime.evaluate({
    expression: `(async () => {
      document.getElementById('btnReviewGame').click();
      await new Promise(r => setTimeout(r, 200));
      const label = document.getElementById('reviewPositionLabel').textContent;
      document.getElementById('btnReviewPrev').click();
      await new Promise(r => setTimeout(r, 120));
      const labelAfterPrev = document.getElementById('reviewPositionLabel').textContent;
      document.getElementById('btnReviewExit').click();
      await new Promise(r => setTimeout(r, 120));
      return { label, labelAfterPrev, reviewControlsHiddenAfterExit: document.getElementById('reviewControls').hidden };
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  L('reviewFlow', reviewState.result.value);

  L('consoleMessagesFinal', consoleMessages.slice());
  L('failedRequestsFinal', failedRequests.slice());

  fs.writeFileSync(path.join(__dirname, 'cdp-report.json'), JSON.stringify(Object.fromEntries(log), null, 2));
  console.log('\nREPORT WRITTEN to scripts/cdp-report.json');
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
