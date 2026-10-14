/**
 * Browser-free DOM harness for the game-ended screen and resign flows.
 *
 * Loads the real frontend (index.html + jQuery + chess.js + chessboard.js +
 * app.js) into a jsdom document, stubs only the HTTP layer (`/api/move`,
 * `/api/reset`), and drives the UI through real DOM clicks. This is the closest
 * thing to a browser test that runs without Chrome: the `scripts/cdp-*.js`
 * harnesses cover real-browser rendering, while this one covers the
 * application's own game-over / resignation state machine.
 *
 * Usage:
 *   npm install --no-save jsdom
 *   node scripts/dom-flows.js
 * (or: NODE_PATH=/path/to/node_modules node scripts/dom-flows.js)
 *
 * Exits non-zero and prints every failure if any flow regresses.
 */
const fs = require('fs');
const path = require('path');

let JSDOM;

try {
  ({ JSDOM } = require('jsdom'));
} catch (error) {
  console.error(
    'This harness needs jsdom (dev-only). Install it with:\n' +
      '  npm install --no-save jsdom'
  );
  process.exit(2);
}

const STATIC_DIR = path.join(__dirname, '..', 'app', 'static');

const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`  ok   ${message}`);
  } else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(25);
  }

  failures.push(`timed out waiting for ${message}`);
  console.log(`  FAIL timed out waiting for ${message}`);
  return false;
}

/**
 * Boots one fresh page. `blackReplies` is the scripted Black (bot) move list in
 * SAN; /api/move answers with the next entry, played on the FEN the app sent.
 */
async function bootPage(blackReplies = []) {
  const html = fs.readFileSync(path.join(STATIC_DIR, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8000/',
    pretendToBeVisual: true,
    runScripts: 'outside-only'
  });

  const { window } = dom;

  // jsdom does not fetch the <link>ed stylesheet, so inline the real CSS: the
  // harness then checks actual computed styles (e.g. that a `hidden` action
  // really disappears instead of being kept on screen by `button { display }`).
  const styleElement = window.document.createElement('style');
  styleElement.textContent = fs.readFileSync(path.join(STATIC_DIR, 'style.css'), 'utf8');
  window.document.head.appendChild(styleElement);

  const replies = blackReplies.slice();

  function jsonReply(payload, status = 200) {
    return Promise.resolve({
      ok: status < 400,
      status,
      json: () => Promise.resolve(payload),
      text: () => Promise.resolve(JSON.stringify(payload))
    });
  }

  window.fetch = function (url, options) {
    const target = String(url);

    if (target.indexOf('/api/reset') !== -1) {
      return jsonReply({ status: 'ok' });
    }

    if (target.indexOf('/api/analyze') !== -1) {
      // Not the subject of these flows; answered so review mode stays quiet.
      return jsonReply({ evaluation: 0, depth: 0, best_move: null, from_book: false });
    }

    if (target.indexOf('/api/move') !== -1) {
      const request = JSON.parse(options.body);
      const board = new window.Chess(request.fen);
      const san = replies.shift();

      if (san === undefined) {
        failures.push(`bot asked to move but the script had no reply (${request.fen})`);
        return jsonReply({ is_game_over: true, result: null });
      }

      const move = board.move(san);

      if (!move) {
        failures.push(`scripted bot move "${san}" is illegal in ${request.fen}`);
        return jsonReply({ is_game_over: true, result: null });
      }

      return jsonReply({
        move: move.from + move.to + (move.promotion || ''),
        from_book: false,
        eval: 0,
        depth: 3,
        is_game_over: false,
        result: null
      });
    }

    return jsonReply({ detail: 'unexpected request' }, 404);
  };

  for (const file of [
    'vendor/jquery.min.js',
    'vendor/chess.min.js',
    'vendor/chessboard.min.js',
    'app.js'
  ]) {
    window.eval(fs.readFileSync(path.join(STATIC_DIR, file), 'utf8'));
  }

  // jQuery defers its ready callbacks to a macrotask.
  await sleep(60);

  const rendered = window.document.querySelector('#board .square-55d63');

  if (!rendered) {
    failures.push('chessboard.js rendered no squares (the frontend failed to initialise)');
  }

  return { dom, window };
}

function isOverlayOpen(window, id) {
  const element = window.document.getElementById(id);
  return element !== null && !element.hasAttribute('hidden');
}

function text(window, id) {
  const element = window.document.getElementById(id);
  return element ? element.textContent.trim().replace(/\s+/g, ' ') : '';
}

function click(window, selector) {
  const element = window.document.querySelector(selector);

  if (!element) {
    failures.push(`cannot click missing element ${selector}`);
    return false;
  }

  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

const clickSquare = (window, square) => click(window, `#board .square-${square}`);

function pressEscape(window) {
  window.document.dispatchEvent(
    new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  );
}

/** Squares -> piece map read from the rendered board. */
function renderedPieces(window) {
  const map = {};

  window.document.querySelectorAll('#board .square-55d63').forEach((element) => {
    const squareClass = Array.from(element.classList).find((name) =>
      /^square-[a-h][1-8]$/.test(name)
    );
    const piece = element.querySelector('img');

    if (squareClass && piece) {
      map[squareClass.slice('square-'.length)] = piece.getAttribute('data-piece');
    }
  });

  return map;
}

/** Exact rendered-board check (chessboard.js render animations included). */
function boardShowsFen(window, fen) {
  const expected = window.Chessboard.fenToObj(fen);
  const rendered = renderedPieces(window);

  return (
    Object.keys(expected).every((square) => rendered[square] === expected[square]) &&
    Object.keys(rendered).every((square) => expected[square] === rendered[square])
  );
}

/**
 * Plays one White move by clicking its squares, then waits until the rendered
 * board matches the position after the bot's scripted reply (`replySan`, which
 * is null when the game ends on the player's move).
 * Returns the resulting FEN, or null when the move could not be played.
 */
async function playMove(page, fen, san, replySan, label) {
  const { window } = page;
  const board = new window.Chess(fen);
  const move = board.move(san);

  if (!move) {
    failures.push(`scripted move "${san}" is illegal in ${fen}`);
    return null;
  }

  clickSquare(window, move.from);
  clickSquare(window, move.to);

  if (replySan) {
    const reply = board.move(replySan);

    if (!reply) {
      failures.push(`scripted reply "${replySan}" is illegal after "${san}"`);
      return null;
    }
  }

  const expected = board.fen();
  const shown = await waitFor(
    () => boardShowsFen(window, expected),
    `${label}: rendered board to show ${expected}`
  );

  return shown ? expected : null;
}

async function scenarioResignFlow() {
  console.log('\nScenario 1: resign confirmation screen + game-ended screen');
  // Replies: e5 for the e4 probe, then the fool's mate played after a "New Game".
  const page = await bootPage(['e5', 'e5', 'Qh4#']);
  const { window } = page;
  const startFen = new window.Chess().fen();

  check(!isOverlayOpen(window, 'gameOverOverlay'), 'game-ended overlay starts hidden');
  check(!isOverlayOpen(window, 'resignOverlay'), 'resign overlay starts hidden');
  check(!window.document.getElementById('btnReviewGame'), 'sidebar Review Game button is gone');

  click(window, '#btnResign');
  check(isOverlayOpen(window, 'resignOverlay'), 'clicking Resign opens the in-app confirmation');
  check(!isOverlayOpen(window, 'gameOverOverlay'), 'the confirmation alone does not end the game');

  pressEscape(window);
  check(!isOverlayOpen(window, 'resignOverlay'), 'Escape cancels the resignation');

  click(window, '#btnResign');
  click(window, '#btnResignCancel');
  check(!isOverlayOpen(window, 'resignOverlay'), '"Keep playing" cancels the resignation');
  check(
    text(window, 'statusText').indexOf('White to move') === 0,
    `game stays active after cancelling (status: ${text(window, 'statusText')})`
  );

  const afterCancel = await playMove(page, startFen, 'e4', 'e5', 'play after cancelling');
  check(afterCancel !== null, 'board still accepts moves after cancelling the resignation');

  click(window, '#btnResign');
  click(window, '#btnResignConfirm');
  await waitFor(() => isOverlayOpen(window, 'gameOverOverlay'), 'game-ended screen after confirming');

  check(isOverlayOpen(window, 'gameOverOverlay'), 'confirming resignation opens the game-ended screen');
  check(!isOverlayOpen(window, 'resignOverlay'), 'the confirmation overlay is dismissed');
  check(text(window, 'gameOverTitle') === 'You resigned', 'title names the resignation');
  check(text(window, 'gameOverResult') === 'Black wins', 'Black is declared the winner');
  check(
    /resigned/i.test(text(window, 'gameOverDetail')),
    `detail explains the termination: "${text(window, 'gameOverDetail')}"`
  );
  check(
    text(window, 'statusText').indexOf('Game Over') === 0,
    'sidebar status also reports the result'
  );

  // A resigned game is not reviewable: the action is removed from the screen.
  const reviewCard = window.document.getElementById('reviewControls');
  const reviewAction = window.document.getElementById('btnGameOverReview');

  check(reviewCard.hasAttribute('hidden'), 'review card is hidden until review starts');
  check(reviewAction.hasAttribute('hidden'), 'Review Game is removed after resigning');
  check(reviewAction.disabled, 'Review Game is inert after resigning');
  check(
    window.getComputedStyle(reviewAction).display === 'none',
    `a hidden action must not render (display: ${window.getComputedStyle(reviewAction).display})`
  );
  check(
    !window.document.getElementById('btnGameOverNew').hasAttribute('hidden'),
    'New Game is still offered after resigning'
  );

  click(window, '#btnGameOverReview');
  await sleep(60);
  check(
    reviewCard.hasAttribute('hidden') && isOverlayOpen(window, 'gameOverOverlay'),
    'review mode stays unreachable after resigning'
  );

  click(window, '#btnGameOverNew');
  // New Game is asynchronous: the overlay closes immediately, the game state
  // resets once /api/reset has answered.
  await waitFor(
    () =>
      !isOverlayOpen(window, 'gameOverOverlay') &&
      boardShowsFen(window, startFen) &&
      text(window, 'statusText').indexOf('White to move') === 0,
    'New Game to reset the board and status'
  );
  check(!isOverlayOpen(window, 'gameOverOverlay'), 'New Game closes the game-ended screen');
  check(
    text(window, 'statusText').indexOf('White to move') === 0,
    `New Game starts a fresh game (status: ${text(window, 'statusText')})`
  );
  check(boardShowsFen(window, startFen), 'New Game resets the board to the starting position');

  // The removal is per-ending, not permanent: a later game that ends on the
  // board must offer review again on the same page.
  const afterResignationFen = await playMove(
    page,
    startFen,
    'f3',
    'e5',
    'f3 after a resignation'
  );
  check(afterResignationFen !== null, 'a new game can be played after a resignation');

  await playMove(
    page,
    afterResignationFen === null ? startFen : afterResignationFen,
    'g4',
    'Qh4#',
    'g4 after a resignation'
  );
  await waitFor(() => isOverlayOpen(window, 'gameOverOverlay'), 'checkmate after a resignation');

  check(isOverlayOpen(window, 'gameOverOverlay'), 'a checkmate after a resignation opens the screen');
  check(text(window, 'gameOverTitle') === 'Checkmate', 'the new ending is described correctly');
  check(
    !reviewAction.hasAttribute('hidden') && !reviewAction.disabled,
    'Review Game is offered again for a later, non-resignation ending'
  );

  window.close();
}

async function scenarioCheckmate() {
  console.log("\nScenario 2: checkmate by the bot (Fool's mate)");
  const page = await bootPage(['e5', 'Qh4#']);
  const { window } = page;

  let fen = await playMove(page, new window.Chess().fen(), 'f3', 'e5', 'f3 e5');
  check(fen !== null, 'first player move and bot reply are applied');

  fen = await playMove(
    page,
    fen === null ? new window.Chess().fen() : fen,
    'g4',
    'Qh4#',
    'g4 Qh4#'
  );
  check(
    fen === 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3',
    `the fool's mate position was reached (got ${fen})`
  );

  await waitFor(() => isOverlayOpen(window, 'gameOverOverlay'), 'checkmate to open the overlay');

  check(isOverlayOpen(window, 'gameOverOverlay'), 'checkmate opens the game-ended screen automatically');
  check(text(window, 'gameOverTitle') === 'Checkmate', 'title says Checkmate');
  check(text(window, 'gameOverResult') === 'Black wins', 'the mating side is declared the winner');
  check(
    /Checkmate: White is in check and has no legal move left\. Black wins/.test(
      text(window, 'gameOverDetail')
    ),
    `detail names the mated side: "${text(window, 'gameOverDetail')}"`
  );
  check(
    text(window, 'statusText') === 'Game Over: Checkmate \u2014 Black wins.',
    `sidebar status matches the modal (status: ${text(window, 'statusText')})`
  );

  const before = JSON.stringify(renderedPieces(window));
  clickSquare(window, 'd2');
  clickSquare(window, 'd4');
  await sleep(80);
  check(
    before === JSON.stringify(renderedPieces(window)),
    'the board rejects input after the game ended'
  );

  window.close();
}

async function scenarioStalemate() {
  console.log('\nScenario 3: draw by stalemate (10-move line)');
  // 1.e3 a5 2.Qh5 Ra6 3.Qxa5 h5 4.Qxc7 Rah6 5.h4 f6
  // 6.Qxd7+ Kf7 7.Qxb7 Qd3 8.Qxb8 Qh7 9.Qxc8 Kg6 10.Qe6 stalemate
  const blackReplies = ['a5', 'Ra6', 'h5', 'Rah6', 'f6', 'Kf7', 'Qd3', 'Qh7', 'Kg6'];
  const whiteMoves = ['e3', 'Qh5', 'Qxa5', 'Qxc7', 'h4', 'Qxd7+', 'Qxb7', 'Qxb8', 'Qxc8', 'Qe6'];

  const page = await bootPage(blackReplies);
  const { window } = page;

  let fen = new window.Chess().fen();

  for (let index = 0; index < whiteMoves.length; index += 1) {
    const isFinalMove = index === whiteMoves.length - 1;
    const next = await playMove(
      page,
      fen,
      whiteMoves[index],
      isFinalMove ? null : blackReplies[index],
      `ply ${index + 1} (${whiteMoves[index]})`
    );

    if (next === null) {
      break;
    }

    fen = next;
  }

  await waitFor(() => isOverlayOpen(window, 'gameOverOverlay'), 'stalemate to open the overlay');

  check(isOverlayOpen(window, 'gameOverOverlay'), 'stalemate opens the game-ended screen');
  check(
    text(window, 'gameOverTitle') === 'Stalemate',
    `title says Stalemate (got "${text(window, 'gameOverTitle')}")`
  );
  check(text(window, 'gameOverResult') === 'Draw', 'stalemate is reported as a draw');
  check(
    text(window, 'gameOverDetail') ===
      'Draw by stalemate: no legal moves remain and the side to move is not in check.',
    `detail is stalemate-specific: "${text(window, 'gameOverDetail')}"`
  );
  check(
    text(window, 'statusText') === 'Game Over: Stalemate \u2014 the position is a draw.',
    `sidebar status matches the modal (status: ${text(window, 'statusText')})`
  );

  const reviewCard = window.document.getElementById('reviewControls');

  check(
    !window.document.getElementById('btnGameOverReview').hasAttribute('hidden'),
    'Review Game is still offered for a game that ended on the board'
  );

  click(window, '#btnGameOverReview');
  await sleep(60);
  check(!reviewCard.hasAttribute('hidden'), 'Review Game works for a draw as well');
  check(
    text(window, 'reviewPositionLabel').indexOf('Qe6') !== -1,
    `review opens at the final position (label: ${text(window, 'reviewPositionLabel')})`
  );
  check(
    !window.document.getElementById('reviewAnalysisCard').hasAttribute('hidden'),
    'post-game analysis card is available in review mode'
  );

  click(window, '#btnReviewExit');
  await sleep(60);
  check(isOverlayOpen(window, 'gameOverOverlay'), 'exiting review restores the game-ended screen');
  check(reviewCard.hasAttribute('hidden'), 'review card is hidden after exiting review');

  window.close();
}

(async () => {
  console.log('jsdom DOM harness: game-ended screen and resign flows');
  console.log('note: the HTTP layer is stubbed; /api/move answers from a scripted SAN list.');

  await scenarioResignFlow();
  await scenarioCheckmate();
  await scenarioStalemate();

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed:`);
    failures.forEach((failure) => console.error(` - ${failure}`));
    process.exit(1);
  }

  console.log('\nAll DOM flow checks passed.');
})().catch((error) => {
  console.error('Harness crashed:', error);
  process.exit(1);
});
