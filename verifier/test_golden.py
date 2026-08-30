"""Golden-fixture test: data/golden_result.json must always pass all six verifier checks.

This is the payload the frontend demo replay and the explanation UI render, so if the
schema, the portfolio or the verifier ever drifts, this test is what catches it.

Run:  pytest verifier/test_golden.py -q      (from the repo root)
or:   python verifier/test_golden.py         (no pytest needed)
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from verify import verify  # noqa: E402

GOLDEN_PATH = os.path.join(ROOT, "data", "golden_result.json")
PORTFOLIO_PATH = os.path.join(ROOT, "data", "portfolio.json")

EXPECTED_TICKERS = ["AAPL", "NVDA", "MSFT", "AVGO", "JPM", "XOM", "WMT", "JNJ", "CAT", "NEE"]
IDS = ["V1", "V2", "V3", "V4", "V5", "V6"]


def load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def golden():
    return load(GOLDEN_PATH)


def portfolio():
    return load(PORTFOLIO_PATH)


# ------------------------------------------------------------------ tests ---

def test_golden_passes_all_six_checks():
    report = verify(golden(), portfolio(), {})
    failed = [(c["id"], c["message"]) for c in report["checks"] if not c["passed"]]
    assert failed == [], f"golden fixture no longer verifies: {failed}"
    assert [c["id"] for c in report["checks"]] == IDS
    assert len(report["checks"]) == 6
    assert report["passed"] is True


def test_golden_passes_with_missing_and_ok_measured():
    """measured={} and an explicit hash-ok both keep V6 green."""
    for measured in ({}, {"verifier_hash_ok": True}, None):
        assert verify(golden(), portfolio(), measured)["passed"] is True, measured


def test_every_holding_present_in_portfolio_order():
    tickers = [p["ticker"] for p in golden()["positions"]]
    assert tickers == EXPECTED_TICKERS
    assert len(tickers) == len(set(tickers)) == 10


def test_v3_arithmetic_recomputed_independently():
    g = golden()
    total = sum(p["weight_pct"] / 100.0 * p["impact_pct"] for p in g["positions"])
    assert abs(total - g["portfolio_impact_pct"]) <= 0.01, (total, g["portfolio_impact_pct"])


def test_v4_arithmetic_recomputed_independently():
    for p in golden()["positions"]:
        expected = p["value_before_usd"] * p["impact_pct"] / 100.0
        assert abs(p["impact_usd"] - expected) <= 1.0, p["ticker"]


def test_position_dollars_sum_to_portfolio_dollars():
    """The waterfall chart adds up: no visible rounding stub in the UI."""
    g = golden()
    assert abs(sum(p["impact_usd"] for p in g["positions"]) - g["portfolio_impact_usd"]) <= 1.0


def test_fixture_matches_the_live_portfolio():
    held = {p["ticker"]: p for p in portfolio()["positions"]}
    for p in golden()["positions"]:
        row = held[p["ticker"]]
        assert p["weight_pct"] == row["weight_pct"], p["ticker"]
        assert p["value_before_usd"] == row["value_usd"], p["ticker"]
    assert golden()["portfolio_value_before_usd"] == portfolio()["total_value_usd"]


def test_event_and_methodology():
    g = golden()
    assert g["news_id"] == "evt-taiwan-quake"
    assert g["methodology"] == "correlation_contagion"
    assert "TSMC" in g["thesis"]
    assert g["budget"]["attempts"] == 2


def test_magnitudes_are_defensible():
    g = golden()
    impacts = {p["ticker"]: p["impact_pct"] for p in g["positions"]}
    # direct supply-chain names take the worst hit, and NVDA worst of all
    assert impacts["NVDA"] == min(impacts.values())
    assert impacts["NVDA"] < impacts["AVGO"] < impacts["AAPL"] < impacts["MSFT"] < 0
    # defensives are flat to slightly positive
    assert impacts["JNJ"] > 0 and impacts["WMT"] > 0 and impacts["XOM"] == 0.0
    # a fab halt, not a crash: single-digit percentages only
    assert all(abs(v) < 10.0 for v in impacts.values())
    assert -10.0 < g["portfolio_impact_pct"] < 0


def test_confidences_rank_with_directness():
    conf = {p["ticker"]: p["confidence"] for p in golden()["positions"]}
    assert conf["NVDA"] > conf["AVGO"] > conf["AAPL"] > conf["MSFT"] > conf["JPM"]
    assert all(0.0 <= c <= 1.0 for c in conf.values())


def test_mechanism_chain_renders():
    mech = golden()["mechanism"]
    assert 4 <= len(mech) <= 6
    for link in mech:
        assert len(link["from"]) <= 22, link["from"]      # node labels must fit the graph
        assert len(link["to"]) <= 22, link["to"]
        assert len(link["effect"]) >= 3
    # one connected chain: every link after the first departs from a known node
    seen = {mech[0]["from"]}
    for link in mech:
        assert link["from"] in seen, f"orphan node in chain: {link['from']}"
        seen.add(link["to"])


def test_rationales_are_substantive_and_distinct():
    rationales = [p["rationale"] for p in golden()["positions"]]
    assert len(set(rationales)) == 10, "rationales must not repeat"
    for p, text in zip(golden()["positions"], rationales):
        assert 60 <= len(text) <= 400, (p["ticker"], len(text))


# Vetted against a live search index. A judge may click these on stage, so the set is
# pinned: no bare publisher homepages, and above all no invented deep links.
VETTED_URLS = {
    "https://www.sdxcentral.com/news/tsmc-evacuates-fabs-and-suspends-construction-in-"
    "earthquake-aftermath-confirms-all-personnel-are-safe/",
    "https://www.microchipusa.com/industry-news/taiwan-earthquake-tsmc-in-taiwan-evacuates-"
    "factories",
    "https://www.tomshardware.com/tech-industry/semiconductors/tsmc-chipmaking-factories-"
    "rocked-by-magnitude-7-0-earthquake-that-was-the-strongest-in-27-years-but-facilities-"
    "escaped-unharmed-companys-earthquake-protection-measures-pay-off",
    "https://earthquake.usgs.gov/",
}


def test_citations_are_the_vetted_urls():
    cites = golden()["citations"]
    assert 3 <= len(cites) <= 5
    urls = [c["url"] for c in cites]
    assert len(set(urls)) == len(urls)
    assert set(urls) == VETTED_URLS, "citations drifted from the vetted, search-confirmed set"
    for c in cites:
        assert c["url"].startswith("https://")
        assert len(c["claim"]) >= 10
        assert c["source"]


def test_citation_claims_do_not_overclaim_damage():
    """The sources describe evacuation, not destruction. Never let a claim say otherwise."""
    for c in golden()["citations"]:
        claim = c["claim"].lower()
        if "tomshardware.com" in c["url"]:
            assert "escaped unharmed" in claim, "must not attach an outage claim to this article"
        for word in ("destroyed", "levelled", "collapsed", "months of lost output"):
            assert word not in claim, (c["source"], word)


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
