"""Workstream B - the verifier gate.

verify(result, portfolio, measured) -> {"passed": bool, "checks": [...]}

Pure function. No network, no printing, no writes. Only reads impact.schema.json.
It must NEVER raise: the agent will emit garbage sometimes, and a garbage input
has to come back as a clean failing report.

Checks, always returned in V1..V6 order (the UI renders them as a live checklist):

  V1 schema valid            kind=schema    jsonschema Draft7, all errors
  V2 tickers match portfolio kind=semantic  full two-way coverage
  V3 positions reconcile     kind=semantic  <- THE MAIN GATE
  V4 impact_usd math         kind=semantic  first 3 offenders
  V5 ranges sane             kind=schema    weights / confidences / portfolio usd
  V6 verifier untampered     kind=semantic  measured["verifier_hash_ok"]

Deliberately NOT checked: citation URLs are never fetched, and budget numbers are
never validated for accuracy (V1 already pins them non-negative). Display data,
not gates.
"""

from __future__ import annotations

import json
import math
import os
from typing import Any

try:  # jsonschema is required for V1; everything else degrades gracefully.
    from jsonschema import Draft7Validator
except Exception:  # pragma: no cover - only hit if the dep is missing
    Draft7Validator = None  # type: ignore[assignment]

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "impact.schema.json")

# Tolerances (contract-fixed).
TOL_PCT = 0.01        # V3: portfolio reconciliation, percentage points
TOL_USD = 1.0         # V4/V5: dollar rounding
TOL_WEIGHT = 0.5      # V5: weight_pct sum vs 100
_EPS = 1e-9           # float noise guard so 0.010000000001 does not bounce a run

MAX_SCHEMA_ERRORS = 5     # keep the big-screen message readable
MAX_USD_OFFENDERS = 3     # spec: report at most the first 3

_CHECK_META = [
    ("V1", "schema valid", "schema"),
    ("V2", "tickers match portfolio", "semantic"),
    ("V3", "positions reconcile", "semantic"),
    ("V4", "impact_usd math", "semantic"),
    ("V5", "ranges sane", "schema"),
    ("V6", "verifier untampered", "semantic"),
]

_SCHEMA_CACHE: dict[str, Any] = {}


# ---------------------------------------------------------------- helpers ---

def _load_schema() -> dict | None:
    """Read + cache the schema. Returns None if it cannot be loaded."""
    if "schema" not in _SCHEMA_CACHE:
        try:
            with open(SCHEMA_PATH, "r", encoding="utf-8") as fh:
                _SCHEMA_CACHE["schema"] = json.load(fh)
        except Exception:
            _SCHEMA_CACHE["schema"] = None
    return _SCHEMA_CACHE["schema"]


def _num(value: Any) -> float | None:
    """Strict numeric coercion: no bools, no NaN/inf, no numeric strings."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    return None


def _f2(value: float | None) -> str:
    return "?" if value is None else f"{value:.2f}"


def _check(cid: str, name: str, kind: str, passed: bool, message: str = "") -> dict:
    return {"id": cid, "name": name, "passed": bool(passed), "message": message, "kind": kind}


def _position_items(result: Any) -> list[tuple[int, dict]]:
    """[(original_index, position_dict), ...] - non-dict entries are dropped."""
    if not isinstance(result, dict):
        return []
    positions = result.get("positions")
    if not isinstance(positions, list):
        return []
    return [(i, p) for i, p in enumerate(positions) if isinstance(p, dict)]


def _portfolio_tickers(portfolio: Any) -> list[str]:
    """Tolerates {"positions": [...]}, a bare list of positions, or a list of strings."""
    rows: Any = None
    if isinstance(portfolio, dict):
        rows = portfolio.get("positions")
    elif isinstance(portfolio, list):
        rows = portfolio
    if not isinstance(rows, list):
        return []
    out: list[str] = []
    for row in rows:
        if isinstance(row, dict):
            ticker = row.get("ticker")
        else:
            ticker = row
        if isinstance(ticker, str) and ticker.strip():
            out.append(ticker.strip())
    return out


def _fmt_error_path(err: Any) -> str:
    parts: list[str] = []
    for token in getattr(err, "absolute_path", []):
        if isinstance(token, int):
            parts.append(f"[{token}]")
        else:
            parts.append(("." if parts else "") + str(token))
    return "".join(parts) or "<root>"


def _join(items: list[str], limit: int, sep: str = "; ") -> str:
    shown = items[:limit]
    text = sep.join(shown)
    extra = len(items) - len(shown)
    if extra > 0:
        text += f" (+{extra} more)"
    return text


# ----------------------------------------------------------------- checks ---

def _v1_schema(result: Any) -> dict:
    cid, name, kind = _CHECK_META[0]
    schema = _load_schema()
    if schema is None:
        return _check(cid, name, kind, False, f"cannot read schema at {SCHEMA_PATH}")
    if Draft7Validator is None:
        return _check(cid, name, kind, False, "jsonschema not installed - cannot validate")

    errors = list(Draft7Validator(schema).iter_errors(result))
    if not errors:
        return _check(cid, name, kind, True, "matches PortfolioImpactAnalysis")

    formatted = sorted({f"{_fmt_error_path(e)}: {e.message}" for e in errors})
    plural = "error" if len(formatted) == 1 else "errors"
    return _check(cid, name, kind, False,
                  f"{len(formatted)} schema {plural} - " + _join(formatted, MAX_SCHEMA_ERRORS))


def _v2_tickers(result: Any, portfolio: Any) -> dict:
    cid, name, kind = _CHECK_META[1]
    held = _portfolio_tickers(portfolio)
    if not held:
        return _check(cid, name, kind, False, "portfolio has no positions - cannot check tickers")

    items = _position_items(result)
    if not items:
        return _check(cid, name, kind, False, "result has no positions")

    found: list[str] = []
    bad_type: list[str] = []
    for idx, pos in items:
        ticker = pos.get("ticker")
        if isinstance(ticker, str) and ticker.strip():
            found.append(ticker.strip())
        else:
            bad_type.append(f"positions[{idx}].ticker is not a ticker string")

    unknown = sorted(set(found) - set(held))
    missing = sorted(set(held) - set(found))

    problems: list[str] = []
    if unknown:
        problems.append("not in portfolio: " + ", ".join(unknown))
    if missing:
        problems.append("missing from positions: " + ", ".join(missing))
    problems.extend(bad_type)

    if problems:
        return _check(cid, name, kind, False, _join(problems, 3))
    return _check(cid, name, kind, True, f"all {len(held)} holdings covered")


def _v3_reconcile(result: Any) -> dict:
    """THE MAIN GATE. Sum(weight_pct/100 * impact_pct) == portfolio_impact_pct +/-0.01."""
    cid, name, kind = _CHECK_META[2]
    items = _position_items(result)
    if not items:
        return _check(cid, name, kind, False, "no positions to reconcile")

    total = 0.0
    for idx, pos in items:
        weight = _num(pos.get("weight_pct"))
        impact = _num(pos.get("impact_pct"))
        if weight is None:
            return _check(cid, name, kind, False,
                          f"cannot reconcile: positions[{idx}].weight_pct is not a number")
        if impact is None:
            return _check(cid, name, kind, False,
                          f"cannot reconcile: positions[{idx}].impact_pct is not a number")
        total += weight / 100.0 * impact

    declared = _num(result.get("portfolio_impact_pct")) if isinstance(result, dict) else None
    if declared is None:
        return _check(cid, name, kind, False,
                      f"Sum = {_f2(total)}, but portfolio_impact_pct is missing or not a number")

    diff = abs(total - declared)
    if diff > TOL_PCT + _EPS:
        return _check(cid, name, kind, False,
                      f"Sum = {_f2(total)}, declared {_f2(declared)} (diff {_f2(diff)})")
    return _check(cid, name, kind, True, f"Sum = {_f2(total)} = declared {_f2(declared)}")


def _v4_position_usd(result: Any) -> dict:
    cid, name, kind = _CHECK_META[3]
    items = _position_items(result)
    if not items:
        return _check(cid, name, kind, False, "no positions to check")

    offenders: list[str] = []
    for idx, pos in items:
        before = _num(pos.get("value_before_usd"))
        impact_pct = _num(pos.get("impact_pct"))
        impact_usd = _num(pos.get("impact_usd"))
        ticker = pos.get("ticker")
        label = f"positions[{idx}]"
        if isinstance(ticker, str) and ticker.strip():
            label += f" {ticker.strip()}"

        if before is None or impact_pct is None or impact_usd is None:
            offenders.append(f"{label}: non-numeric value_before_usd/impact_pct/impact_usd")
            continue

        expected = before * impact_pct / 100.0
        off = abs(impact_usd - expected)
        if off > TOL_USD + _EPS:
            offenders.append(
                f"{label}: impact_usd {_f2(impact_usd)}, expected {_f2(expected)} (off {_f2(off)})")

    if offenders:
        return _check(cid, name, kind, False, _join(offenders, MAX_USD_OFFENDERS))
    return _check(cid, name, kind, True, f"{len(items)} positions within ${TOL_USD:.0f}")


def _v5_ranges(result: Any) -> dict:
    cid, name, kind = _CHECK_META[4]
    if not isinstance(result, dict):
        return _check(cid, name, kind, False, "result is not an object")

    problems: list[str] = []
    items = _position_items(result)

    # weight_pct must sum to 100 +/-0.5
    if not items:
        problems.append("no positions to weigh")
    else:
        weights = [(_num(p.get("weight_pct")), i) for i, p in items]
        bad = [i for w, i in weights if w is None]
        if bad:
            problems.append(f"positions[{bad[0]}].weight_pct is not a number")
        else:
            total_weight = sum(w for w, _ in weights)  # type: ignore[misc]
            if abs(total_weight - 100.0) > TOL_WEIGHT + _EPS:
                problems.append(f"weight_pct sums to {_f2(total_weight)}, expected 100 +/-{TOL_WEIGHT}")

    # confidences in [0, 1]
    top_conf = result.get("confidence")
    if top_conf is not None:
        c = _num(top_conf)
        if c is None or not (0.0 <= c <= 1.0):
            problems.append(f"confidence {top_conf!r} outside [0,1]")
    for idx, pos in items:
        if "confidence" not in pos:
            continue
        c = _num(pos.get("confidence"))
        if c is None or not (0.0 <= c <= 1.0):
            problems.append(f"positions[{idx}].confidence {pos.get('confidence')!r} outside [0,1]")

    # portfolio_impact_usd ~= portfolio_value_before_usd * portfolio_impact_pct/100
    before = _num(result.get("portfolio_value_before_usd"))
    pct = _num(result.get("portfolio_impact_pct"))
    usd = _num(result.get("portfolio_impact_usd"))
    if before is None or pct is None or usd is None:
        problems.append("portfolio_value_before_usd/_impact_pct/_impact_usd not all numbers")
    else:
        expected = before * pct / 100.0
        off = abs(usd - expected)
        if off > TOL_USD + _EPS:
            problems.append(
                f"portfolio_impact_usd {_f2(usd)}, expected {_f2(expected)} (off {_f2(off)})")

    if problems:
        return _check(cid, name, kind, False, _join(problems, 3))
    return _check(cid, name, kind, True, "weights, confidences and portfolio totals sane")


def _v6_tamper(measured: Any) -> dict:
    cid, name, kind = _CHECK_META[5]
    ok = measured.get("verifier_hash_ok", True) if isinstance(measured, dict) else True
    if ok is True:
        return _check(cid, name, kind, True, "verifier hash unchanged")
    return _check(cid, name, kind, False, "verifier files modified during run")


# -------------------------------------------------------------- entrypoint ---

def verify(result: dict, portfolio: dict, measured: dict) -> dict:
    """Run V1..V6 and return {"passed": bool, "checks": [...]}.

    Every check is always present, in V1..V6 order, whether it passed or failed.
    Never raises - an exception inside a single check degrades to that check failing.
    """
    runners = [
        lambda: _v1_schema(result),
        lambda: _v2_tickers(result, portfolio),
        lambda: _v3_reconcile(result),
        lambda: _v4_position_usd(result),
        lambda: _v5_ranges(result),
        lambda: _v6_tamper(measured),
    ]

    checks: list[dict] = []
    for (cid, name, kind), run in zip(_CHECK_META, runners):
        try:
            check = run()
            if not isinstance(check, dict):
                raise TypeError("check did not return a dict")
        except Exception as exc:  # pragma: no cover - belt and braces
            check = _check(cid, name, kind, False, f"verifier error: {type(exc).__name__}: {exc}")
        checks.append(check)

    return {"passed": all(c["passed"] for c in checks), "checks": checks}
