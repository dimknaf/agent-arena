"""Workstream A - Daytona sandbox orchestrator for the portfolio-impact agent arena.

Public surface (the only thing the integrator should depend on):

    async def run_analysis(news: dict, portfolio: dict, emit) -> dict

`emit(event: dict) -> None` (sync or async, both supported) is called for every event in
the CONTRACTS.md §1 event contract: `tool`, `log`, `state`, `verdict`, `result`.

Design notes / hard-won gotchas honoured here:
  * `process.exec` has a 10s default timeout -> we use sessions + run_async=True.
  * Codex writes progress to stderr and the final message to stdout -> both callbacks wired.
  * Log callbacks never block: they `put_nowait` onto an asyncio.Queue and return.
  * `auto_stop_interval=0` so the sandbox does not die mid-run.
  * Models are 5.6 only. No `ultra` effort. No MCP servers.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import json
import os
import shlex
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional

try:  # optional, but the repo ships a .env
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is a convenience only
    pass

REPO_ROOT = Path(__file__).resolve().parent
RUNS_DIR = REPO_ROOT / "runs"
SCHEMA_PATH = REPO_ROOT / "verifier" / "impact.schema.json"

SNAPSHOT_NAME = os.environ.get("DAYTONA_SNAPSHOT", "quant-agent-v1")

# --- provisioning fallback --------------------------------------------------
# The hackathon API key can READ snapshots but POST /snapshots returns 403, so the
# baked snapshot may not exist. We fall back to a plain base image and provision at
# runtime. Measured cold path: ~16s total (create 0.6s, codex 4.2s, python 10.3s).
#
# node:22-bookworm chosen over python:3.11-slim-bookworm because it already ships
# Python 3.11.2 AND node 22, so neither runtime needs an apt install of the other --
# only pip itself is missing. Verified live.
BASE_IMAGE = os.environ.get("DAYTONA_BASE_IMAGE", "node:22-bookworm")
FORCE_BASE_IMAGE = os.environ.get("AGENT_ARENA_FORCE_BASE_IMAGE", "").lower() in (
    "1", "true", "yes", "on",
)

# MUST match what skills/portfolio-impact/SKILL.md tells the agent:
#   sys.path.insert(0, "/opt/kit"); import parallel_client, sec_client
# A mismatch here does not fail loudly -- the agent silently falls back to raw
# requests/curl, losing the Parallel client, the SEC User-Agent guard (a bare EDGAR
# call gets 403 + a ~10 minute IP block) and get_call_count() budget telemetry.
REMOTE_KIT_DIR = "/opt/kit"
# Codex discovers skills at $CWD/.agents/skills, $REPO_ROOT/.agents/skills,
# $HOME/.agents/skills and /etc/codex/skills. Anywhere else is silently ignored.
REMOTE_SKILLS_DIR = "/etc/codex/skills"

# Proves the agent's tools are actually reachable, rather than assuming.
KIT_VERIFY_CMD = (
    "ls -la /etc/codex/skills/ 2>&1 | tail -5; "
    "ls -la /opt/kit/ 2>&1 | tail -5; "
    "python3 -c \"import sys; sys.path.insert(0,'/opt/kit'); "
    "import parallel_client, sec_client; print('kit imports OK')\""
)

# One shell command, so the whole provision is a single streamed session command.
# `--break-system-packages` is required: Debian bookworm marks its Python as
# externally managed (PEP 668) and pip refuses to install without it.
PROVISION_SCRIPT = (
    "set -e; "
    "mkdir -p /root/.codex && chmod 700 /root/.codex; "
    "echo '>>> installing codex-cli'; "
    "npm i -g @openai/codex; "
    "echo '>>> ensuring python toolchain'; "
    "python3 -m pip --version >/dev/null 2>&1 || "
    "{ apt-get update -qq && apt-get install -y -qq python3-pip; }; "
    "python3 -m pip install --quiet --break-system-packages "
    "numpy pandas requests jsonschema python-dateutil; "
    "echo '>>> versions'; "
    "codex --version; "
    "python3 -c \"import pandas,numpy;print('pandas',pandas.__version__,'numpy',numpy.__version__)\""
)

# --- run policy -------------------------------------------------------------
MAX_ATTEMPTS = 4
WALL_CLOCK_BUDGET_S = 6 * 60  # 6 minutes total, all attempts
ATTEMPT_POLL_INTERVAL_S = 2.0
# Printed by every session command so we can detect completion ourselves; see the long
# comment in _run_session_command for why the API's exit_code cannot be trusted alone.
DONE_SENTINEL = "__ARENA_CMD_DONE__"
# If the log stream goes quiet for this long, re-read the log non-streaming.
IDLE_WATCHDOG_S = 45.0

# Sandbox paths. The schema deliberately lives OUTSIDE `-C /work` so the agent's
# workspace root cannot reach it -> it cannot rewrite its own contract.
WORK_DIR = "/work"
VERIFIER_DIR = "/verifier"
REMOTE_SCHEMA = f"{VERIFIER_DIR}/impact.schema.json"
REMOTE_RESULT = f"{WORK_DIR}/result.json"

# --- Codex authentication ---------------------------------------------------
# There is NO OpenAI API key and no fallback. Auth works only by transplanting the
# host's ChatGPT credentials (auth_mode="chatgpt") into the sandbox.
# These bytes are secret: never log, echo, or persist them to runs/.
CODEX_HOME = "/root/.codex"
REMOTE_AUTH = f"{CODEX_HOME}/auth.json"

# Substrings that mean "Codex could not authenticate". Checked only against output
# from a command that also exited non-zero, so an unrelated HTTP 401 from a data
# source cannot raise a false alarm.
AUTH_FAILURE_MARKERS = (
    "not logged in",
    "please run codex login",
    "codex login",
    "unauthorized",
    "authentication failed",
    "invalid_api_key",
    "no credentials",
    "401",
)


def host_auth_path() -> Path:
    """Host ChatGPT credentials; override with CODEX_AUTH_JSON."""
    override = os.environ.get("CODEX_AUTH_JSON")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".codex" / "auth.json"

# --- retry routing (CONTRACTS.md step 6) ------------------------------------
INITIAL_MODEL = "gpt-5.6-terra"
INITIAL_EFFORT = "medium"

ROUTE_MECHANICAL = ("gpt-5.6-luna", "low", "MECHANICAL FIX")
ROUTE_REREASON = ("gpt-5.6-terra", "high", "RE-REASONING")
ROUTE_MAX = ("gpt-5.6-terra", "xhigh", "MAX REASONING")

# --- egress lock ------------------------------------------------------------
# The agent gets network access only to what it actually needs. Override with
# DAYTONA_DOMAIN_ALLOW_LIST (comma-separated) if the agent needs another source.
# chatgpt.com / auth.openai.com are required: ChatGPT-mode auth refreshes tokens there.
DEFAULT_DOMAIN_ALLOW_LIST = (
    "api.openai.com,chatgpt.com,auth.openai.com,api.parallel.ai,data.sec.gov,www.sec.gov"
)
# Safety net so a crashed host process cannot leak a running sandbox.
SANDBOX_TTL_MINUTES = 30


# ===========================================================================
# small helpers
# ===========================================================================


async def _call_emit(emit: Callable[[dict], Any], event: dict) -> None:
    """Emit tolerantly: `emit` may be sync or async, and must never kill the run."""
    try:
        res = emit(event)
        if inspect.isawaitable(res):
            await res
    except Exception as exc:  # a broken UI must not abort the analysis
        print(f"[orchestrator] emit failed: {exc!r}")


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _verifier_dir_hash() -> str:
    """Stable hash of the local /verifier contract files (for V6)."""
    h = hashlib.sha256()
    vdir = REPO_ROOT / "verifier"
    if vdir.is_dir():
        for p in sorted(vdir.rglob("*")):
            if p.is_file() and p.suffix in (".json", ".py"):
                h.update(p.name.encode())
                h.update(p.read_bytes())
    return h.hexdigest()


def _load_verify():
    """Import B's verifier lazily; fall back to a minimal local check if absent.

    Workstream B owns `verifier/verify.py`; during parallel development it may not
    exist yet. We must not create it, so we degrade gracefully instead of crashing.
    """
    try:
        from verifier.verify import verify  # type: ignore

        return verify, True
    except Exception:
        return _fallback_verify, False


def _fallback_verify(result: dict, portfolio: dict, measured: dict) -> dict:
    """TEMPORARY stand-in used only while `verifier/verify.py` does not import.

    Implements a thin version of V1/V2/V3/V4 so the demo loop still works.
    """
    checks: list[dict] = []

    def add(cid, name, passed, kind, message=""):
        checks.append(
            {"id": cid, "name": name, "passed": bool(passed), "message": message, "kind": kind}
        )

    schema_ok = True
    try:
        import jsonschema  # type: ignore

        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        jsonschema.validate(result, schema)
        add("V1", "schema valid", True, "schema")
    except ImportError:
        required = ["news_id", "headline", "thesis", "positions", "portfolio_impact_pct"]
        missing = [k for k in required if k not in (result or {})]
        schema_ok = not missing
        add("V1", "schema valid", schema_ok, "schema", f"missing keys: {missing}" if missing else "")
    except Exception as exc:
        schema_ok = False
        add("V1", "schema valid", False, "schema", str(exc)[:400])

    positions = (result or {}).get("positions") or []
    pf_tickers = {p.get("ticker") for p in (portfolio or {}).get("positions", [])}
    if pf_tickers:
        stray = sorted({p.get("ticker") for p in positions} - pf_tickers)
        add("V2", "tickers subset of portfolio", not stray, "semantic",
            f"unknown tickers: {stray}" if stray else "")

    try:
        total = sum(
            float(p.get("weight_pct", 0)) / 100.0 * float(p.get("impact_pct", 0)) for p in positions
        )
        declared = float((result or {}).get("portfolio_impact_pct", 0))
        ok = abs(total - declared) <= 0.01
        add("V3", "positions reconcile", ok, "semantic",
            "" if ok else f"Sum = {total:.4f}, declared {declared:.4f}")
    except Exception as exc:
        add("V3", "positions reconcile", False, "semantic", str(exc)[:200])

    v4_bad = []
    for p in positions:
        try:
            expected = float(p.get("value_before_usd", 0)) * float(p.get("impact_pct", 0)) / 100.0
            if abs(expected - float(p.get("impact_usd", 0))) > 1.0:
                v4_bad.append(f"{p.get('ticker')}: expected {expected:.2f}, got {p.get('impact_usd')}")
        except Exception:
            v4_bad.append(f"{p.get('ticker')}: unparseable")
    add("V4", "impact_usd consistent", not v4_bad, "semantic", "; ".join(v4_bad[:4]))

    expected_hash = measured.get("verifier_hash_expected")
    actual_hash = measured.get("verifier_hash_actual")
    if expected_hash and actual_hash:
        add("V6", "/verifier hash unchanged", expected_hash == actual_hash, "semantic",
            "" if expected_hash == actual_hash else "schema file was modified in the sandbox")

    return {"passed": all(c["passed"] for c in checks), "checks": checks}


def _route_for(failed_checks: list[dict], attempt: int) -> tuple[str, str, str]:
    """Pick model/effort/route label for the NEXT attempt.

    schema failures  -> gpt-5.6-luna / low   (mechanical fix)
    semantic failures-> gpt-5.6-terra / high (re-reasoning)
    third failure    -> gpt-5.6-terra / xhigh (max reasoning)
    """
    if attempt >= 3:
        return ROUTE_MAX
    kinds = {c.get("kind", "semantic") for c in failed_checks}
    if kinds and kinds <= {"schema"}:
        return ROUTE_MECHANICAL
    return ROUTE_REREASON


# ===========================================================================
# Codex --json stream parsing (deliberately tolerant)
# ===========================================================================


def _dig(obj: Any, *keys: str) -> Any:
    """Return the first non-None value found under any of `keys`, searching one
    level of common wrapper objects (`msg`, `item`, `data`, `payload`, `event`)."""
    if not isinstance(obj, dict):
        return None
    for k in keys:
        if obj.get(k) is not None:
            return obj[k]
    for wrapper in ("msg", "item", "data", "payload", "event", "delta", "response",
                    "usage", "token_usage", "info", "totals", "result"):
        inner = obj.get(wrapper)
        if isinstance(inner, dict):
            got = _dig(inner, *keys)
            if got is not None:
                return got
    return None


# The live dialect (captured from a real run) is {"type":"item.completed","item":{...}},
# where `item.type` -- NOT the envelope's `type` -- carries the row kind.
LIVE_ITEM_KIND = {
    "agent_message": "EMIT",
    "reasoning": "THOUGHT",
    "command_execution": "RUN",
    "file_change": "WRITE",
    "patch": "WRITE",
    "web_search": "SEARCH",
    "mcp_tool_call": "RUN",
    "todo_list": "THOUGHT",
    "error": "SYSTEM",
}


def _item(obj: Any) -> Optional[dict]:
    """The `item` payload of a live-dialect event, if this is one."""
    if isinstance(obj, dict) and isinstance(obj.get("item"), dict):
        return obj["item"]
    return None


def _item_type(obj: Any) -> Optional[str]:
    item = _item(obj)
    if not item:
        return None
    for k in ("type", "item_type"):
        v = item.get(k)
        if isinstance(v, str):
            return v.lower()
    return None


def _event_type_string(obj: Any) -> str:
    """Best-effort extraction of the event's discriminator, lowercased.

    Includes the nested `item.type` so the envelope (`item.completed`) does not
    mask the row kind -- otherwise every item would classify as EMIT via "complete".
    """
    parts: list[str] = []
    if isinstance(obj, dict) and isinstance(obj.get("type"), str):
        parts.append(obj["type"])
    it = _item_type(obj)
    if it:
        parts.append(it)
    for key in ("type", "event_type", "item_type", "kind", "name", "role"):
        val = _dig(obj, key)
        if isinstance(val, str) and val not in parts:
            parts.append(val)
    return " ".join(parts).lower()


def _classify(type_str: str, obj: Any) -> str:
    """Map a Codex event onto our rail kinds. Live `item.type` wins over heuristics."""
    it = _item_type(obj)
    if it and it in LIVE_ITEM_KIND:
        return LIVE_ITEM_KIND[it]
    t = type_str
    if not t:
        return "SYSTEM"
    if "token" in t or "usage" in t:
        return "SYSTEM"
    if "error" in t or "fail" in t:
        return "SYSTEM"
    if "reason" in t or "think" in t or "plan" in t:
        return "THOUGHT"
    if "search" in t or "fetch" in t or "browse" in t or "web" in t:
        return "SEARCH"
    if "patch" in t or "diff" in t or "file_change" in t or "write" in t or "edit" in t:
        return "WRITE"
    if "exec" in t or "command" in t or "shell" in t or "tool" in t or "bash" in t:
        return "RUN"
    if "agent_message" in t or "assistant" in t or "message" in t or "complete" in t or "output" in t:
        return "EMIT"
    return "SYSTEM"


def _summarize(obj: Any, kind: str) -> tuple[str, str, str]:
    """(label, detail, body) for the rail row - all best-effort, never raises."""
    label, detail, body = kind.title(), "", ""

    text = _dig(obj, "text", "message", "content", "reasoning", "summary", "delta")
    if isinstance(text, list):
        chunks = []
        for c in text:
            if isinstance(c, str):
                chunks.append(c)
            elif isinstance(c, dict):
                chunks.append(str(c.get("text") or c.get("content") or ""))
        text = " ".join(x for x in chunks if x)
    if isinstance(text, dict):
        text = json.dumps(text)[:800]
    if isinstance(text, str) and text.strip():
        body = text.strip()

    command = _dig(obj, "command", "cmd", "argv")
    if isinstance(command, list):
        command = " ".join(str(c) for c in command)
    if isinstance(command, str) and command.strip():
        label = command.strip().splitlines()[0][:80]
        body = body or command.strip()

    path = _dig(obj, "path", "file", "filename", "file_path")
    if isinstance(path, str) and path:
        label = path.split("/")[-1][:60]

    query = _dig(obj, "query", "q", "search_query", "url")
    if isinstance(query, str) and query:
        label = query[:80]

    changes = _dig(obj, "changes", "file_changes", "patch")
    if isinstance(changes, dict) and changes:
        names = list(changes.keys())
        label = (names[0].split("/")[-1] if names else label)[:60]
        detail = f"{len(names)} file(s)"
    elif isinstance(changes, str) and changes:
        added = sum(1 for ln in changes.splitlines() if ln.startswith("+"))
        detail = f"+{added} lines"
        body = body or changes[:2000]

    exit_code = _dig(obj, "exit_code", "exitCode", "status_code")
    if isinstance(exit_code, int):
        detail = detail or f"exit {exit_code}"

    if not label or label == kind.title():
        if body:
            label = body.strip().splitlines()[0][:80]
        else:
            label = kind.title()

    return label[:120], detail[:80], body[:4000]


def _turn_usage(obj: Any) -> Optional[dict]:
    """Real per-turn token usage from a live `turn.completed` frame.

    Shape: {"input_tokens","cached_input_tokens","cache_write_input_tokens",
            "output_tokens","reasoning_output_tokens"}
    These are the authoritative counts -- never estimate when this is present.
    """
    if not isinstance(obj, dict):
        return None
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        return None
    if not any(k in usage for k in ("input_tokens", "output_tokens")):
        return None

    def num(key: str) -> int:
        v = usage.get(key)
        return int(v) if isinstance(v, (int, float)) else 0

    return {
        "input_tokens": num("input_tokens"),
        "cached_input_tokens": num("cached_input_tokens"),
        "cache_write_input_tokens": num("cache_write_input_tokens"),
        "output_tokens": num("output_tokens"),
        "reasoning_output_tokens": num("reasoning_output_tokens"),
    }


def _extract_tokens(obj: Any) -> int:
    """Total tokens if this event carries a usage/token count, else 0."""
    total = _dig(obj, "total_tokens", "total_token_usage", "tokens")
    if isinstance(total, dict):
        total = total.get("total_tokens") or total.get("total")
    if isinstance(total, (int, float)):
        return int(total)
    inp = _dig(obj, "input_tokens", "prompt_tokens")
    out = _dig(obj, "output_tokens", "completion_tokens")
    acc = 0
    for v in (inp, out):
        if isinstance(v, (int, float)):
            acc += int(v)
    return acc


def _call_key(obj: Any) -> Optional[str]:
    """Correlation id so `*_begin` / `*_end` collapse into one rail row."""
    for k in ("call_id", "callId", "id", "item_id", "command_id"):
        v = _dig(obj, k)
        if isinstance(v, (str, int)):
            return str(v)
    return None


# ===========================================================================
# The orchestrator
# ===========================================================================


class _RunState:
    """Mutable per-run bookkeeping shared between the parser and the driver."""

    def __init__(self) -> None:
        self.tool_seq = 0
        self.tokens_total = 0
        # Authoritative counts, accumulated across turns from `turn.completed.usage`.
        self.tokens_in = 0
        self.tokens_out = 0
        self.tokens_cached = 0
        self.tokens_reasoning = 0
        self.turns_seen = 0
        self.parallel_calls = 0
        self.open_calls: dict[str, tuple[str, float, str, str]] = {}  # key -> (tool_id, t0, label, detail)
        self.last_tool_id: Optional[str] = None
        self.raw_lines: list[str] = []
        self.plain_lines: list[str] = []
        self.sample_written = False
        self.auth_suspect = False
        self.auth_evidence = ""

    def next_tool_id(self) -> str:
        self.tool_seq += 1
        return f"t{self.tool_seq}"

    def add_turn_usage(self, usage: dict) -> int:
        """Accumulate one turn's real usage. Returns that turn's billable total."""
        self.turns_seen += 1
        self.tokens_in += usage["input_tokens"]
        self.tokens_out += usage["output_tokens"]
        self.tokens_cached += usage["cached_input_tokens"]
        self.tokens_reasoning += usage["reasoning_output_tokens"]
        self.tokens_total = self.tokens_in + self.tokens_out
        return usage["input_tokens"] + usage["output_tokens"]


class Orchestrator:
    def __init__(self, emit: Callable[[dict], Any], run_id: Optional[str] = None) -> None:
        self.emit = emit
        self.run_id = run_id or f"run-{int(time.time())}-{uuid.uuid4().hex[:6]}"
        self.run_dir = RUNS_DIR / self.run_id
        self.started = time.monotonic()
        self.state = _RunState()
        self.attempt = 0
        self.model = INITIAL_MODEL
        self.effort = INITIAL_EFFORT
        self.phase = "spawning"

    # -- emit wrappers ------------------------------------------------------
    @property
    def elapsed_s(self) -> int:
        return int(time.monotonic() - self.started)

    async def emit_state(self, phase: str, **extra: Any) -> None:
        self.phase = phase
        ev = {
            "type": "state",
            "phase": phase,
            "attempt": max(self.attempt, 1),
            "max_attempts": MAX_ATTEMPTS,
            "model": self.model,
            "effort": self.effort,
            "elapsed_s": self.elapsed_s,
            "tokens_total": self.state.tokens_total,
            "parallel_calls": self.state.parallel_calls,
            # Real counts from turn.completed.usage, for the credit HUD.
            "tokens_in": self.state.tokens_in,
            "tokens_out": self.state.tokens_out,
            "tokens_cached": self.state.tokens_cached,
            "tokens_reasoning": self.state.tokens_reasoning,
            "turns": self.state.turns_seen,
        }
        ev.update(extra)
        await _call_emit(self.emit, ev)

    async def emit_log(self, stream: str, text: str) -> None:
        text = (text or "").rstrip("\n")
        if not text:
            return
        self.state.plain_lines.append(f"[{stream}] {text}")
        await _call_emit(self.emit, {"type": "log", "stream": stream, "text": text[:2000]})

    async def emit_tool(
        self,
        kind: str,
        label: str,
        *,
        tool_id: Optional[str] = None,
        detail: str = "",
        tokens: int = 0,
        ms: int = 0,
        status: str = "ok",
        body: str = "",
    ) -> str:
        tid = tool_id or self.state.next_tool_id()
        self.state.last_tool_id = tid
        await _call_emit(
            self.emit,
            {
                "type": "tool",
                "id": tid,
                "kind": kind,
                "label": label,
                "detail": detail,
                "tokens": tokens,
                "ms": ms,
                "status": status,
                "body": body,
            },
        )
        return tid

    # -- codex JSONL parsing ------------------------------------------------
    async def handle_raw_line(self, stream: str, line: str) -> None:
        raw = line.rstrip("\r\n")
        if not raw.strip():
            return
        self.state.raw_lines.append(raw)

        # There is no auth fallback, so a credential problem must be loud and specific.
        if not self.state.auth_suspect:
            low = raw.lower()
            for marker in AUTH_FAILURE_MARKERS:
                if marker in low:
                    self.state.auth_suspect = True
                    self.state.auth_evidence = raw[:300]
                    break

        stripped = raw.strip()
        if not (stripped.startswith("{") or stripped.startswith("[")):
            await self.emit_log(stream, raw)
            return

        try:
            obj = json.loads(stripped)
        except Exception:
            await self.emit_log(stream, raw)
            return

        if not self.state.sample_written:
            self.state.sample_written = True
            self._write_sample(stripped)

        try:
            await self._handle_codex_event(obj, stream)
        except Exception as exc:  # a parser bug must never kill the run
            await self.emit_log(stream, f"[parser] {exc!r}: {raw[:300]}")

    def _write_sample(self, line: str) -> None:
        """One sample raw line per run so we can tighten the parser later."""
        try:
            RUNS_DIR.mkdir(parents=True, exist_ok=True)
            with (RUNS_DIR / "codex_events_sample.jsonl").open("a", encoding="utf-8") as fh:
                fh.write(json.dumps({"run_id": self.run_id, "sample": line[:4000]}) + "\n")
        except Exception:
            pass

    async def _handle_codex_event(self, obj: Any, stream: str) -> None:
        type_str = _event_type_string(obj)

        # --- authoritative usage: `turn.completed` carries the real counts ---
        usage = _turn_usage(obj)
        if usage is not None:
            turn_total = self.state.add_turn_usage(usage)
            await self.emit_tool(
                "SYSTEM",
                f"turn {self.state.turns_seen} complete",
                detail=f"{turn_total:,} tokens",
                tokens=turn_total,
                status="ok",
                body=(
                    f"input {usage['input_tokens']:,} "
                    f"(cached {usage['cached_input_tokens']:,}) / "
                    f"output {usage['output_tokens']:,} "
                    f"(reasoning {usage['reasoning_output_tokens']:,})"
                ),
            )
            return

        # Legacy dialect's cumulative token_count; only trusted if no turn usage exists.
        legacy_tokens = _extract_tokens(obj)
        if legacy_tokens and self.state.turns_seen == 0:
            self.state.tokens_total = max(self.state.tokens_total, legacy_tokens)

        # Pure usage/heartbeat frames get no rail row.
        if ("token" in type_str or "usage" in type_str) and not _dig(obj, "text", "message", "command"):
            return

        kind = _classify(type_str, obj)
        label, detail, body = _summarize(obj, kind)
        key = _call_key(obj)

        is_begin = type_str.endswith("_begin") or ".started" in type_str or "began" in type_str
        is_end = (
            type_str.endswith("_end")
            or ".completed" in type_str
            or ".done" in type_str
            or "finished" in type_str
        )

        if kind == "RUN" and is_begin:
            self.state.parallel_calls += 1

        if is_begin and key:
            tid = await self.emit_tool(kind, label, detail=detail, status="running", body=body)
            self.state.open_calls[key] = (tid, time.monotonic(), label, detail)
            return

        if is_end and key and key in self.state.open_calls:
            tid, t0, begin_label, begin_detail = self.state.open_calls.pop(key)
            ms = int((time.monotonic() - t0) * 1000)
            exit_code = _dig(obj, "exit_code", "exitCode")
            status = "fail" if isinstance(exit_code, int) and exit_code != 0 else "ok"
            if "error" in type_str:
                status = "fail"
            if kind == "RUN":
                self.state.parallel_calls = max(0, self.state.parallel_calls - 1)
            # The `*_end` frame usually carries no command/path, so keep what the
            # `*_begin` frame told us rather than falling back to a generic label.
            if label == kind.title() and begin_label:
                label = begin_label
            await self.emit_tool(
                kind, label, tool_id=tid, detail=detail or begin_detail, ms=ms,
                status=status, body=body,
            )
            return

        # An `item.*` event ALWAYS earns a rail row, even if its item.type is one we
        # have never seen -- dropping unknown item types would silently hide agent work.
        if not body and not detail and kind == "SYSTEM" and _item(obj) is None:
            # Nothing worth a persistent row -> slipstream it.
            await self.emit_log(stream, json.dumps(obj)[:600])
            return

        it = _item_type(obj)
        if it and it not in LIVE_ITEM_KIND:
            detail = detail or it

        # No explicit `tokens=`: real counts are attributed at turn.completed, so
        # ordinary rows carry duration only rather than an estimate.
        status = "fail" if "error" in type_str else "ok"
        await self.emit_tool(kind, label, detail=detail, status=status, body=body)

    # -- sandbox lifecycle --------------------------------------------------
    async def _upload_inputs(self, sandbox, news: dict, portfolio: dict, budget: dict) -> None:
        from daytona import FileUpload

        schema_bytes = SCHEMA_PATH.read_bytes()
        uploads = [
            FileUpload(source=json.dumps(portfolio, indent=2).encode(), destination=f"{WORK_DIR}/portfolio.json"),
            FileUpload(source=json.dumps(news, indent=2).encode(), destination=f"{WORK_DIR}/news.json"),
            FileUpload(source=json.dumps(budget, indent=2).encode(), destination=f"{WORK_DIR}/budget.json"),
            # OUTSIDE the -C /work workspace root: the agent cannot rewrite its own contract.
            FileUpload(source=schema_bytes, destination=REMOTE_SCHEMA),
        ]
        for path, mode in ((WORK_DIR, "755"), (VERIFIER_DIR, "755")):
            with contextlib.suppress(Exception):
                await sandbox.fs.create_folder(path, mode)
        try:
            await sandbox.fs.upload_files(uploads)
        except Exception:
            for up in uploads:
                await sandbox.fs.upload_file(up.source, up.destination)

    async def _create_sandbox(self, daytona, env_vars: dict) -> tuple[Any, bool]:
        """Create the sandbox. Returns (sandbox, needs_provision).

        Fast path: the pre-baked `quant-agent-v1` snapshot. If snapshot creation is
        unavailable -- the hackathon key gets 403 on POST /snapshots, so the snapshot
        may simply not exist -- fall back to a plain base image and provision at
        runtime (~16s measured). Set AGENT_ARENA_FORCE_BASE_IMAGE=1 to skip the
        snapshot attempt entirely; unset it to flip back to the fast path with no
        code change once the key is fixed.
        """
        from daytona import CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams

        # NOTE: created UNLOCKED on purpose. Provisioning needs the npm registry and
        # apt; the agent must not. `_lock_egress()` applies the allow list via
        # update_network_settings immediately before the first codex run.
        common = dict(
            auto_stop_interval=0,  # never let it idle-die mid-run
            auto_archive_interval=0,
            ttl_minutes=SANDBOX_TTL_MINUTES,  # safety net if the host process dies
            env_vars=env_vars,
            labels={"app": "agent-arena", "run_id": self.run_id},
        )

        async def _create(make_params, timeout: int):
            return await daytona.create(make_params(), timeout=timeout)

        if not FORCE_BASE_IMAGE:
            try:
                sandbox = await _create(
                    lambda: CreateSandboxFromSnapshotParams(
                        snapshot=SNAPSHOT_NAME, **common
                    ),
                    180,
                )
                await self.emit_tool(
                    "SYSTEM", f"sandbox {getattr(sandbox, 'id', '?')}",
                    detail=f"snapshot {SNAPSHOT_NAME}", status="ok",
                )
                return sandbox, False
            except Exception as exc:
                await self.emit_tool(
                    "SYSTEM", "snapshot unavailable - provisioning from base image",
                    detail=SNAPSHOT_NAME, status="fail", body=repr(exc)[:400],
                )
        else:
            await self.emit_tool(
                "SYSTEM", "provisioning from base image",
                detail="AGENT_ARENA_FORCE_BASE_IMAGE=1", status="ok",
            )

        sandbox = await _create(
            lambda: CreateSandboxFromImageParams(image=BASE_IMAGE, **common),
            300,
        )
        await self.emit_tool(
            "SYSTEM", f"sandbox {getattr(sandbox, 'id', '?')}",
            detail=f"base image {BASE_IMAGE}", status="ok",
        )
        return sandbox, True

    async def _provision_base_image(self, sandbox, session_id: str, deadline: float) -> None:
        """Install codex-cli + the Python stack on a bare base image.

        Streams output so the screen shows a live PROVISIONING beat instead of
        sitting silent. Measured ~15s on node:22-bookworm.
        """
        t0 = time.monotonic()
        await self.emit_tool(
            "SYSTEM", "installing codex-cli and python stack",
            detail=BASE_IMAGE, status="running",
        )
        exit_code = await self._run_session_command(
            sandbox, session_id, PROVISION_SCRIPT, deadline
        )
        secs = time.monotonic() - t0

        # The script echoes `codex --version` and the pandas/numpy versions; recover
        # them from the tail of the streamed output for the rail row.
        versions = [
            ln for ln in self.state.plain_lines[-40:]
            if "codex-cli" in ln or ln.strip().startswith("[stdout] pandas")
        ]
        detail = " | ".join(v.split("] ", 1)[-1] for v in versions[-2:]) or f"{secs:.0f}s"

        if exit_code != 0:
            await self.emit_tool(
                "SYSTEM", "provisioning FAILED", detail=f"exit {exit_code} after {secs:.0f}s",
                status="fail",
            )
            raise RuntimeError(
                f"Base-image provisioning failed (exit {exit_code}). The sandbox has no "
                f"codex-cli, so the run cannot continue. Check that {BASE_IMAGE} can reach "
                "the npm registry through the domain allow list."
            )

        await self.emit_tool(
            "SYSTEM", "sandbox ready", detail=f"{detail} in {secs:.0f}s", status="ok",
        )

    async def _upload_agent_assets(self, sandbox) -> None:
        """Upload kit/ and skills/ that the snapshot would otherwise have baked in.

        Files are uploaded individually rather than via a directory helper: the SDK's
        Image context path handling is what bit us on Windows, and per-file uploads
        keep the remote layout explicit.
        """
        for local_name, remote_root in (("kit", REMOTE_KIT_DIR), ("skills", REMOTE_SKILLS_DIR)):
            src = REPO_ROOT / local_name
            if not src.is_dir():
                continue
            files = [
                p for p in sorted(src.rglob("*"))
                if p.is_file()
                and "__pycache__" not in p.parts
                and p.suffix not in (".pyc", ".pyo")
            ]
            if not files:
                continue
            with contextlib.suppress(Exception):
                await sandbox.fs.create_folder(remote_root, "755")
            uploaded = 0
            for f in files:
                rel = f.relative_to(src).as_posix()  # POSIX: never Windows backslashes
                try:
                    await sandbox.fs.upload_file(f.read_bytes(), f"{remote_root}/{rel}")
                    uploaded += 1
                except Exception as exc:
                    await self.emit_log("stderr", f"[orchestrator] upload {rel} failed: {exc!r}")
            await self.emit_tool(
                "SYSTEM", f"{local_name} uploaded",
                detail=f"{uploaded} file(s) -> {remote_root}", status="ok",
            )

    async def _verify_agent_assets(self, sandbox, session_id: str, deadline: float) -> None:
        """Prove kit/ and the skill are actually reachable by the agent.

        If the skill is not discovered, the agent runs without our methodology and the
        reconciliation rule -- which is the whole demo -- so we check rather than assume.
        Non-fatal: we report loudly and continue, since the prompt also authorises raw
        HTTP as a fallback.
        """
        before = len(self.state.plain_lines)
        exit_code = await self._run_session_command(
            sandbox, session_id, KIT_VERIFY_CMD, min(deadline, time.monotonic() + 60)
        )
        output = "\n".join(
            ln.split("] ", 1)[-1] for ln in self.state.plain_lines[before:]
        )
        ok = exit_code == 0 and "kit imports OK" in output
        skill_seen = "SKILL.md" in output or "portfolio-impact" in output
        await self.emit_tool(
            "SYSTEM",
            "agent toolkit verified" if ok else "agent toolkit NOT reachable",
            detail=(
                f"kit imports OK, skill {'found' if skill_seen else 'MISSING'}"
                if ok else f"exit {exit_code} -- agent will fall back to raw HTTP"
            ),
            status="ok" if (ok and skill_seen) else "fail",
            body=output[:2000],
        )

    async def _lock_egress(self, sandbox) -> None:
        """Apply the domain allow list immediately before the agent starts.

        We create the sandbox UNLOCKED so provisioning can reach the npm registry and
        apt, then lock it down before any agent code runs. The agent therefore never
        has access to a package registry at all.
        """
        allow_list = os.environ.get("DAYTONA_DOMAIN_ALLOW_LIST", DEFAULT_DOMAIN_ALLOW_LIST)
        if not allow_list:
            await self.emit_tool(
                "SYSTEM", "EGRESS NOT LOCKED", detail="no allow list configured", status="fail",
            )
            return
        domains = [d.strip() for d in allow_list.split(",") if d.strip()]
        try:
            await sandbox.update_network_settings(domain_allow_list=allow_list)
        except Exception as exc:
            # Never silently claim a lock we do not have -- but do not overclaim the
            # opposite either. Measured: this org returns "Network access is restricted
            # and cannot be overridden", i.e. the platform imposes its own policy that
            # we are not permitted to replace. Report what it actually said.
            msg = str(getattr(exc, "message", "") or exc)
            await self.emit_tool(
                "SYSTEM", "EGRESS LOCK REJECTED BY PLATFORM",
                detail=msg[:140], status="fail", body=msg[:500],
            )
            return
        await self.emit_tool(
            "SYSTEM", f"EGRESS LOCKED - {len(domains)} domains",
            detail=", ".join(domains), status="ok",
        )

    async def _upload_credentials(self, sandbox, auth_path: Path) -> None:
        """Transplant the host's ChatGPT auth.json into the sandbox.

        SECRET: these bytes are never logged, echoed, or written to runs/. We report
        only the byte count and the detected auth_mode, never token material.
        """
        raw = auth_path.read_bytes()
        with contextlib.suppress(Exception):
            await sandbox.fs.create_folder(CODEX_HOME, "700")
        await sandbox.fs.upload_file(raw, REMOTE_AUTH)
        with contextlib.suppress(Exception):
            await sandbox.fs.set_file_permissions(REMOTE_AUTH, mode="600")

        mode = "unknown"
        with contextlib.suppress(Exception):
            mode = json.loads(raw.decode("utf-8")).get("auth_mode") or "unknown"
        await self.emit_tool(
            "SYSTEM", "codex credentials transplanted",
            detail=f"auth_mode={mode}, {len(raw)} bytes -> {REMOTE_AUTH}", status="ok",
        )

    async def _sandbox_schema_hash(self, sandbox) -> Optional[str]:
        """Read the schema back from the sandbox to power V6."""
        try:
            data = await sandbox.fs.download_file(REMOTE_SCHEMA)
            if data:
                return _sha256_bytes(data)
        except Exception:
            pass
        return None

    def _build_prompt(self, news: dict, portfolio: dict, attempt: int) -> str:
        tickers = ", ".join(p.get("ticker", "?") for p in portfolio.get("positions", []))
        return f"""You are a quantitative analyst agent. Produce a rigorous portfolio-impact analysis.

INPUTS (already on disk, workspace root /work):
  /work/news.json      the news event to analyse
  /work/portfolio.json the portfolio ({len(portfolio.get('positions', []))} US equities: {tickers})
  /work/budget.json    your budget; this is attempt {attempt}

CONTRACT (read-only, outside your workspace): {REMOTE_SCHEMA}
Read that schema. Your output MUST validate against it. Write the final object to /work/result.json.

WHAT TO DO - do not hand-wave, write and RUN code:
 1. Read the news and the portfolio.
 2. Research the mechanism. Use the network (curl / python requests) for corroboration.
    SEC EDGAR REQUIRES a descriptive User-Agent header or it returns 403 and IP-blocks you
    for ~10 minutes; use the value in $SEC_USER_AGENT.
 3. Write a Python file (e.g. /work/analysis.py) that computes the per-position impacts.
    Actually execute it. Do not fabricate numbers in prose.
 4. ARITHMETIC THAT IS CHECKED BY A HOST-SIDE VERIFIER - get it exactly right:
      * include EVERY position from /work/portfolio.json - all {len(portfolio.get('positions', []))} of
        them, no subsets, no extras. A name you judge unaffected still gets a row with impact_pct 0.
      * copy `weight_pct` and `value_before_usd` straight from the portfolio file; the
        weights must still sum to 100
      * for each position: impact_usd == value_before_usd * impact_pct / 100   (+/- $1)
      * portfolio_impact_pct == SUM over positions of (weight_pct/100 * impact_pct)  (+/- 0.01)
        Compute this by summation in code; never round it by hand.
      * portfolio_impact_usd == portfolio_value_before_usd * portfolio_impact_pct / 100
      * `citations` needs at least 2 entries with real http(s) URLs you actually consulted
      * `budget.attempts` MUST be {attempt}
 5. Write /work/result.json. Emit the same JSON object as your final message.

Keep the thesis 40-600 characters, mechanism 1-6 links, methodology one of
beta_weighted_shock | sector_exposure_map | correlation_contagion.
"""

    def _codex_cmd(self, prompt: str, *, resume: bool) -> str:
        """Build the codex invocation from an explicit per-subcommand flag allowlist.

        CRITICAL: `< /dev/null` is load-bearing. `codex exec` reads stdin whenever stdin
        is not a TTY, and Daytona session commands pipe stdin -- without the redirect it
        prints "Reading additional input from stdin..." and blocks forever.

        NO `2>&1`: Daytona demuxes the two pipes into on_stdout/on_stderr, and the
        frontend colour-codes the slipstream by stream. Merging them would kill that.

        `codex exec resume` REJECTS `-C` (verified against codex-cli 0.151.0:
        "error: unexpected argument '-C' found"). `-o` is accepted on both. The working
        directory is set by the shell `cd` in either case, so nothing is lost.
        """
        flags = [
            "--skip-git-repo-check",
            "--dangerously-bypass-approvals-and-sandbox",
            "--disable fast_mode",
            f"-m {self.model}",
            f"-c model_reasoning_effort={shlex.quote(self.effort)}",
            "--json",
            f"--output-schema {REMOTE_SCHEMA}",
            f"-o {REMOTE_RESULT}",
        ]
        if not resume:
            flags.append(f"-C {WORK_DIR}")  # accepted by `exec`, rejected by `exec resume`

        sub = "exec resume --last" if resume else "exec"
        return (
            f"cd {WORK_DIR} && codex {sub} {' '.join(flags)} "
            f"{shlex.quote(prompt)} < /dev/null"
        )

    async def _run_session_command(
        self, sandbox, session_id: str, command: str, deadline: float
    ) -> int:
        """Start a command async, stream both pipes, wait for exit. Returns exit code.

        Used for both the codex run and base-image provisioning -- anything long enough
        that `process.exec`'s 10s default timeout would kill it.
        """
        from daytona import SessionExecuteRequest

        # COMPLETION DETECTION -- do not rely on get_session_command().exit_code alone.
        # Measured live: while a follow-websocket is attached to a command's logs, the
        # API keeps returning exit_code=None indefinitely (600s observed for a command
        # that finished in ~40s), with no error. The identical poll works when no
        # websocket is attached. So we append our own sentinel and treat that as truth,
        # keeping the API poll only as a secondary signal.
        wrapped = f"( {command} ); echo \"{DONE_SENTINEL}:$?\""

        resp = await sandbox.process.execute_session_command(
            session_id, SessionExecuteRequest(command=wrapped, run_async=True)
        )
        cmd_id = getattr(resp, "cmd_id", None) or getattr(resp, "id", None)
        if not cmd_id:
            raise RuntimeError(f"Daytona did not return a command id: {resp!r}")

        queue: asyncio.Queue = asyncio.Queue()
        done: asyncio.Future = asyncio.get_running_loop().create_future()
        last_output = [time.monotonic()]

        def _finish(code: int) -> None:
            if not done.done():
                done.set_result(code)

        def _scan_sentinel(text: str) -> Optional[int]:
            """Return the exit code if `text` carries our sentinel."""
            if DONE_SENTINEL not in text:
                return None
            tail = text.split(DONE_SENTINEL, 1)[1].lstrip(":").strip()
            digits = ""
            for ch in tail:
                if ch.isdigit() or (ch == "-" and not digits):
                    digits += ch
                else:
                    break
            try:
                return int(digits)
            except ValueError:
                return 0

        # CRITICAL: these callbacks must never block - put_nowait and return.
        async def on_stdout(chunk: str) -> None:
            queue.put_nowait(("stdout", chunk))

        async def on_stderr(chunk: str) -> None:
            queue.put_nowait(("stderr", chunk))

        async def stream() -> None:
            try:
                await sandbox.process.get_session_command_logs_async(
                    session_id, cmd_id, on_stdout, on_stderr
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                queue.put_nowait(("stderr", f"[log stream ended: {exc!r}]\n"))

        buffers = {"stdout": "", "stderr": ""}

        async def consume() -> None:
            while True:
                which, chunk = await queue.get()
                last_output[0] = time.monotonic()
                buffers[which] += chunk
                while "\n" in buffers[which]:
                    line, buffers[which] = buffers[which].split("\n", 1)
                    code = _scan_sentinel(line)
                    if code is not None:
                        _finish(code)
                        continue  # never surface the sentinel to the UI
                    await self.handle_raw_line(which, line)

        stream_task = asyncio.create_task(stream())
        consume_task = asyncio.create_task(consume())

        exit_code = -1
        try:
            while True:
                if time.monotonic() > deadline:
                    await self.emit_log("stderr", "[orchestrator] wall-clock budget exhausted")
                    break

                # 1) primary: our sentinel, seen in the stream (reacts within one tick)
                try:
                    exit_code = await asyncio.wait_for(
                        asyncio.shield(done), timeout=ATTEMPT_POLL_INTERVAL_S
                    )
                    break
                except asyncio.TimeoutError:
                    pass

                # 2) secondary: the API's own exit code, if it ever materialises
                try:
                    cmd = await sandbox.process.get_session_command(session_id, cmd_id)
                    code = getattr(cmd, "exit_code", None)
                    if code is not None:
                        exit_code = int(code)
                        break
                except Exception as exc:
                    await self.emit_log("stderr", f"[orchestrator] poll failed: {exc!r}")

                # 3) watchdog: if the stream has gone quiet the websocket may have died
                #    without raising. Re-read the log non-streaming and look for the
                #    sentinel there before assuming the command is still running.
                if time.monotonic() - last_output[0] > IDLE_WATCHDOG_S:
                    last_output[0] = time.monotonic()
                    try:
                        logs = await sandbox.process.get_session_command_logs(session_id, cmd_id)
                        blob = " ".join(
                            str(getattr(logs, attr, "") or "")
                            for attr in ("output", "stdout", "stderr")
                        )
                        code = _scan_sentinel(blob)
                        if code is not None:
                            await self.emit_log(
                                "stderr",
                                "[orchestrator] stream went quiet; recovered exit code from log fetch",
                            )
                            exit_code = code
                            break
                    except Exception as exc:
                        await self.emit_log("stderr", f"[orchestrator] log refetch failed: {exc!r}")
        finally:
            # Give the stream a moment to flush the tail, then tear both down. Every
            # await here is bounded: a websocket that will not close must never be able
            # to hang the run.
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.sleep(1.5), timeout=3)
            for task in (stream_task, consume_task):
                task.cancel()
            with contextlib.suppress(Exception):
                await asyncio.wait(
                    {stream_task, consume_task}, timeout=5
                )  # abandon stragglers rather than await them forever
            for which, leftover in buffers.items():
                if leftover.strip():
                    await self.handle_raw_line(which, leftover)

        return exit_code

    async def _download_result(self, sandbox) -> tuple[Optional[dict], Optional[str]]:
        try:
            data = await sandbox.fs.download_file(REMOTE_RESULT)
        except Exception as exc:
            return None, f"could not download {REMOTE_RESULT}: {exc}"
        if not data:
            return None, f"{REMOTE_RESULT} is empty or missing"
        try:
            text = data.decode("utf-8", errors="replace")
            return json.loads(text), None
        except Exception as exc:
            return None, f"{REMOTE_RESULT} is not valid JSON: {exc}"

    def _save_run(self, extra: dict) -> None:
        try:
            self.run_dir.mkdir(parents=True, exist_ok=True)
            (self.run_dir / "codex_events.jsonl").write_text(
                "\n".join(self.state.raw_lines), encoding="utf-8"
            )
            (self.run_dir / "console.log").write_text(
                "\n".join(self.state.plain_lines), encoding="utf-8"
            )
            (self.run_dir / "run.json").write_text(
                json.dumps(
                    {
                        "run_id": self.run_id,
                        "elapsed_s": self.elapsed_s,
                        "attempts": self.attempt,
                        "tokens_total": self.state.tokens_total,
                        "model": self.model,
                        "effort": self.effort,
                        **extra,
                    },
                    indent=2,
                    default=str,
                ),
                encoding="utf-8",
            )
        except Exception as exc:
            print(f"[orchestrator] failed to save run: {exc!r}")

    # -- the main loop ------------------------------------------------------
    async def run(self, news: dict, portfolio: dict) -> dict:
        api_key = os.environ.get("DAYTONA_API_KEY")
        if not api_key:
            raise RuntimeError(
                "DAYTONA_API_KEY is not set. Copy .env.example to .env and fill it in "
                "(get a key at https://app.daytona.io)."
            )
        if not SCHEMA_PATH.exists():
            raise RuntimeError(f"Missing schema contract at {SCHEMA_PATH}")

        from daytona import AsyncDaytona, CreateSandboxFromSnapshotParams, DaytonaConfig

        verify_fn, verifier_is_real = _load_verify()
        if not verifier_is_real:
            await self.emit_log(
                "stderr",
                "[orchestrator] verifier/verify.py not importable - using built-in fallback checks",
            )

        cfg_kwargs: dict[str, Any] = {"api_key": api_key}
        if os.environ.get("DAYTONA_API_URL"):
            cfg_kwargs["api_url"] = os.environ["DAYTONA_API_URL"]
        if os.environ.get("DAYTONA_TARGET"):
            cfg_kwargs["target"] = os.environ["DAYTONA_TARGET"]

        deadline = self.started + WALL_CLOCK_BUDGET_S
        local_hash = _verifier_dir_hash()

        auth_path = host_auth_path()
        if not auth_path.is_file():
            raise RuntimeError(
                f"Codex ChatGPT credentials not found at {auth_path}.\n"
                "There is no OPENAI_API_KEY fallback -- the sandbox authenticates only by\n"
                "transplanting your host ChatGPT login. Run `codex login` on this machine\n"
                "first, or set CODEX_AUTH_JSON to the auth.json you want transplanted."
            )

        env_vars = {
            k: v
            for k, v in {
                # CODEX_HOME must match where we upload auth.json below.
                "CODEX_HOME": CODEX_HOME,
                "PARALLEL_API_KEY": os.environ.get("PARALLEL_API_KEY", ""),
                "SEC_USER_AGENT": os.environ.get(
                    "SEC_USER_AGENT", "AgentArena hackathon contact@example.com"
                ),
                "PYTHONUNBUFFERED": "1",
            }.items()
            if v
        }

        daytona = AsyncDaytona(DaytonaConfig(**cfg_kwargs))
        sandbox = None
        session_id = f"agent-{self.run_id}"
        last_report: dict = {"passed": False, "checks": []}
        final_result: Optional[dict] = None

        try:
            await self.emit_state("spawning")
            sandbox, needs_provision = await self._create_sandbox(daytona, env_vars)

            budget = {
                "max_attempts": MAX_ATTEMPTS,
                "wall_clock_budget_s": WALL_CLOCK_BUDGET_S,
                "attempt": 1,
                "parallel_calls_allowed": 8,
                "note": "report your real usage in result.budget; budget.attempts must equal 'attempt'",
            }
            await self._upload_inputs(sandbox, news, portfolio, budget)
            # Must happen BEFORE any codex invocation.
            await self._upload_credentials(sandbox, auth_path)
            await sandbox.process.create_session(session_id)

            if needs_provision:
                await self._provision_base_image(sandbox, session_id, deadline)
            # Unconditional (belt and braces): on the snapshot path these are baked in,
            # but re-uploading is cheap and guarantees kit/skills are present either way.
            await self._upload_agent_assets(sandbox)
            await self._verify_agent_assets(sandbox, session_id, deadline)
            # Lock egress only now: provisioning needs npm + apt, the agent must not.
            await self._lock_egress(sandbox)

            base_prompt = self._build_prompt(news, portfolio, 1)

            for attempt in range(1, MAX_ATTEMPTS + 1):
                self.attempt = attempt
                if time.monotonic() > deadline:
                    await self.emit_log("stderr", "[orchestrator] out of wall-clock budget")
                    break

                budget["attempt"] = attempt
                with contextlib.suppress(Exception):
                    from daytona import FileUpload

                    await sandbox.fs.upload_files(
                        [FileUpload(source=json.dumps(budget, indent=2).encode(),
                                    destination=f"{WORK_DIR}/budget.json")]
                    )

                # Clear any previous attempt's output first: otherwise a resume that
                # writes nothing would leave us re-verifying the stale file and the
                # fallback below would never trigger.
                with contextlib.suppress(Exception):
                    await sandbox.fs.delete_file(REMOTE_RESULT)

                if attempt == 1:
                    prompt, resume = base_prompt, False
                else:
                    prompt, resume = self._retry_prompt(last_report, attempt), True

                await self.emit_state("running")
                cmd = self._codex_cmd(prompt, resume=resume)
                await self.emit_tool("SYSTEM", f"codex attempt {attempt}",
                                     detail=f"{self.model} / {self.effort}", status="running",
                                     body=cmd)
                exit_code = await self._run_session_command(sandbox, session_id, cmd, deadline)
                await self.emit_log("stdout", f"[orchestrator] codex exited {exit_code}")

                # Retrying an auth failure just burns the clock -- fail loudly instead.
                if exit_code != 0 and self.state.auth_suspect:
                    msg = (
                        "Codex could not authenticate inside the sandbox. The transplanted "
                        f"ChatGPT auth.json was rejected. Evidence: {self.state.auth_evidence!r}. "
                        "There is no API-key fallback: re-run `codex login` on the host to "
                        "refresh ~/.codex/auth.json, and confirm chatgpt.com / auth.openai.com "
                        "are reachable from the sandbox (domain allow list)."
                    )
                    await self.emit_state("rejected", error="auth", message=msg)
                    raise RuntimeError(msg)

                await self.emit_state("verifying")
                result, err = await self._download_result(sandbox)

                # `--output-schema` is not yet proven to survive `exec resume`. If a
                # resume produced no result.json, fall back to a fresh `codex exec` with
                # the failure list folded into the full task prompt rather than aborting.
                if result is None and resume:
                    await self.emit_tool(
                        "SYSTEM", "resume produced no result.json",
                        detail="falling back to fresh codex exec", status="fail",
                        body=err or "",
                    )
                    fallback_prompt = (
                        f"{self._build_prompt(news, portfolio, attempt)}\n\n"
                        f"{self._retry_prompt(last_report, attempt)}"
                    )
                    fallback_cmd = self._codex_cmd(fallback_prompt, resume=False)
                    exit_code = await self._run_session_command(sandbox, session_id, fallback_cmd, deadline)
                    await self.emit_log(
                        "stdout", f"[orchestrator] fallback codex exec exited {exit_code}"
                    )
                    result, err = await self._download_result(sandbox)

                sandbox_hash = await self._sandbox_schema_hash(sandbox)
                local_schema_hash = _sha256_bytes(SCHEMA_PATH.read_bytes())

                measured = {
                    "attempts": attempt,
                    "attempt": attempt,
                    "max_attempts": MAX_ATTEMPTS,
                    "parallel_calls_used": self.state.parallel_calls,
                    "tokens_total": self.state.tokens_total,
                    "codex_credits_used": round(self.state.tokens_total / 1_000_000, 6),
                    "elapsed_s": self.elapsed_s,
                    "verifier_hash": local_hash,
                    "verifier_hash_expected": local_schema_hash,
                    "verifier_hash_actual": sandbox_hash or local_schema_hash,
                    "schema_sha256_local": local_schema_hash,
                    "schema_sha256_sandbox": sandbox_hash,
                }

                if result is None:
                    last_report = {
                        "passed": False,
                        "checks": [{"id": "V1", "name": "schema valid", "passed": False,
                                    "message": err or "no result.json", "kind": "schema"}],
                    }
                else:
                    try:
                        last_report = verify_fn(result, portfolio, measured)
                    except Exception as exc:
                        last_report = {
                            "passed": False,
                            "checks": [{"id": "V0", "name": "verifier crashed", "passed": False,
                                        "message": repr(exc)[:400], "kind": "semantic"}],
                        }

                failed = [c for c in last_report.get("checks", []) if not c.get("passed")]
                passed = bool(last_report.get("passed")) and not failed

                next_model, next_effort, route = _route_for(failed, attempt)
                await _call_emit(
                    self.emit,
                    {
                        "type": "verdict",
                        "passed": passed,
                        "attempt": attempt,
                        "checks": last_report.get("checks", []),
                        "route": None if passed else route,
                    },
                )

                if passed:
                    final_result = result
                    await self.emit_state("accepted")
                    await _call_emit(self.emit, {"type": "result", "data": result})
                    break

                await self.emit_state("rejected")
                if attempt >= MAX_ATTEMPTS or time.monotonic() > deadline:
                    break
                # Never kill the agent - nudge it and let it resume its own session.
                self.model, self.effort = next_model, next_effort

            self._save_run(
                {
                    "passed": final_result is not None,
                    "final_verdict": last_report,
                    "result": final_result,
                    "news": news,
                }
            )

            if final_result is None:
                raise RuntimeError(
                    f"Analysis failed after {self.attempt} attempt(s). "
                    f"Last verdict: {json.dumps(last_report)[:1200]}"
                )
            return final_result

        finally:
            if sandbox is not None:
                with contextlib.suppress(Exception):
                    await sandbox.process.delete_session(session_id)
                try:
                    await sandbox.delete()
                    await self.emit_state("destroyed")
                except Exception as exc:
                    await self.emit_log("stderr", f"[orchestrator] sandbox delete failed: {exc!r}")
            with contextlib.suppress(Exception):
                await daytona.close()

    def _retry_prompt(self, report: dict, attempt: int) -> str:
        failed = [c for c in report.get("checks", []) if not c.get("passed")]
        lines = [
            f"  - [{c.get('id')}] {c.get('name')}: {c.get('message', '')}".rstrip()
            for c in failed
        ]
        return f"""Your /work/result.json was REJECTED by the host verifier. Attempt {attempt} of {MAX_ATTEMPTS}.

FAILED CHECKS:
{chr(10).join(lines) if lines else '  - (no detail returned)'}

Fix these specifically. Re-run your analysis code, recompute the arithmetic by summation
(do not round by hand), rewrite /work/result.json so it validates against {REMOTE_SCHEMA},
and set budget.attempts to {attempt}. Emit the corrected JSON object as your final message.
"""


# ===========================================================================
# public API
# ===========================================================================


async def run_analysis(news: dict, portfolio: dict, emit: Callable[[dict], Any]) -> dict:
    """Run one news-event analysis inside a fresh Daytona sandbox.

    Args:
        news: the news event dict (needs at least `id`/`news_id` and `headline`).
        portfolio: the portfolio per CONTRACTS.md §3.
        emit: callback invoked with every event dict (sync or async, both fine).

    Returns:
        The validated PortfolioImpactAnalysis dict.

    Raises:
        RuntimeError if credentials are missing, or after MAX_ATTEMPTS / the
        6-minute wall-clock budget without a passing result.
    """
    return await Orchestrator(emit).run(news, portfolio)


# ===========================================================================
# smoke path
# ===========================================================================

CANNED_NEWS = {
    "id": "news-demo-001",
    "news_id": "news-demo-001",
    "headline": "Taiwan earthquake halts TSMC advanced-node fabs; chip supply chain disruption feared",
    "published_at": "2026-08-30T06:12:00Z",
    "body": (
        "A magnitude 7.1 earthquake struck southern Taiwan early Sunday, forcing TSMC to halt "
        "operations at its Tainan advanced-node fabs. Analysts warn of multi-week disruption to "
        "3nm and 5nm supply, hitting smartphone, datacentre GPU and PC OEM production schedules."
    ),
    "source": "demo",
}

FALLBACK_PORTFOLIO = {
    "total_value_usd": 100000,
    "positions": [
        {"ticker": "AAPL", "name": "Apple Inc.", "sector": "Technology",
         "qty": 40, "price_usd": 455.0, "value_usd": 18200, "weight_pct": 18.2},
        {"ticker": "NVDA", "name": "NVIDIA Corp.", "sector": "Technology",
         "qty": 100, "price_usd": 160.0, "value_usd": 16000, "weight_pct": 16.0},
        {"ticker": "MSFT", "name": "Microsoft Corp.", "sector": "Technology",
         "qty": 25, "price_usd": 520.0, "value_usd": 13000, "weight_pct": 13.0},
        {"ticker": "JPM", "name": "JPMorgan Chase", "sector": "Financials",
         "qty": 40, "price_usd": 280.0, "value_usd": 11200, "weight_pct": 11.2},
        {"ticker": "XOM", "name": "Exxon Mobil", "sector": "Energy",
         "qty": 80, "price_usd": 125.0, "value_usd": 10000, "weight_pct": 10.0},
        {"ticker": "JNJ", "name": "Johnson & Johnson", "sector": "Healthcare",
         "qty": 50, "price_usd": 170.0, "value_usd": 8500, "weight_pct": 8.5},
        {"ticker": "WMT", "name": "Walmart Inc.", "sector": "Consumer Staples",
         "qty": 70, "price_usd": 110.0, "value_usd": 7700, "weight_pct": 7.7},
        {"ticker": "CAT", "name": "Caterpillar Inc.", "sector": "Industrials",
         "qty": 12, "price_usd": 520.0, "value_usd": 6240, "weight_pct": 6.24},
        {"ticker": "PG", "name": "Procter & Gamble", "sector": "Consumer Staples",
         "qty": 30, "price_usd": 168.0, "value_usd": 5040, "weight_pct": 5.04},
        {"ticker": "NEE", "name": "NextEra Energy", "sector": "Utilities",
         "qty": 50, "price_usd": 82.4, "value_usd": 4120, "weight_pct": 4.12},
    ],
}


def _load_portfolio() -> dict:
    p = REPO_ROOT / "data" / "portfolio.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"[smoke] data/portfolio.json unreadable ({exc}); using fallback")
    else:
        print("[smoke] data/portfolio.json not present yet; using fallback portfolio")
    return FALLBACK_PORTFOLIO


async def _smoke() -> None:
    def printer(ev: dict) -> None:
        t = ev.get("type")
        if t == "log":
            print(f"  * {ev['stream']}: {ev['text'][:160]}")
        elif t == "tool":
            print(f"  [{ev['kind']:<7}] {ev['status']:<7} {ev['label'][:80]} {ev.get('detail','')}")
        elif t == "state":
            print(f"== {ev['phase'].upper()} attempt={ev['attempt']} "
                  f"{ev['model']}/{ev['effort']} t={ev['elapsed_s']}s tok={ev['tokens_total']}")
        elif t == "verdict":
            print(f"== VERDICT passed={ev['passed']} route={ev.get('route')}")
            for c in ev.get("checks", []):
                mark = "PASS" if c.get("passed") else "FAIL"
                print(f"     {mark} {c.get('id')} {c.get('name')} {c.get('message','')}")
        elif t == "result":
            print("== RESULT " + json.dumps(ev["data"])[:400])

    news = CANNED_NEWS
    if len(sys.argv) > 2 and sys.argv[1] == "--news":
        news = _load_news(sys.argv[2])
        print(f"[smoke] news: {news.get('id')} - {news.get('headline','')[:80]}")

    t0 = time.monotonic()
    try:
        result = await run_analysis(news, _load_portfolio(), printer)
        print(f"\n=== TOTAL WALL CLOCK: {time.monotonic() - t0:.1f}s ===")
        print("\nFINAL RESULT:\n" + json.dumps(result, indent=2))
    except Exception as exc:
        print(f"\n=== FAILED after {time.monotonic() - t0:.1f}s ===")
        print(f"RUN FAILED: {exc}")
        raise SystemExit(1)


def _load_news(news_id: str) -> dict:
    """Pull one event out of data/news_samples.json by id."""
    p = REPO_ROOT / "data" / "news_samples.json"
    raw = json.loads(p.read_text(encoding="utf-8"))
    items = raw if isinstance(raw, list) else (
        raw.get("events") or raw.get("news") or raw.get("samples") or []
    )
    if isinstance(items, dict):
        items = list(items.values())
    for n in items:
        if isinstance(n, dict) and n.get("id") == news_id or n.get("news_id") == news_id:
            return n
    raise SystemExit(
        f"news id {news_id!r} not found. Available: "
        f"{[n.get('id') for n in items if isinstance(n, dict)]}"
    )


async def _provision_check() -> None:
    """Time the cold provisioning path without burning a full analysis run.

    Creates a sandbox from the base image, provisions it, uploads kit/skills,
    verifies they are reachable, applies the egress lock, then deletes the sandbox.
    """
    if not os.environ.get("DAYTONA_API_KEY"):
        raise SystemExit("DAYTONA_API_KEY is not set (see .env).")

    from daytona import AsyncDaytona, DaytonaConfig

    def printer(ev: dict) -> None:
        if ev.get("type") == "tool":
            print(f"  [{ev['kind']:<7}] {ev['status']:<7} {ev['label']} :: {ev.get('detail','')}")
        elif ev.get("type") == "log":
            print(f"  * {ev['stream']}: {ev['text'][:150]}")

    orc = Orchestrator(printer, run_id="provision-check")
    cfg: dict[str, Any] = {"api_key": os.environ["DAYTONA_API_KEY"]}
    if os.environ.get("DAYTONA_API_URL"):
        cfg["api_url"] = os.environ["DAYTONA_API_URL"]
    if os.environ.get("DAYTONA_TARGET"):
        cfg["target"] = os.environ["DAYTONA_TARGET"]

    daytona = AsyncDaytona(DaytonaConfig(**cfg))
    sandbox = None
    session_id = "provision-check"
    marks: list[tuple[str, float]] = []
    t0 = time.monotonic()

    def mark(label: str) -> None:
        marks.append((label, time.monotonic() - t0))

    try:
        env_vars = {"CODEX_HOME": CODEX_HOME, "PYTHONUNBUFFERED": "1"}
        sec_ua = os.environ.get("SEC_USER_AGENT")
        if sec_ua:
            env_vars["SEC_USER_AGENT"] = sec_ua

        sandbox, needs_provision = await orc._create_sandbox(daytona, env_vars)
        mark("create")
        await sandbox.process.create_session(session_id)

        deadline = t0 + 600
        if needs_provision:
            await orc._provision_base_image(sandbox, session_id, deadline)
            mark("provision (codex + python)")
        else:
            print("  (snapshot path -- no provisioning needed)")

        await orc._upload_agent_assets(sandbox)
        mark("upload kit/skills")
        await orc._verify_agent_assets(sandbox, session_id, deadline)
        mark("verify toolkit")
        await orc._lock_egress(sandbox)
        mark("egress lock")

        print("\n===== PROVISION CHECK TIMING =====")
        print(f"image          : {BASE_IMAGE}")
        prev = 0.0
        for label, at in marks:
            print(f"{label:<26}: +{at - prev:5.1f}s  (t={at:5.1f}s)")
            prev = at
        print(f"{'TOTAL COLD PATH':<26}: {marks[-1][1]:5.1f}s")
    finally:
        if sandbox is not None:
            with contextlib.suppress(Exception):
                await sandbox.process.delete_session(session_id)
            try:
                await sandbox.delete()
                print("sandbox deleted")
            except Exception as exc:
                print(f"WARNING: sandbox delete failed ({exc!r}) -- delete it by hand")
        with contextlib.suppress(Exception):
            await daytona.close()


if __name__ == "__main__":
    if "--provision-check" in sys.argv:
        asyncio.run(_provision_check())
    else:
        asyncio.run(_smoke())
