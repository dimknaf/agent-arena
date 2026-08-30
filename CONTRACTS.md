# CONTRACTS — read before writing code

Four workstreams build in parallel. These interfaces are **fixed**. Do not change them without
telling the integrator. Own only your own files.

| Stream | Owns | Must not touch |
|---|---|---|
| A | `orchestrator.py` | everything else |
| B | `verifier/verify.py` | `impact.schema.json` (fixed contract) |
| C | `static/*` | any `.py` |
| D | `kit/*`, `skills/*`, `data/portfolio.json` | everything else |

Integrator (main) owns `app.py`, `verifier/impact.schema.json`, this file.

---

## 1. Event contract (A → queue → SSE → C)

Orchestrator pushes dicts onto an `asyncio.Queue`. `app.py` relays them verbatim as SSE `data:` JSON.
Frontend switches on `type`.

```jsonc
// persistent rail row — a discrete agent action
{"type":"tool","id":"t7","kind":"THOUGHT|SEARCH|WRITE|RUN|EMIT|SYSTEM",
 "label":"analysis.py","detail":"+34 lines","tokens":1204,"ms":840,
 "status":"running|ok|fail","body":"optional text to show in expanded row"}

// ephemeral slipstream line — raw stdout/stderr, never persisted
{"type":"log","stream":"stdout|stderr","text":"Traceback (most recent call last):"}

// run/attempt state — drives status strip + HUD
{"type":"state","phase":"spawning|running|verifying|rejected|accepted|destroyed",
 "attempt":2,"max_attempts":4,"model":"gpt-5.6-terra","effort":"high",
 "elapsed_s":74,"tokens_total":8210,"parallel_calls":3}

// verifier result — drives the right panel
{"type":"verdict","passed":false,"attempt":1,
 "checks":[{"id":"V1","name":"schema valid","passed":true},
           {"id":"V3","name":"positions reconcile","passed":false,
            "message":"Sum = -1.84, declared -2.10"}],
 "route":"MECHANICAL FIX|RE-REASONING|MAX REASONING"}

// final payload — drives treemap repaint, waterfall, sources panel
{"type":"result","data": { /* validated PortfolioImpactAnalysis */ }}
```

## 2. Verifier contract (B, called by A)

```python
from verifier.verify import verify
report = verify(result: dict, portfolio: dict, measured: dict) -> dict
```
Returns:
```python
{"passed": bool,
 "checks": [{"id":"V3","name":"positions reconcile","passed":False,
             "message":"...","kind":"schema"|"semantic"}]}
```
`kind` drives A's retry routing. Pure function, no network, no printing.

**Checks:** `V1` schema valid (kind=schema) · `V2` tickers ⊆ portfolio (semantic) ·
**`V3` Σ(weight_pct/100 × impact_pct) == portfolio_impact_pct ±0.01 (semantic) ← the designed first failure** ·
`V4` impact_usd ≈ value_before_usd × impact_pct/100, ±$1 (semantic) ·
`V5` ranges/enums sane (schema) · `V6` `/verifier` hash unchanged (semantic).

## 3. Portfolio contract (D → A, B, C)

`data/portfolio.json`:
```json
{"total_value_usd": 100000,
 "positions": [{"ticker":"AAPL","name":"Apple Inc.","sector":"Technology",
                "qty":40,"price_usd":455.0,"value_usd":18200,"weight_pct":18.2}]}
```
Weights must sum to 100 ±0.01. 10 US equities.

## 4. Agent invocation (A)

```bash
codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
  --disable fast_mode -m gpt-5.6-terra -c model_reasoning_effort="medium" \
  --json --output-schema /verifier/impact.schema.json \
  -o /work/result.json -C /work "<task prompt>"
```
Retry: `codex exec resume --last` with the failure list appended.

**Non-negotiable:** models are 5.6 only (`gpt-5.6-terra`, `gpt-5.6-luna`). Never `gpt-5.5`, never
`gpt-5.4-mini` (retires today 19:00 UTC). No `ultra` effort. No MCP servers.

## 5. Hard-won gotchas — violating these breaks the demo

- Daytona `process.exec` default timeout is **10 seconds**. Use `create_session` +
  `execute_session_command(run_async=True)` + `get_session_command_logs_async`.
- Set `auto_stop_interval=0` or the sandbox dies after 15 min idle.
- Codex writes **progress to stderr**, final message to stdout. Wire **both** callbacks.
- **Never block inside a log callback** — it disconnects the stream. Push to a queue, return.
- SEC EDGAR **requires a descriptive `User-Agent`**; without it you get 403 and a ~10-minute IP block.
- Image refs need an explicit tag — `python:latest` is rejected by snapshot creation.
- Frontend: animate **only `transform`/`opacity`**. Cap slipstream at ~30 nodes, remove on `animationend`.
