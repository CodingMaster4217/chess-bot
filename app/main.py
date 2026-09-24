"""
FastAPI Server for Chess Playing Bot
Provides REST endpoints for bot moves, health checks, cache resets,
post-game position analysis, and serves static files.
"""

import os
from contextlib import asynccontextmanager
from typing import Optional
from pydantic import BaseModel, Field, field_validator

import chess
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response

from app.memory import TranspositionTable
from app.book import OpeningBook
from app.engine import ChessEngine, MATE_SCORE


# Initialize singleton instances
tt = TranspositionTable()
opening_book = OpeningBook()
engine = ChessEngine(tt=tt)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: ensure tables preloaded and book ready
    print(f"[Lifespan] Chess Bot server starting up. TT size: {tt.size()}")
    yield
    # Shutdown: flush transposition table entries to SQLite
    print("[Lifespan] Shutting down. Flushing Transposition Table...")
    tt.flush()
    opening_book.close()
    print("[Lifespan] Cleanup completed.")


app = FastAPI(
    title="High-Performance Chess Bot API",
    description="Chess Engine powered by Minimax, Alpha-Beta, Quiescence, Iterative Deepening, PolyGlot Book, and SQLite Transposition Table",
    version="1.0.0",
    lifespan=lifespan,
)

# Enable CORS for local testing and cross-origin access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class MoveRequest(BaseModel):
    fen: str = Field(..., description="Board position in Forsyth-Edwards Notation (FEN)")
    depth: int = Field(default=6, ge=1, le=10, description="Target search depth (1-10)")
    time_limit: Optional[float] = Field(default=2.0, ge=0.1, le=10.0, description="Maximum search time in seconds")


class AnalyzeRequest(BaseModel):
    """Request for post-game position analysis (used by review mode only)."""

    fen: str = Field(..., description="Board position in FEN")
    depth: int = Field(default=6, ge=1, le=10, description="Target search depth (1-10)")
    time_limit: Optional[float] = Field(default=2.0, ge=0.1, le=10.0, description="Maximum search time in seconds")

    @field_validator("fen")
    @classmethod
    def validate_fen(cls, value: str) -> str:
        try:
            chess.Board(value)
        except ValueError as exc:
            raise ValueError("Invalid FEN string provided.") from exc
        return value


class AnalyzeResponse(BaseModel):
    """Analysis result. Scores are always from White's perspective."""

    evaluation: int
    depth: int
    best_move: Optional[str] = None
    from_book: bool = False


class MoveResponse(BaseModel):
    move: str
    from_book: bool
    eval: int
    depth: int
    is_game_over: bool = False
    result: Optional[str] = None


@app.get("/health")
def health_check():
    """Health check endpoint for Render.com deployment monitoring."""
    return {
        "status": "healthy",
        "tt_size": tt.size(),
        "book_available": opening_book.is_available(),
    }


@app.post("/api/move", response_model=MoveResponse)
def calculate_move(request: MoveRequest):
    """
    Receives board FEN and requested depth.
    1. Checks Opening Book for early positions.
    2. Runs Iterative Deepening Minimax with Alpha-Beta and Quiescence.
    3. Returns best move in UCI format along with evaluation score.
    """
    try:
        board = chess.Board(request.fen)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid FEN string provided.")

    if board.is_game_over():
        return MoveResponse(
            move="",
            from_book=False,
            eval=0,
            depth=0,
            is_game_over=True,
            result=board.result(),
        )

    # 1. Check PolyGlot Opening Book (moves 1-12)
    book_move = opening_book.get_move(board)
    if book_move:
        # If in book, eval is approximately neutral (0)
        return MoveResponse(
            move=book_move.uci(),
            from_book=True,
            eval=0,
            depth=0,
            is_game_over=False,
            result=None,
        )

    # 2. Iterative Deepening Minimax Alpha-Beta Engine Search
    best_move, eval_score, depth_reached = engine.find_best_move(
        board,
        target_depth=request.depth,
        time_limit=request.time_limit or 2.0,
    )

    if not best_move:
        # Fallback if no legal move found (stalemate / checkmate)
        return MoveResponse(
            move="",
            from_book=False,
            eval=0,
            depth=0,
            is_game_over=True,
            result=board.result(),
        )

    return MoveResponse(
        move=best_move.uci(),
        from_book=False,
        eval=eval_score,
        depth=depth_reached,
        is_game_over=False,
        result=None,
    )


@app.post("/api/analyze", response_model=AnalyzeResponse)
def analyze_position(request: AnalyzeRequest):
    """
    Post-game analysis for the review UI.

    NOTE: this endpoint intentionally performs no server-side session or
    "game has ended" check. The application keeps no server-side game state
    that could prove a game ended, so gating analysis to finished games is a
    frontend responsibility (review mode is only reachable after checkmate,
    draw, or resignation). This is a frontend post-game feature, not a
    restricted compute endpoint: request scope is bounded by the same
    depth/time limits as /api/move.

    Reuses the same engine search as /api/move; it does not duplicate it.
    Scores are returned from White's perspective (positive favors White).
    Terminal positions are reported explicitly and never fall through to a
    normal search.
    """
    # Pydantic already validated the FEN (422 on structurally invalid input).
    board = chess.Board(request.fen.strip())

    if board.is_checkmate():
        # The side to move has been checkmated. MATE_SCORE from the engine's
        # perspective is returned for the mating side, so report from White's
        # perspective explicitly: White delivered mate -> winning for White.
        evaluation = MATE_SCORE if board.turn == chess.BLACK else -MATE_SCORE
        return AnalyzeResponse(
            evaluation=evaluation,
            depth=0,
            best_move=None,
            from_book=False,
        )

    if board.is_game_over():
        # Stalemate, insufficient material, 75-move rule, fivefold repetition.
        return AnalyzeResponse(
            evaluation=0,
            depth=0,
            best_move=None,
            from_book=False,
        )

    book_move = opening_book.get_move(board)
    if book_move:
        return AnalyzeResponse(
            evaluation=0,
            depth=0,
            best_move=book_move.uci(),
            from_book=True,
        )

    best_move, eval_score, depth_reached = engine.find_best_move(
        board,
        target_depth=request.depth,
        time_limit=request.time_limit or 2.0,
    )

    if not best_move:
        # Defensive: no legal move but not detected as terminal above.
        return AnalyzeResponse(
            evaluation=0,
            depth=0,
            best_move=None,
            from_book=False,
        )

    return AnalyzeResponse(
        evaluation=eval_score,
        depth=depth_reached,
        best_move=best_move.uci(),
        from_book=False,
    )


@app.post("/api/reset")
def reset_game():
    """Flushes temporary cache entries to the persistent SQLite DB."""
    tt.flush()
    return {"status": "ok", "message": "Transposition table flushed to persistent storage."}


# Mount static files directory
#
# Cache policy: static assets are served with `no-cache`, which lets browsers
# STORE the files but REVALIDATE with the server on every load (ETag/Last-
# Modified 304s still apply). Without this, browsers may apply heuristic
# caching and serve a stale app.js after a deploy, which leaves buttons and
# board interactions silently dead (the old script knows nothing about the
# new HTML elements).
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.exists(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.middleware("http")
    async def static_cache_headers(request, call_next):
        response: Response = await call_next(request)
        if request.url.path.startswith("/static"):
            response.headers["Cache-Control"] = "no-cache"
        return response


@app.get("/")
def serve_index():
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        # Revalidate on every load so users never run a stale page against a
        # freshly deployed backend.
        headers = {"Cache-Control": "no-cache"}
        return FileResponse(index_path, headers=headers)
    return {"message": "Chess Bot API is running. Static frontend not found."}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=True)

