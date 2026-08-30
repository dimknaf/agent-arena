"""DE-RISK SPIKE — answers the three questions that can invalidate the architecture.

  1. Does a transplanted ~/.codex/auth.json authenticate Codex inside a Daytona sandbox?
     (fallback: OPENAI_API_KEY — loses the $50 ChatGPT credits, keeps the demo)
  2. Does --output-schema actually constrain the final message?
  3. Does --output-schema survive `codex exec resume`?
     (fallback: fresh exec per attempt — more tokens, still works)

Run:  python spike/spike.py
Each stage prints PASS/FAIL and the script keeps going so one run answers everything.

SECURITY: auth.json holds live ChatGPT OAuth tokens. It is never printed and never
committed (.gitignore covers `auth.json` and `.env`).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

CODEX_AUTH = Path.home() / ".codex" / "auth.json"
SCHEMA = ROOT / "verifier" / "impact.schema.json"

# Minimal schema for the spike — we are testing the mechanism, not the analysis.
SPIKE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["answer", "confidence"],
    "properties": {
        "answer": {"type": "string"},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
}

results: dict[str, str] = {}


def report(stage: str, ok: bool, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    results[stage] = mark
    print(f"\n[{mark}] {stage}" + (f"\n       {detail}" if detail else ""), flush=True)


async def main() -> int:
    print("=" * 70)
    print("AGENT ARENA — de-risk spike")
    print("=" * 70, flush=True)

    # ---------------------------------------------------- stage 0: prerequisites
    key = os.getenv("DAYTONA_API_KEY")
    if not key:
        report("0. DAYTONA_API_KEY present", False,
               "Create .env in the repo root with DAYTONA_API_KEY=...  Nothing can run without it.")
        return 1
    report("0. DAYTONA_API_KEY present", True, f"key ...{key[-4:]}")

    if not CODEX_AUTH.exists():
        report("0b. local codex auth.json", False, f"not found at {CODEX_AUTH}")
        return 1
    auth_raw = CODEX_AUTH.read_text(encoding="utf-8")
    auth = json.loads(auth_raw)
    report("0b. local codex auth.json", True,
           f"auth_mode={auth.get('auth_mode')}  has_api_key={bool(auth.get('OPENAI_API_KEY'))}")

    from daytona import (AsyncDaytona, CreateSandboxFromImageParams,
                         DaytonaConfig, SessionExecuteRequest)

    daytona = AsyncDaytona(DaytonaConfig(api_key=key))
    sandbox = None
    t0 = time.time()

    try:
        # ------------------------------------------------ stage 1: create sandbox
        print("\n> creating sandbox (node image, so codex can npm-install)...", flush=True)
        try:
            sandbox = await daytona.create(
                CreateSandboxFromImageParams(
                    image="node:22-bookworm",          # explicit tag — ':latest' is rejected
                    auto_stop_interval=0,
                    ttl_minutes=20,
                    env_vars={"CODEX_HOME": "/root/.codex"},
                ),
                timeout=180,
                on_snapshot_create_logs=lambda m: print("   img:", m.rstrip(), flush=True),
            )
            report("1. sandbox create", True,
                   f"id={sandbox.id}  {time.time() - t0:.1f}s")
        except Exception as exc:
            report("1. sandbox create", False, f"{type(exc).__name__}: {exc}")
            return 1

        sid = "spike"
        await sandbox.process.create_session(sid)

        async def run(cmd: str, label: str, timeout: int = 300) -> tuple[int, str]:
            """Run via async session (process.exec has a 10s default timeout)."""
            print(f"\n> {label}", flush=True)
            resp = await sandbox.process.execute_session_command(
                sid, SessionExecuteRequest(command=cmd, run_async=True)
            )
            cmd_id = getattr(resp, "cmd_id", None) or getattr(resp, "id", None)
            if cmd_id is None:
                print("   !! could not find command id on:", dir(resp), flush=True)
                return -1, ""
            buf: list[str] = []

            def on_out(chunk: str) -> None:      # never block in here
                buf.append(chunk)
                sys.stdout.write(chunk if chunk.endswith("\n") else chunk + "\n")

            try:
                await asyncio.wait_for(
                    sandbox.process.get_session_command_logs_async(sid, cmd_id, on_out, on_out),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                print(f"   !! timed out after {timeout}s", flush=True)
            info = await sandbox.process.get_session_command(sid, cmd_id)
            return (getattr(info, "exit_code", None) or 0), "".join(buf)

        # ------------------------------------------------ stage 2: install codex
        code, out = await run("npm i -g @openai/codex 2>&1 | tail -5 && codex --version",
                              "installing @openai/codex (latest)", timeout=420)
        ok = code == 0 and "codex" in out.lower()
        report("2. codex install", ok, out.strip()[-200:])
        if not ok:
            return 1

        # ------------------------------------------------ stage 3: transplant auth
        await sandbox.fs.upload_file(auth_raw.encode(), "/root/.codex/auth.json")
        code, out = await run(
            "ls -l /root/.codex/auth.json && "
            "python3 -c \"import json;d=json.load(open('/root/.codex/auth.json'));print('auth_mode',d.get('auth_mode'))\" "
            "|| node -e \"console.log('auth_mode', require('/root/.codex/auth.json').auth_mode)\"",
            "verifying transplanted auth.json", timeout=60)
        report("3. auth.json transplanted", "chatgpt" in out, out.strip()[-200:])

        # ------------------------------------------------ stage 4: THE BIG ONE
        await sandbox.fs.upload_file(
            json.dumps(SPIKE_SCHEMA).encode(), "/verifier/spike.schema.json")
        await sandbox.process.exec("mkdir -p /work", timeout=30)

        codex_cmd = (
            "cd /work && codex exec "
            "--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "
            "--disable fast_mode -m gpt-5.6-terra -c model_reasoning_effort=\"low\" "
            "--json --output-schema /verifier/spike.schema.json "
            "-o /work/result.json -C /work "
            "'What is 17 * 23? Reply with the answer as a string and your confidence.' 2>&1"
        )
        code, out = await run(codex_cmd, "codex exec --output-schema  <-- THE CRITICAL TEST",
                              timeout=300)

        # capture a real JSONL sample so orchestrator's parser can be tightened
        sample = ROOT / "runs"
        sample.mkdir(exist_ok=True)
        (sample / "codex_events_sample.jsonl").write_text(out, encoding="utf-8")

        auth_failed = any(s in out.lower() for s in
                          ("not logged in", "unauthorized", "401", "please run codex login",
                           "authentication", "invalid_api_key"))
        if auth_failed:
            report("4. codex auth in sandbox", False,
                   "ChatGPT auth.json did NOT work headless -> FALL BACK TO OPENAI_API_KEY")
        else:
            report("4. codex auth in sandbox", True, "authenticated via transplanted auth.json")

        try:
            payload = json.loads((await sandbox.fs.download_file("/work/result.json")).decode())
            good = isinstance(payload, dict) and "answer" in payload and "confidence" in payload
            report("5. --output-schema honoured", good, json.dumps(payload)[:300])
        except Exception as exc:
            report("5. --output-schema honoured", False, f"no valid result.json: {exc}")

        # ------------------------------------------------ stage 6: resume + schema
        code, out2 = await run(
            "cd /work && codex exec resume --last "
            "--skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "
            "--disable fast_mode --json --output-schema /verifier/spike.schema.json "
            "-o /work/result2.json -C /work "
            "'VERIFICATION FAILED: confidence must be exactly 0.99. Fix and re-emit.' 2>&1",
            "codex exec resume + --output-schema", timeout=300)
        try:
            p2 = json.loads((await sandbox.fs.download_file("/work/result2.json")).decode())
            report("6. resume keeps --output-schema", "answer" in p2, json.dumps(p2)[:200])
        except Exception as exc:
            report("6. resume keeps --output-schema", False,
                   f"fallback = fresh exec per attempt. ({exc})")

    finally:
        if sandbox is not None:
            try:
                await daytona.delete(sandbox)
                print("\n> sandbox destroyed", flush=True)
            except Exception as exc:
                print(f"\n!! could not delete sandbox: {exc}", flush=True)
        await daytona.close()

    print("\n" + "=" * 70)
    for stage, mark in results.items():
        print(f"  {mark}  {stage}")
    print("=" * 70, flush=True)
    return 0 if all(v == "PASS" for v in results.values()) else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
