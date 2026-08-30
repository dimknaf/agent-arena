# Agent Arena

> **A verifiable, event-driven equity-research agent that writes and runs its own valuation code in a disposable Daytona sandbox.**

Agent Arena turns a market-moving news story into an auditable portfolio-impact assessment. Rather
than asking an LLM to guess a percentage move, it requires the agent to research the event, build a
forward-looking value chain in Python, and pass an independent verifier before results reach the
dashboard.

Built at Daytona HackSprint London, 30 Aug 2026.

---

## Hackathon pitch

Financial research assistants are good at summarising news, but a plausible-looking answer is not
enough when a portfolio decision depends on it. Agent Arena demonstrates a safer model for
agentic analysis: give an agent a real task, a constrained execution environment, an observable
trail of work, and an acceptance test it cannot alter.

The result is a live, cinematic demo of an agent going from headline to a quantified portfolio
impact—complete with sources, calculations, scenario ranges, verifier verdicts, and replayable
evidence.

## The problem

LLMs will tell you a stock is "down about 3%" and cannot show you why. The number is often
asserted rather than derived, and nothing ensures that the underlying arithmetic or assumptions
are coherent. That may be acceptable for a chat response; it is not acceptable for a portfolio
decision.

## The solution

Agent Arena makes the agent *prove its work*:

1. **Live news** — Parallel Search finds real, dated stories across the portfolio, good and bad.
2. **A sandbox spawns** — Daytona, ~0.6s, provisioned with Codex, pandas and our toolkit.
3. **The agent works** — fetches **live market caps from SEC EDGAR**, researches the event, then
   writes and executes its own Python to value it.
4. **A verifier gates it** — 8 checks including nine reconciliation gates. Fail and it is sent back
   with the exact errors. It cannot exit until it passes.
5. **The sandbox is destroyed** — the log remains as proof of work.

## What the app demonstrates

- **Event-to-portfolio reasoning:** select one or more live market events and assess their effect
  across a 10-stock hypothetical portfolio.
- **Agent-authored computation:** Codex writes and executes the valuation code instead of merely
  narrating a conclusion.
- **Forward-looking analysis:** a transparent revenue-to-value chain separates short-term market
  sentiment from longer-term, permanent earnings impact.
- **Independent verification:** schema, completeness, arithmetic, scenario, citation, and
  reconciliation checks gate the final result. The verifier sits outside the agent's writable
  workspace.
- **Transparent provenance:** SEC market-cap sources and article citations are surfaced alongside
  the result, so assumptions can be challenged rather than accepted on faith.
- **Live observability:** FastAPI Server-Sent Events stream the sandbox's states, tools, logs, and
  verifier feedback into the mission-control UI.
- **Replay and export:** completed runs are stored with their event stream, can be replayed without
  inventing demo data, and can be exported as a self-contained HTML report.
- **Ephemeral execution:** each run uses an isolated Daytona sandbox which is removed after the
  analysis, leaving the recorded audit trail rather than a long-lived execution environment.

## Demo flow

1. Open the dashboard and scan the latest relevant news.
2. Choose an event and inspect the exact prompt before it is sent.
3. Start a run and watch the agent research, write code, calculate, and respond to verifier
   feedback in real time.
4. Review the portfolio heat map, scenario bands, waterfall, sources, and verdict.
5. Replay a completed real run or export its analysis for sharing.

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

Create an environment and install the Python dependencies:

```bash
python -m venv .venv
# macOS / Linux
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

On Windows PowerShell, activate with `.\.venv\Scripts\Activate.ps1` and copy the environment
template with `Copy-Item .env.example .env`.

Set `DAYTONA_API_KEY`, `PARALLEL_API_KEY`, `SEC_USER_AGENT`, and `DAYTONA_TARGET` in `.env`.
Codex authentication is transplanted from the host's `~/.codex/auth.json` (or the file referenced
by `CODEX_AUTH_JSON`). Opening the dashboard needs only the local Python app; fetching live news
and launching an analysis use the configured external services.

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
