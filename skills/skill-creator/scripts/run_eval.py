#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes pi to trigger (read the skill)
for a set of queries. Outputs results as JSON.
"""

import argparse
import json
import os
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from scripts.utils import parse_skill_md


def find_project_root() -> Path:
    """Return the working directory pi should run in.

    Unlike Claude Code, pi has no `.claude/` project marker that controls
    skill discovery — skills are loaded explicitly via `--skill` (or from
    pi's own skill locations). We simply use the current directory so the
    agent sees the same relative paths the user would.
    """
    return Path.cwd()


def _safe_skill_name(raw: str, unique_id: str) -> str:
    """Build a frontmatter-valid skill name (lowercase, hyphens, a-z0-9)."""
    base = re.sub(r"[^a-z0-9]+", "-", (raw or "skill").lower()).strip("-") or "skill"
    return f"{base}-{unique_id}"


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    skill_body: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    Creates a throwaway skill directory whose SKILL.md carries the
    description under test, then runs `pi -p --mode json --skill <dir>`.
    We watch the JSON event stream for a `read` tool call targeting that
    SKILL.md, which is how pi loads a skill once the model decides to use
    it. As soon as we see it, we return True and kill the process so the
    run doesn't keep executing the skill.
    """
    unique_id = uuid.uuid4().hex[:8]
    clean_name = _safe_skill_name(skill_name, unique_id)
    temp_skill_dir = Path(tempfile.mkdtemp(prefix=f"pi-skill-eval-{unique_id}-"))
    skill_md_path = temp_skill_dir / "SKILL.md"

    try:
        # Write a SKILL.md with the description under test. The body is the
        # real skill body so the model behaves naturally if it does read it,
        # but the triggering decision is driven solely by the description.
        indented_desc = "\n  ".join(skill_description.split("\n"))
        skill_md_content = (
            f"---\n"
            f"name: {clean_name}\n"
            f"description: |\n"
            f"  {indented_desc}\n"
            f"---\n\n"
            f"{skill_body.strip()}\n"
        )
        skill_md_path.write_text(skill_md_content)

        cmd = [
            "pi",
            "-p", "--mode", "json",
            "--no-session",
            # Only the skill under test should be available, so its
            # description is what gets evaluated in isolation. Explicit
            # --skill paths still load even with --no-skills.
            "--no-skills",
            "--skill", str(temp_skill_dir),
            query,
        ]
        if model:
            cmd.extend(["--model", model])

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
        )

        triggered = False
        start_time = time.time()
        buffer = ""

        def _targets_skill(path: str) -> bool:
            """True if a read target points at the temp skill's SKILL.md."""
            if not path:
                return False
            # The temp dir name embeds unique_id, so this is unique per run
            # and survives absolute/relative/tilde variations.
            return unique_id in path or clean_name in path

        try:
            while time.time() - start_time < timeout:
                if process.poll() is not None:
                    remaining = process.stdout.read()
                    if remaining:
                        buffer += remaining.decode("utf-8", errors="replace")
                    break

                ready, _, _ = select.select([process.stdout], [], [], 1.0)
                if not ready:
                    continue

                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    etype = event.get("type")

                    # Fully-formed tool call (fires before execution).
                    if etype == "message_update":
                        ame = event.get("assistantMessageEvent", {})
                        if ame.get("type") == "toolcall_end":
                            tool_call = ame.get("toolCall", {})
                            if tool_call.get("name") == "read":
                                path = (tool_call.get("arguments") or {}).get("path", "")
                                if _targets_skill(path):
                                    return True

                    # Tool actually started executing — redundant but robust.
                    elif etype == "tool_execution_start":
                        if event.get("toolName") == "read":
                            path = (event.get("args") or {}).get("path", "")
                            if _targets_skill(path):
                                return True

                    elif etype == "agent_end":
                        return triggered
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

        return triggered
    finally:
        shutil.rmtree(temp_skill_dir, ignore_errors=True)


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    skill_body: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    skill_body,
                    timeout,
                    str(project_root),
                    model,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def extract_skill_body(skill_path: Path, full_content: str) -> str:
    """Return the SKILL.md body (everything after the frontmatter)."""
    lines = full_content.split("\n")
    if not lines or lines[0].strip() != "---":
        return full_content
    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return full_content
    return "\n".join(lines[end_idx + 1:])


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use for pi -p (default: user's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description
    skill_body = extract_skill_body(skill_path, content)
    project_root = find_project_root()

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        skill_body=skill_body,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
