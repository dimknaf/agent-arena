"""Parallel AI client - Search API + Extract API.

Verified against the authoritative OpenAPI spec at
https://docs.parallel.ai/public-openapi.json  (servers: https://api.parallel.ai)
plus https://docs.parallel.ai/search/search-quickstart and
https://docs.parallel.ai/extract/extract-quickstart  (read 2026-08-30).

Shape, so nobody has to guess:
  * Base URL  : https://api.parallel.ai
  * Auth      : header ``x-api-key: <PARALLEL_API_KEY>``   (NOT Authorization: Bearer)
  * Search    : POST /v1/search   body {"search_queries":[...], "objective":"...",
                "mode":"turbo|fast|basic|advanced", "max_chars_total":N,
                "advanced_settings":{"max_results":N,
                                     "excerpt_settings":{"max_chars_per_result":N}}}
                -> {"search_id","results":[{"url","title","publish_date","excerpts":[...]}],
                    "usage":[...], "session_id"}
  * Extract   : POST /v1/extract  body {"urls":[...], "objective":"...",
                "advanced_settings":{"full_content":true}}
                -> {"extract_id","results":[{"url","title","publish_date","excerpts",
                    "full_content"}], "errors":[{"url","error_type",...}], "session_id"}

Gotchas the spec enforces (both request bodies are ``additionalProperties: false``,
so an unknown top-level key is a hard 422):
  * ``max_results`` is NOT top-level - it nests under ``advanced_settings``.
  * ``max_chars_per_result`` nests under ``advanced_settings.excerpt_settings``.
  * There is no ``processor`` field on Search (that belongs to the Task API).
  * Extract has a partial-failure model: a URL that fails appears in ``errors``,
    not in ``results``. Never assume 1:1 ordering with the requested urls.
  * ``full_content`` defaults to false; without it you only get excerpts.

The legacy ``/v1beta`` paths (which needed a ``parallel-beta`` header) are retired;
this client targets ``/v1`` and falls back to ``/v1beta`` only if ``/v1`` 404s.

Public API:
    search(query, max_results=5)  -> list[dict]  # {url,title,published_at,snippet,excerpts}
    extract(url)                  -> str         # clean article text
    extract_many(urls)            -> dict[str,str]
    get_call_count()              -> int         # for the budget block
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Sequence

import requests

BASE_URL = os.environ.get("PARALLEL_BASE_URL", "https://api.parallel.ai").rstrip("/")
SEARCH_PATH = "/v1/search"
EXTRACT_PATH = "/v1/extract"
BETA_SEARCH_PATH = "/v1beta/search"
BETA_EXTRACT_PATH = "/v1beta/extract"
BETA_HEADER = {"parallel-beta": "search-extract-2025-10-10"}

DEFAULT_TIMEOUT = 90  # 'advanced' mode is ~3s but live fetches can be much slower

_call_count = 0
_session: requests.Session | None = None
_session_id: str | None = None  # round-tripped between calls; improves context
_lock = threading.Lock()


class ParallelError(RuntimeError):
    """Configuration or transport error talking to the Parallel API."""


def _api_key() -> str:
    key = (os.environ.get("PARALLEL_API_KEY") or "").strip()
    if not key:
        raise ParallelError(
            "PARALLEL_API_KEY is not set. Get one at https://platform.parallel.ai "
            "and export it before calling search()/extract()."
        )
    return key


def get_session() -> requests.Session:
    global _session
    with _lock:
        if _session is None:
            s = requests.Session()
            s.headers.update({"Content-Type": "application/json", "User-Agent": "AgentArena/1.0"})
            _session = s
        _session.headers["x-api-key"] = _api_key()
        return _session


def get_call_count() -> int:
    """Total Parallel API calls made by this process (report as parallel_calls_used)."""
    return _call_count


def reset_call_count() -> None:
    global _call_count
    with _lock:
        _call_count = 0


def get_session_id() -> str | None:
    """The Parallel session id captured from the last response, if any."""
    return _session_id


def _post(path: str, payload: dict, *, beta_path: str = "", timeout: int = DEFAULT_TIMEOUT) -> dict:
    global _call_count, _session_id
    session = get_session()
    if _session_id and "session_id" not in payload:
        payload = {**payload, "session_id": _session_id}

    with _lock:
        _call_count += 1

    url = f"{BASE_URL}{path}"
    resp = session.post(url, json=payload, timeout=timeout)

    # The v1beta paths are retired, but fall back once if this deployment is older.
    if resp.status_code == 404 and beta_path:
        resp = session.post(
            f"{BASE_URL}{beta_path}", json=payload, headers=BETA_HEADER, timeout=timeout
        )

    if resp.status_code == 401 or resp.status_code == 403:
        raise ParallelError(
            f"Parallel API auth failed ({resp.status_code}). Check PARALLEL_API_KEY; "
            "the header must be 'x-api-key', not 'Authorization: Bearer'. "
            f"Body: {resp.text[:300]}"
        )
    if resp.status_code >= 400:
        # Error envelope: {"type":"error","error":{"ref_id":...,"message":...,"detail":...}}
        detail = resp.text[:600]
        try:
            err = resp.json().get("error", {})
            detail = f"{err.get('message')} | {err.get('detail')} | ref={err.get('ref_id')}"
        except Exception:
            pass
        raise ParallelError(f"Parallel {path} failed with HTTP {resp.status_code}: {detail}")

    data = resp.json()
    sid = data.get("session_id")
    if sid:
        _session_id = sid
    return data


# --------------------------------------------------------------------------- #
# Search
# --------------------------------------------------------------------------- #


def search(
    query: str,
    max_results: int = 5,
    *,
    objective: str | None = None,
    mode: str = "basic",
    max_chars_per_result: int = 4000,
    max_chars_total: int | None = None,
    include_domains: Sequence[str] | None = None,
    exclude_domains: Sequence[str] | None = None,
    after_date: str | None = None,
) -> list[dict]:
    """Web search. Returns a list of normalised result dicts.

    Each item: {"url","title","published_at","snippet","excerpts"} where ``snippet``
    is the excerpts joined into one block of text (usually enough on its own -
    only call :func:`extract` when you need the full article).

    ``mode`` is one of turbo (~250ms) / fast (~700ms) / basic (~1s) /
    advanced (~3s, the API default). ``basic`` is a good default here - anything
    else risks a 422 since the enum is closed.
    """
    advanced: dict[str, Any] = {"max_results": int(max_results)}
    if max_chars_per_result:
        advanced["excerpt_settings"] = {"max_chars_per_result": int(max_chars_per_result)}
    source_policy: dict[str, Any] = {}
    if include_domains:
        source_policy["include_domains"] = list(include_domains)
    if exclude_domains:
        source_policy["exclude_domains"] = list(exclude_domains)
    if after_date:
        source_policy["after_date"] = after_date
    if source_policy:
        advanced["source_policy"] = source_policy

    payload: dict[str, Any] = {
        "search_queries": [query] if isinstance(query, str) else list(query),
        "objective": objective or (query if isinstance(query, str) else " ".join(query)),
        "mode": mode,
        "advanced_settings": advanced,
    }
    if max_chars_total:
        payload["max_chars_total"] = int(max_chars_total)

    data = _post(SEARCH_PATH, payload, beta_path=BETA_SEARCH_PATH)
    return [_normalise(r) for r in (data.get("results") or [])][:max_results]


def _normalise(r: dict) -> dict:
    excerpts = [e for e in (r.get("excerpts") or []) if e]
    return {
        "url": r.get("url") or "",
        "title": r.get("title") or "",
        "published_at": r.get("publish_date") or "",
        "snippet": "\n\n".join(excerpts).strip(),
        "excerpts": excerpts,
        "full_content": r.get("full_content") or "",
    }


# --------------------------------------------------------------------------- #
# Extract
# --------------------------------------------------------------------------- #


def extract(url: str, *, objective: str | None = None, max_chars: int = 50000) -> str:
    """Fetch one URL and return clean article text (markdown-ish plain text).

    Falls back to the objective-aligned excerpts if ``full_content`` comes back
    empty, and returns "" if the URL is in the response's ``errors`` array.
    """
    out = extract_many([url], objective=objective, max_chars=max_chars)
    return out.get(url, "") or (next(iter(out.values()), "") if len(out) == 1 else "")


def extract_many(
    urls: Sequence[str],
    *,
    objective: str | None = None,
    max_chars: int = 50000,
) -> dict[str, str]:
    """Extract up to 20 URLs in one call. Returns {url: text}; failures map to "".

    Note the partial-failure model - a URL that could not be fetched shows up in
    the response's ``errors`` list, never in ``results``, so we key by url.
    """
    urls = [u for u in urls if u][:20]
    if not urls:
        return {}

    payload: dict[str, Any] = {
        "urls": list(urls),
        "advanced_settings": {"full_content": {"max_chars_per_result": int(max_chars)}},
    }
    if objective:
        payload["objective"] = objective

    data = _post(EXTRACT_PATH, payload, beta_path=BETA_EXTRACT_PATH)

    out: dict[str, str] = {u: "" for u in urls}
    for r in data.get("results") or []:
        text = r.get("full_content") or "\n\n".join(r.get("excerpts") or [])
        out[r.get("url") or ""] = (text or "").strip()[:max_chars]
    for e in data.get("errors") or []:
        out.setdefault(e.get("url") or "", "")
    return out


def search_and_extract(query: str, max_results: int = 3, **kw) -> list[dict]:
    """Search, then pull full text for the hits. 2 API calls total."""
    hits = search(query, max_results=max_results, **kw)
    texts = extract_many([h["url"] for h in hits], objective=query)
    for h in hits:
        h["full_content"] = texts.get(h["url"], "") or h["snippet"]
    return hits


if __name__ == "__main__":  # pragma: no cover - smoke test
    import sys

    q = sys.argv[1] if len(sys.argv) > 1 else "TSMC advanced packaging CoWoS capacity outage impact NVIDIA"
    try:
        results = search(q, max_results=3)
        print(f"search({q!r}) -> {len(results)} results")
        for r in results:
            print(f"  - {r['title'][:80]!r}\n    {r['url']}  ({r['published_at']})")
            print(f"    snippet: {r['snippet'][:180]!r}")
        if results:
            body = extract(results[0]["url"], objective=q, max_chars=1200)
            print(f"\nextract({results[0]['url']}) -> {len(body)} chars")
            print(body[:600])
        print(f"\nparallel_calls_used: {get_call_count()}  session_id={get_session_id()}")
    except ParallelError as exc:
        print(f"ParallelError: {exc}")
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001
        print(f"{type(exc).__name__}: {exc}")
        print(json.dumps({"hint": "check BASE_URL/paths against https://docs.parallel.ai"}))
        sys.exit(1)
