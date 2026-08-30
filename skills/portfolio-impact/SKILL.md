---
name: portfolio-impact
description: Quantify the impact of a breaking news event on every holding in a stock portfolio and emit a validated PortfolioImpactAnalysis JSON. Use whenever given a news event plus a portfolio.json and asked for per-position impact, second-order effects, or a portfolio-level P&L estimate.
---

# Portfolio impact analysis

Given a news event and `/work/portfolio.json`, quantify the impact on **every** holding and
emit JSON matching `/verifier/impact.schema.json` to `/work/result.json`. A verifier checks it
and will reject you with a precise list of failed checks.

## Method

Pick **one** methodology, declare it in `methodology`, and apply it consistently:

| value | formula |
|---|---|
| `beta_weighted_shock` | `impact_pct_i = beta_i × market_shock_pct` — for market-wide/rate/macro shocks |
| `sector_exposure_map` | `impact_pct_i = sector_shock_pct[sector_i] × exposure_i` — for sector or commodity shocks |
| `correlation_contagion` | `impact_pct_i = corr(i, hit) × impact_pct_hit` — for a shock to one named company that spreads |

Pick the one that matches the transmission mechanism, not the one that is easiest.

## Workflow

1. Read `/work/portfolio.json`. Read the event.
2. Research: 2–4 calls, no more. Establish what actually happened, the size of the move, and
   who is exposed. Then stop researching and start computing.
3. Write a Python script in `/work` (pandas + numpy are installed) that loads the portfolio,
   applies your formula to every row, and computes the totals. **Compute, do not estimate in
   your head** — mental arithmetic across 10 positions is the single most common cause of
   rejection.
4. Write `/work/result.json`. Print the reconciliation residual so you can see it is ~0.

## THE RECONCILIATION RULE — read this twice

```
portfolio_impact_pct == sum(p["weight_pct"]/100 * p["impact_pct"] for p in positions)   # ±0.01
```

Compute `portfolio_impact_pct` **from the line items**. Never write it down independently and
never round it by hand. This is the check that rejects most first attempts.

Also required, per position:

```
impact_usd == value_before_usd * impact_pct / 100        # ±$1
```
and `portfolio_impact_usd == sum(impact_usd)`, `portfolio_value_before_usd == total_value_usd`.

Do it like this:

```python
import json
port = json.load(open("/work/portfolio.json"))
positions = []
for p in port["positions"]:
    impact_pct = round(my_formula(p), 4)          # your chosen methodology
    positions.append({
        "ticker": p["ticker"], "sector": p["sector"],
        "weight_pct": p["weight_pct"], "value_before_usd": p["value_usd"],
        "impact_pct": impact_pct,
        "impact_usd": round(p["value_usd"] * impact_pct / 100, 2),
        "rationale": "...", "confidence": 0.6,
    })
total_pct = round(sum(p["weight_pct"]/100 * p["impact_pct"] for p in positions), 4)
total_usd = round(sum(p["impact_usd"] for p in positions), 2)
assert abs(total_pct - sum(p["weight_pct"]/100*p["impact_pct"] for p in positions)) < 0.01
```

## Coverage

**Every holding in the portfolio must appear in `positions`** — all 10, same tickers, same
`weight_pct` and `value_before_usd` as the portfolio file. A holding you judge unaffected still
gets a row with `"impact_pct": 0` and a one-line rationale saying why it is insulated. Omitting
a position fails the verifier; inventing a ticker not in the portfolio also fails.

Keep `impact_pct` inside ±25 (schema bound). Realistic single-event moves are ±0.5% to ±8%;
anything past ±10% needs a strong reason in the rationale.

## Tools

- `/opt/kit/parallel_client.py` — `search(query, max_results=5) -> list[dict]` and
  `extract(url) -> str`. Needs `PARALLEL_API_KEY` (already in env).
- `/opt/kit/sec_client.py` — `ticker_to_cik`, `latest_filings(cik, forms=("8-K",))` (the rows
  carry 8-K `items` codes), `filing_text`. **`SEC_USER_AGENT` must be set on every request** —
  the client enforces it; without it EDGAR 403s and blocks the IP for ~10 minutes.
- Finnhub's free tier returns 403 on `/stock/candle`. Do not try it.

```python
import sys; sys.path.insert(0, "/opt/kit")
import parallel_client, sec_client
hits = parallel_client.search("TSMC fab outage AI GPU supply", max_results=5)
n_calls = parallel_client.get_call_count()
```

## Citations

`citations` needs **at least 2** entries, each `{claim, url}` with a real `https://` URL that
you actually fetched in this run. Copy the URL from the tool output. **Never invent, guess, or
reconstruct a URL** — a plausible-looking fabricated link is a failure, not a near miss.

## Budget

Credits are limited. Be efficient: research once, compute once, emit once. Report honestly in
`budget`:

- `codex_credits_used` — your best estimate of credits consumed so far
- `parallel_calls_used` — from `parallel_client.get_call_count()`
- `attempts` — 1 on the first emit, incremented on each retry

## On rejection

You will be handed the exact list of failed checks. Fix **precisely those** and re-emit. Do not
rewrite the thesis, do not change methodology, do not re-run research — the usual fix is
arithmetic. If `V3` failed, recompute `portfolio_impact_pct` from the line items with Python.
