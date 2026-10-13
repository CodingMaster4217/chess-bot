"""
Test-session configuration.

The application persists its transposition table to SQLite at ``DB_PATH`` and
``POST /api/reset`` (exercised by the API tests) flushes the in-memory table to
that file. Without this, running the suite can rewrite the repository's tracked
``data/transposition.db`` depending on test ordering.

Point ``DB_PATH`` at a throwaway directory for the whole session so the tests
never touch ``data/``.

``OPENING_BOOK_PATH`` is deliberately left untouched: the book is opened
read-only (nothing in the app ever writes to it) and the API tests should keep
exercising the real book.
"""

import os
import tempfile

os.environ["DB_PATH"] = os.path.join(
    tempfile.mkdtemp(prefix="chessbot-tests-"), "transposition.db"
)
