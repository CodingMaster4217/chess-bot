"""
Persistent Transposition Table using in-memory LRU cache + SQLite persistence.
Uses 64-bit PolyGlot Zobrist hashing via python-chess.
"""

import os
import sqlite3
import threading
from typing import Optional, Tuple, Dict, Any
import chess
import chess.polyglot


# Transposition Table Entry Flag Constants
FLAG_EXACT = 0
FLAG_LOWERBOUND = 1  # Beta-cutoff (score >= beta)
FLAG_UPPERBOUND = 2  # Alpha-cutoff (score <= alpha)


class TTEntry:
    __slots__ = ("depth", "score", "flag", "best_move")

    def __init__(self, depth: int, score: int, flag: int, best_move: Optional[str] = None):
        self.depth = depth
        self.score = score
        self.flag = flag
        self.best_move = best_move

    def to_tuple(self) -> Tuple[int, int, int, Optional[str]]:
        return (self.depth, self.score, self.flag, self.best_move)


class TranspositionTable:
    def __init__(self, db_path: Optional[str] = None, max_memory_entries: int = 50000):
        self.db_path = db_path or os.getenv("DB_PATH", "data/transposition.db")
        self.max_memory_entries = max_memory_entries
        self.table: Dict[int, TTEntry] = {}
        self.dirty_keys = set()
        self.lock = threading.Lock()
        
        # Ensure target directory exists
        db_dir = os.path.dirname(self.db_path)
        if db_dir and not os.path.exists(db_dir):
            os.makedirs(db_dir, exist_ok=True)

        self._init_db()
        self.load_from_db(limit=25000)

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False, timeout=10.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS transposition (
                    z_hash INTEGER PRIMARY KEY,
                    depth INTEGER NOT NULL,
                    score INTEGER NOT NULL,
                    flag INTEGER NOT NULL,
                    best_move TEXT
                )
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_depth ON transposition (depth DESC);")
            conn.commit()

    @staticmethod
    def hash_board(board: chess.Board) -> int:
        """Computes 64-bit PolyGlot Zobrist hash of the current position."""
        return chess.polyglot.zobrist_hash(board)

    def lookup(self, board: chess.Board, depth: int, alpha: int, beta: int) -> Tuple[Optional[int], Optional[chess.Move]]:
        """
        Check transposition table for existing evaluation.
        Returns:
            (usable_score, best_move_if_known)
            usable_score will be None if depth is insufficient or bounds do not satisfy cutoff.
        """
        z_hash = self.hash_board(board)
        with self.lock:
            entry = self.table.get(z_hash)

        if entry is None:
            return None, None

        best_move = None
        if entry.best_move:
            try:
                move = chess.Move.from_uci(entry.best_move)
                if move in board.legal_moves:
                    best_move = move
            except ValueError:
                best_move = None

        # Only use cached score if it was searched at least to current remaining depth
        if entry.depth >= depth:
            if entry.flag == FLAG_EXACT:
                return entry.score, best_move
            elif entry.flag == FLAG_LOWERBOUND and entry.score >= beta:
                return entry.score, best_move
            elif entry.flag == FLAG_UPPERBOUND and entry.score <= alpha:
                return entry.score, best_move

        return None, best_move

    def store(self, board: chess.Board, depth: int, score: int, flag: int, best_move: Optional[chess.Move] = None):
        """Stores or updates transposition table entry in memory."""
        z_hash = self.hash_board(board)
        move_str = best_move.uci() if best_move else None

        with self.lock:
            existing = self.table.get(z_hash)
            # Replacement scheme: replace if new search is deeper or same depth
            if existing is None or depth >= existing.depth:
                self.table[z_hash] = TTEntry(depth=depth, score=score, flag=flag, best_move=move_str)
                self.dirty_keys.add(z_hash)

                # Guard against unbounded memory growth
                if len(self.table) > self.max_memory_entries:
                    # Pop 10% arbitrary keys (or keys that are dirty/clean)
                    keys_to_remove = list(self.table.keys())[:int(self.max_memory_entries * 0.1)]
                    for k in keys_to_remove:
                        self.table.pop(k, None)

    def flush(self):
        """Flushes modified/dirty entries to SQLite database."""
        with self.lock:
            if not self.dirty_keys:
                return
            keys_to_persist = list(self.dirty_keys)
            records = []
            for k in keys_to_persist:
                entry = self.table.get(k)
                if entry:
                    records.append((k, entry.depth, entry.score, entry.flag, entry.best_move))
            self.dirty_keys.clear()

        if not records:
            return

        # SQLite handles signed 64-bit integers (-2^63 to 2^63-1).
        # Python-chess Polyglot hash is unsigned 64-bit (0 to 2^64-1).
        # Convert uint64 to int64 for safe storage.
        converted_records = []
        for k, depth, score, flag, best_move in records:
            signed_k = k - (1 << 64) if k >= (1 << 63) else k
            converted_records.append((signed_k, depth, score, flag, best_move))

        try:
            with self._get_connection() as conn:
                conn.executemany("""
                    INSERT INTO transposition (z_hash, depth, score, flag, best_move)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(z_hash) DO UPDATE SET
                        depth=excluded.depth,
                        score=excluded.score,
                        flag=excluded.flag,
                        best_move=excluded.best_move
                    WHERE excluded.depth >= transposition.depth
                """, converted_records)
                conn.commit()
        except Exception as e:
            print(f"[TranspositionTable] Flush error: {e}")

    def load_from_db(self, limit: int = 25000):
        """Pre-warms in-memory cache with highest-depth records from database."""
        try:
            with self._get_connection() as conn:
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT z_hash, depth, score, flag, best_move FROM transposition ORDER BY depth DESC LIMIT ?",
                    (limit,)
                )
                rows = cursor.fetchall()
                with self.lock:
                    for signed_z_hash, depth, score, flag, best_move in rows:
                        # Convert signed 64-bit back to unsigned 64-bit for polyglot hash matching
                        uint64_hash = signed_z_hash + (1 << 64) if signed_z_hash < 0 else signed_z_hash
                        self.table[uint64_hash] = TTEntry(depth=depth, score=score, flag=flag, best_move=best_move)
            print(f"[TranspositionTable] Preloaded {len(rows)} entries from {self.db_path}")
        except Exception as e:
            print(f"[TranspositionTable] Could not preload DB: {e}")

    def size(self) -> int:
        with self.lock:
            return len(self.table)
