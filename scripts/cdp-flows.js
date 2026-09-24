/**
 * Deep flow verification in real headless Chrome:
 * review navigation with moves, analysis fetch + cache, legal-moves toggle
 * persistence, illegal clicks, outside deselect, resize stability.
 *
 * Usage: node scripts/cdp-flows.js [port]
 * Requires: local Chrome on debug port 9222 and dev-only npm packages:
 *   npm install --no-save chrome-remote-interface
 */
const fs = require('fs');
const path = require('path');
const CDP = require('chrome-remote-interface');

const PORT = parseInt(process.argv[2] || '8123', 10);
const URL_BASE = `http://127.0.0.1:${PORT}`;

const log = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: 9222 });
  const { Runtime, Page, Network, Emulation } = client;

  const consoleMessages = [];
  const requests = [];

  Runtime.consoleAPICalled((e) => {
    const text = (e.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' ');
    consoleMessages.push(`[${e.type}] ${text}`);
  });
  Runtime.exceptionThrown((e) => {
    consoleMessages.push(`[EXCEPTION] ${e.exceptionDetails.text}`);
  });
  Network.requestWillBeSent((e) => {
    if (e.request.url.includes('/api/')) requests.push({ url: e.request.url.replace(URL_BASE, ''), ts: Date.now() });
  });

  await Runtime.enable();
  await Page.enable();
  await Network.enable();
  await Network.setCacheDisabled({ cacheDisabled: true });
  await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });

  await Page.navigate({ url: URL_BASE + '/' });
  await Page.loadEventFired();
  await sleep(1000);

  const evalJs = async (expr, awaitPromise = false) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  // --- Scenario A: legal-moves toggle OFF, then click-to-move still works ---
  log.toggleOff = await evalJs(`(async () => {
    const cb = document.getElementById('showLegalMoves');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    const fire = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    fire(document.querySelector('#board .square-e2'));
    await new Promise(r => setTimeout(r, 80));
    const sel = document.querySelector('#board .square-e2').className;
    const hintCount = document.querySelectorAll('#board .legal-move-hint, #board .legal-capture-hint').length;
    // move anyway (click-to-move must work without highlights)
    fire(document.querySelector('#board .square-e4'));
    await new Promise(r => setTimeout(r, 700)); // chessboard.js animates ~200ms
    return {
      selHasSelSquare: sel.includes('sel-square'),
      hintCountWhileOff: hintCount,
      movedWithoutHints: !!document.querySelector('#board .square-e4 img'),
      stored: localStorage.getItem('deepchess.showLegalMoves')
    };
  })()`, true);

  await sleep(2500); // engine replies (2 plies now in history)

  // --- Scenario B: restore toggle ON, verify persistence after reload -------
  await evalJs(`(async () => {
    const cb = document.getElementById('showLegalMoves');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return localStorage.getItem('deepchess.showLegalMoves');
  })()`, true);

  await Page.navigate({ url: URL_BASE + '/' });
  await Page.loadEventFired();
  await sleep(900);

  log.persistAfterReload = await evalJs(`({
    checkboxChecked: document.getElementById('showLegalMoves').checked,
    stored: localStorage.getItem('deepchess.showLegalMoves')
  })`);

  // --- Scenario C: play a full move pair, illegal click, outside deselect ---
  log.clickFlow = await evalJs(`(async () => {
    const fire = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // select e2, click ILLEGAL destination e5: state unchanged, selection kept
    fire(document.querySelector('#board .square-e2'));
    await new Promise(r => setTimeout(r, 60));
    const hints = [...document.querySelectorAll('#board .legal-move-hint')].map(el => el.className.match(/square-([a-h][1-8])/)[1]).sort();
    fire(document.querySelector('#board .square-e5'));
    await new Promise(r => setTimeout(r, 60));
    const afterIllegal = {
      e5HasPawn: !!document.querySelector('#board .square-e5 img'),
      selectionKept: document.querySelector('#board .square-e2').className.includes('sel-square')
    };
    // deselect via outside click
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    const afterOutside = {
      selectionCleared: !document.querySelector('#board .square-e2').className.includes('sel-square')
    };
    // now the real move e2-e4
    fire(document.querySelector('#board .square-e2'));
    await new Promise(r => setTimeout(r, 60));
    fire(document.querySelector('#board .square-e4'));
    await new Promise(r => setTimeout(r, 200));
    return { hints, afterIllegal, afterOutside, e4HasPawn: !!document.querySelector('#board .square-e4 img') };
  })()`, true);

  await sleep(2500); // engine reply -> 2 plies

  // --- Scenario D: resign -> review navigation with 2 plies + analysis ------
  log.review = await evalJs(`(async () => {
    window.confirm = () => true;
    document.getElementById('btnResign').click();
    await new Promise(r => setTimeout(r, 120));
    const status = document.getElementById('statusText').textContent;
    document.getElementById('btnReviewGame').click();
    await new Promise(r => setTimeout(r, 150));
    const labelFinal = document.getElementById('reviewPositionLabel').textContent;
    const nextDisabledAtEnd = document.getElementById('btnReviewNext').disabled;
    const prevDisabledAtEnd = document.getElementById('btnReviewPrev').disabled;
    // navigate: prev -> ply 1, first -> start, next -> ply 1, last -> final
    document.getElementById('btnReviewPrev').click();
    await new Promise(r => setTimeout(r, 100));
    const labelPly1 = document.getElementById('reviewPositionLabel').textContent;
    document.getElementById('btnReviewFirst').click();
    await new Promise(r => setTimeout(r, 100));
    const labelStart = document.getElementById('reviewPositionLabel').textContent;
    const firstDisabledAtStart = document.getElementById('btnReviewFirst').disabled;
    const nextDisabledAtStart = document.getElementById('btnReviewNext').disabled;
    document.getElementById('btnReviewNext').click();
    await new Promise(r => setTimeout(r, 100));
    const labelBackToPly1 = document.getElementById('reviewPositionLabel').textContent;
    document.getElementById('btnReviewLast').click();
    await new Promise(r => setTimeout(r, 100));
    const labelBackFinal = document.getElementById('reviewPositionLabel').textContent;
    // exit review returns to final position, review hidden, resign still disabled
    document.getElementById('btnReviewExit').click();
    await new Promise(r => setTimeout(r, 100));
    return {
      status, labelFinal, nextDisabledAtEnd, prevDisabledAtEnd,
      labelPly1, labelStart, firstDisabledAtStart, nextDisabledAtStart,
      labelBackToPly1, labelBackFinal,
      reviewHiddenAfterExit: document.getElementById('reviewControls').hidden
    };
  })()`, true);

  // re-enter review; analysis: ply1 position has stored engine data; final ply triggers /api/analyze
  log.analysis = await evalJs(`(async () => {
    document.getElementById('btnReviewGame').click();
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('btnReviewFirst').click();
    await new Promise(r => setTimeout(r, 100));
    document.getElementById('btnReviewNext').click(); // ply 1: stored engine data
    await new Promise(r => setTimeout(r, 100));
    const ply1 = {
      san: document.getElementById('reviewSan').textContent,
      eval: document.getElementById('reviewEval').textContent,
      depth: document.getElementById('reviewDepth').textContent,
      status: document.getElementById('reviewAnalysisStatus').textContent
    };
    document.getElementById('btnReviewLast').click(); // final ply: needs /api/analyze
    await new Promise(r => setTimeout(r, 2500));
    const finalPly = {
      eval: document.getElementById('reviewEval').textContent,
      depth: document.getElementById('reviewDepth').textContent,
      status: document.getElementById('reviewAnalysisStatus').textContent
    };
    // history row click jumps to position
    const historyBtn = document.querySelector('#historyBody button');
    let historyJump = null;
    if (historyBtn) {
      historyBtn.click();
      await new Promise(r => setTimeout(r, 100));
      historyJump = document.getElementById('reviewPositionLabel').textContent;
    }
    // rapid navigation then check no stale overwrite
    document.getElementById('btnReviewFirst').click();
    document.getElementById('btnReviewLast').click();
    document.getElementById('btnReviewFirst').click();
    await new Promise(r => setTimeout(r, 2000));
    const afterRapid = document.getElementById('reviewEval').textContent;
    return { ply1, finalPly, historyJump, afterRapid };
  })()`, true);

  // --- Scenario E: mobile viewport -> resize -> click-to-move still works ---
  await Emulation.setDeviceMetricsOverride({ width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  // exit review first via New Game
  await evalJs(`(async () => {
    document.getElementById('btnNewGame').click();
    await new Promise(r => setTimeout(r, 400));
    return true;
  })()`, true);
  log.mobileAfterResize = await evalJs(`(async () => {
    const fire = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const squares = document.querySelectorAll('#board .square-55d63').length;
    fire(document.querySelector('#board .square-d2'));
    await new Promise(r => setTimeout(r, 80));
    const sel = document.querySelector('#board .square-d2').className.includes('sel-square');
    fire(document.querySelector('#board .square-d4'));
    await new Promise(r => setTimeout(r, 700)); // chessboard.js animates ~200ms
    return { squares, selected: sel, moved: !!document.querySelector('#board .square-d4 img') };
  })()`, true);

  // --- Scenario F: New Game clears review state -----------------------------
  log.newGameResets = await evalJs(`({
    reviewDisabledAgain: document.getElementById('btnReviewGame').disabled,
    resignEnabled: !document.getElementById('btnResign').disabled,
    reviewHidden: document.getElementById('reviewControls').hidden,
    statusText: document.getElementById('statusText').textContent
  })`);

  log.consoleMessages = consoleMessages;
  log.analysisRequests = requests;

  fs.writeFileSync(path.join(__dirname, 'cdp-flows-report.json'), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log, null, 2));
  await client.close();
  process.exit(0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
