"""
PolyGlot Opening Book Handler.
Supports loading .bin books with weighted random selection,
and gracefully falls back if the file is missing or invalid.
"""

import os
import random
from typing import Optional
import chess
import chess.polyglot


DEFAULT_BOOK_PATH = "data/opening_book.bin"


class OpeningBook:
    def __init__(self, book_path: Optional[str] = None):
        self.book_path = book_path or os.getenv("OPENING_BOOK_PATH", DEFAULT_BOOK_PATH)
        self.reader: Optional[chess.polyglot.MemoryMappedReader] = None
        self._ensure_book_directory()
        self.reload()

    def _ensure_book_directory(self):
        book_dir = os.path.dirname(self.book_path)
        if book_dir and not os.path.exists(book_dir):
            os.makedirs(book_dir, exist_ok=True)

    def is_available(self) -> bool:
        return self.reader is not None

    def reload(self):
        """Loads or reloads the opening book reader if file exists and is valid."""
        if self.reader is not None:
            try:
                self.reader.close()
            except Exception:
                pass
            self.reader = None

        if not os.path.exists(self.book_path):
            print(f"[OpeningBook] File not found at '{self.book_path}'. Creating empty fallback stub.")
            self._create_empty_stub_book()

        if os.path.exists(self.book_path):
            try:
                self.reader = chess.polyglot.open_reader(self.book_path)
                print(f"[OpeningBook] Successfully loaded opening book from '{self.book_path}'")
            except Exception as e:
                print(f"[OpeningBook] Warning: Could not open '{self.book_path}': {e}. Continuing without opening book.")
                self.reader = None

    def _create_empty_stub_book(self):
        """Creates an empty 0-byte file so polyglot readers or downstream tasks have a valid file target."""
        try:
            with open(self.book_path, "wb") as f:
                pass
        except Exception as e:
            print(f"[OpeningBook] Failed to create empty stub file: {e}")

    def get_move(self, board: chess.Board, max_fullmove_number: int = 12) -> Optional[chess.Move]:
        """
        Queries the opening book for the given board position.
        Uses weighted choice if multiple book moves are present.
        Only queries if current fullmove number is within max_fullmove_number (default: 12).
        """
        if self.reader is None:
            return None

        # Polyglot books are primarily intended for the opening phase
        if board.fullmove_number > max_fullmove_number:
            return None

        try:
            entries = list(self.reader.find_all(board))
            if not entries:
                return None

            # Filter entries with weight > 0 if possible
            weighted_entries = [e for e in entries if e.weight > 0]
            if not weighted_entries:
                weighted_entries = entries

            weights = [e.weight for e in weighted_entries]
            # If all weights are 0, use uniform distribution
            if sum(weights) == 0:
                selected_entry = random.choice(weighted_entries)
            else:
                selected_entry = random.choices(weighted_entries, weights=weights, k=1)[0]

            chosen_move = selected_entry.move
            if chosen_move in board.legal_moves:
                return chosen_move
        except Exception as e:
            print(f"[OpeningBook] Read error for position: {e}")

        return None

    def close(self):
        if self.reader:
            try:
                self.reader.close()
            except Exception:
                pass
            self.reader = None

