/**
 * DeepChess Client-Side Application Logic
 * Integrates chessboard.js and chess.js with the FastAPI AI backend.
 */

$(document).ready(function () {
  let board = null;
  const game = new Chess();
  let playerColor = 'white';
  let isEngineThinking = false;
  let moveHistory = [];

  // DOM Elements
  const $statusText = $('#statusText');
  const $statusBox = $('#statusBox');
  const $depthSelect = $('#depthSelect');
  const $timeLimitSelect = $('#timeLimitSelect');
  const $evalBar = $('#evalBarWhite');
  const $evalLabel = $('#evalLabel');
  const $historyBody = $('#historyBody');
  const $moveCountBadge = $('#moveCountBadge');
  const $metricOrigin = $('#metricOrigin');
  const $metricDepth = $('#metricDepth');
  const $metricEval = $('#metricEval');
  const $btnNewGame = $('#btnNewGame');
  const $btnFlipBoard = $('#btnFlipBoard');

  // Determine piece images path
  const pieceTheme = 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png';

  // Board Event Handlers
  function onDragStart(source, piece, position, orientation) {
    // Prevent piece pickup if game is over
    if (game.game_over()) return false;

    // Prevent dragging when engine is thinking
    if (isEngineThinking) return false;

    // Only allow picking up pieces for the side to move
    if (
      (game.turn() === 'w' && piece.search(/^b/) !== -1) ||
      (game.turn() === 'b' && piece.search(/^w/) !== -1)
    ) {
      return false;
    }

    // Only allow dragging player's pieces (unless board flipped for black player)
    const isPlayerTurn = (game.turn() === 'w' && playerColor === 'white') ||
                         (game.turn() === 'b' && playerColor === 'black');
    if (!isPlayerTurn) return false;

    return true;
  }

  function onDrop(source, target) {
    // Check if move is legal
    const move = game.move({
      from: source,
      to: target,
      promotion: 'q' // Auto-promote to Queen for simplicity
    });

    // If illegal move, snap piece back
    if (move === null) return 'snapback';

    // Update history table and UI state
    recordMove(move);
    updateStatus();

    // Trigger Bot Move
    window.setTimeout(triggerEngineMove, 150);
  }

  function onSnapEnd() {
    board.position(game.fen());
  }

  // Engine API Communication
  async function triggerEngineMove() {
    if (game.game_over()) return;

    isEngineThinking = true;
    setThinkingState(true);

    const depth = parseInt($depthSelect.val(), 10);
    const timeLimit = parseFloat($timeLimitSelect.val());
    const fen = game.fen();

    try {
      const response = await fetch('/api/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen: fen,
          depth: depth,
          time_limit: timeLimit
        })
      });

      if (!response.ok) {
        throw new Error(`Server returned HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.is_game_over) {
        updateStatus();
        return;
      }

      if (data.move) {
        const fromSquare = data.move.substring(0, 2);
        const toSquare = data.move.substring(2, 4);
        const promotion = data.move.length > 4 ? data.move.substring(4, 5) : undefined;

        const botMove = game.move({
          from: fromSquare,
          to: toSquare,
          promotion: promotion || 'q'
        });

        if (botMove) {
          board.position(game.fen());
          recordMove(botMove);
          updateDiagnostics(data);
          updateEvaluation(data.eval);
        }
      }
    } catch (err) {
      console.error('Failed to get bot move:', err);
      $statusText.text('Error communicating with Chess Bot server.');
    } finally {
      isEngineThinking = false;
      setThinkingState(false);
      updateStatus();
    }
  }

  // UI Updates & Visual Helpers
  function setThinkingState(isThinking) {
    if (isThinking) {
      $statusBox.addClass('thinking');
      $statusText.html('<span class="spinner"></span> Bot is calculating best line...');
      $btnNewGame.prop('disabled', true);
      $btnFlipBoard.prop('disabled', true);
    } else {
      $statusBox.removeClass('thinking');
      $btnNewGame.prop('disabled', false);
      $btnFlipBoard.prop('disabled', false);
    }
  }

  function updateStatus() {
    let status = '';
    const moveColor = game.turn() === 'w' ? 'White' : 'Black';

    if (game.in_checkmate()) {
      status = `Game Over: ${moveColor} is checkmated!`;
      $statusBox.addClass('game-over');
    } else if (game.in_draw()) {
      status = 'Game Over: Draw (Stalemate / 50-move rule / Repetition)';
      $statusBox.addClass('game-over');
    } else {
      status = `${moveColor} to move.`;
      if (game.in_check()) {
        status += ' (Check!)';
      }
      $statusBox.removeClass('game-over');
    }

    $statusText.text(status);
  }

  function updateEvaluation(centipawns) {
    // Score is relative to White
    // Clamping to visual range -1000 to +1000
    const clamped = Math.max(-1000, Math.min(1000, centipawns));
    // Percentage for White: 0cp -> 50%
    const whitePercent = 50 + (clamped / 1000) * 45;
    $evalBar.css('height', `${whitePercent}%`);

    const pawnScore = (centipawns / 100).toFixed(2);
    const displayScore = centipawns > 0 ? `+${pawnScore}` : pawnScore;
    $evalLabel.text(displayScore);
    $metricEval.text(displayScore);
  }

  function updateDiagnostics(data) {
    $metricOrigin.text(data.from_book ? 'PolyGlot Book' : 'Iterative Deepening Search');
    $metricDepth.text(data.from_book ? 'Book Entry' : `Depth ${data.depth}`);
  }

  function recordMove(move) {
    moveHistory.push(move);
    renderMoveHistory();
  }

  function renderMoveHistory() {
    $historyBody.empty();
    const totalMoves = moveHistory.length;
    $moveCountBadge.text(`${totalMoves} ${totalMoves === 1 ? 'move' : 'moves'}`);

    for (let i = 0; i < totalMoves; i += 2) {
      const moveNum = Math.floor(i / 2) + 1;
      const whiteMove = moveHistory[i] ? moveHistory[i].san : '';
      const blackMove = moveHistory[i + 1] ? moveHistory[i + 1].san : '';

      const rowHtml = `
        <tr>
          <td>${moveNum}.</td>
          <td><strong>${whiteMove}</strong></td>
          <td><strong>${blackMove}</strong></td>
        </tr>
      `;
      $historyBody.append(rowHtml);
    }

    // Scroll to bottom
    const historyContainer = document.querySelector('.history-container');
    if (historyContainer) {
      historyContainer.scrollTop = historyContainer.scrollHeight;
    }
  }

  // Button Listeners
  $btnNewGame.on('click', async function () {
    if (isEngineThinking) return;

    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch (e) {
      console.warn('Reset call failed:', e);
    }

    game.reset();
    board.position('start');
    moveHistory = [];
    renderMoveHistory();
    updateEvaluation(0);
    $metricOrigin.text('-');
    $metricDepth.text('-');
    updateStatus();

    // If playing as Black, trigger bot's opening move
    if (playerColor === 'black') {
      window.setTimeout(triggerEngineMove, 200);
    }
  });

  $btnFlipBoard.on('click', function () {
    if (isEngineThinking) return;

    board.flip();
    playerColor = board.orientation();

    // If flipped and it's bot's turn, trigger move
    const isBotTurn = (game.turn() === 'w' && playerColor === 'black') ||
                      (game.turn() === 'b' && playerColor === 'white');
    if (isBotTurn) {
      window.setTimeout(triggerEngineMove, 200);
    }
  });

  // Initialize Chessboard.js
  const config = {
    draggable: true,
    position: 'start',
    pieceTheme: pieceTheme,
    onDragStart: onDragStart,
    onDrop: onDrop,
    onSnapEnd: onSnapEnd
  };

  board = Chessboard('board', config);
  updateStatus();

  // Resize handler for responsiveness
  $(window).resize(board.resize);
});

