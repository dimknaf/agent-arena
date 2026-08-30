"""AGENT ARENA — FastAPI integration layer.

Serves the arena UI, exposes the portfolio, relays orchestrator events to the
browser over SSE, and triggers analysis runs.

One process, no build step:  uvicorn app:app --reload --port 8000
"""
from __future__ import annotations

import asyncio
import json
import os
import re
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
    """Live news only. The canned samples are NOT a runtime source any more —
    only the hypothetical portfolio is allowed to be fixed data."""
    if _live_news_cache["events"]:
        return list(_live_news_cache["events"])
    return (await api_news_live()).get("events", [])


# Live news, cached. kit.parallel_client is synchronous `requests`, so every call
# goes through asyncio.to_thread — calling it inline would block the event loop and
# stall the SSE stream, which is the one thing this app must never do.
_live_news_cache: dict[str, Any] = {"events": [], "fetched_at": 0.0}
_LIVE_TTL_S = 180.0


# Headlines say "Nvidia", not "NVDA" — match on company aliases as well as symbols,
# plus the off-portfolio entities (TSMC, OPEC, the Fed) that drive second-order effects.
_ALIASES: dict[str, tuple[str, ...]] = {
    "AAPL": ("apple", "iphone"),
    "NVDA": ("nvidia", "geforce", "blackwell", "h100", "h200"),
    "MSFT": ("microsoft", "azure", "openai"),
    "AVGO": ("broadcom", "vmware"),
    "JPM": ("jpmorgan", "jp morgan"),
    "XOM": ("exxon", "opec", "crude", "brent"),
    "WMT": ("walmart",),
    "JNJ": ("johnson & johnson", "johnson and johnson"),
    "CAT": ("caterpillar",),
    "NEE": ("nextera", "utility", "grid"),
}
# Suppliers and macro actors that hit several holdings at once.
_CHAIN: dict[str, tuple[str, ...]] = {
    "tsmc": ("NVDA", "AVGO", "AAPL"),
    "taiwan semiconductor": ("NVDA", "AVGO", "AAPL"),
    "cowos": ("NVDA", "AVGO"),
    "federal reserve": ("JPM", "NEE", "MSFT"),
    "opec": ("XOM", "CAT"),
    "datacenter": ("NVDA", "MSFT", "NEE"),
    "data center": ("NVDA", "MSFT", "NEE"),
}


def _hints_for(text: str, tickers: list[str]) -> list[str]:
    low = text.lower()
    upper = text.upper()
    hits: set[str] = set()
    for t in tickers:
        # Word boundaries matter: a bare substring test makes "CAT" match ALLOCATION
        # and INDICATE, which tags half the portfolio onto every story.
        if re.search(rf"\b{re.escape(t)}\b", upper) or any(a in low for a in _ALIASES.get(t, ())):
            hits.add(t)
    for term, affected in _CHAIN.items():
        if term in low:
            hits.update(a for a in affected if a in tickers)
    return sorted(hits)


def _fetch_live_news(tickers: list[str], after: str) -> list[dict[str, Any]]:
    from kit import parallel_client

    # search() accepts a LIST of queries in one billed call. Specific queries beat one
    # broad one: a single "news for AAPL NVDA MSFT..." query just returns generic
    # market-roundup landing pages, which are useless as an analysis trigger.
    queries = [
        "Nvidia AI chip supply constraint or datacenter demand news",
        "TSMC semiconductor fab capacity or advanced packaging news",
        "Apple iPhone supply chain or chip sourcing news",
        "Microsoft AI capex or Azure datacenter spending news",
        "OPEC oil output decision or crude price shock",
        "Federal Reserve rate decision or inflation surprise markets",
    ]
    hits = parallel_client.search(
        queries,
        max_results=8,
        mode="fast",
        objective=("A specific, recent, market-moving corporate or macro EVENT that would "
                   "measurably move US large-cap equities. Prefer a concrete happening with "
                   "a date over a market-roundup or a live-updates landing page."),
        include_domains=["reuters.com", "apnews.com", "cnbc.com", "bloomberg.com",
                         "ft.com", "tomshardware.com", "theverge.com"],
        after_date=after,
    )
    # Drop evergreen landing pages - they are not events and make a poor trigger.
    junk = ("live-updates", "/markets/us", "stock-market-today", "/quotes/",
            "stock market news for", "breaking stock market news",
            "stock price, quote", "- stock price")
    hits = [h for h in hits
            if not any(j in (h.get("url", "") + " " + h.get("title", "")).lower() for j in junk)]
    events = []
    for i, h in enumerate(hits):
        title = (h.get("title") or "").strip()
        if not title:
            continue
        events.append({
            "id": f"live-{i}-{abs(hash(h.get('url', ''))) % 100000}",
            "headline": title,
            "summary": (h.get("snippet") or "")[:1200],
            "published_at": h.get("published_at") or "",
            "url": h.get("url") or "",
            "tickers_hint": _hints_for(f"{title} {h.get('snippet', '')[:600]}", tickers),
            "live": True,
        })
    # An event nothing in the book is exposed to makes a dull analysis - rank those last.
    events.sort(key=lambda e: -len(e["tickers_hint"]))
    return events


@app.get("/api/news/live")
async def api_news_live(force: bool = False) -> dict[str, Any]:
    """Genuinely live headlines via Parallel Search. Falls back to the canned
    samples on any failure — the news strip must never end up empty."""
    now = time.time()
    if not force and _live_news_cache["events"] and now - _live_news_cache["fetched_at"] < _LIVE_TTL_S:
        return {"events": _live_news_cache["events"], "cached": True, "live": True}

    try:
        portfolio = load_portfolio()
        tickers = [p["ticker"] for p in portfolio.get("positions", [])]
        after = time.strftime("%Y-%m-%d", time.gmtime(now - 5 * 86400))
        events = await asyncio.wait_for(
            asyncio.to_thread(_fetch_live_news, tickers, after), timeout=45.0
        )
        if not events:
            raise RuntimeError("search returned nothing usable")
        _live_news_cache.update(events=events, fetched_at=now)
        return {"events": events, "cached": False, "live": True}
    except Exception as exc:
        # Report the failure honestly. We do NOT silently substitute canned events —
        # a demo that claims live news and quietly serves fixtures is worse than one
        # that says the scan failed.
        return {"events": [], "cached": False, "live": False,
                "error": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------- prompt


@app.get("/api/prompt")
async def api_prompt(news_id: str | None = None) -> dict[str, Any]:
    """The exact prompt sent to Codex, so it can be sanity-checked before a run."""
    try:
        import orchestrator
        portfolio = load_portfolio()
        events = await api_news()
        news = next((e for e in events if e.get("id") == news_id), None) or (
            events[0] if events else {"id": "none", "headline": "(no news selected)"})
        orch = orchestrator.Orchestrator(lambda _e: None)
        prompt = orch._build_prompt(news, portfolio, 1)
        return {"prompt": prompt, "chars": len(prompt), "news_id": news.get("id")}
    except Exception as exc:
        return {"prompt": "", "error": f"{type(exc).__name__}: {exc}"}


# ---------------------------------------------------------------- past runs


RUNS = ROOT / "runs"


@app.get("/api/runs")
async def api_runs() -> list[dict[str, Any]]:
    """Past REAL runs, newest first. These are the replay source — we never
    replay invented data."""
    out = []
    if RUNS.exists():
        for d in sorted(RUNS.iterdir(), reverse=True):
            f = d / "run.json"
            if not (d.is_dir() and f.exists()):
                continue
            try:
                r = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            res = r.get("result") or {}
            out.append({
                "run_id": r.get("run_id", d.name),
                "passed": r.get("passed"),
                "attempts": r.get("attempts"),
                "elapsed_s": r.get("elapsed_s"),
                "tokens_total": r.get("tokens_total"),
                "headline": (r.get("news") or {}).get("headline") or res.get("headline"),
                "events": (d / "events.jsonl").exists(),
            })
    return out[:40]


@app.get("/api/runs/{run_id}")
async def api_run(run_id: str) -> dict[str, Any]:
    """One past run, with its recorded event stream if we captured one."""
    d = RUNS / run_id
    if not d.is_dir():
        matches = [p for p in RUNS.iterdir() if p.is_dir() and p.name.startswith(run_id)] \
            if RUNS.exists() else []
        if not matches:
            raise HTTPException(404, f"no such run: {run_id}")
        d = matches[0]
    f = d / "run.json"
    if not f.exists():
        raise HTTPException(404, f"run {d.name} has no run.json")
    payload = json.loads(f.read_text(encoding="utf-8"))

    events: list[dict[str, Any]] = []
    ef = d / "events.jsonl"
    if ef.exists():
        for line in ef.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except Exception:
                pass
    payload["events"] = events
    return payload


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
    # Claim the run SYNCHRONOUSLY. _run_lock is acquired inside a detached task, so
    # checking it here leaves a window where two fast clicks both pass and the second
    # silently starts a sandbox the moment the first finishes.
    if _current_run["active"] or _run_lock.locked():
        raise HTTPException(409, "a run is already in progress")
    _current_run["active"] = True

    try:
        payload = payload or {}
        news = payload.get("news")

        if news is None:
            available = list(_live_news_cache["events"])
            ids = payload.get("news_ids") or (
                [payload["news_id"]] if payload.get("news_id") else [])
            if not available:
                raise HTTPException(503, "no news available - run a live scan first")
            if ids:
                news = [e for e in available if e.get("id") in ids]
                missing = set(ids) - {e.get("id") for e in news}
                if missing:
                    raise HTTPException(404, f"unknown news_id(s): {sorted(missing)}")
            else:
                news = [available[0]]

        # One combined scenario: several stories go into a single sandbox so the
        # agent can reason about how they compound or offset each other.
        if isinstance(news, dict):
            news = [news]
        if not news:
            raise HTTPException(400, "no news events selected")
    except Exception:
        _current_run["active"] = False   # never strand the claim on a bad request
        raise

    asyncio.create_task(_run(news))
    return {"started": True,
            "count": len(news),
            "news_ids": [e.get("id") for e in news],
            "headlines": [e.get("headline") for e in news]}


async def _run(news: list[dict[str, Any]]) -> None:
    async with _run_lock:
        run_id = f"run-{int(time.time())}"
        _current_run.update(active=True, run_id=run_id, started=time.time())

        # Record every event so this run can be replayed later. Replay must be a
        # genuine past run, never a fixture.
        recorded: list[dict[str, Any]] = []

        def rec(event: dict[str, Any]) -> None:
            recorded.append(event)
            emit(event)

        rec({"type": "state", "phase": "spawning", "attempt": 1, "run_id": run_id,
             "headline": news[0].get("headline"),
             "headlines": [e.get("headline") for e in news]})
        try:
            import orchestrator
            portfolio = load_portfolio()
            payload = news[0] if len(news) == 1 else news
            result = await orchestrator.run_analysis(payload, portfolio, rec)
            rec({"type": "result", "data": result})
        except Exception as exc:  # never let a failure kill the stream
            rec({"type": "state", "phase": "error", "message": f"{type(exc).__name__}: {exc}"})
        finally:
            _current_run.update(active=False)
            try:
                d = RUNS / run_id
                d.mkdir(parents=True, exist_ok=True)
                with (d / "events.jsonl").open("w", encoding="utf-8") as fh:
                    for e in recorded:
                        fh.write(json.dumps(e, default=str) + "\n")
                if not (d / "run.json").exists():
                    (d / "run.json").write_text(json.dumps(
                        {"run_id": run_id, "news": news[0], "news_all": news},
                        indent=2, default=str), encoding="utf-8")
            except Exception:
                pass


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
