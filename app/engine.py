"""
Chess Engine Core
Includes:
- Positional & Material Evaluation with Piece-Square Tables (PST)
- MVV-LVA Capture Ordering, Checks, and Hash Moves
- Alpha-Beta Pruning (Negamax)
- Quiescence Search with delta pruning / capture search
- Iterative Deepening Search with configurable time-limit controls
"""

import time
from typing import Optional, Tuple, List
import chess

from app.memory import (
    TranspositionTable,
    FLAG_EXACT,
    FLAG_LOWERBOUND,
    FLAG_UPPERBOUND,
)

# Base piece values in centipawns
PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 20000,
}

# Piece-Square Tables (from White's perspective; 0=a1, 63=h8)
# Favoring center control, development, king safety in middlegame
PAWN_TABLE = [
     0,  0,  0,  0,  0,  0,  0,  0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
     5,  5, 10, 25, 25, 10,  5,  5,
     0,  0,  0, 20, 20,  0,  0,  0,
     5, -5,-10,  0,  0,-10, -5,  5,
     5, 10, 10,-20,-20, 10, 10,  5,
     0,  0,  0,  0,  0,  0,  0,  0
]

KNIGHT_TABLE = [
    -50,-40,-30,-30,-30,-30,-40,-50,
    -40,-20,  0,  0,  0,  0,-20,-40,
    -30,  0, 10, 15, 15, 10,  0,-30,
    -30,  5, 15, 20, 20, 15,  5,-30,
    -30,  0, 15, 20, 20, 15,  0,-30,
    -30,  5, 10, 15, 15, 10,  5,-30,
    -40,-20,  0,  5,  5,  0,-20,-40,
    -50,-40,-30,-30,-30,-30,-40,-50,
]

BISHOP_TABLE = [
    -20,-10,-10,-10,-10,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5, 10, 10,  5,  0,-10,
    -10,  5,  5, 10, 10,  5,  5,-10,
    -10,  0, 10, 10, 10, 10,  0,-10,
    -10, 10, 10, 10, 10, 10, 10,-10,
    -10,  5,  0,  0,  0,  0,  5,-10,
    -20,-10,-10,-10,-10,-10,-10,-20,
]

ROOK_TABLE = [
      0,  0,  0,  0,  0,  0,  0,  0,
      5, 10, 10, 10, 10, 10, 10,  5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
     -5,  0,  0,  0,  0,  0,  0, -5,
      0,  0,  0,  5,  5,  0,  0,  0
]

QUEEN_TABLE = [
    -20,-10,-10, -5, -5,-10,-10,-20,
    -10,  0,  0,  0,  0,  0,  0,-10,
    -10,  0,  5,  5,  5,  5,  0,-10,
     -5,  0,  5,  5,  5,  5,  0, -5,
      0,  0,  5,  5,  5,  5,  0, -5,
    -10,  5,  5,  5,  5,  5,  0,-10,
    -10,  0,  5,  0,  0,  0,  0,-10,
    -20,-10,-10, -5, -5,-10,-10,-20
]

KING_MIDDLEGAME_TABLE = [
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -30,-40,-40,-50,-50,-40,-40,-30,
    -20,-30,-30,-40,-40,-30,-30,-20,
    -10,-20,-20,-20,-20,-20,-20,-10,
     20, 20,  0,  0,  0,  0, 20, 20,
     20, 30, 10,  0,  0, 10, 30, 20
]

PST_MAP = {
    chess.PAWN: PAWN_TABLE,
    chess.KNIGHT: KNIGHT_TABLE,
    chess.BISHOP: BISHOP_TABLE,
    chess.ROOK: ROOK_TABLE,
    chess.QUEEN: QUEEN_TABLE,
    chess.KING: KING_MIDDLEGAME_TABLE,
}

INFINITY = 1000000
MATE_SCORE = 900000


def evaluate_board(board: chess.Board) -> int:
    """
    Evaluates board position from White's perspective.
    Returns centipawn integer score (+ for White, - for Black).
    """
    if board.is_checkmate():
        # The player whose turn it is has been checkmated
        return -MATE_SCORE if board.turn == chess.WHITE else MATE_SCORE

    if board.is_stalemate() or board.is_insufficient_material() or board.can_claim_draw():
        return 0

    white_eval = 0
    black_eval = 0

    for square, piece in board.piece_map().items():
        val = PIECE_VALUES.get(piece.piece_type, 0)
        pst = PST_MAP.get(piece.piece_type)

        if piece.color == chess.WHITE:
            # Table is indexed from 0 (a1) to 63 (h8)
            pst_val = pst[63 - square] if pst else 0
            white_eval += val + pst_val
        else:
            # Black position is mirrored vertically: square ^ 56
            sq_mirror = square ^ 56
            pst_val = pst[63 - sq_mirror] if pst else 0
            black_eval += val + pst_val

    # Perspective: relative to White
    score = white_eval - black_eval
    return score


def mvv_lva_score(board: chess.Board, move: chess.Move) -> int:
    """Calculates Most Valuable Victim - Least Valuable Attacker score."""
    victim_piece = board.piece_at(move.to_square)
    victim_val = PIECE_VALUES.get(victim_piece.piece_type, 0) if victim_piece else 0

    attacker_piece = board.piece_at(move.from_square)
    attacker_val = PIECE_VALUES.get(attacker_piece.piece_type, 0) if attacker_piece else 0

    # Boost promotions
    promotion_val = 0
    if move.promotion:
        promotion_val = PIECE_VALUES.get(move.promotion, 0)

    return (victim_val * 10) - attacker_val + promotion_val


def order_moves(board: chess.Board, moves: List[chess.Move], tt_move: Optional[chess.Move] = None) -> List[chess.Move]:
    """
    Orders moves to maximize Alpha-Beta cutoffs:
    1. Hash Move (from Transposition Table)
    2. Winning/Neutral Captures (MVV-LVA)
    3. Promotions
    4. Checks
    5. Quiet Moves
    """
    scored_moves = []
    for move in moves:
        score = 0
        if tt_move and move == tt_move:
            score = 1000000  # Highest priority
        elif board.is_capture(move):
            score = 100000 + mvv_lva_score(board, move)
        elif move.promotion:
            score = 90000 + PIECE_VALUES.get(move.promotion, 0)
        elif board.gives_check(move):
            score = 50000
        else:
            score = 0
        scored_moves.append((score, move))

    scored_moves.sort(key=lambda item: item[0], reverse=True)
    return [move for _, move in scored_moves]


class SearchTimeout(Exception):
    """Raised when search time limit is exceeded."""
    pass


class ChessEngine:
    def __init__(self, tt: Optional[TranspositionTable] = None):
        self.tt = tt or TranspositionTable()
        self.nodes_visited = 0
        self.start_time = 0.0
        self.time_limit = 2.0
        self.stop_search = False

    def _check_time(self):
        """Raises SearchTimeout if time budget is consumed."""
        if (self.nodes_visited & 2047) == 0:
            if time.time() - self.start_time > self.time_limit:
                self.stop_search = True
                raise SearchTimeout()

    def quiescence_search(self, board: chess.Board, alpha: int, beta: int, depth: int = 0, max_q_depth: int = 8) -> int:
        """
        Quiescence Search searches only tactical moves (captures/promotions)
        to avoid the horizon effect at leaf nodes.
        """
        self.nodes_visited += 1
        self._check_time()

        # Stand-pat evaluation
        perspective = 1 if board.turn == chess.WHITE else -1
        stand_pat = perspective * evaluate_board(board)

        if stand_pat >= beta:
            return beta
        if alpha < stand_pat:
            alpha = stand_pat

        if depth >= max_q_depth:
            return stand_pat

        # Delta pruning: if capturing queen cannot even improve stand_pat by alpha, skip
        delta = 950
        if stand_pat < alpha - delta:
            return alpha

        # Generate captures only
        capture_moves = [m for m in board.legal_moves if board.is_capture(m) or m.promotion]
        if not capture_moves:
            return stand_pat

        ordered_captures = order_moves(board, capture_moves)

        for move in ordered_captures:
            board.push(move)
            score = -self.quiescence_search(board, -beta, -alpha, depth + 1, max_q_depth)
            board.pop()

            if score >= beta:
                return beta
            if score > alpha:
                alpha = score

        return alpha

    def alpha_beta(
        self,
        board: chess.Board,
        depth: int,
        alpha: int,
        beta: int,
        ply: int = 0
    ) -> int:
        """
        Negamax Alpha-Beta search with transposition table lookups and move ordering.
        """
        self.nodes_visited += 1
        self._check_time()

        # Terminal conditions
        if board.is_checkmate():
            return -(MATE_SCORE - ply)
        if board.is_stalemate() or board.is_insufficient_material() or board.can_claim_draw():
            return 0

        # Transposition table probe
        tt_score, tt_move = self.tt.lookup(board, depth, alpha, beta)
        if tt_score is not None:
            return tt_score

        if depth <= 0:
            return self.quiescence_search(board, alpha, beta)

        legal_moves = list(board.legal_moves)
        if not legal_moves:
            if board.is_check():
                return -(MATE_SCORE - ply)
            return 0

        ordered_moves = order_moves(board, legal_moves, tt_move)
        best_score = -INFINITY
        best_move = None
        orig_alpha = alpha

        for move in ordered_moves:
            board.push(move)
            score = -self.alpha_beta(board, depth - 1, -beta, -alpha, ply + 1)
            board.pop()

            if score > best_score:
                best_score = score
                best_move = move

            if score > alpha:
                alpha = score

            if alpha >= beta:
                # Beta-cutoff
                break

        # Record into Transposition Table
        if best_score <= orig_alpha:
            flag = FLAG_UPPERBOUND
        elif best_score >= beta:
            flag = FLAG_LOWERBOUND
        else:
            flag = FLAG_EXACT

        self.tt.store(board, depth, best_score, flag, best_move)
        return best_score

    def find_best_move(
        self,
        board: chess.Board,
        target_depth: int = 6,
        time_limit: float = 2.0
    ) -> Tuple[Optional[chess.Move], int, int]:
        """
        Iterative Deepening Search.
        Searches progressively from depth 1 to target_depth within the given time_limit.
        Returns: (best_move, best_score_from_side_to_move_perspective, depth_completed)
        """
        self.nodes_visited = 0
        self.start_time = time.time()
        self.time_limit = time_limit
        self.stop_search = False

        legal_moves = list(board.legal_moves)
        if not legal_moves:
            return None, 0, 0

        best_move_overall = legal_moves[0]
        best_score_overall = 0
        completed_depth = 0

        # Iterative Deepening loop
        for depth in range(1, target_depth + 1):
            try:
                alpha = -INFINITY
                beta = INFINITY
                depth_best_move = None
                depth_best_score = -INFINITY

                # Order moves at root based on previous best move
                ordered_moves = order_moves(board, legal_moves, best_move_overall)

                for move in ordered_moves:
                    board.push(move)
                    score = -self.alpha_beta(board, depth - 1, -beta, -alpha, ply=1)
                    board.pop()

                    if score > depth_best_score:
                        depth_best_score = score
                        depth_best_move = move

                    if score > alpha:
                        alpha = score

                if depth_best_move:
                    best_move_overall = depth_best_move
                    best_score_overall = depth_best_score
                    completed_depth = depth

                # Early checkmate cutoff
                if depth_best_score >= MATE_SCORE - 100:
                    break

            except SearchTimeout:
                # Time limit expired: discard incomplete iteration and break
                break

        # Return score converted from white's perspective for frontend display convenience
        eval_score = best_score_overall if board.turn == chess.WHITE else -best_score_overall
        return best_move_overall, eval_score, completed_depth

