"""AGENT ARENA — FastAPI integration layer.

Serves the arena UI, exposes the portfolio, relays orchestrator events to the
browser over SSE, and triggers analysis runs.

One process, no build step:  uvicorn app:app --reload --port 8000
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any, AsyncIterator

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
DATA = ROOT / "data"

app = FastAPI(title="Agent Arena")

# Single in-memory bus. One demo, one viewer — a queue is enough.
# CRITICAL: orchestrator log callbacks must never block; they push here and return.
_bus: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10_000)
_run_lock = asyncio.Lock()
_current_run: dict[str, Any] = {"active": False, "run_id": None, "started": None}


def emit(event: dict[str, Any]) -> None:
    """Non-blocking publish. Drops slipstream logs under backpressure rather than
    stalling the agent — losing a decorative log line beats freezing the demo."""
    try:
        _bus.put_nowait(event)
    except asyncio.QueueFull:
        if event.get("type") != "log":
            try:
                _bus.get_nowait()          # evict oldest, keep the important event
                _bus.put_nowait(event)
            except Exception:
                pass


# ---------------------------------------------------------------- data


def load_portfolio() -> dict[str, Any]:
    path = DATA / "portfolio.json"
    if not path.exists():
        raise HTTPException(503, "data/portfolio.json not built yet")
    return json.loads(path.read_text(encoding="utf-8"))


def load_news() -> list[dict[str, Any]]:
    path = DATA / "news_samples.json"
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    return payload if isinstance(payload, list) else payload.get("events", [])


@app.get("/api/portfolio")
async def api_portfolio() -> dict[str, Any]:
    return load_portfolio()


@app.get("/api/news")
async def api_news() -> list[dict[str, Any]]:
    return load_news()


@app.get("/api/health")
async def api_health() -> dict[str, Any]:
    return {
        "ok": True,
        "daytona_key": bool(os.getenv("DAYTONA_API_KEY")),
        "parallel_key": bool(os.getenv("PARALLEL_API_KEY")),
        "sec_user_agent": bool(os.getenv("SEC_USER_AGENT")),
        "portfolio": (DATA / "portfolio.json").exists(),
        "orchestrator": _orchestrator_available(),
        "run": _current_run,
    }


def _orchestrator_available() -> bool:
    try:
        import orchestrator  # noqa: F401
        return hasattr(orchestrator, "run_analysis")
    except Exception:
        return False


# ---------------------------------------------------------------- stream


@app.get("/api/stream")
async def api_stream() -> StreamingResponse:
    async def gen() -> AsyncIterator[bytes]:
        yield b": connected\n\n"
        last_ping = time.monotonic()
        while True:
            try:
                event = await asyncio.wait_for(_bus.get(), timeout=10.0)
                yield f"data: {json.dumps(event, default=str)}\n\n".encode()
            except asyncio.TimeoutError:
                pass
            if time.monotonic() - last_ping > 10:
                last_ping = time.monotonic()
                yield b": keepalive\n\n"   # keeps proxies from buffering us shut

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------- trigger


@app.post("/api/trigger")
async def api_trigger(payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Fire an analysis run. Body: {news_id} or a full news object."""
    if _run_lock.locked():
        raise HTTPException(409, "a run is already in progress")

    payload = payload or {}
    news = payload.get("news")
    if news is None:
        events = load_news()
        if not events:
            raise HTTPException(503, "no news events available")
        news_id = payload.get("news_id")
        news = next((e for e in events if e.get("id") == news_id), events[0])

    asyncio.create_task(_run(news))
    return {"started": True, "news_id": news.get("id"), "headline": news.get("headline")}


async def _run(news: dict[str, Any]) -> None:
    async with _run_lock:
        run_id = f"run-{int(time.time())}"
        _current_run.update(active=True, run_id=run_id, started=time.time())
        emit({"type": "state", "phase": "spawning", "attempt": 1, "run_id": run_id,
              "headline": news.get("headline")})
        try:
            import orchestrator
            portfolio = load_portfolio()
            result = await orchestrator.run_analysis(news, portfolio, emit)
            emit({"type": "result", "data": result})
        except Exception as exc:  # never let a failure kill the stream
            emit({"type": "state", "phase": "error", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            _current_run.update(active=False)


# ---------------------------------------------------------------- static


@app.get("/")
async def index() -> FileResponse:
    page = STATIC / "index.html"
    if not page.exists():
        raise HTTPException(503, "static/index.html not built yet")
    return FileResponse(page, headers={"Cache-Control": "no-store"})


if STATIC.exists():
    # index.html references its assets relatively ("app.js", "style.css") but is served
    # from "/", so those resolve to "/app.js". Mount static at BOTH paths — at root
    # (html=True) so the relative refs resolve, and at /static for explicit references.
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="root")
