"""
Lightweight API tests for the chess bot FastAPI backend.

Requires the project dependencies (fastapi, python-chess) and pytest.
Run from the project root with the project venv:

    .venv/Scripts/python.exe -m pytest tests/ -v
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
AFTER_E4_FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"


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
