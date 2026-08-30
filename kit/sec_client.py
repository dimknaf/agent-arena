"""SEC EDGAR client - free, keyless, but NOT header-less.

Docs:
  - https://www.sec.gov/search-filings/edgar-application-programming-interfaces
  - https://www.sec.gov/os/webmaster-faq#developers   (fair access policy)

CRITICAL: every request must carry a descriptive ``User-Agent`` identifying the
requester (name + contact email). Without it EDGAR returns 403 *and* blocks the
source IP for roughly ten minutes. This module refuses to make any request
unless ``SEC_USER_AGENT`` is set, and funnels everything through one shared
:class:`requests.Session` so the header can never be forgotten. Requests are
additionally rate limited to 5/second (EDGAR's published ceiling).

Public API:
    ticker_to_cik(ticker) -> str                    # 10-digit zero-padded CIK
    latest_filings(cik, forms=("8-K",), limit=5)    # newest first
    filing_text(cik, accession, primary_doc) -> str # HTML stripped to text
    get_call_count() -> int
"""

from __future__ import annotations

import os
import re
import threading
import time
from html import unescape
from typing import Iterable, Sequence

import requests

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"
ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/{doc}"

MAX_REQUESTS_PER_SECOND = 5
DEFAULT_TIMEOUT = 30

_call_count = 0
_session: requests.Session | None = None
_ticker_cache: dict[str, str] | None = None
_lock = threading.Lock()


class SECError(RuntimeError):
    """Raised for configuration or transport problems talking to EDGAR."""


# --------------------------------------------------------------------------- #
# Rate limiting: simple token bucket, 5 tokens/sec, burst 5
# --------------------------------------------------------------------------- #


class _TokenBucket:
    def __init__(self, rate: float = MAX_REQUESTS_PER_SECOND, capacity: float | None = None):
        self.rate = float(rate)
        self.capacity = float(capacity if capacity is not None else rate)
        self._tokens = self.capacity
        self._updated = time.monotonic()
        self._lock = threading.Lock()

    def take(self, n: float = 1.0) -> None:
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(self.capacity, self._tokens + (now - self._updated) * self.rate)
                self._updated = now
                if self._tokens >= n:
                    self._tokens -= n
                    return
                wait = (n - self._tokens) / self.rate
            time.sleep(max(wait, 0.01))


_bucket = _TokenBucket()


# --------------------------------------------------------------------------- #
# Shared session - the ONLY way this module touches the network
# --------------------------------------------------------------------------- #


def _user_agent() -> str:
    ua = (os.environ.get("SEC_USER_AGENT") or "").strip()
    if not ua:
        raise SECError(
            "SEC_USER_AGENT is not set. SEC EDGAR requires a descriptive User-Agent "
            'such as "AgentArena you@example.com"; requests without one get HTTP 403 '
            "and the IP is blocked for ~10 minutes. Set the env var and retry."
        )
    if "@" not in ua:
        # Not fatal, but EDGAR's fair-access policy asks for a contact address.
        ua = f"{ua} (contact: set SEC_USER_AGENT with an email)"
    return ua


def get_session() -> requests.Session:
    """Shared session with the mandatory EDGAR headers baked in."""
    global _session
    with _lock:
        if _session is None:
            s = requests.Session()
            s.headers.update(
                {
                    "User-Agent": _user_agent(),
                    "Accept-Encoding": "gzip, deflate",
                    "Accept": "application/json, text/html;q=0.9, */*;q=0.8",
                }
            )
            _session = s
        else:
            # Env var may have been fixed after a failed first call.
            _session.headers["User-Agent"] = _user_agent()
        return _session


def _get(url: str, *, timeout: int = DEFAULT_TIMEOUT) -> requests.Response:
    global _call_count
    session = get_session()  # raises if SEC_USER_AGENT missing
    _bucket.take()
    with _lock:
        _call_count += 1
    resp = session.get(url, timeout=timeout)
    if resp.status_code == 403:
        raise SECError(
            f"EDGAR returned 403 for {url}. The User-Agent header is almost certainly "
            f"missing or non-descriptive (currently: {session.headers.get('User-Agent')!r}). "
            "The source IP may now be blocked for ~10 minutes - stop retrying."
        )
    if resp.status_code == 429:
        raise SECError(f"EDGAR rate limited (429) on {url}. Back off and retry in a minute.")
    resp.raise_for_status()
    return resp


def get_call_count() -> int:
    """Number of HTTP requests this module has made."""
    return _call_count


# --------------------------------------------------------------------------- #
# 1. ticker -> CIK
# --------------------------------------------------------------------------- #


def _load_ticker_map() -> dict[str, str]:
    global _ticker_cache
    if _ticker_cache is None:
        data = _get(COMPANY_TICKERS_URL).json()
        # Shape: {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}, ...}
        rows = data.values() if isinstance(data, dict) else data
        _ticker_cache = {
            str(r["ticker"]).upper(): str(int(r["cik_str"])).zfill(10)
            for r in rows
            if r.get("ticker")
        }
    return _ticker_cache


def ticker_to_cik(ticker: str) -> str:
    """'AAPL' -> '0000320193'. Cached in memory after the first call."""
    key = str(ticker).strip().upper()
    mapping = _load_ticker_map()
    try:
        return mapping[key]
    except KeyError:
        raise SECError(f"Ticker {key!r} not found in SEC company_tickers.json") from None


# --------------------------------------------------------------------------- #
# 2. recent filings
# --------------------------------------------------------------------------- #


def latest_filings(
    cik: str,
    forms: Sequence[str] | Iterable[str] = ("8-K",),
    limit: int = 5,
) -> list[dict]:
    """Recent filings for a CIK, newest first.

    Reads ``filings.recent`` from the submissions endpoint. That block is a set of
    parallel arrays (accessionNumber, form, items, acceptanceDateTime, ...), so we
    zip them into row dicts. Sorted by ``acceptanceDateTime`` - the moment EDGAR
    actually accepted the filing - never by ``filingDate``, which is date-only and
    ties for every filing on the same day.

    Returns dicts with:
        accession, accession_nodash, form, items, filing_date, acceptance_datetime,
        report_date, primary_doc, primary_doc_description, url, index_url, cik
    """
    cik10 = str(cik).strip().upper().replace("CIK", "").zfill(10)
    wanted = {str(f).upper() for f in forms} if forms else None

    data = _get(SUBMISSIONS_URL.format(cik10=cik10)).json()
    recent = data.get("filings", {}).get("recent", {})
    accessions = recent.get("accessionNumber", [])

    def col(name: str) -> list:
        v = recent.get(name, [])
        return list(v) + [""] * (len(accessions) - len(v))

    forms_col = col("form")
    items_col = col("items")
    fdate_col = col("filingDate")
    adate_col = col("acceptanceDateTime")
    rdate_col = col("reportDate")
    doc_col = col("primaryDocument")
    desc_col = col("primaryDocDescription")

    cik_int = str(int(cik10))
    rows: list[dict] = []
    for i, acc in enumerate(accessions):
        form = str(forms_col[i]).upper()
        if wanted and form not in wanted:
            continue
        acc_nodash = str(acc).replace("-", "")
        doc = str(doc_col[i] or "")
        rows.append(
            {
                "cik": cik10,
                "accession": str(acc),
                "accession_nodash": acc_nodash,
                "form": forms_col[i],
                # 8-K item codes, e.g. "2.02,9.01" - already provided by EDGAR.
                "items": [s.strip() for s in str(items_col[i] or "").split(",") if s.strip()],
                "filing_date": fdate_col[i],
                "acceptance_datetime": adate_col[i],
                "report_date": rdate_col[i],
                "primary_doc": doc,
                "primary_doc_description": desc_col[i],
                "url": ARCHIVES_URL.format(cik_int=cik_int, acc_nodash=acc_nodash, doc=doc)
                if doc
                else "",
                "index_url": (
                    f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/"
                    f"{acc}-index.htm"
                ),
            }
        )

    rows.sort(key=lambda r: str(r.get("acceptance_datetime") or ""), reverse=True)
    return rows[: max(0, int(limit))]


# --------------------------------------------------------------------------- #
# 3. filing text
# --------------------------------------------------------------------------- #

_SCRIPT_STYLE_RE = re.compile(r"(?is)<(script|style|head)\b.*?</\1\s*>")
_BLOCK_RE = re.compile(r"(?i)</?(p|div|br|tr|li|h[1-6]|table|section)\b[^>]*>")
_TAG_RE = re.compile(r"(?s)<[^>]+>")
_WS_RE = re.compile(r"[ \t\r\f\v]+")
_NL_RE = re.compile(r"\n{3,}")


def html_to_text(html: str) -> str:
    """Strip HTML to readable plain text (no external deps)."""
    txt = _SCRIPT_STYLE_RE.sub(" ", html)
    txt = _BLOCK_RE.sub("\n", txt)
    txt = _TAG_RE.sub(" ", txt)
    txt = unescape(txt)
    txt = txt.replace("\xa0", " ")
    txt = _WS_RE.sub(" ", txt)
    txt = "\n".join(line.strip() for line in txt.split("\n"))
    return _NL_RE.sub("\n\n", txt).strip()


def filing_text(cik: str, accession: str, primary_doc: str, max_chars: int = 40000) -> str:
    """Fetch a filing's primary document and return it as plain text."""
    cik_int = str(int(str(cik).strip().upper().replace("CIK", "")))
    acc_nodash = str(accession).replace("-", "")
    url = ARCHIVES_URL.format(cik_int=cik_int, acc_nodash=acc_nodash, doc=primary_doc)
    resp = _get(url)
    text = html_to_text(resp.text)
    return text[:max_chars] if max_chars and len(text) > max_chars else text


# --------------------------------------------------------------------------- #
# Convenience
# --------------------------------------------------------------------------- #


def recent_8ks_for_ticker(ticker: str, limit: int = 5) -> list[dict]:
    """One-liner: ticker -> newest 8-K filings (with item codes)."""
    return latest_filings(ticker_to_cik(ticker), forms=("8-K",), limit=limit)


if __name__ == "__main__":  # pragma: no cover - smoke test
    import json
    import sys

    tick = sys.argv[1] if len(sys.argv) > 1 else "NVDA"
    try:
        cik = ticker_to_cik(tick)
        print(f"{tick} -> CIK {cik}")
        rows = latest_filings(cik, forms=("8-K",), limit=3)
        for r in rows:
            print(
                json.dumps(
                    {k: r[k] for k in ("form", "items", "acceptance_datetime", "primary_doc")},
                    indent=None,
                )
            )
        if rows and rows[0]["primary_doc"]:
            body = filing_text(cik, rows[0]["accession"], rows[0]["primary_doc"], max_chars=600)
            print("\n--- first 600 chars of newest 8-K ---")
            print(body)
        print(f"\nsec requests used: {get_call_count()}")
    except SECError as exc:
        print(f"SECError: {exc}")
        sys.exit(1)
