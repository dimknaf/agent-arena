---
name: portfolio-impact
description: Estimate the forward-looking fundamental value impact of a news event on every holding in a stock portfolio, across short/medium/long horizons with low-base-high ranges, and emit a validated PortfolioImpactAnalysis JSON. Use whenever given a news event plus a portfolio.json and asked for per-position impact, second-order effects, or portfolio P&L.
---

# Portfolio impact analysis

Given a news event and `/work/portfolio.json`, quantify the impact on **every** holding and write `/work/result.json` matching `/verifier/impact.schema.json`. A verifier returns the exact failed checks.

You are valuing **a change in the business**, not extrapolating a price chart. Do not size impact with beta or historical correlation. Ask: how many dollars of future profit did this event create or destroy, and how large is the company that owns them? $50bn of value lost at a $1tn company is -5%, whatever the stock did today. Set `methodology` to `fundamental_value_impact`.

## The chain — six steps, every number derived and shown

1. **EXPOSURE** `revenue_line_usd` — the business line the news touches, not total revenue. "NVDA data centre", not "NVDA".
2. **MAGNITUDE** `affected_fraction` — share of that line actually hit (0-1).
3. **DURATION** `duration_months`, `permanent_share` — how long it runs, and what fraction never comes back. **Deferred revenue slips right; it is not lost.** A fab outage delaying shipments a quarter destroys little value; a design win lost to a rival destroys all of it. This step separates a scare from a wound.
4. **PROFIT** `revenue_at_stake_usd = revenue_line_usd * affected_fraction * (duration_months/12) * permanent_share`, then `profit_at_stake_usd = revenue_at_stake_usd * margin`
5. **CAPITALISE** `value_at_stake_usd = profit_at_stake_usd * earnings_multiple`
6. **EQUITY** `impact_pct = value_at_stake_usd / market_cap_usd * 100`

Negative for value destroyed. Emit all six inputs plus `revenue_at_stake_usd`, `profit_at_stake_usd`, `value_at_stake_usd`, `market_cap_usd` — the verifier recomputes the chain from them.

> **V7 closure:** `value_at_stake_usd / market_cap_usd * 100` must equal `horizons.long_term.impact_pct.base` within 0.05. The chain lands on the **long-term base cell**; the other eight are derived from it, never independently invented.

### Worked example — ILLUSTRATIVE ONLY, derive your own

Stale numbers, shown for the pattern. They will **not** match what you fetch. Copy the method.

```
NVDA, TSMC fab outage, long_term / base
  revenue_line_usd  $115bn   data-centre segment      margin            0.55
  affected_fraction 0.25     gated by node + CoWoS    earnings_multiple 30
  duration_months   3        backlog clears in a qtr  market_cap_usd    $1.02tn (FETCHED, cited)
  permanent_share   0.30     70% ships late, not never
  -> revenue_at_stake = 115 * 0.25 * (3/12) * 0.30 = $2.2bn
  -> profit_at_stake  = 2.2 * 0.55                 = $1.2bn
  -> value_at_stake   = 1.2 * 30                   = -$36bn
  -> impact_pct       = -36 / 1020 * 100           = -3.5%   <- long_term.base
  -> contribution     = -3.5 * 14.00/100           = -0.49pp of portfolio
```

## Market caps must be fetched live

**A fabricated market cap invalidates the entire chain** — step 6 divides by it. Never invent, hardcode, or recall from memory. Fetch it and cite the source URL:

```python
import sys; sys.path.insert(0, "/opt/kit")
import sec_client
mc  = sec_client.market_cap("NVDA", price_usd=200.0)  # live XBRL shares x price
rev = sec_client.annual_revenue("NVDA")               # total; you attribute it to a segment
# both return {..., "source_url": ...} -> put that URL in citations
```

Pass `price_usd` from `portfolio.json`. If a ticker fails, fall back to `parallel_client.search` and cite that. Same rule for `revenue_line_usd`: segment revenue comes from a filing or fetched research, never from memory.

## Three horizons, three different mechanisms

Not one number scaled by time. Each carries its own `method` and `note`.

| horizon | window | `method` | driven by |
|---|---|---|---|
| `short_term` | 0-1 mo | `sentiment_positioning` | headline severity, narrative, crowding, positioning, momentum. **Not the chain.** |
| `medium_term` | 1-6 mo | `fundamental_chain_discounted` | the chain, discounted for what is already priced in |
| `long_term` | 6-24 mo | `fundamental_chain` | the chain in full |

Short-term moves are sentiment and flow, not value: a crowded long unwinds harder than fundamentals justify, an unloved name barely moves on real damage.

**short_term and long_term ARE ALLOWED TO DISAGREE, and the divergence is the most valuable output here.** A name can be -8% on panic and only -2% on value — that gap is the trade. Do not average them, smooth them together, or let one anchor the other. If every position has short ≈ long you have not done the work. Explain the divergence in `horizons.*.note`.

## Ranges: three runs of the chain, not three guesses

Every estimate is `{low, base, high}`. Vary the chain inputs and **re-run**; say what you varied in `variant_basis`:

- **low** — larger `affected_fraction`, longer `duration_months`, higher `permanent_share`
- **base** — central estimate
- **high** — contained and mostly deferred: smaller fraction, shorter, lower permanent share

**V5b requires `low <= base <= high` numerically**, so for damage `low` is the most negative. Bounds are +/-60; realistic single-event moves are +/-0.5% to +/-8%. Never type three numbers the arithmetic did not produce.

## THE ARITHMETIC RULE — nine reconciliation gates

For **every** (horizon, variant) pair — 3 x 3 = 9 gates (V3):

```
horizons[h].impact_pct[v] == SUM(p.weight_pct/100 * p.horizons[h].impact_pct[v])   +/-0.01
```

Also `impact_usd == value_before_usd * impact_pct / 100` in every cell (V4, +/-$1).

Compute the **whole grid in one pandas script** — three rows of arithmetic over a DataFrame, not 90 separate decisions. Derive portfolio totals **from** the position rows, never independently. **Print the nine residuals before writing the file.** This is where attempts get rejected.

```python
import pandas as pd
df = pd.DataFrame(rows)          # one row per position, chain inputs as columns
for h in ("short_term", "medium_term", "long_term"):
    for v in ("low", "base", "high"):
        total = (df.weight_pct / 100 * df[f"{h}_{v}"]).sum()
        print(h, v, round(total, 4), "residual", round(total - portfolio[h][v], 6))
```

## Output shape

Top level: `news_id`, `headline`, `published_at` (ISO-8601, `""` if truly unknown), `thesis` (40-600 chars), `methodology`, `confidence`, `mechanism` (1-6 edges of `{from, to, effect}`; **`from`/`to` max 22 chars**), `positions`, `portfolio_value_before_usd`, `horizons`, `citations`, `budget`.

`positions[]`: `ticker`, `sector`, `weight_pct`, `value_before_usd`, the six chain inputs, `revenue_at_stake_usd`, `profit_at_stake_usd`, `value_at_stake_usd`, `market_cap_usd`, `value_basis` (plain-language derivation of `value_at_stake_usd`, 20-400 chars), `variant_basis`, `rationale`, `confidence`, and `horizons.{short_term,medium_term,long_term}` each with `method`, `note`, and `impact_pct`/`impact_usd` as `{low, base, high}`.

**Every holding appears**, with the same `ticker`, `weight_pct` and `value_before_usd` as the portfolio file. Say "no fundamental damage" **structurally**, not in prose: set `affected_fraction` to `0.0` and `horizons.long_term.impact_pct.base` to `0.0`. That is self-documenting and needs no magic token. `value_basis` should be a genuine explanation of why the name is insulated. **Never fabricate a chain to justify a zero.**

Two easy mistakes:

> **Zero the fraction, never the cap.** Still give an unaffected name a **real** `market_cap_usd` and an explicit `value_at_stake_usd: 0.0`. V7 then *verifies* it instead of skipping, and it passes for free because `0 == 0/cap*100`. Supply both and it is checked; omit either and it is merely skipped. This holds both for an all-zero name and for one that moves on sentiment alone — non-zero `short_term`, zero `long_term`, no chain.
>
> **Write the `0.0`, do not leave a stale number.** A non-zero `value_at_stake_usd` sitting beside a zero impact grid is incoherent — billions at stake yet no impact anywhere — and V7 fails it loudly. When you conclude a name is unaffected, reset the stake as well as the fraction.
>
> **You cannot dodge the gate by leaving the chain blank.** Declaring no chain while claiming a non-zero `long_term.impact_pct.base` does **not** skip V7 — it fails with a specific message. Claim a long-run number and you must justify it with the chain.

## Tools

- `/opt/kit/sec_client.py` — `market_cap`, `annual_revenue`, `ticker_to_cik`, `latest_filings(cik, forms=("8-K",))` (rows carry 8-K `items` codes), `filing_text`. **`SEC_USER_AGENT` must be set** — the client enforces it; without it EDGAR 403s and blocks the IP for ~10 minutes.
- `/opt/kit/parallel_client.py` — `search(query, max_results=5)`, `extract(url)`, `get_call_count()`. Needs `PARALLEL_API_KEY` (already in env).
- Finnhub free tier 403s on `/stock/candle`. Do not try it.

pandas and numpy are installed in `/work`. **Compute, do not estimate in your head.**

## Citations, budget, rejection

`citations` needs >=2 entries with **all four** of `claim`, `url`, `source`, `published_at`, using real `https://` URLs you fetched this run — including the market-cap sources. Copy them from tool output; **never invent or reconstruct a URL**, a plausible-looking fabricated link is a failure, not a near miss.

Research once (2-4 calls), compute once, emit once. Report `codex_credits_used`, `parallel_calls_used` (`parallel_client.get_call_count()`) and `attempts` in `budget`.

On rejection you get the exact failed checks. Fix **precisely those** and re-emit — do not rewrite the thesis or re-run research. The usual fix is arithmetic: recompute the failing horizon/variant total from the position rows in pandas.
