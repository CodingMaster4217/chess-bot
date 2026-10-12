/**
 * Real-input diagnostic for the click-selection / legal-move defects.
 *
 * Uses Input.dispatchMouseEvent (trusted, native input pipeline) — NOT
 * dispatchEvent — so the browser builds events exactly like a user click,
 * including any retargeting caused by DOM changes between mousedown and
 * mouseup (e.g. chessboard.js's floating drag avatar).
 *
 * Records the 12 items requested for a fresh game, click on e2:
 *   1. exact event.target            (capture listener on document)
 *   2. target tag name + classes
 *   3. target.closest('.square-55d63')
 *   4. extracted coordinate
 *   5. whether handleSquareClick runs (propagation path + listener registry)
 *   6. canHumanMove() result          (derived from status + state probes)
 *   7. game.get('e2')
 *   8. game.moves({square:'e2',verbose:true})
 *   9. state.selectedSquare afterward (via rendered .sel-square effect)
 *  10. classes on e2/e3/e4
 *  11. computed styles of highlight pseudo-elements
 *  12. element intercepting the pointer event
 *
 * Usage: node scripts/cdp-diagnose.js [appPort]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const CDP = require('chrome-remote-interface');

const PORT = parseInt(process.argv[2] || '8123', 10);
const URL_BASE = `http://127.0.0.1:${PORT}`;

const report = {};
const L = (k, v) => { report[k] = v; console.log(`\n=== ${k}\n` + JSON.stringify(v, null, 2)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    }).on('error', reject);
  });
}

(async () => {
  // Find Chrome debug port
  let chromePort = null;
  for (let p = 9222; p < 9242; p++) {
    try { await getJson(`http://127.0.0.1:${p}/json/version`); chromePort = p; break; } catch (e) {}
  }
  if (!chromePort) throw new Error('No Chrome debug port found');
  L('chromePort', chromePort);

  const client = await CDP({ port: chromePort });
  const { Runtime, Page, Network, Input, DOM, Console } = client;

  const consoleMessages = [];
  const failedRequests = [];
  const apiRequests = [];

  Runtime.consoleAPICalled((e) => {
    const text = (e.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
    consoleMessages.push(`[${e.type}] ${text}`);
  });
  Runtime.exceptionThrown((e) => {
    const d = e.exceptionDetails;
    consoleMessages.push(`[EXCEPTION] ${d.text} ${d.exception && d.exception.description ? d.exception.description : ''}`);
  });
  Network.responseReceived((e) => {
    if (e.response.status >= 400) failedRequests.push(`${e.response.status} ${e.response.url}`);
  });
  Network.loadingFailed((e) => failedRequests.push(`FAILED ${e.errorText}`));
  Network.requestWillBeSent((e) => {
    if (e.request.url.includes('/api/')) apiRequests.push(e.request.url.replace(URL_BASE, ''));
  });

  await Runtime.enable();
  await Page.enable();
  await Network.enable();
  await Console.enable();
  await DOM.enable();
  await Network.setCacheDisabled({ cacheDisabled: true });

  // Inject instrumentation BEFORE any page script runs: log every
  // addEventListener registration so we know exactly what is bound where.
  await Page.addScriptToEvaluateOnNewDocument({
    source: `
      window.__diag = { listeners: [], clicks: [] };
      const origAdd = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, fn, opts) {
        try {
          if (type === 'click' || type === 'mousedown' || type === 'mouseup' || type === 'touchstart') {
            window.__diag.listeners.push({
              type,
              target: this === document ? 'document'
                : this === document.body ? 'body'
                : this.id ? '#' + this.id
                : (this.tagName || '?') + '.' + String(this.className || '').slice(0, 60),
              delegated: typeof fn === 'function' ? (fn.toString().includes('handleSquareClick') ? 'handleSquareClick' : 'other') : 'non-function'
            });
          }
        } catch (e) {}
        return origAdd.call(this, type, fn, opts);
      };
      // Capture-phase recorder for every real click: target, classes, closest, path.
      origAdd.call(document, 'click', function (event) {
        const t = event.target;
        const rec = {
          isTrusted: event.isTrusted,
          targetDesc: t === document ? 'document' : t.id ? '#' + t.id : (t.tagName || '?') + '.' + String(t.className || ''),
          closestSquare: t && t.closest ? (t.closest('.square-55d63') ? t.closest('.square-55d63').getAttribute('data-square') : null) : null,
          boardInPath: event.composedPath().some((n) => n.id === 'board'),
          pathLen: event.composedPath().length
        };
        window.__diag.clicks.push(rec);
      }, true);
    `,
  });

  await Page.navigate({ url: URL_BASE + '/' });
  await Page.loadEventFired();
  await sleep(1500);

  const evalJs = async (expr, awaitPromise = false) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.result.description || ''));
    return r.result.value;
  };

  // ---------- 0. Page boot state ----------
  L('boot', await evalJs(`(() => {
    const b = document.getElementById('board');
    return {
      squares: document.querySelectorAll('#board .square-55d63').length,
      e2HTML: (document.querySelector('#board .square-e2') || {}).outerHTML || 'MISSING',
      clickListeners: window.__diag.listeners.filter(l => l.type === 'click'),
      mousedownListeners: window.__diag.listeners.filter(l => l.type === 'mousedown'),
      jqueryBoardEvents: (() => {
        try {
          const ev = window.jQuery._data(document.getElementById('board'), 'events') || {};
          return Object.fromEntries(Object.keys(ev).map(k => [k, ev[k].length]));
        } catch (e) { return 'err: ' + e.message; }
      })()
    };
  })()`));

  // ---------- Real trusted click on e2 via CDP Input domain ----------
  const e2rect = await evalJs(`(() => {
    const r = document.querySelector('#board .square-e2').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
  })()`);

  // 12. What is on top of e2 right now (before any pointer activity)?
  L('interceptBefore', await evalJs(`(() => {
    const sq = document.querySelector('#board .square-e2');
    const el = document.elementFromPoint(${e2rect.x}, ${e2rect.y});
    return {
      topElement: el ? el.tagName + '.' + String(el.className || '') : null,
      isSquareOrChild: el ? (el === sq || sq.contains(el)) : false
    };
  })()`));

  // Send REAL mousedown + mouseup at e2 center (browser derives the click)
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: e2rect.x, y: e2rect.y, button: 'left', clickCount: 1 });
  await sleep(60);
  // Capture state DURING the press: chessboard.js drag avatar may now exist.
  L('duringPress', await evalJs(`(() => {
    const avatars = [...document.querySelectorAll('body > img[data-piece]')].map(i => ({
      piece: i.getAttribute('data-piece'), display: getComputedStyle(i).display,
      pos: getComputedStyle(i).position
    }));
    const el = document.elementFromPoint(${e2rect.x}, ${e2rect.y});
    const e2 = document.querySelector('#board .square-e2');
    return {
      dragAvatarOnBody: avatars,
      topElementNow: el ? el.tagName + '.' + String(el.className || '') : null,
      e2ClassesNow: e2.className,
      highlight1Applied: e2.className.includes('highlight1-32417')
    };
  })()`));
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: e2rect.x, y: e2rect.y, button: 'left', clickCount: 1 });
  await sleep(200);

  // ---------- Items 1-5, 9, 10, 12: what the real click delivered ----------
  L('realClickRecord', await evalJs(`window.__diag.clicks`));

  L('afterRealClickE2', await evalJs(`(() => {
    const e2 = document.querySelector('#board .square-e2');
    const e3 = document.querySelector('#board .square-e3');
    const e4 = document.querySelector('#board .square-e4');
    const el = document.elementFromPoint(${e2rect.x}, ${e2rect.y});
    return {
      item9_selectedSquare_effect: e2.className.includes('sel-square') ? 'e2 (sel-square present)' : 'none',
      item10_e2Classes: e2.className,
      item10_e3Classes: e3.className,
      item10_e4Classes: e4.className,
      item10_hintSquares: [...document.querySelectorAll('#board .legal-move-hint, #board .legal-capture-hint')].map(el => el.getAttribute('data-square')),
      item12_interceptAfter: el ? el.tagName + '.' + String(el.className || '') : null,
      statusText: document.getElementById('statusText').textContent
    };
  })()`));

  // ---------- Items 6, 7, 8: game-state queries (fresh Chess mirror) ----------
  L('gameStateProbes', await evalJs(`(() => {
    const g = new window.Chess();
    const moves = g.moves({ square: 'e2', verbose: true });
    return {
      item6_canHumanMove_derivation: {
        engineThinking: false,
        gameFinished: false,
        reviewMode: false,
        turn: g.turn(),
        gameOver: g.game_over(),
        derivedResult: g.turn() === 'w' && !g.game_over()
      },
      item7_gameGet_e2: g.get('e2'),
      item8_movesE2_verbose: moves.map(m => ({ from: m.from, to: m.to, flags: m.flags, piece: m.piece }))
    };
  })()`));

  // ---------- Contrast: synthetic (untrusted) click ----------
  L('syntheticClickContrast', await evalJs(`(async () => {
    const e2 = document.querySelector('#board .square-e2');
    e2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 120));
    const e3 = document.querySelector('#board .square-e3');
    const e4 = document.querySelector('#board .square-e4');
    return {
      selAfterSynthetic: e2.className.includes('sel-square'),
      hintSquares: [...document.querySelectorAll('#board .legal-move-hint, #board .legal-capture-hint')].map(el => el.getAttribute('data-square')),
      e3Classes: e3.className,
      e4Classes: e4.className
    };
  })()`));

  // ---------- Item 11: computed styles of highlight pseudo-elements ----------
  L('highlightPseudoStyles', await evalJs(`(() => {
    const e3 = document.querySelector('#board .square-e3');
    const cs = getComputedStyle(e3, '::after');
    return {
      e3HasHintClass: e3.className.includes('legal-move-hint'),
      afterContent: cs.content,
      afterBackground: cs.backgroundColor,
      afterPosition: cs.position,
      afterSize: cs.width + ' x ' + cs.height,
      e3BoxShadow: getComputedStyle(e3).boxShadow,
      e3Position: getComputedStyle(e3).position,
      e3Overflow: getComputedStyle(e3).overflow
    };
  })()`));

  // ---------- Real trusted click sequence e2 then e4 (full click-to-move) ----------
  const e4rect = await evalJs(`(() => {
    const r = document.querySelector('#board .square-e4').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  // selection may already exist from synthetic contrast; deselect first
  await evalJs(`(() => {
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await sleep(100);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: e2rect.x, y: e2rect.y, button: 'left', clickCount: 1 });
  await sleep(60);
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: e2rect.x, y: e2rect.y, button: 'left', clickCount: 1 });
  await sleep(150);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: e4rect.x, y: e4rect.y, button: 'left', clickCount: 1 });
  await sleep(60);
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: e4rect.x, y: e4rect.y, button: 'left', clickCount: 1 });
  await sleep(400);

  L('realClickE2thenE4', await evalJs(`(() => {
    return {
      e4HasPawn: !!document.querySelector('#board .square-e4 img'),
      e2HasPawn: !!document.querySelector('#board .square-e2 img'),
      clicksRecorded: window.__diag.clicks,
      statusText: document.getElementById('statusText').textContent
    };
  })()`));
  await sleep(2500); // engine reply?
  L('afterEngine', await evalJs(`(() => ({
    statusText: document.getElementById('statusText').textContent,
    historyRows: document.querySelectorAll('#historyBody tr').length,
    apiRequests: ${JSON.stringify(apiRequests)}
  }))()`));

  // ---------- Confirm drag-and-drop still works (real input) ----------
  await evalJs(`document.getElementById('btnNewGame').click(); true`);
  await sleep(600);
  const d2rect = await evalJs(`(() => {
    const r = document.querySelector('#board .square-d2').getBoundingClientRect();
    const r4 = document.querySelector('#board .square-d4').getBoundingClientRect();
    return { x1: r.left + r.width/2, y1: r.top + r.height/2, x2: r4.left + r4.width/2, y2: r4.top + r4.height/2 };
  })()`);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: d2rect.x1, y: d2rect.y1, button: 'left', clickCount: 1 });
  await sleep(80);
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: d2rect.x2, y: d2rect.y2, button: 'left', clickCount: 1 });
  await sleep(80);
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: d2rect.x2, y: d2rect.y2, button: 'left', clickCount: 1 });
  await sleep(500);
  L('dragDropCheck', await evalJs(`(() => ({
    d4HasPawn: !!document.querySelector('#board .square-d4 img'),
    d2HasPawn: !!document.querySelector('#board .square-d2 img'),
    statusText: document.getElementById('statusText').textContent
  }))()`));

  L('consoleMessages', consoleMessages.slice());
  L('failedRequests', failedRequests.slice());

  fs.writeFileSync(path.join(__dirname, 'cdp-diagnose-report.json'), JSON.stringify(report, null, 2));
  console.log('\nREPORT WRITTEN to scripts/cdp-diagnose-report.json');
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
