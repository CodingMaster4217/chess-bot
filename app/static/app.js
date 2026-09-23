/**
 * DeepChess client-side application.
 * Connects chessboard.js and chess.js to the FastAPI backend.
 */

$(document).ready(function () {
  const missingDependencies = [];

  if (typeof window.jQuery === 'undefined') {
    missingDependencies.push('jQuery');
  }

  if (typeof window.Chess === 'undefined') {
    missingDependencies.push('chess.js');
  }

  if (typeof window.Chessboard === 'undefined') {
    missingDependencies.push('chessboard.js');
  }

  if (missingDependencies.length > 0) {
    const message =
      `Cannot initialize chessboard. Missing dependencies: ` +
      missingDependencies.join(', ');

    console.error(message);

    const boardElement = document.getElementById('board');

    if (boardElement) {
      boardElement.innerHTML = `
        <p style="color: #ef4444; padding: 2rem; text-align: center;">
          ${message}
        </p>
      `;
    }

    return;
  }

  let board = null;
  const game = new Chess();
  let isEngineThinking = false;
  let moveHistory = [];

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

  /**
   * Returns whether the current chess.js position is over.
   */
  function isGameOver() {
    return game.game_over();
  }

  /**
   * Controls whether a piece may be picked up.
   */
  function onDragStart(source, piece) {
    if (isGameOver() || isEngineThinking) {
      return false;
    }

    // The human always controls White.
    if (game.turn() !== 'w') {
      return false;
    }

    if (piece.search(/^b/) !== -1) {
      return false;
    }

    return true;
  }

  /**
   * Applies a move made by the human.
   */
  function onDrop(source, target) {
    const move = game.move({
      from: source,
      to: target,
      promotion: 'q'
    });

    if (move === null) {
      return 'snapback';
    }

    recordMove(move);
    updateStatus();

    window.setTimeout(triggerEngineMove, 150);

    return undefined;
  }

  /**
   * Synchronizes chessboard.js with chess.js after an animation.
   */
  function onSnapEnd() {
    if (board) {
      board.position(game.fen());
    }
  }

  /**
   * Requests and applies the engine's reply.
   */
  async function triggerEngineMove() {
    if (isGameOver()) {
      updateStatus();
      return;
    }

    isEngineThinking = true;
    setThinkingState(true);

    const depth = parseInt($depthSelect.val(), 10);
    const timeLimit = parseFloat($timeLimitSelect.val());

    try {
      const response = await fetch('/api/move', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fen: game.fen(),
          depth: depth,
          time_limit: timeLimit
        })
      });

      if (!response.ok) {
        let detail = '';

        try {
          const errorData = await response.json();
          detail = errorData.detail
            ? `: ${JSON.stringify(errorData.detail)}`
            : '';
        } catch (error) {
          // The server did not return JSON.
        }

        throw new Error(
          `Server returned HTTP ${response.status}${detail}`
        );
      }

      const data = await response.json();

      if (data.is_game_over) {
        updateStatus();
        return;
      }

      if (!data.move || typeof data.move !== 'string') {
        throw new Error('The server did not return a valid move.');
      }

      const fromSquare = data.move.substring(0, 2);
      const toSquare = data.move.substring(2, 4);
      const promotion =
        data.move.length > 4
          ? data.move.substring(4, 5)
          : 'q';

      const botMove = game.move({
        from: fromSquare,
        to: toSquare,
        promotion: promotion
      });

      if (botMove === null) {
        throw new Error(
          `The server returned an illegal move: ${data.move}`
        );
      }

      if (board) {
        board.position(game.fen());
      }

      recordMove(botMove);
      updateDiagnostics(data);
      updateEvaluation(data.eval);
    } catch (error) {
      console.error('Failed to get bot move:', error);
      $statusText.text(
        'Could not get a move from the chess server. Please start a new game or try again.'
      );
    } finally {
      isEngineThinking = false;
      setThinkingState(false);
      updateStatus();
    }
  }

  /**
   * Updates the UI while the engine is calculating.
   */
  function setThinkingState(isThinking) {
    if (isThinking) {
      $statusBox.addClass('thinking');
      $statusText.text('Bot is calculating the best move...');
      $btnNewGame.prop('disabled', true);
      $btnFlipBoard.prop('disabled', true);
    } else {
      $statusBox.removeClass('thinking');
      $btnNewGame.prop('disabled', false);
      $btnFlipBoard.prop('disabled', false);
    }
  }

  /**
   * Displays the current game state.
   */
  function updateStatus() {
    if (isEngineThinking) {
      return;
    }

    const moveColor = game.turn() === 'w' ? 'White' : 'Black';
    let status;

    if (game.in_checkmate()) {
      status = `Game Over: ${moveColor} is checkmated.`;
      $statusBox.addClass('game-over');
    } else if (game.in_draw()) {
      status =
        'Game Over: Draw by stalemate, repetition, insufficient material, or the 50-move rule.';
      $statusBox.addClass('game-over');
    } else {
      status = `${moveColor} to move.`;

      if (game.in_check()) {
        status += ' Check!';
      }

      $statusBox.removeClass('game-over');
    }

    $statusText.text(status);
  }

  /**
   * Updates the evaluation bar.
   */
  function updateEvaluation(centipawns) {
    const score = Number(centipawns);

    if (!Number.isFinite(score)) {
      $evalBar.css('height', '50%');
      $evalLabel.text('0.00');
      $metricEval.text('0.00');
      return;
    }

    const clamped = Math.max(-1000, Math.min(1000, score));
    const whitePercent = 50 + (clamped / 1000) * 45;

    $evalBar.css('height', `${whitePercent}%`);

    const pawnScore = (score / 100).toFixed(2);
    const displayScore =
      score > 0 ? `+${pawnScore}` : pawnScore;

    $evalLabel.text(displayScore);
    $metricEval.text(displayScore);
  }

  /**
   * Displays details returned by the engine.
   */
  function updateDiagnostics(data) {
    $metricOrigin.text(
      data.from_book
        ? 'PolyGlot Book'
        : 'Iterative Deepening Search'
    );

    $metricDepth.text(
      data.from_book
        ? 'Book Entry'
        : data.depth !== undefined
          ? `Depth ${data.depth}`
          : '-'
    );
  }

  /**
   * Adds a move to the client-side history.
   */
  function recordMove(move) {
    moveHistory.push(move);
    renderMoveHistory();
  }

  /**
   * Renders complete move pairs in the history table.
   */
  function renderMoveHistory() {
    $historyBody.empty();

    const totalMoves = moveHistory.length;

    $moveCountBadge.text(
      `${totalMoves} ${totalMoves === 1 ? 'move' : 'moves'}`
    );

    for (let index = 0; index < totalMoves; index += 2) {
      const moveNumber = Math.floor(index / 2) + 1;
      const whiteMove = moveHistory[index]
        ? moveHistory[index].san
        : '';
      const blackMove = moveHistory[index + 1]
        ? moveHistory[index + 1].san
        : '';

      const $row = $('<tr>');
      $('<td>').text(`${moveNumber}.`).appendTo($row);
      $('<td>').text(whiteMove).appendTo($row);
      $('<td>').text(blackMove).appendTo($row);

      $historyBody.append($row);
    }

    const historyContainer =
      document.querySelector('.history-container');

    if (historyContainer) {
      historyContainer.scrollTop =
        historyContainer.scrollHeight;
    }
  }

  /**
   * Resets both the backend session and browser position.
   */
  $btnNewGame.on('click', async function () {
    if (isEngineThinking) {
      return;
    }

    $btnNewGame.prop('disabled', true);

    try {
      const response = await fetch('/api/reset', {
        method: 'POST'
      });

      if (!response.ok) {
        console.warn(
          `Reset endpoint returned HTTP ${response.status}`
        );
      }
    } catch (error) {
      console.warn('Could not reset the backend session:', error);
    } finally {
      game.reset();
      moveHistory = [];

      if (board) {
        board.start();
      }

      renderMoveHistory();
      updateEvaluation(0);

      $metricOrigin.text('-');
      $metricDepth.text('-');
      $statusBox.removeClass('thinking game-over');
      $btnNewGame.prop('disabled', false);

      updateStatus();
    }
  });

  /**
   * Flips only the visual orientation.
   * The human continues to control White.
   */
  $btnFlipBoard.on('click', function () {
    if (!board || isEngineThinking) {
      return;
    }

    board.flip();
  });

  /**
   * Creates the chessboard after all dependencies and DOM elements exist.
   */
  try {
    board = Chessboard('board', {
      draggable: true,
      position: 'start',
      orientation: 'white',
      pieceTheme:
        '/static/img/chesspieces/wikipedia/{piece}.png',
      onDragStart: onDragStart,
      onDrop: onDrop,
      onSnapEnd: onSnapEnd
    });
  } catch (error) {
    console.error('Chessboard initialization failed:', error);

    $('#board').html(`
      <p style="color: #ef4444; padding: 2rem; text-align: center;">
        Chessboard initialization failed. Check the browser console.
      </p>
    `);

    return;
  }

  // chessboard.js calculates dimensions from its container.
  // Resize once after layout and whenever the viewport changes.
  window.setTimeout(function () {
    if (board) {
      board.resize();
    }
  }, 0);

  let resizeTimer = null;

  $(window).on('resize', function () {
    window.clearTimeout(resizeTimer);

    resizeTimer = window.setTimeout(function () {
      if (board) {
        board.resize();
      }
    }, 100);
  });

  renderMoveHistory();
  updateEvaluation(0);
  updateStatus();
});
