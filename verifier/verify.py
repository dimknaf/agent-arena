"""Workstream B - the verifier gate (forward-looking fundamental-value shape).

verify(result, portfolio, measured) -> {"passed": bool, "checks": [...]}

Pure function. No network, no printing, no writes. Only reads impact.schema.json.
It must NEVER raise: the agent will emit garbage sometimes, and a garbage or
half-built 3x3 grid has to come back as a clean failing report, not a KeyError.

Checks, always returned in V1..V7 order (the UI renders them as a live checklist).
`kind` drives the orchestrator's retry routing: schema -> cheap MECHANICAL FIX lane,
semantic -> expensive RE-REASONING lane. V5 is deliberately split so that fixable
bookkeeping does not pay re-reasoning prices.

  V1  schema valid            kind=schema    jsonschema Draft7, all errors
  V2  tickers match portfolio kind=semantic  full two-way coverage
  V3  nine reconciliation     kind=semantic  <- THE PRIMARY GATE
  V4  impact_usd math         kind=semantic  90 cells, first 3 offenders
  V5a ranges sane             kind=schema    weights / confidences / portfolio usd
  V5b scenario bands ordered  kind=semantic  low <= base <= high, position + portfolio
  V6  verifier untampered     kind=semantic  measured hash
  V7  value chain closes      kind=semantic  value_at_stake / market_cap == long_term base

V3 runs one gate per (horizon, variant) pair - 9 in all - and reports as a single
check whose message names the failing pair and both numbers.

Deliberately NOT checked: citation URLs are never fetched; budget numbers are never
validated for accuracy (V1 pins them non-negative); and the two intermediate chain
fields (revenue_at_stake_usd, profit_at_stake_usd) are required-but-unchecked display
data. Only the final identity value_at_stake_usd/market_cap_usd is gated, by V7.
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

HORIZONS = ("short_term", "medium_term", "long_term")
VARIANTS = ("low", "base", "high")

# Tolerances (contract-fixed).
TOL_PCT = 0.01        # V3: each of the nine reconciliation gates, percentage points
TOL_USD = 1.0         # V4/V5: dollar rounding
TOL_WEIGHT = 0.5      # V5: weight_pct sum vs 100
TOL_CHAIN = 0.05      # V7: value chain closure, percentage points
_EPS = 1e-9           # float noise guard so 0.010000000001 does not bounce a run

MAX_SCHEMA_ERRORS = 5     # keep the big-screen message readable
MAX_OFFENDERS = 3         # spec: report at most the first 3

_CHECK_META = [
    ("V1", "schema valid", "schema"),
    ("V2", "tickers match portfolio", "semantic"),
    ("V3", "nine gates reconcile", "semantic"),
    ("V4", "impact_usd math", "semantic"),
    ("V5a", "ranges sane", "schema"),
    ("V5b", "scenario bands ordered", "semantic"),
    ("V6", "verifier untampered", "semantic"),
    ("V7", "value chain closes", "semantic"),
]

# The six fundamental-chain inputs. All zero == the agent declared no value chain.
CHAIN_INPUTS = ("revenue_line_usd", "affected_fraction", "duration_months",
                "permanent_share", "margin", "earnings_multiple")

_SCHEMA_CACHE: dict[str, Any] = {}


# ---------------------------------------------------------------- helpers ---

def _load_schema() -> dict | None:
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


def _dig(obj: Any, *keys: str) -> Any:
    """Walk nested dicts without ever raising. Returns None on any miss."""
    cur = obj
    for key in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
    return cur


def _cell(container: Any, horizon: str, metric: str, variant: str) -> float | None:
    """One cell of a 3x3 grid: horizons[h][impact_pct|impact_usd][low|base|high]."""
    return _num(_dig(container, "horizons", horizon, metric, variant))


def _position_items(result: Any) -> list[tuple[int, dict]]:
    """[(original_index, position_dict), ...] - non-dict entries are dropped."""
    if not isinstance(result, dict):
        return []
    positions = result.get("positions")
    if not isinstance(positions, list):
        return []
    return [(i, p) for i, p in enumerate(positions) if isinstance(p, dict)]


def _label(idx: int, pos: dict) -> str:
    ticker = pos.get("ticker")
    if isinstance(ticker, str) and ticker.strip():
        return f"positions[{idx}] {ticker.strip()}"
    return f"positions[{idx}]"


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
        ticker = row.get("ticker") if isinstance(row, dict) else row
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
    problems: list[str] = []
    for idx, pos in items:
        ticker = pos.get("ticker")
        if isinstance(ticker, str) and ticker.strip():
            found.append(ticker.strip())
        else:
            problems.append(f"positions[{idx}].ticker is not a ticker string")

    unknown = sorted(set(found) - set(held))
    missing = sorted(set(held) - set(found))
    if unknown:
        problems.insert(0, "not in portfolio: " + ", ".join(unknown))
    if missing:
        problems.insert(0, "missing from positions: " + ", ".join(missing))

    if problems:
        return _check(cid, name, kind, False, _join(problems, MAX_OFFENDERS))
    return _check(cid, name, kind, True, f"all {len(held)} holdings covered")


def _v3_reconcile(result: Any) -> dict:
    """THE PRIMARY GATE. Nine gates: one per (horizon, variant) pair."""
    cid, name, kind = _CHECK_META[2]
    items = _position_items(result)
    if not items:
        return _check(cid, name, kind, False, "no positions to reconcile")

    failures: list[str] = []
    base_sum: float | None = None

    for horizon in HORIZONS:
        for variant in VARIANTS:
            pair = f"{horizon}/{variant}"
            total = 0.0
            broken: str | None = None

            for idx, pos in items:
                weight = _num(pos.get("weight_pct"))
                impact = _cell(pos, horizon, "impact_pct", variant)
                if weight is None:
                    broken = f"{pair}: {_label(idx, pos)}.weight_pct is not a number"
                    break
                if impact is None:
                    broken = (f"{pair}: {_label(idx, pos)}."
                              f"horizons.{horizon}.impact_pct.{variant} is missing or not a number")
                    break
                total += weight / 100.0 * impact

            if broken:
                failures.append(broken)
                continue

            declared = _cell(result, horizon, "impact_pct", variant)
            if declared is None:
                failures.append(f"{pair}: Sum = {_f2(total)}, but portfolio "
                                f"horizons.{horizon}.impact_pct.{variant} is missing "
                                f"or not a number")
                continue

            if horizon == "long_term" and variant == "base":
                base_sum = total

            diff = abs(total - declared)
            if diff > TOL_PCT + _EPS:
                failures.append(f"{pair}: Sum = {_f2(total)}, declared {_f2(declared)} "
                                f"(diff {_f2(diff)})")

    if failures:
        return _check(cid, name, kind, False,
                      f"{len(failures)}/9 gates failed - " + _join(failures, MAX_OFFENDERS))
    tail = f" (long_term/base Sum = {_f2(base_sum)})" if base_sum is not None else ""
    return _check(cid, name, kind, True, f"9/9 gates reconcile{tail}")


def _v4_position_usd(result: Any) -> dict:
    """impact_usd == value_before_usd * impact_pct/100 for all 9 cells of every position."""
    cid, name, kind = _CHECK_META[3]
    items = _position_items(result)
    if not items:
        return _check(cid, name, kind, False, "no positions to check")

    offenders: list[str] = []
    cells = 0
    for idx, pos in items:
        before = _num(pos.get("value_before_usd"))
        if before is None:
            offenders.append(f"{_label(idx, pos)}.value_before_usd is not a number")
            continue
        for horizon in HORIZONS:
            for variant in VARIANTS:
                pct = _cell(pos, horizon, "impact_pct", variant)
                usd = _cell(pos, horizon, "impact_usd", variant)
                if pct is None or usd is None:
                    offenders.append(f"{_label(idx, pos)} {horizon}/{variant}: "
                                     f"impact_pct or impact_usd missing or not a number")
                    continue
                cells += 1
                expected = before * pct / 100.0
                off = abs(usd - expected)
                if off > TOL_USD + _EPS:
                    offenders.append(f"{_label(idx, pos)} {horizon}/{variant}: "
                                     f"impact_usd {_f2(usd)}, expected {_f2(expected)} "
                                     f"(off {_f2(off)})")

    if offenders:
        return _check(cid, name, kind, False, _join(offenders, MAX_OFFENDERS))
    return _check(cid, name, kind, True, f"{cells} grid cells within ${TOL_USD:.0f}")


def _v5a_ranges(result: Any) -> dict:
    """MECHANICAL half: weights, confidences, portfolio usd. All fixable without
    rethinking the analysis, so kind=schema routes these to the cheap retry lane."""
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
                problems.append(f"weight_pct sums to {_f2(total_weight)}, "
                                f"expected 100 +/-{TOL_WEIGHT}")

    # confidences in [0, 1]
    if result.get("confidence") is not None:
        c = _num(result.get("confidence"))
        if c is None or not (0.0 <= c <= 1.0):
            problems.append(f"confidence {result.get('confidence')!r} outside [0,1]")
    for idx, pos in items:
        if "confidence" not in pos:
            continue
        c = _num(pos.get("confidence"))
        if c is None or not (0.0 <= c <= 1.0):
            problems.append(f"positions[{idx}].confidence {pos.get('confidence')!r} outside [0,1]")

    # portfolio impact_usd must follow from portfolio impact_pct
    before_total = _num(result.get("portfolio_value_before_usd"))
    if before_total is None:
        problems.append("portfolio_value_before_usd is missing or not a number")
    else:
        for horizon in HORIZONS:
            for variant in VARIANTS:
                pct = _cell(result, horizon, "impact_pct", variant)
                usd = _cell(result, horizon, "impact_usd", variant)
                if pct is None or usd is None:
                    continue
                expected = before_total * pct / 100.0
                off = abs(usd - expected)
                if off > TOL_USD + _EPS:
                    problems.append(f"portfolio {horizon}/{variant} impact_usd {_f2(usd)}, "
                                    f"expected {_f2(expected)} (off {_f2(off)})")

    if problems:
        return _check(cid, name, kind, False, _join(problems, MAX_OFFENDERS))
    return _check(cid, name, kind, True, "weights, confidences and portfolio totals sane")


def _v5b_bands(result: Any) -> dict:
    """REASONING half: low <= base <= high. Getting this backwards means the scenario
    thinking is wrong, not the formatting, so kind=semantic routes it to re-reasoning."""
    cid, name, kind = _CHECK_META[5]
    if not isinstance(result, dict):
        return _check(cid, name, kind, False, "result is not an object")

    problems: list[str] = []
    bands = 0

    def inspect(container: Any, where: str) -> None:
        nonlocal bands
        for horizon in HORIZONS:
            for metric in ("impact_pct", "impact_usd"):
                band = [_cell(container, horizon, metric, v) for v in VARIANTS]
                if any(b is None for b in band):
                    problems.append(f"{where} {horizon}.{metric} "
                                    f"is missing a low/base/high value")
                    continue
                bands += 1
                if not (band[0] <= band[1] <= band[2]):  # type: ignore[operator]
                    problems.append(f"{where} {horizon}.{metric} not ordered: "
                                    f"low {_f2(band[0])}, base {_f2(band[1])}, "
                                    f"high {_f2(band[2])}")

    inspect(result, "portfolio")
    for idx, pos in _position_items(result):
        inspect(pos, _label(idx, pos))

    if problems:
        return _check(cid, name, kind, False, _join(problems, MAX_OFFENDERS))
    return _check(cid, name, kind, True, f"{bands} bands ordered low <= base <= high")


def _v6_tamper(measured: Any) -> dict:
    """Accepts either measured["verifier_hash_ok"], or expected/actual hashes to compare."""
    cid, name, kind = _CHECK_META[6]
    if not isinstance(measured, dict):
        return _check(cid, name, kind, True, "verifier hash unchanged")

    if "verifier_hash_ok" in measured:
        if measured.get("verifier_hash_ok") is True:
            return _check(cid, name, kind, True, "verifier hash unchanged")
        return _check(cid, name, kind, False, "verifier files modified during run")

    expected = measured.get("verifier_hash_expected")
    actual = measured.get("verifier_hash_actual")
    if expected is None and actual is None:
        return _check(cid, name, kind, True, "verifier hash unchanged")
    if not isinstance(expected, str) or not isinstance(actual, str) or not expected or not actual:
        return _check(cid, name, kind, False,
                      "verifier hash inconclusive - need both expected and actual")
    if expected.strip().lower() == actual.strip().lower():
        return _check(cid, name, kind, True, "verifier hash unchanged")
    return _check(cid, name, kind, False, "verifier files modified during run")


def _v7_skip(pos: dict, methodology: Any) -> bool:
    """Should this position be exempt from the value-chain identity?

    Keyed off STRUCTURE, not prose. An agent that writes a perfectly good sentence
    without a magic token must not be gated on a chain it deliberately did not compute.
    The value_basis token is kept only as a last-resort fallback.

    Note the deliberate asymmetry: a position that supplies market_cap_usd > 0 and a
    value_at_stake_usd is CHECKED even when it is unaffected, because 0 == 0/cap*100
    closes trivially and verifying it costs nothing. We skip only when the position
    genuinely lacks the inputs the identity needs.
    """
    # 1. Explicit declaration: the whole analysis, or this position, is valued by a
    #    direct market-cap re-rating rather than a revenue chain.
    if isinstance(methodology, str) and methodology == "market_cap_value_impact":
        return True

    # 2. Structural: the entire 3x3 impact grid is zero -> a genuinely unaffected name.
    cells = [_cell(pos, h, "impact_pct", v) for h in HORIZONS for v in VARIANTS]
    if cells and all(c == 0.0 for c in cells):
        return True

    # 3. Structural: no chain was declared (no revenue at risk, or all six inputs zero)
    #    AND no long-run impact is claimed AND the identity's inputs are absent anyway.
    #    The long_base guard closes the loophole: claim a long-run number and you are
    #    gated on justifying it, chain or no chain.
    long_base = _cell(pos, "long_term", "impact_pct", "base")
    if long_base == 0.0:
        inputs = [_num(pos.get(key)) for key in CHAIN_INPUTS]
        no_chain = all(i == 0.0 for i in inputs) or _num(pos.get("affected_fraction")) == 0.0
        cap = _num(pos.get("market_cap_usd"))
        stake = _num(pos.get("value_at_stake_usd"))
        if no_chain and (cap is None or cap <= 0 or stake is None):
            return True

    # 4. Fallback only: legacy prose token.
    basis = pos.get("value_basis")
    return isinstance(basis, str) and "market_cap_value_impact" in basis


def _v7_chain(result: Any) -> dict:
    """long_term.base == value_at_stake_usd / market_cap_usd * 100, and market_cap_usd > 0."""
    cid, name, kind = _CHECK_META[7]
    items = _position_items(result)
    if not items:
        return _check(cid, name, kind, False, "no positions to check")

    methodology = result.get("methodology") if isinstance(result, dict) else None
    offenders: list[str] = []
    checked = skipped = 0

    for idx, pos in items:
        if _v7_skip(pos, methodology):
            skipped += 1
            continue
        checked += 1
        stake = _num(pos.get("value_at_stake_usd"))
        cap = _num(pos.get("market_cap_usd"))
        declared = _cell(pos, "long_term", "impact_pct", "base")

        if cap is None or cap <= 0:
            offenders.append(f"{_label(idx, pos)}: market_cap_usd must be > 0, "
                             f"got {pos.get('market_cap_usd')!r}")
            continue
        if stake is None:
            offenders.append(f"{_label(idx, pos)}: value_at_stake_usd is missing or not a number")
            continue
        if declared is None:
            offenders.append(f"{_label(idx, pos)}: "
                             f"horizons.long_term.impact_pct.base is missing or not a number")
            continue

        expected = stake / cap * 100.0
        off = abs(declared - expected)
        if off > TOL_CHAIN + _EPS:
            offenders.append(f"{_label(idx, pos)}: long_term base {_f2(declared)}, but "
                             f"value_at_stake/market_cap = {_f2(expected)} (off {_f2(off)})")

    if offenders:
        return _check(cid, name, kind, False, _join(offenders, MAX_OFFENDERS))
    tail = f", {skipped} skipped" if skipped else ""
    return _check(cid, name, kind, True, f"{checked} value chains close{tail}")


# -------------------------------------------------------------- entrypoint ---

def verify(result: dict, portfolio: dict, measured: dict) -> dict:
    """Run V1..V7 and return {"passed": bool, "checks": [...]}.

    Every check is always present, in V1..V7 order, whether it passed or failed.
    Never raises - an exception inside a single check degrades to that check failing.
    """
    runners = [
        lambda: _v1_schema(result),
        lambda: _v2_tickers(result, portfolio),
        lambda: _v3_reconcile(result),
        lambda: _v4_position_usd(result),
        lambda: _v5a_ranges(result),
        lambda: _v5b_bands(result),
        lambda: _v6_tamper(measured),
        lambda: _v7_chain(result),
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
