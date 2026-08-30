"""Build the `quant-agent-v1` Daytona snapshot used by orchestrator.py.

Standalone: `python build_snapshot.py` (add `--force` to rebuild if it already exists).

The snapshot carries:
  * Python 3.11 + the numeric stack the agent writes its analysis code against
  * Node 22 + the OpenAI Codex CLI
  * /work   — the agent's writable workspace (`codex -C /work`)
  * /verifier — the read-only schema contract, OUTSIDE the workspace root, so the
    agent cannot rewrite the contract it is judged against
  * /kit, /skills — house tooling and skills baked in by workstream D (if present)

Gotcha honoured: image refs need an explicit tag. `python:latest` is rejected by
snapshot creation, so we pin `python:3.11-slim-bookworm`.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover
    pass

REPO_ROOT = Path(__file__).resolve().parent
SNAPSHOT_NAME = os.environ.get("DAYTONA_SNAPSHOT", "quant-agent-v1")

# Explicit tag — never `:latest`.
BASE_IMAGE = "python:3.11-slim-bookworm"
NODE_MAJOR = "22"

PY_PACKAGES = [
    "numpy",
    "pandas",
    "scipy",
    "requests",
    "httpx",
    "jsonschema",
    "python-dateutil",
    "beautifulsoup4",
    "lxml",
]


def _has_files(path: Path) -> bool:
    return path.is_dir() and any(p.is_file() for p in path.rglob("*"))


def build_image():
    """Declarative Image definition for the snapshot."""
    from daytona import Image

    image = (
        Image.base(BASE_IMAGE)
        .env(
            {
                "DEBIAN_FRONTEND": "noninteractive",
                "PYTHONUNBUFFERED": "1",
                "PIP_DISABLE_PIP_VERSION_CHECK": "1",
                # Codex writes its config/session state here; keep it on a stable path
                # so `codex exec resume --last` finds the previous session.
                "CODEX_HOME": "/root/.codex",
            }
        )
        .run_commands(
            "apt-get update && apt-get install -y --no-install-recommends "
            "curl ca-certificates git jq ripgrep procps unzip "
            "&& rm -rf /var/lib/apt/lists/*",
            # Node 22 via NodeSource, then the Codex CLI.
            f"curl -fsSL https://deb.nodesource.com/setup_{NODE_MAJOR}.x | bash - "
            "&& apt-get install -y --no-install-recommends nodejs "
            "&& rm -rf /var/lib/apt/lists/*",
            "npm install -g @openai/codex && codex --version || true",
        )
        .pip_install(*PY_PACKAGES)
        .run_commands(
            # Workspace the agent owns...
            "mkdir -p /work && chmod 777 /work",
            # ...and the contract it must not touch. It lives outside `-C /work`
            # so the agent's workspace root cannot reach it.
            "mkdir -p /verifier",
            "mkdir -p /root/.codex",
        )
    )

    # Seed the schema into the image so the sandbox is usable even before the
    # orchestrator uploads its copy at run time (that upload is authoritative).
    #
    # NOTE: we deliberately do NOT use Image.add_local_file here. The Daytona SDK's
    # compute_archive_base_path() strips the drive letter but keeps Windows
    # backslashes, emitting `COPY Users\dimkn\...\file /dst`, which a Linux builder
    # cannot resolve. base64-inlining sidesteps the build context entirely.
    schema = REPO_ROOT / "verifier" / "impact.schema.json"
    if schema.is_file():
        b64 = base64.b64encode(schema.read_bytes()).decode()
        image = image.run_commands(
            f"printf %s {b64} | base64 -d > /verifier/impact.schema.json "
            "&& chmod 444 /verifier/impact.schema.json && chmod 555 /verifier"
        )
    else:
        print("[build] WARNING: verifier/impact.schema.json not found; not seeding it")

    # Workstream D's kit + skills, baked in if they exist yet.
    # Relative, single-segment paths only — see the backslash note above; `kit`
    # normalises to `kit` with no separator, so the COPY line stays POSIX-clean.
    # build_image() is called with cwd == REPO_ROOT (see main()).
    for local, remote in (("kit", "/kit"), ("skills", "/skills")):
        if _has_files(REPO_ROOT / local):
            print(f"[build] baking {local}/ -> {remote}")
            image = image.add_local_dir(local, remote)
        else:
            print(f"[build] skipping {local}/ (empty or missing)")

    # Keep the sandbox alive; Daytona sandboxes need a long-running process.
    image = image.workdir("/work").entrypoint(["sleep", "infinity"])
    return image


async def main() -> int:
    ap = argparse.ArgumentParser(description="Build the quant-agent-v1 Daytona snapshot")
    ap.add_argument("--name", default=SNAPSHOT_NAME, help=f"snapshot name (default {SNAPSHOT_NAME})")
    ap.add_argument("--force", action="store_true", help="rebuild even if the snapshot exists")
    ap.add_argument("--dockerfile", action="store_true",
                    help="print the generated Dockerfile and exit (no credentials needed)")
    args = ap.parse_args()

    # add_local_dir() resolves relative to cwd and the SDK mangles absolute
    # Windows paths into the Dockerfile, so anchor cwd at the repo root.
    os.chdir(REPO_ROOT)
    image = build_image()

    if args.dockerfile:
        print("\n----- generated Dockerfile -----")
        print(image.dockerfile())
        return 0

    api_key = os.environ.get("DAYTONA_API_KEY")
    if not api_key:
        print(
            "ERROR: DAYTONA_API_KEY is not set.\n"
            "  Copy .env.example to .env and fill it in (key from https://app.daytona.io).\n"
            "  Tip: `python build_snapshot.py --dockerfile` works without credentials.",
            file=sys.stderr,
        )
        return 2

    from daytona import AsyncDaytona, CreateSnapshotParams, DaytonaConfig, Resources

    cfg = {"api_key": api_key}
    if os.environ.get("DAYTONA_API_URL"):
        cfg["api_url"] = os.environ["DAYTONA_API_URL"]
    if os.environ.get("DAYTONA_TARGET"):
        cfg["target"] = os.environ["DAYTONA_TARGET"]

    daytona = AsyncDaytona(DaytonaConfig(**cfg))
    try:
        if not args.force:
            try:
                existing = await daytona.snapshot.get(args.name)
                print(f"[build] snapshot '{args.name}' already exists "
                      f"(state={getattr(existing, 'state', '?')}). Use --force to rebuild.")
                return 0
            except Exception:
                pass  # not found -> build it

        params = CreateSnapshotParams(
            name=args.name,
            image=image,
            resources=Resources(cpu=2, memory=4, disk=10),
        )
        print(f"[build] creating snapshot '{args.name}' from {BASE_IMAGE} ...")
        snapshot = await daytona.snapshot.create(params, on_logs=print, timeout=1800)
        print(f"\n[build] done: {getattr(snapshot, 'name', args.name)} "
              f"state={getattr(snapshot, 'state', '?')}")
        return 0
    except Exception as exc:
        print(f"\n[build] FAILED: {exc!r}", file=sys.stderr)
        return 1
    finally:
        try:
            await daytona.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
