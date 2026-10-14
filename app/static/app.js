/**
 * DeepChess client-side application.
 * Connects chessboard.js (v1.0.0) and chess.js (0.10.x) to the FastAPI backend.
 *
 * Architecture notes:
 * - All UI state lives in a single `state` object; every state transition
 *   goes through helper functions (finishGame, enterReview, exitReview,
 *   resetGameState) and ends with updateControls().
 * - Drag-and-drop and click-to-move share one move path: tryPlayerMove().
 * - Board listeners are namespaced and bound idempotently (off then on),
 *   so re-initialization can never create duplicate handlers.
 * - Live engine analysis is never rendered during an active game; engine
 *   data is stored for post-game review only.
 * - Game endings are surfaced by two in-app overlays instead of native
 *   dialogs: the game-ended screen (finishGame -> showGameOverModal) and the
 *   resign confirmation ($btnResign -> openResignModal).
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
      // Static, application-owned message; contains no untrusted input.
      boardElement.innerHTML =
        '<p style="color: #ef4444; padding: 2rem; text-align: center;"></p>';
      boardElement.querySelector('p').textContent = message;
    }

    return;
  }

  // ------------------------------------------------------------------
  // Centralized DOM references
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
  const $btnResignConfirm = $('#btnResignConfirm');
  const $btnResignCancel = $('#btnResignCancel');
  const $resignOverlay = $('#resignOverlay');
  const $gameOverOverlay = $('#gameOverOverlay');
  const $gameOverIcon = $('#gameOverIcon');
  const $gameOverTitle = $('#gameOverTitle');
  const $gameOverResult = $('#gameOverResult');
  const $gameOverCode = $('#gameOverCode');
  const $gameOverDetail = $('#gameOverDetail');
  const $btnGameOverReview = $('#btnGameOverReview');
  const $btnGameOverNew = $('#btnGameOverNew');
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
  // Centralized state model
  // ------------------------------------------------------------------
  const state = {
    engineThinking: false,       // an /api/move request is in flight
    gameFinished: false,         // application-level result (includes resignation)
    finishReason: null,          // 'checkmate' | 'draw' | 'resignation' | null
    serverResult: null,          // '1-0' | '0-1' | '1/2-1/2' when the backend reported the ending
    reviewMode: false,           // read-only review navigation active
    currentReviewIndex: 0,       // 0 = start position, N = after ply N
    selectedSquare: null,        // click-to-move selection
    showLegalMoves: true         // user preference (persisted)
  };

  // Set when a drag actually travels to a DIFFERENT square so the click
  // handler ignores the mouseup/click event browsers fire after a real drag.
  // A click that mouses down and releases on the same square is a genuine
  // click (selection / deselect), so it must NOT be suppressed.
  let suppressClickUntil = 0;

  /**
   * Marks the just-finished gesture as a real drag (mouseup on a square
   * different from the mousedown square). Its trailing click is ignored.
   */
  function suppressNextClick() {
    suppressClickUntil = Date.now() + 450;
  }

  // ------------------------------------------------------------------
  // chessboard.js drag-avatar click interception
  //
  // chessboard.js v1.0.0 starts a drag on EVERY mousedown over an occupied
  // square (no movement threshold). During the gesture it appends a
  // floating avatar <img> to <body>, positioned under the cursor. For a
  // plain click (no movement) that avatar intercepts the mouseup, so the
  // browser retargets the resulting click event to <body> (the nearest
  // common ancestor of the mousedown and mouseup targets) and it never
  // reaches #board — silently killing click-to-move and selection.
  //
  // The avatar is purely visual: chessboard.js computes drop squares from
  // pageX/pageY coordinates only and never hit-tests the avatar, so making
  // it transparent to hit-testing restores the correct click target
  // without affecting drag-and-drop. CSS animations (transform) do not
  // participate in hit-testing, so no transition can reintroduce it.
  // ------------------------------------------------------------------
  const dragAvatarStyle = document.createElement('style');
  dragAvatarStyle.id = 'drag-avatar-style';
  dragAvatarStyle.textContent =
    'body > img[data-piece] { pointer-events: none !important; }';
  document.head.appendChild(dragAvatarStyle);

  // Legal-move display preference persistence.
  const LEGAL_MOVES_STORAGE_KEY = 'deepchess.showLegalMoves';

  try {
    const stored = window.localStorage.getItem(LEGAL_MOVES_STORAGE_KEY);
    if (stored === 'true') {
      state.showLegalMoves = true;
    } else if (stored === 'false') {
      state.showLegalMoves = false;
    }
  } catch (error) {
    // localStorage unavailable (private mode etc.) - keep the default.
  }

  $showLegalMoves.prop('checked', state.showLegalMoves);

  // ------------------------------------------------------------------
  // Game history (for post-game review)
  // ------------------------------------------------------------------
  const game = new Chess();
  let moveHistory = [];

  // gameHistory.initialFen : starting FEN of the game
  // gameHistory.positions[i] : { fen, eval?, depth?, fromBook? } for
  //   i = 0 (start) .. plyCount. eval/depth/fromBook describe the engine
  //   search performed AT that position (present only when the engine
  //   searched or answered from book there).
  // gameHistory.moves[i] : metadata for the move that produced
  //   positions[i + 1]:
  //   { san, uci, from, to, promotion, color, ply, moveNumber, fenAfter }
  // UCI is always built from from/to/promotion, never inferred from SAN.
  const gameHistory = createEmptyGameHistory();

  // Post-game analysis cache: fen -> { evaluation, depth, bestMove, fromBook }
  const reviewAnalysisCache = new Map();
  let analysisRequestToken = 0;
  let analysisAbortController = null;

  function createEmptyGameHistory() {
    return {
      initialFen: game.fen(),
      positions: [{ fen: game.fen() }],
      moves: []
    };
  }

  // ------------------------------------------------------------------
  // Centralized state queries and transitions
  // ------------------------------------------------------------------

  /**
   * True only when the human may currently make a move (drag or click).
   */
  function canHumanMove() {
    return (
      !state.engineThinking &&
      !state.gameFinished &&
      !state.reviewMode &&
      !game.game_over() &&
      game.turn() === 'w' // the human always controls White
    );
  }

  /**
   * Records an application-level game result. chess.js cannot know about
   * resignations, so this is the single authority for "game over".
   *
   * `options.result` is the optional result code reported by the backend
   * ('1-0', '0-1', '1/2-1/2'); it is only used to label endings chess.js
   * cannot classify itself.
   */
  function finishGame(reason, options) {
    if (state.gameFinished) {
      return;
    }

    const details = options || {};

    state.gameFinished = true;
    state.finishReason = reason;
    state.serverResult = details.result || null;

    clearSelectionAndHighlights();
    updateStatus();
    updateControls();
    showGameOverModal();
  }

  /**
   * Detects chess.js-native endings and routes them through finishGame.
   */
  function syncFinishFromBoard() {
    if (state.gameFinished) {
      return;
    }

    if (game.in_checkmate()) {
      finishGame('checkmate');
    } else if (game.in_draw()) {
      finishGame('draw');
    }
  }

  // ------------------------------------------------------------------
  // Game-ending description (single source of truth)
  //
  // Both the sidebar status box and the game-ended modal render from this
  // description, so the termination reason can never disagree between them.
  // chess.js is the authority for the ending; the optional result code the
  // backend returned is used to label endings chess.js cannot classify
  // itself (seventy-five-move rule / fivefold repetition).
  // ------------------------------------------------------------------

  const RESULT_CODE_LABELS = {
    '1-0': 'White wins',
    '0-1': 'Black wins',
    '1/2-1/2': 'Draw'
  };

  function describeResultCode(code) {
    return (code && RESULT_CODE_LABELS[code]) || null;
  }

  /**
   * Halfmove clock (5th FEN field). chess.js only exposes the fifty-move rule
   * through in_draw(), so the clock is read directly to tell that draw apart
   * from stalemate, repetition, and insufficient material.
   */
  function halfmoveClock() {
    const fields = game.fen().split(' ');
    const clock = parseInt(fields[4], 10);

    return Number.isFinite(clock) ? clock : 0;
  }

  /**
   * Returns { title, result, code, detail, statusLine, icon, tone } for the
   * finished game. Only called once state.gameFinished is true.
   */
  function getGameEndDetails() {
    if (state.finishReason === 'resignation') {
      return {
        title: 'You resigned',
        result: 'Black wins',
        code: state.serverResult,
        detail: 'You resigned the game, so Black is declared the winner. The position on the board is no longer playable.',
        statusLine: 'You resigned \u2014 Black wins.',
        icon: 'fa-solid fa-flag',
        tone: 'resigned'
      };
    }

    if (game.in_checkmate()) {
      // The side to move is the side that has been checkmated.
      const mated = game.turn() === 'w' ? 'White' : 'Black';
      const winner = mated === 'White' ? 'Black' : 'White';

      return {
        title: 'Checkmate',
        result: `${winner} wins`,
        code: state.serverResult,
        detail: `Checkmate: ${mated} is in check and has no legal move left. ${winner} wins the game.`,
        statusLine: `Checkmate \u2014 ${winner} wins.`,
        icon: 'fa-solid fa-chess-king',
        tone: 'checkmate'
      };
    }

    if (game.in_stalemate()) {
      return {
        title: 'Stalemate',
        result: 'Draw',
        code: state.serverResult,
        detail: 'Draw by stalemate: no legal moves remain and the side to move is not in check.',
        statusLine: 'Stalemate \u2014 the position is a draw.',
        icon: 'fa-solid fa-handshake',
        tone: 'draw'
      };
    }

    if (game.insufficient_material()) {
      return {
        title: 'Draw',
        result: 'Draw',
        code: state.serverResult,
        detail: 'Draw by insufficient material: neither side has enough material left to deliver checkmate.',
        statusLine: 'Draw by insufficient material.',
        icon: 'fa-solid fa-handshake',
        tone: 'draw'
      };
    }

    if (game.in_threefold_repetition()) {
      return {
        title: 'Draw',
        result: 'Draw',
        code: state.serverResult,
        detail: 'Draw by threefold repetition: the same position has occurred three times.',
        statusLine: 'Draw by threefold repetition.',
        icon: 'fa-solid fa-handshake',
        tone: 'draw'
      };
    }

    if (halfmoveClock() >= 100) {
      return {
        title: 'Draw',
        result: 'Draw',
        code: state.serverResult,
        detail: 'Draw by the fifty-move rule: 50 moves passed without a pawn move or a capture.',
        statusLine: 'Draw by the fifty-move rule.',
        icon: 'fa-solid fa-handshake',
        tone: 'draw'
      };
    }

    // The backend ended the game on a rule this chess.js build does not model
    // (seventy-five-move rule / fivefold repetition); its result code is the
    // only precise information available.
    return {
      title: 'Game Over',
      result: describeResultCode(state.serverResult) || 'Game over',
      code: state.serverResult,
      detail: 'The game is over by rule: the position is terminal, so no further moves can be played from it.',
      statusLine: 'the game is over by rule.',
      icon: 'fa-solid fa-flag-checkered',
      tone: 'draw'
    };
  }

  // ------------------------------------------------------------------
  // Modal overlays (game-ended screen + resign confirmation)
  //
  // Both overlays are plain DOM (no native alert/confirm), keyboard
  // reachable: opening one moves focus inside it, Tab is trapped between its
  // controls, and closing restores focus to the control that opened it.
  // ------------------------------------------------------------------

  const FOCUSABLE_SELECTOR =
    'button:not([disabled]), [href], input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), ' +
    '[tabindex]:not([tabindex="-1"])';

  let modalRestoreFocus = null;

  function isModalOpen($overlay) {
    return $overlay.attr('data-open') === 'true';
  }

  function anyModalOpen() {
    return $('.modal-overlay[data-open]').length > 0;
  }

  function openModal($overlay, $initialFocus) {
    modalRestoreFocus = document.activeElement;

    $overlay.removeAttr('hidden');
    $overlay.attr('data-open', 'true');
    document.body.classList.add('modal-open');

    const $focusTarget =
      $initialFocus && $initialFocus.length
        ? $initialFocus
        : $overlay.find(FOCUSABLE_SELECTOR).first();

    $focusTarget.trigger('focus');
  }

  /**
   * Hides the overlay. Focus returns to the element that opened it when
   * `restoreFocus` is true (the game-ended overlay has no trigger element).
   */
  function closeModal($overlay, restoreFocus) {
    $overlay.attr('hidden', '');
    $overlay.removeAttr('data-open');

    if (!anyModalOpen()) {
      document.body.classList.remove('modal-open');
    }

    if (restoreFocus && modalRestoreFocus && document.contains(modalRestoreFocus)) {
      modalRestoreFocus.focus();
    }

    modalRestoreFocus = null;
  }

  /**
   * Keeps Tab focus cycling inside the open dialog.
   */
  function trapModalFocus(event, $overlay) {
    if (event.key !== 'Tab') {
      return;
    }

    const $focusable = $overlay.find(FOCUSABLE_SELECTOR).filter(':visible');

    if ($focusable.length === 0) {
      return;
    }

    const first = $focusable.get(0);
    const last = $focusable.get($focusable.length - 1);

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Renders and shows the game-ended screen. Called exactly once per game by
   * finishGame(); exitReview() restores it after a review session.
   */
  function showGameOverModal() {
    const details = getGameEndDetails();

    // Icon markup is built from internal constants only (never user input).
    $gameOverIcon.attr('class', `modal-icon modal-icon-${details.tone}`);
    $gameOverIcon.html(`<i class="${details.icon}" aria-hidden="true"></i>`);

    $gameOverTitle.text(details.title);
    $gameOverResult.text(details.result);

    if (details.code) {
      $gameOverCode.text(details.code).removeAttr('hidden');
    } else {
      $gameOverCode.text('').attr('hidden', '');
    }

    $gameOverDetail.text(details.detail);

    // Review is offered only for a game that reached its end on the board:
    // a resigned game has no continuation to step through, and a game with no
    // recorded move has nothing to review. Either way the button is removed
    // from the screen (not merely disabled) so the ending offers New Game only.
    const reviewPossible =
      state.finishReason !== 'resignation' && gameHistory.moves.length > 0;

    $btnGameOverReview.prop('disabled', !reviewPossible);

    if (reviewPossible) {
      $btnGameOverReview.removeAttr('hidden');
    } else {
      $btnGameOverReview.attr('hidden', '');
    }

    openModal(
      $gameOverOverlay,
      $btnGameOverReview.prop('disabled') ? $btnGameOverNew : $btnGameOverReview
    );
  }

  function closeGameOverModal() {
    closeModal($gameOverOverlay, false);
  }

  function openResignModal() {
    openModal($resignOverlay, $btnResignConfirm);
  }

  function closeResignModal() {
    closeModal($resignOverlay, true);
  }

  function cancelResign() {
    closeResignModal();
  }

  /**
   * Escaping the resign confirmation cancels it. The game-ended screen has no
   * dismiss action: the player must either review the game or start a new one.
   */
  $(document).on('keydown.modals', function (event) {
    if (isModalOpen($resignOverlay)) {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelResign();
        return;
      }

      trapModalFocus(event, $resignOverlay);
      return;
    }

    if (isModalOpen($gameOverOverlay)) {
      trapModalFocus(event, $gameOverOverlay);
    }
  });

  /**
   * Enters review mode at the given index. The completed chess.js game is
   * never modified; review navigation only changes the displayed FEN.
   */
  function enterReview(index) {
    if (!state.gameFinished || state.reviewMode) {
      return;
    }

    state.reviewMode = true;
    state.currentReviewIndex = clampReviewIndex(index);

    clearSelectionAndHighlights();

    $reviewControls.removeAttr('hidden');
    $reviewAnalysisCard.removeAttr('hidden');

    renderMoveHistory();
    showReviewPosition(state.currentReviewIndex);
  }

  /**
   * Exits review mode and returns to the final completed position
   * (not a new active game).
   */
  function exitReview() {
    if (!state.reviewMode) {
      return;
    }

    state.reviewMode = false;
    cancelPendingAnalysis();

    $reviewControls.attr('hidden', '');
    $reviewAnalysisCard.attr('hidden', '');
    $reviewAnalysisStatus.empty();

    clearSelectionAndHighlights();
    applyPositionToBoard();
    renderMoveHistory();
    updateStatus();
    updateControls();

    // The game-ended screen is the only way back into review, so it is
    // restored when the review session ends (the board is still the final
    // completed position, never a new playable game).
    if (state.gameFinished) {
      showGameOverModal();
    }
  }

  /**
   * Clears all game, history, and review state for a fresh game.
   */
  function resetGameState() {
    cancelPendingAnalysis();

    game.reset();
    moveHistory = [];

    state.gameFinished = false;
    state.finishReason = null;
    state.serverResult = null;
    state.reviewMode = false;
    state.currentReviewIndex = 0;
    state.selectedSquare = null;

    gameHistory.initialFen = game.fen();
    gameHistory.positions = [{ fen: game.fen() }];
    gameHistory.moves = [];
    reviewAnalysisCache.clear();

    if (board) {
      board.start();
    }

    closeGameOverModal();
    closeResignModal();

    $reviewControls.attr('hidden', '');
    $reviewAnalysisCard.attr('hidden', '');
    $reviewAnalysisStatus.empty();

    renderMoveHistory();
    updateStatus();
    updateControls();
  }

  /**
   * Single source of truth for every control's enabled/disabled state.
   * Called after every relevant state transition.
   */
  function updateControls() {
    const canMove = canHumanMove();
    const maxIndex = gameHistory.moves.length;
    const atStart = state.currentReviewIndex <= 0;
    const atEnd = state.currentReviewIndex >= maxIndex;
    const inReview = state.reviewMode;

    $btnNewGame.prop('disabled', state.engineThinking);
    $btnFlipBoard.prop('disabled', state.engineThinking);
    $btnResign.prop('disabled', !canMove);

    $btnReviewFirst.prop('disabled', !inReview || atStart);
    $btnReviewPrev.prop('disabled', !inReview || atStart);
    $btnReviewMovePrev.prop('disabled', !inReview || atStart);
    $btnReviewNext.prop('disabled', !inReview || atEnd);
    $btnReviewLast.prop('disabled', !inReview || atEnd);
    $btnReviewMoveNext.prop('disabled', !inReview || atEnd);
  }

  function clampReviewIndex(index) {
    const maxIndex = gameHistory.moves.length;

    if (index < 0) {
      return 0;
    }

    if (index > maxIndex) {
      return maxIndex;
    }

    return index;
  }

  // ------------------------------------------------------------------
  // Shared move handler (used by BOTH drag-and-drop and click-to-move)
  // ------------------------------------------------------------------

  /**
   * Validates and applies a player move from any input source.
   * Returns the recorded move object on success, or null on failure
   * (the position is unchanged in that case).
   */
  function tryPlayerMove(fromSquare, toSquare, promotion) {
    if (!canHumanMove()) {
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
      // Illegal move: position unchanged; caller decides UI (snapback etc.)
      return null;
    }

    clearSelectionAndHighlights();

    recordMove(move);
    syncFinishFromBoard();
    updateStatus();
    updateControls();

    window.setTimeout(triggerEngineMove, 150);

    return move;
  }

  // ------------------------------------------------------------------
  // chessboard.js drag handlers
  // ------------------------------------------------------------------

  /**
   * Controls whether a piece may be picked up for dragging. Returning false
   * also prevents chessboard.js from entering drag mode at all.
   */
  function onDragStart(source, piece) {
    if (!canHumanMove()) {
      return false;
    }

    if (piece.search(/^b/) !== -1) {
      return false;
    }

    // Dragging a different piece than the one selected clears selection.
    if (state.selectedSquare && state.selectedSquare !== source) {
      clearSelectionAndHighlights();
    }

    return true;
  }

  /**
   * Drag-and-drop entry point. Delegates to the shared move handler.
   * Illegal moves must snap back.
   */
  function onDrop(source, target) {
    // A drop on a DIFFERENT square is a completed drag; its trailing click
    // must be suppressed. A same-square drop is a plain click (select or
    // deselect) and must stay enabled for the click handler.
    if (source !== target) {
      suppressNextClick();
    }

    if (!canHumanMove()) {
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
  // Click-to-move (single, idempotent, delegated listener)
  // ------------------------------------------------------------------

  /**
   * Extracts a square name from a chessboard.js square element.
   * Resolves real click targets robustly from piece images, notation divs,
   * and squares, so class order and target nesting are irrelevant.
   */
  function getSquareFromEvent(event) {
    const target =
      event.target instanceof Element
        ? event.target.closest('[class*="square-"]')
        : null;

    if (!target || !boardElement.contains(target)) {
      return null;
    }

    for (const className of target.classList) {
      const match = /^square-([a-h][1-8])$/.exec(className);

      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Handles clicks anywhere inside #board. The actual click target may be
   * a piece image, a notation div, or the square itself, so the square is
   * resolved with closest('.square-55d63').
   */
  function handleSquareClick(event) {
    const square = getSquareFromEvent(event);

    if (!square) {
      return;
    }

    if (Date.now() < suppressClickUntil) {
      return; // Trailing click of a completed drag gesture.
    }

    if (!canHumanMove()) {
      return;
    }

    onSquareActivated(square);
  }

  /**
   * Selection / move logic for an activated square.
   */
  function onSquareActivated(square) {
    const piece = game.get(square);

    if (state.selectedSquare === square) {
      // Clicking the selected square again deselects it.
      clearSelectionAndHighlights();
      return;
    }

    if (state.selectedSquare) {
      const legalTargets = getLegalTargets(state.selectedSquare);

      if (legalTargets.indexOf(square) !== -1) {
        // Legal destination: move.
        const move = tryPlayerMove(state.selectedSquare, square, 'q');

        if (move !== null) {
          applyPositionToBoard();
        } else {
          clearSelectionAndHighlights();
        }

        return;
      }

      if (piece && piece.color === 'w') {
        // Clicking another movable human piece changes the selection.
        selectSquare(square);
        return;
      }

      // Illegal destination: game state unchanged; keep the selection.
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
    if (!square || !canHumanMove()) {
      return [];
    }

    return game
      .moves({ square: square, verbose: true })
      .map(function (move) {
        return move.to;
      });
  }

  /**
   * Applies selection + legal-destination highlight classes for the
   * current selection.
   */
  function renderSelection() {
    if (!state.selectedSquare) {
      return;
    }

    $(boardElement).find('.square-' + state.selectedSquare)
      .addClass('sel-square');

    if (!state.showLegalMoves) {
      return;
    }

    const moves = game.moves({
      square: state.selectedSquare,
      verbose: true
    });

    moves.forEach(function (move) {
      const isCapture =
        move.flags.indexOf('c') !== -1 || move.flags.indexOf('e') !== -1;

      $(boardElement)
        .find('.square-' + move.to)
        .addClass(isCapture ? 'legal-capture-hint' : 'legal-move-hint');
    });
  }

  /**
   * Selects a square and (optionally) shows legal destinations.
   */
  function selectSquare(square) {
    clearSelectionAndHighlights();
    state.selectedSquare = square;
    renderSelection();
  }

  /**
   * Removes the selection and every selection/highlight class.
   */
  function clearSelectionAndHighlights() {
    state.selectedSquare = null;

    $(boardElement).find(
      '.sel-square, .legal-move-hint, .legal-capture-hint'
    ).removeClass('sel-square legal-move-hint legal-capture-hint');
  }

  /**
   * Deselects when clicking anywhere outside the board.
   */
  function onDocumentClick(event) {
    if (!state.selectedSquare) {
      return;
    }

    if (boardElement && boardElement.contains(event.target)) {
      return;
    }

    clearSelectionAndHighlights();
  }

  // Bind exactly once, idempotently. .off() removes any previous namespaced
  // handler before .on() adds it, so double initialization is impossible.
  // The listener lives on the stable #board container (never recreated by
  // chessboard.js resize/position/flip) and resolves the real target with
  // closest(), so clicks on piece images work too.
  $('#board')
    .off('click.chessMove')
    .on('click.chessMove', handleSquareClick);

  $(document)
    .off('click.chessDeselect')
    .on('click.chessDeselect', onDocumentClick);

  // ------------------------------------------------------------------
  // Engine move
  // ------------------------------------------------------------------

  /**
   * Requests and applies the engine's reply.
   */
  async function triggerEngineMove() {
    if (state.gameFinished || game.game_over()) {
      updateStatus();
      return;
    }

    if (state.engineThinking) {
      return; // Prevent duplicate engine requests.
    }

    state.engineThinking = true;
    setThinkingState(true);
    clearSelectionAndHighlights();
    updateControls();

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

      if (state.gameFinished) {
        // The user resigned (or the game otherwise ended) while this request
        // was in flight; the reply must not be applied to a finished game.
        return;
      }

      if (data.is_game_over) {
        syncFinishFromBoard();

        // python-chess also ends the game on the seventy-five-move rule and
        // fivefold repetition, which this chess.js build does not model. Trust
        // the server's verdict (and use its result code) in that case.
        if (!state.gameFinished) {
          finishGame('draw', { result: data.result });
        }

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
      // (the position after the player's move). Capture the index BEFORE
      // recordMove pushes the engine-result position.
      const searchedIndex = gameHistory.positions.length - 1;

      recordMove(botMove);

      const searchedPosition = gameHistory.positions[searchedIndex];

      if (searchedPosition) {
        searchedPosition.eval = data.eval;
        searchedPosition.depth = data.depth;
        searchedPosition.fromBook = data.from_book;
      }

      applyPositionToBoard();
      syncFinishFromBoard();
    } catch (error) {
      console.error('Failed to get bot move:', error);
      $statusText.text(
        'Could not get a move from the chess server. Please start a new game or try again.'
      );
    } finally {
      state.engineThinking = false;
      setThinkingState(false);
      updateStatus();
      updateControls();
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
   * Updates the status UI while the engine is calculating.
   */
  function setThinkingState(isThinking) {
    if (isThinking) {
      $statusBox.addClass('thinking');
      $statusText.text('Bot is calculating the best move...');
    } else {
      $statusBox.removeClass('thinking');
    }
    // Enable/disable states are owned exclusively by updateControls().
  }

  /**
   * Displays the current game state. No engine analysis is ever shown here.
   * Finished games are described by getGameEndDetails(), the same source the
   * game-ended screen renders from.
   */
  function updateStatus() {
    if (state.engineThinking) {
      return;
    }

    if (state.gameFinished) {
      const details = getGameEndDetails();

      $statusText.text(`Game Over: ${details.statusLine}`);
      $statusBox.addClass('game-over');
      return;
    }

    const moveColor = game.turn() === 'w' ? 'White' : 'Black';
    let status;

    if (game.in_check()) {
      status = `${moveColor} to move. Check!`;
    } else {
      status = `${moveColor} to move.`;
    }

    $statusBox.removeClass('game-over');
    $statusText.text(status);
  }

  // ------------------------------------------------------------------
  // Game history + move history rendering
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

    gameHistory.moves.push({
      san: move.san,
      uci: uci,
      from: move.from,
      to: move.to,
      promotion: move.promotion || null,
      color: move.color,
      ply: gameHistory.moves.length + 1,
      moveNumber: Math.floor(gameHistory.moves.length / 2) + 1,
      fenAfter: game.fen()
    });

    gameHistory.positions.push({ fen: game.fen() });

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
    const record = gameHistory.moves[plyIndex];
    const $cell = $('<td>');

    if (!record) {
      return $cell;
    }

    if (state.reviewMode && state.gameFinished) {
      const $button = $('<button>', {
        type: 'button',
        class: 'history-move-btn',
        'aria-label': `Review position after ${record.color === 'w' ? 'White' : 'Black'} plays ${record.san}`
      }).text(record.san);

      if (state.currentReviewIndex === plyIndex + 1) {
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
  // Review navigation and analysis
  // ------------------------------------------------------------------

  /**
   * Displays a stored position by index (0 = start, N = after ply N).
   * Never calls game.move() / game.undo().
   */
  function showReviewPosition(index) {
    state.currentReviewIndex = clampReviewIndex(index);

    const position = gameHistory.positions[state.currentReviewIndex];

    if (position && board) {
      board.position(position.fen, false);
    }

    // Position label: "Start" or "12. Nf3" / "12... Nf6" style.
    if (state.currentReviewIndex === 0) {
      $reviewPositionLabel.text('Start');
    } else {
      const move = gameHistory.moves[state.currentReviewIndex - 1];
      const prefix =
        move.color === 'w'
          ? `${move.moveNumber}.`
          : `${move.moveNumber}...`;

      $reviewPositionLabel.text(
        `${prefix} ${move.san}  (ply ${state.currentReviewIndex}/${gameHistory.moves.length})`
      );
    }

    updateControls();
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

    if (state.currentReviewIndex === 0) {
      $reviewEval.text('0.00'); // The starting position is balanced.
      return;
    }

    const move = gameHistory.moves[state.currentReviewIndex - 1];
    const position = gameHistory.positions[state.currentReviewIndex];

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
    if (reviewAnalysisCache.has(fen)) {
      applyAnalysisResult(reviewAnalysisCache.get(fen), fen);
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

      reviewAnalysisCache.set(fen, result);
      applyAnalysisResult(result, fen);
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return; // Superseded by a newer request.
      }

      console.error('Analysis request failed:', error);

      if (token === analysisRequestToken) {
        const current = gameHistory.positions[state.currentReviewIndex];

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
   * Applies an analysis result to the UI if the displayed position still
   * matches the analyzed one.
   */
  function applyAnalysisResult(result, fen) {
    if (!state.reviewMode) {
      return;
    }

    const position = gameHistory.positions[state.currentReviewIndex];

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
    if (state.engineThinking) {
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
      resetGameState();
      $btnNewGame.prop('disabled', false);
    }
  });

  /**
   * Flips only the visual orientation. The human continues to control White.
   * Selection is cleared because square elements change position.
   */
  $btnFlipBoard.on('click', function () {
    if (!board || state.engineThinking) {
      return;
    }

    clearSelectionAndHighlights();
    board.flip();
  });

  /**
   * Opens the in-app resign confirmation. The game only ends after the
   * confirmation is accepted ($btnResignConfirm); declining leaves the game
   * untouched. Replaces the previous native browser confirmation dialog.
   */
  $btnResign.on('click', function () {
    if (!canHumanMove()) {
      return;
    }

    openResignModal();
  });

  $btnResignCancel.on('click', function () {
    cancelResign();
  });

  /**
   * Confirms the resignation: the game ends immediately, the game-ended
   * screen takes over, and Black is declared the winner.
   */
  $btnResignConfirm.on('click', function () {
    closeResignModal();
    finishGame('resignation');
  });

  /**
   * Game-ended screen actions. "Review Game" is the only entry point into
   * review mode now that the sidebar button is gone.
   */
  $btnGameOverReview.on('click', function () {
    if ($btnGameOverReview.prop('disabled')) {
      return;
    }

    closeGameOverModal();
    enterReview(gameHistory.moves.length);
  });

  $btnGameOverNew.on('click', function () {
    closeGameOverModal();
    $btnNewGame.trigger('click');
  });

  $btnReviewExit.on('click', function () {
    exitReview();
  });

  $btnReviewFirst.on('click', function () {
    showReviewPosition(0);
  });

  $btnReviewPrev.on('click', function () {
    showReviewPosition(state.currentReviewIndex - 1);
  });

  $btnReviewNext.on('click', function () {
    showReviewPosition(state.currentReviewIndex + 1);
  });

  $btnReviewLast.on('click', function () {
    showReviewPosition(gameHistory.moves.length);
  });

  $btnReviewMovePrev.on('click', function () {
    showReviewPosition(state.currentReviewIndex - 1);
  });

  $btnReviewMoveNext.on('click', function () {
    showReviewPosition(state.currentReviewIndex + 1);
  });

  /**
   * Show-legal-moves preference: persisted to localStorage and restored on
   * load. Click-to-move works with the display on or off.
   */
  $showLegalMoves.on('change', function () {
    state.showLegalMoves = $(this).is(':checked');

    try {
      window.localStorage.setItem(
        LEGAL_MOVES_STORAGE_KEY,
        state.showLegalMoves ? 'true' : 'false'
      );
    } catch (error) {
      // Ignore storage failures (private browsing etc.).
    }

    if (state.selectedSquare) {
      clearSelectionAndHighlights();
      renderSelection(); // Re-render highlights for the current selection.
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
  updateControls();
  updateStatus();
});
