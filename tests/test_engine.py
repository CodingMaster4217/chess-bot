"""
Engine reliability regression tests (P0-1: reliable deadlines + board
integrity, P0-2: no shared search state).

Covered here:
* the caller's board is restored exactly, including on a forced timeout and on
  an unrelated exception raised mid-search
* six consecutive search-and-play iterations on one board object
* engine-level deadlines are honoured within the documented tolerance
* concurrent engines keep their own deadline and node counter
* a fixed-depth search result is unchanged (the timing fix must not alter the
  search)

Timing tests keep the acceptance-criteria tolerance of +0.15 s instead of
being widened to make a run pass; measured values are printed so a failure can
be read against the real numbers.
"""

import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import chess

from app.engine import (
    TIME_CHECK_INTERVAL,
    TIME_CHECK_MASK,
    ChessEngine,
    evaluate_board,
)
from app.memory import TranspositionTable

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
MIDDLEGAME_FEN = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 2 3"
CASTLED_FEN = "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 0 1"
KIWIPETE_FEN = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
MATE_IN_ONE_FEN = "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1"

# Acceptance criteria for P0-1: engine-level wall time must not exceed the
# requested limit by more than this on an otherwise unloaded machine.
ENGINE_TIME_TOLERANCE = 0.15

# Concurrent searches compete for the GIL and the CPU, so wall-clock time can
# legitimately stretch past the engine's own deadline while a thread waits to
# be scheduled. This bound is only meant to catch a state-isolation
# regression (a search hijacked by another thread's deadline), not to measure
# deadline accuracy.
CONCURRENT_OVERRUN_LIMIT = 1.5

TIMING_POSITIONS = {
    "start": START_FEN,
    "middlegame": MIDDLEGAME_FEN,
    "castled": CASTLED_FEN,
    "kiwipete": KIWIPETE_FEN,
}

TIMING_LIMITS = [0.1, 0.2, 1.0, 2.0]


@pytest.fixture
def tt(tmp_path):
    """File-backed transposition table, never the repository's data/ DB."""
    return TranspositionTable(db_path=str(tmp_path / "tt.db"))


@pytest.fixture
def engine(tt):
    return ChessEngine(tt=tt)


def assert_board_untouched(board, expected_fen, expected_stack_size=0):
    assert board.fen() == expected_fen, "search mutated the caller's position"
    assert len(board.move_stack) == expected_stack_size, (
        f"search leaked {len(board.move_stack)} pushed move(s) onto the board"
    )


def assert_legal_move(board, move):
    assert move is not None, "engine returned no move for a position with legal moves"
    assert move in board.legal_moves, f"engine returned an illegal move: {move.uci()}"


class TestBoardIntegrity:
    def test_forced_timeout_keeps_board_and_returns_legal_move(self, engine):
        board = chess.Board(START_FEN)
        fen_before = board.fen()

        start = time.perf_counter()
        move, score, depth = engine.find_best_move(board, target_depth=10, time_limit=0.02)
        elapsed = time.perf_counter() - start

        print(f"forced timeout: elapsed={elapsed:.3f}s depth={depth} move={move.uci() if move else None}")
        assert_board_untouched(board, fen_before)
        assert_legal_move(board, move)

    def test_forced_timeout_mid_middlegame_keeps_board(self, engine):
        board = chess.Board(CASTLED_FEN)
        fen_before = board.fen()

        engine.find_best_move(board, target_depth=12, time_limit=0.05)

        assert_board_untouched(board, fen_before)

    def test_completed_search_keeps_board(self, engine):
        board = chess.Board(MIDDLEGAME_FEN)
        fen_before = board.fen()

        move, score, depth = engine.find_best_move(board, target_depth=3, time_limit=30.0)

        assert depth == 3
        assert_board_untouched(board, fen_before)
        assert_legal_move(board, move)

    def test_unrelated_exception_propagates_and_restores_board(self, engine, monkeypatch):
        """A non-timeout error must not be swallowed, and must still unwind the board."""
        real_evaluate = evaluate_board
        calls = {"count": 0}

        def exploding_evaluate(board):
            calls["count"] += 1
            if calls["count"] > 5:
                raise RuntimeError("injected evaluation failure")
            return real_evaluate(board)

        monkeypatch.setattr("app.engine.evaluate_board", exploding_evaluate)

        board = chess.Board(START_FEN)
        fen_before = board.fen()

        with pytest.raises(RuntimeError, match="injected evaluation failure"):
            engine.find_best_move(board, target_depth=4, time_limit=30.0)

        assert calls["count"] > 5, "the injected failure never fired"
        assert_board_untouched(board, fen_before)

    def test_six_consecutive_searches_on_one_board(self, engine):
        """Repeated timeout-aborted searches must leave a playable board behind."""
        board = chess.Board(START_FEN)
        moves = []

        for iteration in range(6):
            fen_before = board.fen()
            stack_before = len(board.move_stack)

            move, score, depth = engine.find_best_move(board, target_depth=8, time_limit=0.15)

            assert_board_untouched(board, fen_before, stack_before)
            assert_legal_move(board, move)

            board.push(move)
            moves.append(move.uci())

        assert board.is_valid()
        assert len(board.move_stack) == 6
        print(f"six iterations produced: {moves}")

    def test_position_without_legal_moves_returns_none(self, engine):
        # Fool's mate: White (to move) is already checkmated.
        board = chess.Board("rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3")
        fen_before = board.fen()

        move, score, depth = engine.find_best_move(board, target_depth=4, time_limit=1.0)

        assert move is None
        assert (score, depth) == (0, 0)
        assert_board_untouched(board, fen_before)


class TestDeadlineEnforcement:
    @pytest.mark.parametrize("limit", TIMING_LIMITS)
    @pytest.mark.parametrize("name", sorted(TIMING_POSITIONS))
    def test_deadline_is_respected(self, engine, name, limit):
        fen = TIMING_POSITIONS[name]
        board = chess.Board(fen)
        fen_before = board.fen()

        start = time.perf_counter()
        move, score, depth = engine.find_best_move(board, target_depth=8, time_limit=limit)
        elapsed = time.perf_counter() - start

        print(
            f"{name:11s} limit={limit:4.1f}s elapsed={elapsed:6.3f}s "
            f"overrun={elapsed - limit:+.3f}s depth={depth} nodes={engine.nodes_visited}"
        )

        assert elapsed <= limit + ENGINE_TIME_TOLERANCE, (
            f"{name} exceeded its {limit}s budget: elapsed={elapsed:.3f}s "
            f"(tolerance +{ENGINE_TIME_TOLERANCE}s)"
        )
        assert_board_untouched(board, fen_before)
        assert_legal_move(board, move)

    def test_late_deadline_returns_last_completed_iteration(self, tt, tmp_path):
        """
        A search cut off during a deeper iteration must return the result of the
        last fully completed iteration (not a partial one) and report the depth
        it actually completed.
        """
        reference_engine = ChessEngine(
            tt=TranspositionTable(db_path=str(tmp_path / "depth1.db"))
        )
        reference_board = chess.Board(CASTLED_FEN)
        reference_move, _, reference_depth = reference_engine.find_best_move(
            reference_board, target_depth=1, time_limit=30.0
        )
        assert reference_depth == 1

        engine = ChessEngine(tt=tt)
        board = chess.Board(CASTLED_FEN)
        move, score, depth = engine.find_best_move(board, target_depth=8, time_limit=0.3)

        print(f"completed depth={depth} move={move.uci() if move else None}")
        assert_legal_move(board, move)
        assert 1 <= depth < 8

        if depth == 1:
            # Nothing deeper completed, so the answer is the depth-1 iteration.
            assert move == reference_move

    def test_absurdly_short_limit_still_returns_a_legal_move(self, engine):
        """With no iteration able to complete, the fallback must still be legal."""
        board = chess.Board(CASTLED_FEN)
        fen_before = board.fen()

        move, score, depth = engine.find_best_move(board, target_depth=8, time_limit=0.0001)

        assert depth == 0
        assert_board_untouched(board, fen_before)
        assert_legal_move(board, move)

    def test_time_check_polling_constants_are_consistent(self):
        assert TIME_CHECK_INTERVAL > 0
        assert (TIME_CHECK_INTERVAL & TIME_CHECK_MASK) == 0, (
            "TIME_CHECK_INTERVAL must be a power of two for mask-based polling"
        )
        assert TIME_CHECK_MASK == TIME_CHECK_INTERVAL - 1


class TestSearchStateIsolation:
    def test_engine_instances_keep_separate_search_state(self, tt):
        first = ChessEngine(tt=tt)
        second = ChessEngine(tt=tt)
        assert first is not second

        first.find_best_move(chess.Board(START_FEN), target_depth=2, time_limit=30.0)
        first_nodes = first.nodes_visited
        first_limit = first.time_limit

        second.find_best_move(chess.Board(KIWIPETE_FEN), target_depth=2, time_limit=0.05)
        second_nodes = second.nodes_visited

        assert first_limit == 30.0
        assert first.nodes_visited == first_nodes
        assert second.time_limit == 0.05
        assert second_nodes > 0

    def test_concurrent_searches_do_not_interfere(self, tt):
        """
        Two searches with very different budgets must each obey their own
        deadline: the short search may not run on the long search's budget, and
        the long search may not be cut short by the short one's deadline.
        """
        short_limit, long_limit = 0.2, 1.5
        short_engine = ChessEngine(tt=tt)
        long_engine = ChessEngine(tt=tt)

        results = {}

        def run(name, eng, fen, limit):
            board = chess.Board(fen)
            start = time.perf_counter()
            move, score, depth = eng.find_best_move(board, target_depth=8, time_limit=limit)
            results[name] = {
                "elapsed": time.perf_counter() - start,
                "move": move,
                "depth": depth,
                "nodes": eng.nodes_visited,
                "limit": eng.time_limit,
                "fen_intact": board.fen() == fen,
                "legal": move in board.legal_moves if move else False,
            }

        threads = [
            threading.Thread(
                target=run, args=("short", short_engine, MIDDLEGAME_FEN, short_limit)
            ),
            threading.Thread(target=run, args=("long", long_engine, START_FEN, long_limit)),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        assert not any(thread.is_alive() for thread in threads), "a concurrent search hung"

        short, long = results["short"], results["long"]
        print(
            f"short: limit={short_limit}s elapsed={short['elapsed']:.3f}s nodes={short['nodes']} | "
            f"long: limit={long_limit}s elapsed={long['elapsed']:.3f}s nodes={long['nodes']}"
        )

        # Both searches produced usable results from untouched boards.
        assert short["legal"] and long["legal"]
        assert short["fen_intact"] and long["fen_intact"]

        # Each engine kept its own deadline and node counter.
        assert short["limit"] == short_limit
        assert long["limit"] == long_limit
        assert 0 < short["nodes"] < long["nodes"]

        # The short search was governed by its own (short) deadline, not the
        # long search's, and vice versa: losing state would abort the long
        # search almost immediately (measured 0.69s of a 3.0s budget before the
        # fix) and let the short search run far past its limit (measured 61x).
        assert short["elapsed"] <= short_limit + CONCURRENT_OVERRUN_LIMIT
        assert long["elapsed"] >= long_limit * 0.6
        assert long["elapsed"] <= long_limit + CONCURRENT_OVERRUN_LIMIT


class TestSearchUnchanged:
    def test_fixed_depth_result_is_stable_across_cold_searches(self, tmp_path):
        """
        Two cold searches of the same position at a fixed depth with a generous
        budget must agree exactly. This pins the search result so the timing
        and polling changes cannot silently alter playing strength.
        """
        outcomes = []

        for run_index in range(2):
            table = TranspositionTable(db_path=str(tmp_path / f"cold_{run_index}.db"))
            eng = ChessEngine(tt=table)
            board = chess.Board(START_FEN)
            move, score, depth = eng.find_best_move(board, target_depth=4, time_limit=60.0)
            assert_board_untouched(board, START_FEN)
            outcomes.append((move.uci(), score, depth, eng.nodes_visited))

        assert outcomes[0] == outcomes[1], f"non-deterministic search: {outcomes}"

        move_uci, score, depth, nodes = outcomes[0]
        # Baseline measured from the pre-fix engine (audit Phase 1).
        assert (move_uci, score, depth) == ("g1f3", 0, 4)
        print(f"depth={depth} move={move_uci} eval={score} nodes={nodes}")

    def test_finds_mate_in_one(self, engine):
        board = chess.Board(MATE_IN_ONE_FEN)

        move, score, depth = engine.find_best_move(board, target_depth=4, time_limit=2.0)

        assert move is not None
        assert move.uci() == "a1a8"
        board.push(move)
        assert board.is_checkmate()
        board.pop()

    def test_promotion_move_is_returned_with_piece_suffix(self, engine):
        # White to move: the a1 king has no legal square, so the only legal
        # moves are the four promotions of the b7 pawn.
        board = chess.Board("8/1P6/8/8/8/8/2k5/K7 w - - 0 1")
        legal_promotions = [m for m in board.legal_moves if m.promotion]
        assert len(legal_promotions) == 4

        move, score, depth = engine.find_best_move(board, target_depth=3, time_limit=2.0)

        assert move is not None
        assert move.promotion == chess.QUEEN
        assert len(move.uci()) == 5
