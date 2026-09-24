/**
 * DeepChess client-side application.
 * Connects chessboard.js (v1.0.0) and chess.js (0.10.x) to the FastAPI backend.
 *
 * Live engine analysis is never shown during an active game.
 * Engine data (eval/depth/book) is stored only for post-game review.
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
      // Static application-owned message; contains no untrusted input.
      boardElement.innerHTML =
        '<p style="color: #ef4444; padding: 2rem; text-align: center;"></p>';
      boardElement.querySelector('p').textContent = message;
    }

    return;
  }

  // ------------------------------------------------------------------
  // DOM references
  // ------------------------------------------------------------------
  const $statusText = $('#statusText');
  const $statusBox = $('#statusBox');
  const $depthSelect = $('#depthSelect');
  const $timeLimitSelect = $('#timeLimitSelect');
  const $historyBody = $('#historyBody');
  const $moveCountBadge = $('#moveCountBadge');
  const $btnNewGame = $('#btnNewGame');
  const $btnFlipBoard = $('#btnFlipBoard');
  const $btnResign = $('#btnResign');
  const $btnReviewGame = $('#btnReviewGame');
  const $btnReviewExit = $('#btnReviewExit');
  const $btnReviewFirst = $('#btnReviewFirst');
  const $btnReviewPrev = $('#btnReviewPrev');
  const $btnReviewNext = $('#btnReviewNext');
  const $btnReviewLast = $('#btnReviewLast');
  const $btnReviewMovePrev = $('#btnReviewMovePrev');
  const $btnReviewMoveNext = $('#btnReviewMoveNext');
  const $reviewControls = $('#reviewControls');
  const $reviewAnalysisCard = $('#reviewAnalysisCard');
  const $reviewPositionLabel = $('#reviewPositionLabel');
  const $reviewSan = $('#reviewSan');
  const $reviewEval = $('#reviewEval');
  const $reviewDepth = $('#reviewDepth');
  const $reviewBook = $('#reviewBook');
  const $reviewAnalysisStatus = $('#reviewAnalysisStatus');
  const $showLegalMoves = $('#showLegalMoves');
  const boardElement = document.getElementById('board');

  // ------------------------------------------------------------------
  // Game state
  // ------------------------------------------------------------------
  let board = null;
  const game = new Chess();
  let isEngineThinking = false;
  let moveHistory = [];

  // Application-level result flag. chess.js game_over() cannot know about a
  // resignation, so this flag is required to gate review and input.
  let gameHasEnded = false;
  let endReason = null; // 'checkmate' | 'draw' | 'resignation'

  // Review state. reviewIndex 0 = initial position, N = position after ply N.
  let reviewMode = false;
  let reviewIndex = 0;

  // Click-to-move selection state.
  let selectedSquare = null;

  // Set while a drag-driven move is being processed so the click handler can
  // ignore the mouseup/click that follows a completed drag.
  let suppressClickUntil = 0;

  // Legal-move display preference (default: enabled when no saved value).
  const LEGAL_MOVES_STORAGE_KEY = 'deepchess.showLegalMoves';
  let showLegalMovesPref = true;

  try {
    const stored = window.localStorage.getItem(LEGAL_MOVES_STORAGE_KEY);
    if (stored === 'true') {
      showLegalMovesPref = true;
    } else if (stored === 'false') {
      showLegalMovesPref = false;
    }
  } catch (error) {
    // localStorage unavailable (private mode etc.) - keep the default.
  }

  $showLegalMoves.prop('checked', showLegalMovesPref);

  // ------------------------------------------------------------------
  // Game record (for post-game review)
  // ------------------------------------------------------------------
  // reviewRecord.initialFen : starting FEN of the game
  // reviewRecord.positions[i] : { fen, eval?, depth?, fromBook? } for
  //   i = 0 (start) .. plyCount. eval/depth/fromBook describe the engine
  //   search performed AT that position (present only when the engine
  //   searched or answered from book there).
  // reviewRecord.moves[i] : metadata for the move that produced
  //   positions[i + 1]:
  //   { san, uci, from, to, promotion, color, ply, moveNumber, fenAfter }
  // UCI is always built from from/to/promotion, never inferred from SAN.
  const reviewRecord = {
    initialFen: game.fen(),
    positions: [{ fen: game.fen() }],
    moves: []
  };

  // Post-game analysis caches and request tracking (checkpoint 3 wires these
  // to the /api/analyze endpoint).
  const analysisCache = new Map(); // fen -> { evaluation, depth, bestMove, fromBook }
  let analysisRequestToken = 0;
  let analysisAbortController = null;

  /**
   * Returns whether the current chess.js position is over.
   */
  function isGameOver() {
    return game.game_over();
  }

  /**
   * True when the local game can still be played (includes resignation,
   * which chess.js does not know about).
   */
  function isActiveGame() {
    return !gameHasEnded && !isGameOver();
  }

  /**
   * True when a human move attempt (drag or click) may be processed.
   */
  function canAcceptPlayerMove() {
    if (!isActiveGame()) {
      return false;
    }

    if (isEngineThinking) {
      return false;
    }

    if (reviewMode) {
      return false;
    }

    // The human always controls White.
    if (game.turn() !== 'w') {
      return false;
    }

    return true;
  }

  /**
   * True when clicking on a piece is allowed to start a selection.
   * (Same conditions as moving, but used before a square is chosen.)
   */
  function canSelectPieces() {
    return canAcceptPlayerMove();
  }

  // ------------------------------------------------------------------
  // Shared move handler (used by BOTH drag-and-drop and click-to-move)
  // ------------------------------------------------------------------

  /**
   * Validates and applies a player move from any input source.
   * Returns the recorded move object on success, or null on failure
   * (the position is unchanged in that case).
   *
   * Guards: game over (incl. resignation), engine thinking, review mode,
   * not the human's turn. Exactly one engine request is scheduled per
   * successful move.
   */
  function tryPlayerMove(fromSquare, toSquare, promotion) {
    if (!canAcceptPlayerMove()) {
      return null;
    }

    const requestedPromotion =
      !promotion && typeof promotion !== 'string' ? 'q' : promotion;

    const move = game.move({
      from: fromSquare,
      to: toSquare,
      promotion: requestedPromotion || 'q'
    });

    if (move === null) {
      // Illegal move: position unchanged, caller decides UI (snapback etc.)
      return null;
    }

    clearSelection();

    recordMove(move);
    checkGameEnd();
    updateStatus();

    window.setTimeout(triggerEngineMove, 150);

    return move;
  }

  // ------------------------------------------------------------------
  // chessboard.js drag handlers
  // ------------------------------------------------------------------

  /**
   * Controls whether a piece may be picked up for dragging.
   * Returning false also prevents chessboard.js from entering drag mode,
   * which keeps click-to-move and drag-and-drop from interfering.
   */
  function onDragStart(source, piece) {
    if (!canAcceptPlayerMove()) {
      return false;
    }

    if (piece.search(/^b/) !== -1) {
      return false;
    }

    // A drag of the currently selected piece clears click-selection.
    if (selectedSquare && selectedSquare !== source) {
      clearSelection();
    }

    return true;
  }

  /**
   * Drag-and-drop entry point. Delegates to the shared move handler.
   * Illegal moves must snap back.
   */
  function onDrop(source, target) {
    suppressClickUntil = Date.now() + 450;

    if (!canAcceptPlayerMove()) {
      return 'snapback';
    }

    const move = tryPlayerMove(source, target, 'q');

    if (move === null) {
      return 'snapback';
    }

    return undefined;
  }

  /**
   * Synchronizes chessboard.js with chess.js after a drag animation.
   */
  function onSnapEnd() {
    if (board) {
      board.position(game.fen());
    }
  }

  // ------------------------------------------------------------------
  // Click-to-move (delegated, single listener)
  // ------------------------------------------------------------------

  /**
   * Extracts a square name from a chessboard.js square element.
   * Uses the data-square attribute first and falls back to scanning the
   * className for a square-<name> token, so class order is irrelevant.
   */
  function extractSquare(element) {
    if (!element || element.nodeType !== 1) {
      return null;
    }

    const attr = element.getAttribute('data-square');
    if (attr && /^[a-h][1-8]$/.test(attr)) {
      return attr;
    }

    const match = /\bsquare-([a-h][1-8])\b/.exec(element.className || '');
    return match ? match[1] : null;
  }

  /**
   * Handles clicks on board squares: select / reselect / deselect / move.
   */
  function onBoardSquareClick(square) {
    if (Date.now() < suppressClickUntil) {
      return; // Part of a drag gesture that chessboard.js already handled.
    }

    if (!canSelectPieces()) {
      return;
    }

    const piece = game.get(square);

    if (selectedSquare === square) {
      // Clicking the selected square again deselects it.
      clearSelection();
      return;
    }

    if (selectedSquare) {
      const legalTargets = getLegalTargets(selectedSquare);

      if (legalTargets.indexOf(square) !== -1) {
        // Legal destination: move. The board position is updated by
        // triggerEngineMove's caller via applyPositionToBoard().
        const move = tryPlayerMove(selectedSquare, square, 'q');

        if (move !== null) {
          applyPositionToBoard();
        } else {
          clearSelection();
        }

        return;
      }

      if (piece && piece.color === 'w') {
        // Clicking another movable human piece changes the selection.
        selectSquare(square);
        return;
      }

      // Illegal destination: does not change the game state. Keep the
      // selection so the user can pick another square.
      return;
    }

    if (piece && piece.color === 'w') {
      selectSquare(square);
    }
  }

  /**
   * Returns the legal destination squares for the given square.
   * Legality is computed by chess.js only.
   */
  function getLegalTargets(square) {
    if (!square || !isActiveGame() || game.turn() !== 'w') {
      return [];
    }

    return game
      .moves({ square: square, verbose: true })
      .map(function (move) {
        return move.to;
      });
  }

  /**
   * Selects a square and (optionally) shows legal destinations.
   */
  function selectSquare(square) {
    clearSelection();
    selectedSquare = square;

    const $square = $(boardElement).find('.square-' + square);
    $square.addClass('sel-square');

    if (!showLegalMovesPref) {
      return;
    }

    const moves = game.moves({ square: square, verbose: true });

    moves.forEach(function (move) {
      const isCapture =
        move.flags.indexOf('c') !== -1 || move.flags.indexOf('e') !== -1;

      $(boardElement)
        .find('.square-' + move.to)
        .addClass(isCapture ? 'legal-capture-hint' : 'legal-move-hint');
    });
  }

  /**
   * Removes the selection and all legal-move highlight classes.
   */
  function clearSelection() {
    selectedSquare = null;

    $(boardElement).find(
      '.sel-square, .legal-move-hint, .legal-capture-hint'
    ).removeClass('sel-square legal-move-hint legal-capture-hint');
  }

  /**
   * Deselects when clicking anywhere outside the board.
   */
  function onDocumentClick(event) {
    if (!selectedSquare) {
      return;
    }

    if (boardElement && boardElement.contains(event.target)) {
      return;
    }

    clearSelection();
  }

  // Bind once. chessboard.js rebuilds square elements internally but never
  // replaces #board itself, so this delegated listener survives resizes,
  // board.start() and position updates without ever being re-created.
  $(boardElement).on(
    'click.deepchess',
    '.square-55d63',
    function (event) {
      const square = extractSquare(this);

      if (square) {
        event.preventDefault();
        onBoardSquareClick(square);
      }
    }
  );

  $(document).on('click.deepchess', onDocumentClick);

  // ------------------------------------------------------------------
  // Engine move
  // ------------------------------------------------------------------

  /**
   * Requests and applies the engine's reply.
   */
  async function triggerEngineMove() {
    if (!isActiveGame()) {
      updateStatus();
      return;
    }

    if (isEngineThinking) {
      return; // Prevent duplicate engine requests.
    }

    isEngineThinking = true;
    setThinkingState(true);
    clearSelection();

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
        checkGameEnd();
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

      // The /api/move response describes the position the engine searched
      // (the position after the player's move), so attach the data to that
      // position record rather than to the move the engine produced.
      // Capture the index BEFORE recordMove pushes the engine-result position.
      const searchedIndex = reviewRecord.positions.length - 1;

      recordMove(botMove);

      const searchedPosition = reviewRecord.positions[searchedIndex];

      if (searchedPosition) {
        searchedPosition.eval = data.eval;
        searchedPosition.depth = data.depth;
        searchedPosition.fromBook = data.from_book;
      }

      applyPositionToBoard();
      checkGameEnd();
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
   * Pushes the current chess.js position to chessboard.js.
   */
  function applyPositionToBoard() {
    if (board) {
      board.position(game.fen());
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
      $btnResign.prop('disabled', true);
    } else {
      $statusBox.removeClass('thinking');
      $btnNewGame.prop('disabled', false);
      $btnFlipBoard.prop('disabled', false);
      updateControlStates();
    }
  }

  /**
   * Detects checkmate / draw and finalizes the game record.
   */
  function checkGameEnd() {
    if (gameHasEnded) {
      return;
    }

    if (game.in_checkmate()) {
      gameHasEnded = true;
      endReason = 'checkmate';
    } else if (game.in_draw()) {
      gameHasEnded = true;
      endReason = 'draw';
    }
  }

  /**
   * Displays the current game state. No engine analysis is ever shown here.
   */
  function updateStatus() {
    if (isEngineThinking) {
      return;
    }

    if (gameHasEnded && endReason === 'resignation') {
      $statusText.text('Game Over: You resigned. Black wins.');
      $statusBox.addClass('game-over');
      updateControlStates();
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
    updateControlStates();
  }

  /**
   * Enables/disables controls according to the current state.
   */
  function updateControlStates() {
    const active = isActiveGame();

    $btnResign.prop('disabled', !active || isEngineThinking || reviewMode);
    $btnReviewGame.prop('disabled', !gameHasEnded || reviewMode);

    $btnReviewPrev.prop('disabled', !reviewMode || reviewIndex <= 0);
    $btnReviewFirst.prop('disabled', !reviewMode || reviewIndex <= 0);
    $btnReviewNext.prop(
      'disabled',
      !reviewMode || reviewIndex >= reviewRecord.moves.length
    );
    $btnReviewLast.prop(
      'disabled',
      !reviewMode || reviewIndex >= reviewRecord.moves.length
    );
    $btnReviewMovePrev.prop('disabled', !reviewMode || reviewIndex <= 0);
    $btnReviewMoveNext.prop(
      'disabled',
      !reviewMode || reviewIndex >= reviewRecord.moves.length
    );
  }

  // ------------------------------------------------------------------
  // Game record + move history rendering
  // ------------------------------------------------------------------

  /**
   * Adds a move to the client-side history and the review record.
   */
  function recordMove(move) {
    moveHistory.push(move);

    const uci =
      move.from +
      move.to +
      (move.promotion ? move.promotion : '');

    reviewRecord.moves.push({
      san: move.san,
      uci: uci,
      from: move.from,
      to: move.to,
      promotion: move.promotion || null,
      color: move.color,
      ply: reviewRecord.moves.length + 1,
      moveNumber: Math.floor(reviewRecord.moves.length / 2) + 1,
      fenAfter: game.fen()
    });

    reviewRecord.positions.push({ fen: game.fen() });

    renderMoveHistory();
  }

  /**
   * Renders complete move pairs in the history table.
   * In review mode, cells become keyboard-accessible buttons that jump to
   * the corresponding position.
   */
  function renderMoveHistory() {
    $historyBody.empty();

    const totalMoves = moveHistory.length;

    $moveCountBadge.text(
      `${totalMoves} ${totalMoves === 1 ? 'move' : 'moves'}`
    );

    for (let index = 0; index < totalMoves; index += 2) {
      const moveNumber = Math.floor(index / 2) + 1;
      const whitePly = index;
      const blackPly = index + 1;

      const $row = $('<tr>');
      $('<td>').text(`${moveNumber}.`).appendTo($row);

      $row.append(buildHistoryCell(whitePly));
      $row.append(buildHistoryCell(blackPly));

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
   * Builds one SAN cell for the history table. In review mode the cell is
   * a button so it is keyboard accessible.
   */
  function buildHistoryCell(plyIndex) {
    const record = reviewRecord.moves[plyIndex];
    const $cell = $('<td>');

    if (!record) {
      return $cell;
    }

    if (reviewMode && gameHasEnded) {
      const $button = $('<button>', {
        type: 'button',
        class: 'history-move-btn',
        'aria-label': `Review position after ${record.color === 'w' ? 'White' : 'Black'} plays ${record.san}`
      }).text(record.san);

      if (reviewIndex === plyIndex + 1) {
        $button.addClass('active');
      }

      $button.on('click', function () {
        showReviewPosition(plyIndex + 1);
      });

      $button.appendTo($cell);
    } else {
      $cell.text(record.san);
    }

    return $cell;
  }

  // ------------------------------------------------------------------
  // Review mode
  // ------------------------------------------------------------------

  /**
   * Enters review mode. The completed chess.js game is never modified;
   * review navigation only changes the displayed FEN.
   */
  function enterReviewMode() {
    if (!gameHasEnded || reviewMode) {
      return;
    }

    reviewMode = true;
    reviewIndex = reviewRecord.moves.length; // Final position.
    clearSelection();

    $reviewControls.removeAttr('hidden');
    $reviewAnalysisCard.removeAttr('hidden');

    renderMoveHistory();
    showReviewPosition(reviewIndex);
  }

  /**
   * Exits review mode and returns to the final completed position
   * (not a new active game).
   */
  function exitReviewMode() {
    if (!reviewMode) {
      return;
    }

    reviewMode = false;
    cancelPendingAnalysis();

    $reviewControls.attr('hidden', '');
    $reviewAnalysisCard.attr('hidden', '');
    $reviewAnalysisStatus.empty();

    clearSelection();
    applyPositionToBoard();
    renderMoveHistory();
    updateStatus();
  }

  /**
   * Displays a stored position by index (0 = start, N = after ply N).
   * Never calls game.move() / game.undo().
   */
  function showReviewPosition(index) {
    const maxIndex = reviewRecord.moves.length;

    if (index < 0) {
      index = 0;
    }

    if (index > maxIndex) {
      index = maxIndex;
    }

    reviewIndex = index;

    const position = reviewRecord.positions[index];
    if (position && board) {
      board.position(position.fen, false);
    }

    // Position label: "Start" or "12. Nf3" / "12... Nf6" style.
    if (index === 0) {
      $reviewPositionLabel.text('Start');
    } else {
      const move = reviewRecord.moves[index - 1];
      const prefix = move.color === 'w' ? `${move.moveNumber}.` : `${move.moveNumber}...`;
      $reviewPositionLabel.text(`${prefix} ${move.san}  (ply ${index}/${maxIndex})`);
    }

    updateControlStates();
    renderMoveHistory();
    updateReviewAnalysis();
  }

  function cancelPendingAnalysis() {
    analysisRequestToken += 1;

    if (analysisAbortController) {
      try {
        analysisAbortController.abort();
      } catch (error) {
        // Ignore abort errors.
      }
      analysisAbortController = null;
    }
  }

  /**
   * Post-game analysis for the currently displayed review position.
   * Loads and failure states never interrupt navigation.
   */
  function updateReviewAnalysis() {
    $reviewSan.text('-');
    $reviewEval.text('-');
    $reviewDepth.text('-');
    $reviewBook.text('-');
    $reviewAnalysisStatus.empty();

    if (reviewIndex === 0) {
      $reviewEval.text('0.00'); // The starting position is balanced.
      return;
    }

    const move = reviewRecord.moves[reviewIndex - 1];
    const position = reviewRecord.positions[reviewIndex];

    if (!move || !position) {
      return;
    }

    $reviewSan.text(move.san);

    // Terminal positions are resolved locally without a request.
    const terminal = analyzeTerminalPosition(position.fen);

    if (terminal) {
      $reviewEval.text(terminal);
      return;
    }

    // Prefer data captured from the engine's own search at this position.
    if (position.fromBook) {
      $reviewEval.text('0.00');
      $reviewDepth.text('Book');
      $reviewBook.text('Book move');
      return;
    }

    if (
      typeof position.eval === 'number' &&
      Number.isFinite(position.eval)
    ) {
      $reviewEval.text(formatEvaluation(position.eval));

      if (typeof position.depth === 'number') {
        $reviewDepth.text(`Depth ${position.depth}`);
      }

      $reviewBook.text('Search');
      return;
    }

    // No stored data: request a fresh analysis from /api/analyze.
    $reviewAnalysisStatus.text('Analyzing position...');
    requestAnalysis(position.fen);
  }

  /**
   * Returns a display string for terminal positions, or null.
   * Evaluation convention: positive favors White, negative favors Black.
   */
  function analyzeTerminalPosition(fen) {
    if (typeof Chess === 'undefined') {
      return null;
    }

    try {
      const probe = new Chess(fen);

      if (probe.in_checkmate()) {
        return probe.turn() === 'w' ? '0-1 (checkmate)' : '1-0 (checkmate)';
      }

      if (probe.in_draw()) {
        return '0.00 (draw)';
      }
    } catch (error) {
      // Not a parseable FEN - let the regular path handle it.
    }

    return null;
  }

  /**
   * Formats centipawns (White POV) as pawns, e.g. +1.25 / -0.40.
   */
  function formatEvaluation(centipawns) {
    const score = Number(centipawns);

    if (!Number.isFinite(score)) {
      return '-';
    }

    const pawnScore = (score / 100).toFixed(2);
    return score > 0 ? `+${pawnScore}` : pawnScore;
  }

  /**
   * Calls POST /api/analyze for a review position.
   * Each request owns a token captured after invalidating older ones, so a
   * late reply can never overwrite the UI of a different selected position.
   */
  async function requestAnalysis(fen) {
    if (analysisCache.has(fen)) {
      applyAnalysisResult(analysisCache.get(fen), fen);
      return;
    }

    cancelPendingAnalysis();

    const token = ++analysisRequestToken;
    analysisAbortController = new AbortController();
    const controller = analysisAbortController;

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          fen: fen,
          depth: 8,
          time_limit: 2.0
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Analysis failed with HTTP ${response.status}`);
      }

      const data = await response.json();

      const result = {
        evaluation: typeof data.evaluation === 'number' ? data.evaluation : null,
        depth: typeof data.depth === 'number' ? data.depth : null,
        bestMove: typeof data.best_move === 'string' ? data.best_move : null,
        fromBook: Boolean(data.from_book)
      };

      analysisCache.set(fen, result);
      applyAnalysisResult(result, fen);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return; // Superseded by a newer request.
      }

      console.error('Analysis request failed:', error);

      if (token === analysisRequestToken) {
        const current = reviewRecord.positions[reviewIndex];

        // Only show the error if the failed position is still displayed.
        if (current && current.fen === fen) {
          $reviewAnalysisStatus.text(
            'Analysis unavailable for this position.'
          );
        }
      }
    } finally {
      if (analysisAbortController === controller) {
        analysisAbortController = null;
      }
    }
  }

  /**
   * Applies an analysis result to the UI if this is still the newest request
   * and the displayed position has not changed.
   */
  function applyAnalysisResult(result, fen) {
    if (!reviewMode) {
      return;
    }

    const position = reviewRecord.positions[reviewIndex];

    if (!position || position.fen !== fen) {
      return;
    }

    if (result.fromBook) {
      $reviewEval.text('0.00');
      $reviewDepth.text('Book');
      $reviewBook.text('Book move');
    } else {
      $reviewEval.text(
        result.evaluation === null ? '-' : formatEvaluation(result.evaluation)
      );
      $reviewDepth.text(
        result.depth === null ? '-' : `Depth ${result.depth}`
      );
      $reviewBook.text('Search');
    }

    $reviewAnalysisStatus.empty();
  }

  // ------------------------------------------------------------------
  // Controls
  // ------------------------------------------------------------------

  /**
   * Resets the backend session and all local state, including review data.
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
      cancelPendingAnalysis();

      game.reset();
      moveHistory = [];
      gameHasEnded = false;
      endReason = null;
      reviewMode = false;
      reviewIndex = 0;

      reviewRecord.initialFen = game.fen();
      reviewRecord.positions = [{ fen: game.fen() }];
      reviewRecord.moves = [];
      analysisCache.clear();

      clearSelection();

      if (board) {
        board.start();
      }

      $reviewControls.attr('hidden', '');
      $reviewAnalysisCard.attr('hidden', '');
      $reviewAnalysisStatus.empty();

      renderMoveHistory();
      updateControlStates();

      $statusBox.removeClass('thinking game-over');
      $btnNewGame.prop('disabled', false);

      updateStatus();
    }
  });

  /**
   * Flips only the visual orientation. The human continues to control White.
   * Selection is cleared because square elements change position.
   */
  $btnFlipBoard.on('click', function () {
    if (!board || isEngineThinking) {
      return;
    }

    clearSelection();
    board.flip();
  });

  /**
   * Resigns after explicit confirmation. Ends the local game even though
   * chess.js considers it playable.
   */
  $btnResign.on('click', function () {
    if (!isActiveGame() || isEngineThinking || reviewMode) {
      return;
    }

    if (!window.confirm('Are you sure you want to resign this game?')) {
      return;
    }

    gameHasEnded = true;
    endReason = 'resignation';
    clearSelection();

    if (reviewRecord.moves.length === 0) {
      // No positions beyond the start; keep the record valid anyway.
    }

    updateStatus();
  });

  $btnReviewGame.on('click', function () {
    enterReviewMode();
  });

  $btnReviewExit.on('click', function () {
    exitReviewMode();
  });

  $btnReviewFirst.on('click', function () {
    showReviewPosition(0);
  });

  $btnReviewPrev.on('click', function () {
    showReviewPosition(reviewIndex - 1);
  });

  $btnReviewNext.on('click', function () {
    showReviewPosition(reviewIndex + 1);
  });

  $btnReviewLast.on('click', function () {
    showReviewPosition(reviewRecord.moves.length);
  });

  $btnReviewMovePrev.on('click', function () {
    showReviewPosition(reviewIndex - 1);
  });

  $btnReviewMoveNext.on('click', function () {
    showReviewPosition(reviewIndex + 1);
  });

  /**
   * Show-legal-moves preference: persisted to localStorage and restored on
   * load. Click-to-move works with the display on or off.
   */
  $showLegalMoves.on('change', function () {
    showLegalMovesPref = $(this).is(':checked');

    try {
      window.localStorage.setItem(
        LEGAL_MOVES_STORAGE_KEY,
        showLegalMovesPref ? 'true' : 'false'
      );
    } catch (error) {
      // Ignore storage failures (private browsing etc.).
    }

    if (selectedSquare) {
      selectSquare(selectedSquare); // Re-render highlights for the current selection.
    }
  });

  // ------------------------------------------------------------------
  // Board initialization
  // ------------------------------------------------------------------

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

    const failureElement = document.getElementById('board');

    if (failureElement) {
      failureElement.innerHTML =
        '<p style="color: #ef4444; padding: 2rem; text-align: center;"></p>';
      failureElement.querySelector('p').textContent =
        'Chessboard initialization failed. Check the browser console.';
    }

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
  updateControlStates();
  updateStatus();
});
