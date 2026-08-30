# Agent Arena

**An autonomous Codex agent writes and runs its own equity valuation inside a disposable Daytona
sandbox — and cannot finish until a verifier it has no access to says the arithmetic holds.**

Built at Daytona HackSprint London, 30 Aug 2026.

---

## The idea

LLMs will tell you a stock is "down about 3%" and cannot show you why. Every number is asserted,
never derived, and nothing checks it.

Agent Arena makes the agent *prove it*:

1. **Live news** — Parallel Search finds real, dated stories across the portfolio, good and bad.
2. **A sandbox spawns** — Daytona, ~0.6s, provisioned with Codex, pandas and our toolkit.
3. **The agent works** — fetches **live market caps from SEC EDGAR**, researches the event, then
   writes and executes its own Python to value it.
4. **A verifier gates it** — 8 checks including nine reconciliation gates. Fail and it is sent back
   with the exact errors. It cannot exit until it passes.
5. **The sandbox is destroyed** — the log remains as proof of work.

## The analysis: forward-looking value, not price history

No betas, no correlations. A six-step chain where every number is shown and challengeable:

```
$115bn  data-centre revenue line
  x 40%   affected by the disruption
  x 9/12  month economic window
  x 25%   permanently lost (the rest deferred, not destroyed)
  x margin x multiple
  = -$166.0bn value at stake
  / $4,860bn market cap        <- fetched live from SEC, with provenance
  = -3.42%
```

Across **three horizons with different methods** — short-term is sentiment and positioning,
long-term is permanent earnings — each as a low/base/high band.

```
NVDA   -8.00% short  ->  -3.42% long
```

The market prices panic in weeks; only permanently lost earnings survive to twelve months.

## Verified

- 8/8 verifier checks on a real run, **first attempt**, 290s, 11 citations
- 56 tests on the verifier
- Every market cap carries `source_url` and `accession`
- The verifier lives **outside** the agent's writable workspace — it cannot rewrite its own contract

## Stack

| | |
|---|---|
| **Daytona** | sandbox lifecycle, session log streaming, filesystem, egress policy |
| **Codex** | the in-sandbox agent (`exec --output-schema --json`, `resume`) — and our build tool |
| **Parallel** | Search for live news, Extract for article bodies |
| **SEC EDGAR** | live market caps and fundamentals, keyless |
| Backend | Python + FastAPI, SSE |
| Frontend | one static page, no build step |

## Run it

```bash
pip install -r requirements.txt
cp .env.example .env     # DAYTONA_API_KEY, PARALLEL_API_KEY, SEC_USER_AGENT, DAYTONA_TARGET=eu
python -m uvicorn app:app --port 8077
```

Codex auth is transplanted from the host's `~/.codex/auth.json`.

- `/` — scan news, pick stories, run
- `/?replay=<run_id>` — replay a real past run, dead time compressed
- `/api/prompt` — the exact prompt the agent receives

## Layout

```
app.py              FastAPI: SSE relay, news, trigger, prompt, past runs
orchestrator.py     Daytona lifecycle, Codex invocation, retry routing
verifier/           the schema and the 8 checks (56 tests)
skills/             the SKILL.md baked into the sandbox
kit/                SEC + Parallel clients the agent uses
static/             the arena and the analysis reveal
```

## Honest limits

The portfolio is hypothetical. Summing downside cases assumes they happen together — conservative,
and labelled as such rather than passed off as a probabilistic bound. The agent's chain inputs are
its own estimates; the point is that every one is stated and checkable.
