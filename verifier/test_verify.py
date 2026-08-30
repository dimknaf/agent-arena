"""Tests for the Workstream B verifier gate (fundamental-value shape, V1..V7).

Run:  pytest verifier/test_verify.py -q      (from the repo root)
or:   python verifier/test_verify.py         (no pytest needed)
"""

import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify import verify  # noqa: E402

IDS = ["V1", "V2", "V3", "V4", "V5", "V6", "V7"]
HORIZONS = ["short_term", "medium_term", "long_term"]
VARIANTS = ["low", "base", "high"]

PORTFOLIO = {
    "total_value_usd": 100000,
    "positions": [
        {"ticker": "AAPL", "name": "Apple Inc.", "sector": "Technology",
         "qty": 100, "price_usd": 500.0, "value_usd": 50000, "weight_pct": 50.0},
        {"ticker": "MSFT", "name": "Microsoft Corp.", "sector": "Technology",
         "qty": 60, "price_usd": 500.0, "value_usd": 30000, "weight_pct": 30.0},
        {"ticker": "XOM", "name": "Exxon Mobil Corp.", "sector": "Energy",
         "qty": 200, "price_usd": 100.0, "value_usd": 20000, "weight_pct": 20.0},
    ],
}

MEASURED = {"verifier_hash_ok": True}

# ticker -> (weight_pct, value_before_usd, {horizon: base_pct}, value_at_stake, market_cap)
SPEC = {
    "AAPL": (50.0, 50000.0, {"short_term": -4.0, "medium_term": -2.4, "long_term": -1.6},
             -16.0e9, 1000.0e9),
    "MSFT": (30.0, 30000.0, {"short_term": -2.0, "medium_term": -1.2, "long_term": -0.8},
             -8.0e9, 1000.0e9),
    "XOM": (20.0, 20000.0, {"short_term": 1.0, "medium_term": 0.4, "long_term": 0.0},
            0.0, 500.0e9),
}

# fixed half-widths keep low <= base <= high and keep the arithmetic exact
HALF = {"short_term": 1.0, "medium_term": 0.6, "long_term": 0.4}


def _band(base, half):
    return {"low": round(base - half, 6), "base": round(base, 6), "high": round(base + half, 6)}


def valid_result():
    """Fully self-consistent analysis: 90 grid cells that all reconcile."""
    positions = []
    for ticker, (weight, value, bases, stake, cap) in SPEC.items():
        horizons = {}
        for h in HORIZONS:
            pct = _band(bases[h], HALF[h])
            horizons[h] = {
                "impact_pct": pct,
                "impact_usd": {v: round(value * pct[v] / 100.0, 2) for v in VARIANTS},
                "method": "fundamental_value_chain",
                "note": "Capitalised value chain over market cap; see value_basis for inputs.",
            }
        positions.append({
            "ticker": ticker, "sector": "Technology", "weight_pct": weight,
            "value_before_usd": value,
            "rationale": "Exposure runs through the single-source packaging step at the "
                         "affected supplier.",
            "confidence": 0.7,
            "revenue_line_usd": 100.0e9, "affected_fraction": 0.4, "duration_months": 9.0,
            "permanent_share": 0.05, "margin": 0.3, "earnings_multiple": 25.0,
            "revenue_at_stake_usd": -1.5e9, "profit_at_stake_usd": -0.45e9,
            "value_at_stake_usd": stake, "market_cap_usd": cap,
            "value_basis": "Market cap from the last close; exposed revenue line times affected "
                           "fraction times window times permanent share, capitalised.",
            "variant_basis": "Low doubles the permanent share; high assumes full catch-up "
                             "inside the disruption window.",
            "horizons": horizons,
        })

    pf = {}
    for h in HORIZONS:
        pct = {v: round(sum(p["weight_pct"] / 100.0 * p["horizons"][h]["impact_pct"][v]
                            for p in positions), 6) for v in VARIANTS}
        pf[h] = {"impact_pct": pct,
                 "impact_usd": {v: round(100000.0 * pct[v] / 100.0, 2) for v in VARIANTS}}

    return {
        "news_id": "evt-test-001",
        "headline": "Supplier outage halts leading-edge production at a single-source fab",
        "published_at": "2026-08-30T09:00:00Z",
        "thesis": "A single-source supplier outage defers revenue across the hardware cluster; "
                  "only a small permanent share capitalises into long-run value.",
        "methodology": "fundamental_value_impact",
        "confidence": 0.66,
        "mechanism": [
            {"from": "supplier outage", "to": "packaging queue",
             "effect": "single-source step gates the downstream chain"},
            {"from": "packaging queue", "to": "hardware names",
             "effect": "revenue deferred, small permanent share capitalised"},
        ],
        "positions": positions,
        "portfolio_value_before_usd": 100000.0,
        "horizons": pf,
        "citations": [
            {"claim": "Supplier confirmed the outage on Friday.",
             "url": "https://example.com/outage", "source": "Example Wire",
             "published_at": "2026-08-28"},
            {"claim": "Packaging capacity is the binding constraint.",
             "url": "https://example.com/packaging", "source": "Example Wire",
             "published_at": ""},
        ],
        "budget": {"codex_credits_used": 2.4, "parallel_calls_used": 4, "attempts": 2},
    }


def run(result, portfolio=PORTFOLIO, measured=MEASURED):
    return verify(result, portfolio, measured)


def by_id(report):
    return {c["id"]: c for c in report["checks"]}


def assert_shape(report):
    assert isinstance(report, dict)
    assert set(report) == {"passed", "checks"}
    assert isinstance(report["passed"], bool)
    assert [c["id"] for c in report["checks"]] == IDS, "checks must be in V1..V7 order"
    for check in report["checks"]:
        assert set(check) == {"id", "name", "passed", "message", "kind"}
        assert isinstance(check["passed"], bool)
        assert isinstance(check["message"], str)
        assert check["kind"] in ("schema", "semantic")
        assert isinstance(check["name"], str) and check["name"]


# ------------------------------------------------------------------ tests ---

def test_valid_result_passes_all_seven():
    report = run(valid_result())
    assert_shape(report)
    failed = [c for c in report["checks"] if not c["passed"]]
    assert failed == [], f"expected a clean pass, got: {failed}"
    assert report["passed"] is True


def test_kinds_match_contract():
    kinds = {c["id"]: c["kind"] for c in run(valid_result())["checks"]}
    assert kinds == {"V1": "schema", "V2": "semantic", "V3": "semantic", "V4": "semantic",
                     "V5": "semantic", "V6": "semantic", "V7": "semantic"}


def test_v3_names_the_failing_pair_and_both_numbers():
    r = valid_result()
    r["horizons"]["long_term"]["impact_pct"]["low"] = -2.90
    r["horizons"]["long_term"]["impact_usd"]["low"] = -2900.0
    checks = by_id(run(r))
    v3 = checks["V3"]
    assert v3["passed"] is False
    assert v3["kind"] == "semantic"
    assert "1/9 gates failed" in v3["message"], v3["message"]
    assert "long_term/low" in v3["message"], v3["message"]
    assert "declared -2.90" in v3["message"], v3["message"]
    assert "Sum = " in v3["message"] and "diff " in v3["message"]
    # the other eight gates are untouched, and only V3/V5 notice this edit
    for cid in ("V1", "V2", "V4", "V7"):
        assert checks[cid]["passed"] is True, (cid, checks[cid]["message"])


def test_v3_counts_all_nine_failures():
    r = valid_result()
    for h in HORIZONS:
        for v in VARIANTS:
            r["horizons"][h]["impact_pct"][v] += 5.0
            r["horizons"][h]["impact_usd"][v] += 5000.0
    v3 = by_id(run(r))["V3"]
    assert v3["passed"] is False
    assert "9/9 gates failed" in v3["message"], v3["message"]


def test_v3_passes_within_tolerance_and_fails_outside():
    r = valid_result()
    r["horizons"]["short_term"]["impact_pct"]["base"] += 0.01      # exactly at tolerance
    r["horizons"]["short_term"]["impact_usd"]["base"] = round(
        100000.0 * r["horizons"]["short_term"]["impact_pct"]["base"] / 100.0, 2)
    assert by_id(run(r))["V3"]["passed"] is True

    r2 = valid_result()
    r2["horizons"]["short_term"]["impact_pct"]["base"] += 0.03     # outside
    r2["horizons"]["short_term"]["impact_usd"]["base"] = round(
        100000.0 * r2["horizons"]["short_term"]["impact_pct"]["base"] / 100.0, 2)
    assert by_id(run(r2))["V3"]["passed"] is False


def test_missing_required_field_fails_v1_as_schema():
    r = valid_result()
    del r["thesis"]
    v1 = by_id(run(r))["V1"]
    assert v1["passed"] is False
    assert v1["kind"] == "schema"
    assert "thesis" in v1["message"]


def test_v1_reports_grid_paths():
    r = valid_result()
    r["positions"][1]["horizons"]["long_term"]["impact_pct"]["base"] = -99.0
    v1 = by_id(run(r))["V1"]
    assert v1["passed"] is False
    assert "positions[1].horizons.long_term.impact_pct.base" in v1["message"], v1["message"]


def test_v1_collects_all_errors():
    r = valid_result()
    del r["thesis"]
    del r["methodology"]
    r["confidence"] = 5.0
    v1 = by_id(run(r))["V1"]
    assert v1["passed"] is False
    assert "3 schema errors" in v1["message"], v1["message"]


def test_unknown_ticker_fails_v2():
    r = valid_result()
    r["positions"][2]["ticker"] = "TSLA"
    checks = by_id(run(r))
    assert checks["V2"]["passed"] is False
    assert checks["V2"]["kind"] == "semantic"
    assert "TSLA" in checks["V2"]["message"] and "XOM" in checks["V2"]["message"]
    assert checks["V1"]["passed"] is True
    assert checks["V3"]["passed"] is True


def test_v4_reports_grid_cell_offenders():
    r = valid_result()
    r["positions"][0]["horizons"]["medium_term"]["impact_usd"]["high"] += 50.0
    v4 = by_id(run(r))["V4"]
    assert v4["passed"] is False
    assert v4["kind"] == "semantic"
    assert "AAPL" in v4["message"] and "medium_term/high" in v4["message"], v4["message"]


def test_v4_caps_at_three_offenders():
    r = valid_result()
    for pos in r["positions"]:
        for h in HORIZONS:
            for v in VARIANTS:
                pos["horizons"][h]["impact_usd"][v] += 500.0
    v4 = by_id(run(r))["V4"]
    assert v4["passed"] is False
    assert v4["message"].count("expected") <= 3
    assert "more)" in v4["message"]


def test_v5_catches_unordered_band():
    r = valid_result()
    pct = r["positions"][0]["horizons"]["long_term"]["impact_pct"]
    pct["low"], pct["high"] = pct["high"], pct["low"]      # low now above high
    v5 = by_id(run(r))["V5"]
    assert v5["passed"] is False
    assert v5["kind"] == "semantic"
    assert "not ordered" in v5["message"], v5["message"]


def test_v5_catches_unordered_portfolio_band():
    r = valid_result()
    r["horizons"]["short_term"]["impact_pct"]["base"] = 99.0
    v5 = by_id(run(r))["V5"]
    assert v5["passed"] is False
    assert "portfolio short_term.impact_pct not ordered" in v5["message"], v5["message"]


def test_v5_catches_weight_sum_and_confidence():
    r = valid_result()
    r["positions"][0]["weight_pct"] = 40.0
    assert "sums to 90.00" in by_id(run(r))["V5"]["message"]

    r2 = valid_result()
    r2["positions"][1]["confidence"] = 1.4
    assert "outside [0,1]" in by_id(run(r2))["V5"]["message"]


def test_v5_catches_portfolio_usd_mismatch():
    r = valid_result()
    r["horizons"]["long_term"]["impact_usd"]["base"] -= 500.0
    v5 = by_id(run(r))["V5"]
    assert v5["passed"] is False
    assert "portfolio long_term/base impact_usd" in v5["message"], v5["message"]


def test_v6_hash_ok_flag():
    assert by_id(run(valid_result(), measured={"verifier_hash_ok": True}))["V6"]["passed"] is True
    bad = by_id(run(valid_result(), measured={"verifier_hash_ok": False}))["V6"]
    assert bad["passed"] is False
    assert bad["message"] == "verifier files modified during run"


def test_v6_expected_actual_hash_pair():
    """The orchestrator sends expected/actual hashes rather than a bool."""
    same = {"verifier_hash_expected": "ab12", "verifier_hash_actual": "AB12"}
    assert by_id(run(valid_result(), measured=same))["V6"]["passed"] is True

    diff = {"verifier_hash_expected": "ab12", "verifier_hash_actual": "ffff"}
    bad = by_id(run(valid_result(), measured=diff))["V6"]
    assert bad["passed"] is False
    assert bad["message"] == "verifier files modified during run"

    half = {"verifier_hash_expected": "ab12"}
    lone = by_id(run(valid_result(), measured=half))["V6"]
    assert lone["passed"] is False
    assert "inconclusive" in lone["message"]


def test_v6_defaults_true_when_unmeasured():
    for measured in ({}, None, "nonsense", 7):
        assert by_id(run(valid_result(), measured=measured))["V6"]["passed"] is True, measured


def test_v7_catches_broken_chain():
    r = valid_result()
    r["positions"][0]["value_at_stake_usd"] = -50.0e9      # implies -5.0%, grid says -1.6%
    v7 = by_id(run(r))["V7"]
    assert v7["passed"] is False
    assert v7["kind"] == "semantic"
    assert "AAPL" in v7["message"] and "-5.00" in v7["message"], v7["message"]


def test_v7_requires_positive_market_cap():
    r = valid_result()
    r["positions"][1]["market_cap_usd"] = 0.0
    v7 = by_id(run(r))["V7"]
    assert v7["passed"] is False
    assert "market_cap_usd must be > 0" in v7["message"]


def test_v7_skips_all_zero_grid_position():
    """A genuinely unaffected name is not forced to fabricate a chain."""
    r = valid_result()
    pos = r["positions"][2]
    for h in HORIZONS:
        for v in VARIANTS:
            pos["horizons"][h]["impact_pct"][v] = 0.0
            pos["horizons"][h]["impact_usd"][v] = 0.0
    pos["market_cap_usd"] = 0.0            # would fail V7 if it were not skipped
    pos["value_at_stake_usd"] = 123.0
    for h in HORIZONS:                     # keep the portfolio grid reconciled
        for v in VARIANTS:
            pct = round(sum(p["weight_pct"] / 100.0 * p["horizons"][h]["impact_pct"][v]
                            for p in r["positions"]), 6)
            r["horizons"][h]["impact_pct"][v] = pct
            r["horizons"][h]["impact_usd"][v] = round(100000.0 * pct / 100.0, 2)
    checks = by_id(run(r))
    assert checks["V7"]["passed"] is True, checks["V7"]["message"]
    assert "skipped" in checks["V7"]["message"]
    assert checks["V3"]["passed"] is True


def test_v7_skips_market_cap_value_impact_basis():
    r = valid_result()
    r["positions"][0]["value_basis"] = "market_cap_value_impact: direct re-rating of the cap."
    r["positions"][0]["value_at_stake_usd"] = 999.0       # nonsense, but exempt
    assert by_id(run(r))["V7"]["passed"] is True


# ------------------------------------------------- malformed / partial grids ---

def test_garbage_inputs_never_raise():
    garbage = [{}, None, "not a dict", [1, 2, 3], 42, True,
               {"positions": "nope"}, {"positions": [None, 7]},
               {"positions": [{"ticker": 5}]}, {"horizons": "nope"},
               {"horizons": {"short_term": 3}}]
    for bad in garbage:
        report = verify(bad, PORTFOLIO, MEASURED)
        assert_shape(report)
        assert report["passed"] is False, bad
        assert by_id(report)["V1"]["passed"] is False, bad


def test_partial_grid_produces_clean_report_not_keyerror():
    """The agent WILL ship a half-built 3x3 grid. That must read, not explode."""
    mutations = [
        lambda r: r["positions"][0].pop("horizons"),
        lambda r: r["positions"][0]["horizons"].pop("long_term"),
        lambda r: r["positions"][0]["horizons"]["long_term"].pop("impact_pct"),
        lambda r: r["positions"][0]["horizons"]["long_term"]["impact_pct"].pop("base"),
        lambda r: r["positions"][0]["horizons"]["long_term"]["impact_usd"].pop("high"),
        lambda r: r.pop("horizons"),
        lambda r: r["horizons"].pop("medium_term"),
        lambda r: r["horizons"]["medium_term"]["impact_pct"].pop("low"),
        lambda r: r["horizons"]["medium_term"].__setitem__("impact_pct", None),
        lambda r: r["positions"][0]["horizons"].__setitem__("long_term", "oops"),
        lambda r: r["positions"][0]["horizons"]["short_term"]["impact_pct"].__setitem__(
            "base", "minus one"),
        lambda r: r["positions"][0].__setitem__("weight_pct", None),
    ]
    for i, mutate in enumerate(mutations):
        r = valid_result()
        mutate(r)
        report = verify(r, PORTFOLIO, MEASURED)
        assert_shape(report)
        assert report["passed"] is False, i
        for check in report["checks"]:
            assert "verifier error" not in check["message"], (i, check)


def test_garbage_portfolio_and_measured_never_raise():
    for bad_portfolio in [None, {}, "x", [], 3, {"positions": None}]:
        for bad_measured in [None, {}, "x", 7]:
            assert_shape(verify(valid_result(), bad_portfolio, bad_measured))


def test_verify_does_not_mutate_inputs():
    r, p, m = valid_result(), copy.deepcopy(PORTFOLIO), copy.deepcopy(MEASURED)
    before = (copy.deepcopy(r), copy.deepcopy(p), copy.deepcopy(m))
    verify(r, p, m)
    assert (r, p, m) == before


if __name__ == "__main__":
    fns = [(n, f) for n, f in sorted(globals().items())
           if n.startswith("test_") and callable(f)]
    failures = 0
    for name, fn in fns:
        try:
            fn()
            print(f"PASS {name}")
        except Exception as exc:
            failures += 1
            print(f"FAIL {name}: {type(exc).__name__}: {exc}")
    print(f"\n{len(fns) - failures}/{len(fns)} passed")
    sys.exit(1 if failures else 0)
