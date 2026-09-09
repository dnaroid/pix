#!/usr/bin/env python3
"""Deterministic regression checks for Spec Wiki maintenance primitives."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


CLI = Path(__file__).resolve().parents[1] / "scripts" / "spec_wiki.py"


def run(cwd: Path, *args: str) -> str:
    proc = subprocess.run(
        ["python3", str(CLI), "--root", str(cwd), *args],
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        raise AssertionError(f"command failed {args}:\nstdout={proc.stdout}\nstderr={proc.stderr}")
    return proc.stdout


def run_json(cwd: Path, *args: str) -> dict:
    return json.loads(run(cwd, *args, "--json"))


def git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, stdout=subprocess.DEVNULL)


def write(root: Path, rel: str, text: str) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def init_repo(root: Path) -> None:
    git(root, "init", "-q")
    git(root, "config", "user.email", "spec-wiki-eval@example.com")
    git(root, "config", "user.name", "Spec Wiki Eval")


def commit_all(root: Path, message: str = "baseline") -> None:
    git(root, "add", ".")
    git(root, "commit", "-qm", message)


def test_relation_map_invalidates_verification(tmp: Path) -> None:
    root = tmp / "relations"
    root.mkdir()
    init_repo(root)
    write(root, "src/a.ts", "export const a = 1\n")
    write(root, "src/b.ts", "export const b = 2\n")
    write(
        root,
        "docs/contract.md",
        """# Contract

## Type
As-is

## Lifecycle
Active

## Behavior
A is part of the current contract.

## Related files
- `src/a.ts`
""",
    )
    commit_all(root)
    run(
        root,
        "record",
        "--path",
        "docs/contract.md",
        "--classification",
        "spec",
        "--type",
        "as-is",
        "--lifecycle",
        "active",
        "--confidence",
        "high",
        "--summary",
        "Contract for A.",
    )
    run(root, "verify", "--path", "docs/contract.md")
    audit = run_json(root, "audit")
    assert audit["freshCount"] == 1

    run(root, "relate", "--path", "docs/contract.md", "--add-code", "src/b.ts")
    audit = run_json(root, "audit")
    assert audit["freshCount"] == 0
    status = next(item for item in audit["statuses"] if item["path"] == "docs/contract.md")
    assert status["status"] == "inputs-changed"
    assert "relations:changed" in status["reasons"]

    run(root, "verify", "--path", "docs/contract.md")
    assert run_json(root, "audit")["freshCount"] == 1
    run(root, "relate", "--path", "docs/contract.md", "--remove-code", "src/b.ts")
    status = next(item for item in run_json(root, "audit")["statuses"] if item["path"] == "docs/contract.md")
    assert status["status"] == "inputs-changed"
    assert status["reasons"] == ["relations:changed"]


def test_impact_detects_coverage_gaps_and_moves(tmp: Path) -> None:
    root = tmp / "impact"
    root.mkdir()
    init_repo(root)
    write(root, "src/session.ts", "export function session() { return 'ok' }\n")
    write(
        root,
        "docs/session-contract.md",
        """# Session contract

## Type
As-is

## Lifecycle
Active

## Behavior
Session loading returns the current session.

## Related files
- `src/session.ts`
""",
    )
    commit_all(root)
    run(
        root,
        "record",
        "--path",
        "docs/session-contract.md",
        "--classification",
        "spec",
        "--type",
        "as-is",
        "--lifecycle",
        "active",
        "--confidence",
        "high",
        "--summary",
        "Session loading contract.",
    )
    run(root, "verify", "--path", "docs/session-contract.md")

    git(root, "mv", "docs/session-contract.md", "docs/session-lifecycle.md")
    with (root / "docs/session-lifecycle.md").open("a", encoding="utf-8") as handle:
        handle.write("\nMoved without changing the behavioral contract.\n")
    write(root, "src/refresh-worker.ts", "export const retryOnce = true\n")
    write(root, "notes.txt", "deliberately low signal document\n")

    impact = run_json(root, "impact")
    assert ".spec-wiki/state.json" not in impact["changedPaths"]
    assert any(
        item.get("status") == "R"
        and item.get("oldPath") == "docs/session-contract.md"
        and item.get("path") == "docs/session-lifecycle.md"
        for item in impact["changes"]
    )
    assert "src/refresh-worker.ts" in impact["uncoveredPaths"]
    changed_docs = {item["path"]: item for item in impact["changedDocuments"]}
    assert changed_docs["docs/session-lifecycle.md"]["requiresClassification"] is True
    assert changed_docs["notes.txt"]["score"] == 0
    assert "docs/session-contract.md" in impact["missingTrackedSpecs"]
    assert impact["semanticSweepRequired"] is True


def test_deep_audit_finds_low_signal_committed_docs(tmp: Path) -> None:
    root = tmp / "deep"
    root.mkdir()
    init_repo(root)
    write(
        root,
        "notes/capture.txt",
        "Duplicate capture requests with the same key return the original result.\n",
    )
    write(root, "skills/example/evals/fixture.md", "# Contract\n\n## Behavior\nFixture only.\n")
    commit_all(root)

    normal = run_json(root, "discover", "--limit", "100")
    assert "notes/capture.txt" not in {item["path"] for item in normal["candidates"]}
    deep = run_json(root, "discover", "--all-unclassified", "--limit", "100")
    paths = {item["path"] for item in deep["candidates"]}
    assert "notes/capture.txt" in paths
    assert "skills/example/evals/fixture.md" not in paths


def test_relate_restores_source_explicit_relation(tmp: Path) -> None:
    root = tmp / "supersession"
    root.mkdir()
    init_repo(root)
    write(root, "docs/b.md", "# B\n")
    write(
        root,
        "docs/a.md",
        """# A contract

## Type
As-is

## Lifecycle
Active

## Behavior
A references B.

[B](./b.md)
""",
    )
    commit_all(root)
    run(
        root,
        "record",
        "--path",
        "docs/a.md",
        "--classification",
        "spec",
        "--type",
        "as-is",
        "--lifecycle",
        "active",
        "--confidence",
        "high",
        "--summary",
        "A contract.",
    )
    run(root, "verify", "--path", "docs/a.md")
    run(root, "relate", "--path", "docs/a.md", "--add-supersedes", "docs/b.md")
    state = json.loads((root / ".spec-wiki/state.json").read_text(encoding="utf-8"))
    relations = state["entries"]["docs/a.md"]["relations"]["specs"]
    assert any(
        item.get("path") == "docs/b.md"
        and item.get("source") == "explicit"
        and item.get("kind") == "related"
        for item in relations
    )
    assert any(item.get("path") == "docs/b.md" and item.get("kind") == "supersedes" for item in relations)
    run(root, "relate", "--path", "docs/a.md", "--remove-supersedes", "docs/b.md")
    state = json.loads((root / ".spec-wiki/state.json").read_text(encoding="utf-8"))
    relations = state["entries"]["docs/a.md"]["relations"]["specs"]
    assert any(
        item.get("path") == "docs/b.md"
        and item.get("source") == "explicit"
        and item.get("kind") == "related"
        for item in relations
    )
    assert not any(item.get("kind") == "supersedes" for item in relations)


def test_changed_non_primary_requires_reclassification(tmp: Path) -> None:
    root = tmp / "reclassification"
    root.mkdir()
    init_repo(root)
    write(root, "docs/info.md", "# Operator notes\n\nRun the service with --help.\n")
    commit_all(root)
    run(
        root,
        "record",
        "--path",
        "docs/info.md",
        "--classification",
        "guide",
        "--summary",
        "Operator notes.",
    )
    write(
        root,
        "docs/info.md",
        """# Request contract

## Type
As-is

## Lifecycle
Active

## Behavior
Duplicate requests return the original result.
""",
    )
    impact = run_json(root, "impact", "docs/info.md")
    changed = next(item for item in impact["changedDocuments"] if item["path"] == "docs/info.md")
    assert changed["knownClassification"] == "guide"
    assert changed["requiresClassification"] is False
    assert changed["requiresReclassification"] is True
    assert impact["semanticSweepRequired"] is True


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="spec-wiki-maint-") as directory:
        tmp = Path(directory)
        test_relation_map_invalidates_verification(tmp)
        test_impact_detects_coverage_gaps_and_moves(tmp)
        test_deep_audit_finds_low_signal_committed_docs(tmp)
        test_relate_restores_source_explicit_relation(tmp)
        test_changed_non_primary_requires_reclassification(tmp)
    print("maintenance regression: 5/5 passed")


if __name__ == "__main__":
    main()
