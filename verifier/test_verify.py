"""Tests for the Workstream B verifier gate.

Run:  pytest verifier/test_verify.py -q      (from the repo root)
or:   python verifier/test_verify.py         (no pytest needed)
"""

import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verify import verify  # noqa: E402

IDS = ["V1", "V2", "V3", "V4", "V5", "V6"]

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


def valid_result():
    """Fully self-consistent analysis.

    Sum = 0.50*-2.0 + 0.30*-1.0 + 0.20*3.0 = -0.70  == portfolio_impact_pct
    """
    return {
        "news_id": "news-2026-08-30-001",
        "headline": "Regulator opens antitrust probe into cloud bundling practices",
        "published_at": "2026-08-30T09:00:00Z",
        "thesis": ("A new antitrust probe into cloud bundling pressures megacap software "
                   "multiples while energy holdings rally on an unrelated supply headline."),
        "methodology": "sector_exposure_map",
        "confidence": 0.62,
        "mechanism": [
            {"from": "antitrust probe", "to": "cloud pricing power", "effect": "compresses margins"},
            {"from": "supply disruption", "to": "crude prices", "effect": "lifts energy earnings"},
        ],
        "positions": [
            {"ticker": "AAPL", "sector": "Technology", "weight_pct": 50.0,
             "value_before_usd": 50000.0, "impact_pct": -2.0, "impact_usd": -1000.0,
             "rationale": "Services segment shares the regulatory read-across.",
             "confidence": 0.55},
            {"ticker": "MSFT", "sector": "Technology", "weight_pct": 30.0,
             "value_before_usd": 30000.0, "impact_pct": -1.0, "impact_usd": -300.0,
             "rationale": "Azure bundling is named directly in the filing.",
             "confidence": 0.7},
            {"ticker": "XOM", "sector": "Energy", "weight_pct": 20.0,
             "value_before_usd": 20000.0, "impact_pct": 3.0, "impact_usd": 600.0,
             "rationale": "Crude strength flows straight to upstream margins.",
             "confidence": 0.6},
        ],
        "portfolio_value_before_usd": 100000.0,
        "portfolio_impact_pct": -0.7,
        "portfolio_impact_usd": -700.0,
        "citations": [
            {"claim": "Regulator confirmed the probe on Friday.",
             "url": "https://example.com/probe", "source": "Example Wire"},
            {"claim": "Crude rose 4% on the supply headline.",
             "url": "https://example.com/crude", "source": "Example Wire"},
        ],
        "budget": {"codex_credits_used": 1.4, "parallel_calls_used": 3, "attempts": 1},
    }


def run(result, portfolio=PORTFOLIO, measured=MEASURED):
    return verify(result, portfolio, measured)


def by_id(report):
    return {c["id"]: c for c in report["checks"]}


def assert_shape(report):
    assert isinstance(report, dict)
    assert set(report) == {"passed", "checks"}
    assert isinstance(report["passed"], bool)
    assert [c["id"] for c in report["checks"]] == IDS, "checks must be in V1..V6 order"
    for check in report["checks"]:
        assert set(check) == {"id", "name", "passed", "message", "kind"}
        assert isinstance(check["passed"], bool)
        assert isinstance(check["message"], str)
        assert check["kind"] in ("schema", "semantic")
        assert isinstance(check["name"], str) and check["name"]


# ------------------------------------------------------------------ tests ---

def test_valid_result_passes_all_six():
    report = run(valid_result())
    assert_shape(report)
    failed = [c for c in report["checks"] if not c["passed"]]
    assert failed == [], f"expected a clean pass, got: {failed}"
    assert report["passed"] is True


def test_kinds_match_contract():
    report = run(valid_result())
    kinds = {c["id"]: c["kind"] for c in report["checks"]}
    assert kinds == {"V1": "schema", "V2": "semantic", "V3": "semantic",
                     "V4": "semantic", "V5": "schema", "V6": "semantic"}


def test_v3_mismatch_fails_only_v3():
    r = valid_result()
    r["portfolio_impact_pct"] = -2.10
    r["portfolio_impact_usd"] = -2100.0  # keep V5 self-consistent
    report = run(r)
    assert_shape(report)
    checks = by_id(report)
    assert report["passed"] is False
    assert checks["V3"]["passed"] is False
    assert checks["V3"]["kind"] == "semantic"
    msg = checks["V3"]["message"]
    assert "Sum = -0.70" in msg, msg
    assert "declared -2.10" in msg, msg
    assert "1.40" in msg, msg
    for cid in ("V1", "V2", "V4", "V5", "V6"):
        assert checks[cid]["passed"] is True, (cid, checks[cid]["message"])


def test_v3_tolerance_edge():
    r = valid_result()
    r["portfolio_impact_pct"] = -0.71          # exactly 0.01 off -> still passes
    r["portfolio_impact_usd"] = -710.0
    assert by_id(run(r))["V3"]["passed"] is True

    r2 = valid_result()
    r2["portfolio_impact_pct"] = -0.73         # 0.03 off -> bounces
    r2["portfolio_impact_usd"] = -730.0
    assert by_id(run(r2))["V3"]["passed"] is False


def test_missing_required_field_fails_v1_as_schema():
    r = valid_result()
    del r["thesis"]
    report = run(r)
    assert_shape(report)
    v1 = by_id(report)["V1"]
    assert v1["passed"] is False
    assert v1["kind"] == "schema"
    assert "thesis" in v1["message"]
    assert report["passed"] is False


def test_out_of_range_impact_pct_is_reported_with_path():
    r = valid_result()
    r["positions"][2]["impact_pct"] = -31.0
    r["positions"][2]["impact_usd"] = -6200.0
    v1 = by_id(run(r))["V1"]
    assert v1["passed"] is False
    assert "positions[2].impact_pct" in v1["message"], v1["message"]
    assert "-31" in v1["message"]


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
    report = run(r)
    assert_shape(report)
    checks = by_id(report)
    assert checks["V2"]["passed"] is False
    assert checks["V2"]["kind"] == "semantic"
    assert "TSLA" in checks["V2"]["message"]
    assert "XOM" in checks["V2"]["message"]      # full coverage is required too
    assert checks["V1"]["passed"] is True
    assert checks["V3"]["passed"] is True
    assert report["passed"] is False


def test_missing_coverage_fails_v2():
    r = valid_result()
    r["positions"] = r["positions"][:2]          # drop XOM entirely
    r["portfolio_impact_pct"] = -1.3
    r["portfolio_impact_usd"] = -1300.0
    checks = by_id(run(r))
    assert checks["V2"]["passed"] is False
    assert "missing from positions: XOM" in checks["V2"]["message"]


def test_v4_reports_at_most_three_offenders():
    r = valid_result()
    for pos in r["positions"]:
        pos["impact_usd"] = pos["impact_usd"] + 50.0
    checks = by_id(run(r))
    assert checks["V4"]["passed"] is False
    assert checks["V4"]["kind"] == "semantic"
    assert checks["V4"]["message"].count("expected") <= 3
    assert "AAPL" in checks["V4"]["message"]


def test_v4_tolerates_dollar_rounding():
    r = valid_result()
    r["positions"][0]["impact_usd"] = -1000.49
    assert by_id(run(r))["V4"]["passed"] is True


def test_v5_weight_sum_and_confidence():
    r = valid_result()
    r["positions"][0]["weight_pct"] = 40.0       # weights now sum to 90
    r["portfolio_impact_pct"] = -0.5
    r["portfolio_impact_usd"] = -500.0
    v5 = by_id(run(r))["V5"]
    assert v5["passed"] is False
    assert v5["kind"] == "schema"
    assert "90.00" in v5["message"], v5["message"]


def test_v5_portfolio_usd_mismatch():
    r = valid_result()
    r["portfolio_impact_usd"] = -1234.0
    v5 = by_id(run(r))["V5"]
    assert v5["passed"] is False
    assert "portfolio_impact_usd" in v5["message"]


def test_v6_tamper():
    report = run(valid_result(), measured={"verifier_hash_ok": False})
    checks = by_id(report)
    assert checks["V6"]["passed"] is False
    assert checks["V6"]["kind"] == "semantic"
    assert checks["V6"]["message"] == "verifier files modified during run"
    assert report["passed"] is False


def test_v6_defaults_true_when_unmeasured():
    assert by_id(run(valid_result(), measured={}))["V6"]["passed"] is True
    assert by_id(run(valid_result(), measured=None))["V6"]["passed"] is True


def test_garbage_inputs_never_raise():
    garbage = [{}, None, "not a dict", [1, 2, 3], 42, True, {"positions": "nope"},
               {"positions": [None, 7]}, {"positions": [{"ticker": 5}]}]
    for bad in garbage:
        report = verify(bad, PORTFOLIO, MEASURED)
        assert_shape(report)
        assert report["passed"] is False, bad
        assert by_id(report)["V1"]["passed"] is False, bad


def test_garbage_portfolio_and_measured_never_raise():
    for bad_portfolio in [None, {}, "x", [], 3, {"positions": None}]:
        for bad_measured in [None, {}, "x", 7]:
            report = verify(valid_result(), bad_portfolio, bad_measured)
            assert_shape(report)


def test_verify_does_not_mutate_inputs():
    r = valid_result()
    p = copy.deepcopy(PORTFOLIO)
    m = copy.deepcopy(MEASURED)
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
