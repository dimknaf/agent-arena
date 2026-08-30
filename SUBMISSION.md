# AGENT ARENA — submission text

Paste-ready. Repo must be **PUBLIC** before submitting.

---

## Project name
**Agent Arena — verified equity research, written by an agent, in a disposable sandbox**

## Summary (2–3 sentences)
Agent Arena spawns a Daytona sandbox, drops OpenAI Codex into it, and makes it write and run its own
fundamental valuation code against a live news event. The agent cannot finish until its output
passes a programmatic verifier it has no access to — nine reconciliation gates, live market caps,
and a value chain that must close arithmetically. When it passes, the sandbox is destroyed and the
logs remain as proof of work.

## The problem
LLMs will tell you a stock is "down about 3%" and cannot show you why. Every number is asserted, not
derived, and nothing checks it. That is fine for a chatbot and useless for a portfolio.

Existing tools (AlphaSense, Bloomberg, Rogo, Hebbia) retrieve and summarise. None of them let an
agent write and execute its own analysis code against your actual positions, and none gate the
answer behind a verifier the agent cannot reach.

## What it does
1. **Live news** — Parallel Search finds real, dated, market-moving stories across the portfolio,
   both good and bad. Nothing is hardcoded except the hypothetical book itself.
2. **A sandbox spawns** — Daytona, ~0.6s, provisioned with Codex, pandas and our toolkit.
3. **The agent works** — it reads its brief, fetches **live market caps from SEC EDGAR**, researches
   the event, then writes and executes its own Python to value it.
4. **The verifier gates it** — 8 checks, including nine reconciliation gates across a 3×3
   horizon × scenario grid. Fail and it is sent back with the exact errors; it cannot exit until it
   passes. Failures are routed by kind: format errors go to a cheap model, reasoning errors to a
   stronger one.
5. **The sandbox is destroyed** — the log remains as the audit trail.

## The analysis — forward-looking value, not price history
No betas, no correlations, no "what the price did". A six-step chain, every number derived and
shown:

```
$115bn  data-centre revenue line
  × 40%   affected by the disruption
  × 9/12  month economic window
  × 25%   permanently lost (the rest is deferred, not destroyed)
  × margin × multiple
  = -$166.0bn value at stake
  ÷ $4,860bn market cap        ← fetched live from SEC, with provenance
  = -3.42%
```

Across **three horizons with different methods** — short-term is sentiment and positioning,
long-term is permanent earnings — each as a **low/base/high band**. That is where the insight lives:

```
NVDA   -8.00% short  →  -3.42% long
```
The market prices panic in weeks; only permanently lost earnings survive to twelve months. The
agent says so itself: *"Short-term panic is larger than the long-term value loss because most
wafers, packaging and cloud capacity are deferred rather than permanently lost."*

## Use of Codex
Codex is both the runtime agent and how this was built.
- **At runtime**, `codex exec` runs headless inside the sandbox with `--output-schema` binding the
  final answer to a JSON Schema, `--json` streaming the event log to the dashboard, and
  `exec resume` carrying the verifier's rejections back in with context preserved.
- `-c model_reasoning_summary=detailed` surfaces the agent's own reasoning, rendered live as it
  thinks.
- **Codex also wrote much of this project**, spending the hackathon credits.

## Use of Daytona
Load-bearing, not decorative. Every analysis runs in a fresh sandbox: created, provisioned with
Codex, given the brief, locked down, and destroyed on success. Streaming stdout/stderr from
`getSessionCommandLogs` is what the screen renders. No sandbox, no product.

## Sponsor tools
- **Daytona** — sandbox lifecycle, session streaming, filesystem, egress policy
- **Codex** — the in-sandbox agent (`exec`, `--output-schema`, `--json`, `resume`) and our build tool
- **Parallel** — Search for live news discovery, Extract for article bodies

## Verified, not claimed
- 8/8 verifier checks green on a real run, **first attempt**, 290s, 332k tokens, 11 citations
- 56 tests on the verifier
- Market caps fetched live from EDGAR with `source_url` and `accession` for every one
- The verifier lives outside the agent's writable workspace — it cannot rewrite its own contract

## Honest limits
- The portfolio is hypothetical.
- Summing downside cases assumes they happen together — conservative, and labelled as such, not
  passed off as a probabilistic bound.
- The agent's chain inputs are its own estimates; the point is that every one is **stated and
  checkable**, not that they are certain.

## Run it
```bash
pip install -r requirements.txt
cp .env.example .env      # DAYTONA_API_KEY, PARALLEL_API_KEY, SEC_USER_AGENT, DAYTONA_TARGET=eu
python -m uvicorn app:app --port 8077
```
Codex auth is transplanted from the host's `~/.codex/auth.json`.
