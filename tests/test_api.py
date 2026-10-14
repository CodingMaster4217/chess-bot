"""
Lightweight API tests for the chess bot FastAPI backend.

Requires the project dependencies (fastapi, python-chess) and pytest.
Run from the project root with the project venv:

    .venv/Scripts/python.exe -m pytest tests/ -v
"""

import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chess
import pytest
from fastapi.testclient import TestClient

from app import main as app_main
from app.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
AFTER_E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"
MIDDLEGAME_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 3"
CASTLED_FEN = "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 1"
KIWIPETE_FEN = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"

# The engine honours its own deadline within +0.15 s (see tests/test_engine.py);
# this allowance additionally covers HTTP/JSON overhead and thread-pool
# scheduling (`def` endpoints run in a worker thread).
API_TIME_TOLERANCE = 0.6
CONCURRENT_API_TOLERANCE = 3.0


class TestHealth:
    def test_health_returns_healthy(self, client):
        response = client.get("/health")

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "healthy"
        assert isinstance(body["tt_size"], int)
        assert isinstance(body["book_available"], bool)


class TestMoveEndpoint:
    def test_move_from_starting_position(self, client):
        response = client.post(
            "/api/move",
            json={"fen": START_FEN, "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 200
        body = response.json()
        assert set(body) >= {"move", "from_book", "eval", "depth", "is_game_over"}
        assert body["is_game_over"] is False
        assert len(body["move"]) >= 4  # UCI coordinate move

    def test_move_with_invalid_fen_returns_400(self, client):
        response = client.post(
            "/api/move",
            json={"fen": "not a fen", "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 400
        assert "Invalid FEN" in response.json()["detail"]

    def test_move_on_terminal_position_reports_game_over(self, client):
        # Fool's mate: black has delivered checkmate.
        checkmate_fen = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
        response = client.post(
            "/api/move",
            json={"fen": checkmate_fen, "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["is_game_over"] is True
        assert body["move"] == ""

    def test_move_depth_out_of_range_is_422(self, client):
        response = client.post(
            "/api/move",
            json={"fen": START_FEN, "depth": 99, "time_limit": 1.0},
        )

        assert response.status_code == 422


class TestResetEndpoint:
    def test_reset_returns_ok(self, client):
        response = client.post("/api/reset")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"


class TestAnalyzeEndpoint:
    def test_analyze_non_terminal_position(self, client):
        response = client.post(
            "/api/analyze",
            json={"fen": AFTER_E4_FEN, "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 200
        body = response.json()
        assert set(body) >= {"evaluation", "depth", "best_move", "from_book"}
        assert isinstance(body["evaluation"], int)
        assert isinstance(body["depth"], int)
        assert isinstance(body["from_book"], bool)
        assert body["best_move"] is None or isinstance(body["best_move"], str)

    def test_analyze_white_checkmate_is_winning_for_white(self, client):
        # Scholar's Mate: Black to move has been checkmated by Qxf7#.
        white_mated_black = "r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4"
        response = client.post(
            "/api/analyze",
            json={"fen": white_mated_black, "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["best_move"] is None
        # Positive evaluation favors White.
        assert body["evaluation"] > 0

    def test_analyze_black_checkmate_is_winning_for_black(self, client):
        # Fool's mate: White to move has been checkmated.
        black_mated_white = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"
        response = client.post(
            "/api/analyze",
            json={"fen": black_mated_white, "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["best_move"] is None
        # Negative evaluation favors Black.
        assert body["evaluation"] < 0

    def test_analyze_draw_scores_zero(self, client):
        # Stalemate: Black to move has no legal move and is not in check.
        stalemate_fen = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"
        response = client.post(
            "/api/analyze",
            json={"fen": stalemate_fen, "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["evaluation"] == 0
        assert body["best_move"] is None

    def test_analyze_invalid_fen_returns_422(self, client):
        response = client.post(
            "/api/analyze",
            json={"fen": "definitely not a fen", "depth": 2, "time_limit": 1.0},
        )

        assert response.status_code == 422

    def test_analyze_depth_out_of_range_is_422(self, client):
        response = client.post(
            "/api/analyze",
            json={"fen": AFTER_E4_FEN, "depth": 0, "time_limit": 1.0},
        )

        assert response.status_code == 422

    def test_analyze_time_limit_out_of_range_is_422(self, client):
        response = client.post(
            "/api/analyze",
            json={"fen": AFTER_E4_FEN, "depth": 2, "time_limit": 60.0},
        )

        assert response.status_code == 422


class TestEnginePerRequest:
    """P0-2: every request must search with its own engine state."""

    def test_each_request_builds_its_own_engine_and_shares_the_tt(self, client, monkeypatch):
        created = []
        real_build_engine = app_main.build_engine

        def spy_build_engine():
            engine = real_build_engine()
            created.append(engine)
            return engine

        monkeypatch.setattr(app_main, "build_engine", spy_build_engine)

        move_response = client.post(
            "/api/move", json={"fen": MIDDLEGAME_FEN, "depth": 3, "time_limit": 1.0}
        )
        analyze_response = client.post(
            "/api/analyze", json={"fen": CASTLED_FEN, "depth": 3, "time_limit": 1.0}
        )

        assert move_response.status_code == 200
        assert analyze_response.status_code == 200
        # These positions are not in the book, so both endpoints really searched.
        assert move_response.json()["from_book"] is False
        assert analyze_response.json()["from_book"] is False

        assert len(created) == 2, "endpoints did not build an engine per request"
        assert created[0] is not created[1], "the same engine instance served two requests"

        # The thread-safe transposition table is still shared.
        assert created[0].tt is app_main.tt
        assert created[1].tt is app_main.tt

        # Each engine ran exactly one search, so their state cannot overlap.
        assert created[0].nodes_visited > 0
        assert created[1].nodes_visited > 0


class TestMoveRequestTiming:
    def test_move_respects_requested_time_limit(self, client):
        for limit in (0.3, 1.0):
            started = time.perf_counter()
            response = client.post(
                "/api/move",
                json={"fen": MIDDLEGAME_FEN, "depth": 8, "time_limit": limit},
            )
            elapsed = time.perf_counter() - started
            print(f"/api/move limit={limit}s elapsed={elapsed:.3f}s")

            assert response.status_code == 200
            body = response.json()
            assert body["from_book"] is False
            move = chess.Move.from_uci(body["move"])
            assert move in chess.Board(MIDDLEGAME_FEN).legal_moves
            assert elapsed <= limit + API_TIME_TOLERANCE, (
                f"/api/move overran its {limit}s budget: {elapsed:.3f}s"
            )


class TestConcurrentMoveRequests:
    def test_concurrent_moves_are_valid_and_independent(self):
        requests = [
            (MIDDLEGAME_FEN, 0.3, 4),
            (CASTLED_FEN, 0.4, 5),
            (KIWIPETE_FEN, 0.5, 4),
            (AFTER_E4_FEN, 0.2, 3),
        ]

        def issue(fen, time_limit, depth):
            # A separate client per thread; no context manager, so the app
            # lifespan (and its TT flush) does not run during the test.
            local_client = TestClient(app)
            started = time.perf_counter()
            response = local_client.post(
                "/api/move",
                json={"fen": fen, "depth": depth, "time_limit": time_limit},
            )
            return {
                "fen": fen,
                "time_limit": time_limit,
                "elapsed": time.perf_counter() - started,
                "response": response,
            }

        with ThreadPoolExecutor(max_workers=len(requests)) as pool:
            results = list(pool.map(lambda args: issue(*args), requests))

        for result in results:
            body = result["response"].json()
            print(
                f"concurrent /api/move limit={result['time_limit']}s "
                f"elapsed={result['elapsed']:.3f}s depth={body.get('depth')} move={body.get('move')}"
            )

            assert result["response"].status_code == 200
            assert body["is_game_over"] is False
            assert body["from_book"] is False
            move = chess.Move.from_uci(body["move"])
            assert move in chess.Board(result["fen"]).legal_moves
            assert result["elapsed"] <= result["time_limit"] + CONCURRENT_API_TOLERANCE, (
                "a concurrent request ran far past its own budget, which points at "
                "shared search state"
            )


class TestStaticFrontend:
    """
    Static-delivery guard for the frontend work that was unmerged until now.

    ``fix/click-selection-and-hints`` (commit cade508) fixed click-to-move:
    chessboard.js 1.0.0 starts a drag on every mousedown over a piece, and its
    floating drag avatar swallowed the mouseup of a plain click, so the browser
    retargeted the click to <body> and it never reached #board. The fix makes
    that avatar transparent to hit-testing and stops suppressing clicks after a
    same-square drop (a select/deselect, not a drag).

    These are content guards on the served asset, not behavioural browser
    tests: the repository's ``scripts/cdp-*.js`` harnesses cover behaviour and
    need Chrome plus ``chrome-remote-interface``.
    """

    FRONTEND_ASSETS = [
        "/",
        "/static/app.js",
        "/static/style.css",
        "/static/vendor/jquery.min.js",
        "/static/vendor/chess.min.js",
        "/static/vendor/chessboard.min.js",
        "/static/img/chesspieces/wikipedia/wP.png",
    ]

    def test_frontend_is_served(self, client):
        for path in self.FRONTEND_ASSETS:
            response = client.get(path)
            assert response.status_code == 200, path
            assert response.content, path

        index = client.get("/")
        assert 'id="board"' in index.text
        assert index.headers["cache-control"] == "no-cache"

        app_js = client.get("/static/app.js")
        assert app_js.headers["cache-control"] == "no-cache"
    def test_click_selection_fix_is_still_present(self, client):
        app_js = client.get("/static/app.js").text

        # The drag avatar must not intercept the click that follows a click.
        assert "body > img[data-piece]" in app_js, "drag-avatar hit-testing rule lost"
        assert "pointer-events: none" in app_js, "drag avatar intercepts clicks again"

        # A same-square drop is a click (select/deselect), not a drag.
        assert "if (source !== target)" in app_js, "same-square click suppression regressed"

        # The square resolver must survive any click target inside a square.
        assert "getSquareFromEvent" in app_js, "robust square resolver removed"
        assert "[class*=\"square-\"]" in app_js, "square resolution relies on a fixed class again"


class TestGameEndUi:
    """
    Guards for the game-ended screen and the resign confirmation screen.

    ``scripts/dom-flows.js`` drives these flows in a jsdom document (real
    clicks, real chess.js); these static guards keep the wiring present in the
    served assets so a regression cannot pass silently when jsdom is not
    installed. They are content checks, not behavioural ones.
    """

    def test_review_game_button_is_removed(self, client):
        index = client.get("/").text
        app_js = client.get("/static/app.js").text

        assert "btnReviewGame" not in index, "the sidebar Review Game button is back"
        assert "btnReviewGame" not in app_js, "orphaned Review Game wiring remains"

    def test_game_ended_screen_markup_is_present(self, client):
        index = client.get("/").text

        for element_id in (
            "gameOverOverlay",
            "gameOverResult",
            "gameOverCode",
            "gameOverDetail",
            "btnGameOverReview",
            "btnGameOverNew",
        ):
            assert f'id="{element_id}"' in index, f"missing game-ended element {element_id}"

        assert index.count('role="dialog"') >= 2, "overlays must be dialogs"
        assert index.count('aria-modal="true"') >= 2, "overlays must be modal"
        assert 'aria-labelledby="gameOverTitle"' in index
        assert 'aria-describedby="gameOverDetail"' in index

    def test_resign_confirmation_markup_is_present(self, client):
        index = client.get("/").text

        for element_id in ("resignOverlay", "btnResignConfirm", "btnResignCancel"):
            assert f'id="{element_id}"' in index, f"missing resign element {element_id}"

        # Native dialogs must not be used for resigning any more.
        assert "window.confirm" not in index

    def test_no_native_dialogs_in_application_script(self, client):
        app_js = client.get("/static/app.js").text

        assert "confirm(" not in app_js, "native confirmation dialog is back"
        assert "alert(" not in app_js, "native alert is back"

    def test_every_termination_reason_is_described(self, client):
        app_js = client.get("/static/app.js").text

        # One description per documented ending, and a single source of truth
        # shared by the status box and the game-ended screen.
        assert "function getGameEndDetails" in app_js
        assert "function showGameOverModal" in app_js
        assert "function openResignModal" in app_js

        assert "in_checkmate()" in app_js
        assert "in_stalemate()" in app_js
        assert "insufficient_material()" in app_js
        assert "in_threefold_repetition()" in app_js
        assert "halfmoveClock() >= 100" in app_js, "fifty-move rule is no longer detected"
        assert "state.finishReason === 'resignation'" in app_js

        for phrase in (
            "Checkmate: ",
            "Draw by stalemate: no legal moves remain",
            "Draw by insufficient material",
            "Draw by threefold repetition",
            "Draw by the fifty-move rule",
        ):
            assert phrase in app_js, f"missing termination detail: {phrase}"

    def test_game_ended_screen_owns_review_entry(self, client):
        app_js = client.get("/static/app.js").text

        # Review mode is still reachable, now from the game-ended screen.
        assert "$btnGameOverReview.on('click'" in app_js
        assert "enterReview(gameHistory.moves.length)" in app_js
        assert "showGameOverModal();" in app_js, "finishGame must open the game-ended screen"

    def test_resigned_games_do_not_offer_review(self, client):
        app_js = client.get("/static/app.js").text
        css = client.get("/static/style.css").text

        # A resigned game must not offer review: the game-ended screen drops the
        # action instead of merely leaving it disabled.
        assert "state.finishReason !== 'resignation'" in app_js, (
            "resigned games can be reviewed again"
        )
        assert "$btnGameOverReview.attr('hidden', '')" in app_js, (
            "the Review Game action is no longer removed after a resignation"
        )
        assert ".modal-actions [hidden]" in css, (
            "a hidden modal action would still render (button display rule wins)"
        )

    def test_server_reported_endings_are_honoured(self, client):
        app_js = client.get("/static/app.js").text

        # python-chess ends games chess.js cannot classify (75-move rule /
        # fivefold repetition); the backend result code must still be used.
        assert "finishGame('draw', { result: data.result })" in app_js
        assert "describeResultCode" in app_js

    def test_modal_styles_are_shipped(self, client):
        css = client.get("/static/style.css").text

        assert ".modal-overlay {" in css
        assert ".modal-overlay[hidden]" in css, "hidden overlays would stay visible"
        assert ".modal {" in css
        assert ".modal-actions {" in css
        assert "button.btn-danger" in css
        assert "body.modal-open" in css, "the page would scroll behind the overlay"
        assert "align-items: flex-end" in css, "no mobile layout for the modals"
