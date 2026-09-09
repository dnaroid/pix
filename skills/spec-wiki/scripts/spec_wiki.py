#!/usr/bin/env python3
"""Deterministic storage/discovery layer for the spec-wiki skill."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 2
SPEC_CLASSIFICATIONS = {"spec", "spec-like"}
CLASSIFICATIONS = SPEC_CLASSIFICATIONS | {"meta-index", "design-only", "guide", "other"}
SPEC_TYPES = {"as-is", "change", "mixed", "unknown"}
CONFIDENCES = {"high", "medium", "low", "unknown"}
LIFECYCLES = {"active", "proposed", "historical", "superseded", "unknown"}
SPEC_RELATION_KINDS = {"related", "supersedes", "superseded-by"}
DOC_EXTENSIONS = {".md", ".mdx", ".rst", ".adoc", ".txt"}
DEFAULT_IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".spec-wiki",
    ".idea",
    ".vscode",
    ".venv",
    "venv",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "coverage",
    ".next",
    ".nuxt",
    ".cache",
    "__pycache__",
}
DEFAULT_CONFIG: dict[str, Any] = {
    "includeExtensions": sorted(DOC_EXTENSIONS),
    "include": [],
    "exclude": [],
    "forceSpecs": [],
    "ignoreSpecs": [],
    "minCandidateScore": 3,
    "maxFileBytes": 512 * 1024,
}

SPEC_NAME_RE = re.compile(r"(?:^|[-_.])(spec|contract|requirements?|rfc|protocol|behavior)(?:[-_.]|$)", re.I)
SPEC_DIR_NAMES = {"spec", "specs", "contracts", "requirements", "rfcs", "rfc", "protocols"}
FIXTURE_DIR_NAMES = {"evals", "fixtures", "fixture", "examples", "example", "testdata", "samples", "sample"}
SKILL_RESOURCE_DIR_NAMES = {"skills", "agents"}
DESIGN_NAME_RE = re.compile(r"(?:^|[-_.])(adr|design|decision|evidence|measurement|review)(?:[-_.]|$)", re.I)
SPEC_HEADING_RE = re.compile(
    r"^(?:#+\s*)?(?:"
    r"behavior|behaviour|requirements?|contracts?|invariants?|scope|non-goals?|"
    r"acceptance(?: criteria)?|expected behavior|verification|edge cases?|public contracts?|"
    r"current behavior|intended behavior|semantics|compatibility"
    r")\s*:?[\s#]*$",
    re.I,
)
META_NAME_RE = re.compile(r"^(?:\d+[-_.])?(?:readme|index|overview|toc|catalog|contents?)(?:[-_.].*)?$", re.I)
META_TEXT_RE = re.compile(r"\b(?:specs? index|spec inventory|full spec inventory|table of contents|documentation index|catalog of specs)\b", re.I)
TYPE_AS_IS_RE = re.compile(r"\b(?:as-is|current behavior|current behaviour)\b", re.I)
TYPE_CHANGE_RE = re.compile(r"\b(?:change spec|intended behavior|intended behaviour|proposed behavior|target behavior)\b", re.I)
MARKDOWN_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
BACKTICK_RE = re.compile(r"`([^`\n]+)`")
PLAIN_PATH_RE = re.compile(r"(?<![\w/])(?:[A-Za-z0-9_.@+-]+/)+[A-Za-z0-9_.@+\-]+\.[A-Za-z0-9]{1,12}")
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
RELATIVE_BASE_RE = re.compile(
    r"(?:paths?|references?|files?)\b[^\n]{0,80}?\brelative\s+to\s+`([^`]+)`",
    re.I,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def file_hash(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        return "sha256:" + digest.hexdigest()
    except (OSError, PermissionError):
        return None


def normalize_rel_path(root: Path, value: str | Path) -> str:
    raw = Path(value)
    absolute = raw if raw.is_absolute() else root / raw
    resolved = absolute.resolve(strict=False)
    try:
        relative = resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"path escapes project root: {value}") from exc
    return relative.as_posix()


def safe_project_path(root: Path, rel: str) -> Path:
    normalized = normalize_rel_path(root, rel)
    return root / normalized


def strip_jsonc(text: str) -> str:
    output: list[str] = []
    i = 0
    in_string = False
    escaped = False
    while i < len(text):
        char = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            i += 1
            continue
        if char == '"':
            in_string = True
            output.append(char)
            i += 1
            continue
        if char == "/" and nxt == "/":
            i += 2
            while i < len(text) and text[i] not in "\r\n":
                i += 1
            continue
        if char == "/" and nxt == "*":
            i += 2
            while i + 1 < len(text) and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        output.append(char)
        i += 1
    cleaned = "".join(output)
    output = []
    in_string = False
    escaped = False
    for index, char in enumerate(cleaned):
        if in_string:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            output.append(char)
            continue
        if char == ",":
            cursor = index + 1
            while cursor < len(cleaned) and cleaned[cursor].isspace():
                cursor += 1
            if cursor < len(cleaned) and cleaned[cursor] in "}]":
                continue
        output.append(char)
    return "".join(output)


def detect_root(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        )
        value = proc.stdout.strip()
        if value:
            return Path(value).resolve()
    except (FileNotFoundError, subprocess.SubprocessError):
        pass
    return Path.cwd().resolve()


def resolve_state_dir(root: Path, value: str | None) -> Path:
    if not value:
        candidate = root / ".spec-wiki"
        if candidate.is_symlink():
            raise ValueError("default .spec-wiki directory must not be a symlink")
        return candidate
    candidate = Path(value).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    resolved = (root / candidate).resolve(strict=False)
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"relative --state-dir escapes project root: {value}") from exc
    return resolved


def load_config(root: Path, state_dir: Path, explicit: str | None) -> dict[str, Any]:
    config = dict(DEFAULT_CONFIG)
    config_path = Path(explicit).expanduser() if explicit else state_dir / "config.jsonc"
    if not config_path.is_absolute():
        config_path = root / config_path
    if not config_path.exists():
        fallback = config_path.with_suffix(".json") if config_path.suffix == ".jsonc" else None
        if not fallback or not fallback.exists():
            return config
        config_path = fallback
    try:
        parsed = json.loads(strip_jsonc(config_path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"failed to parse config {config_path}: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"config must be a JSON object: {config_path}")
    config.update(parsed)
    for key in ("includeExtensions", "include", "exclude", "forceSpecs", "ignoreSpecs"):
        value = config.get(key)
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError(f"config.{key} must be an array of strings")
    for key in ("minCandidateScore", "maxFileBytes"):
        value = config.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            raise ValueError(f"config.{key} must be a non-negative integer")
    if config["maxFileBytes"] == 0:
        raise ValueError("config.maxFileBytes must be greater than zero")
    return config


def state_file(state_dir: Path) -> Path:
    return state_dir / "state.json"


def index_file(state_dir: Path) -> Path:
    return state_dir / "index.md"


def empty_state() -> dict[str, Any]:
    return {"schemaVersion": SCHEMA_VERSION, "entries": {}}


def load_state(state_dir: Path) -> dict[str, Any]:
    path = state_file(state_dir)
    if not path.exists():
        return empty_state()
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"failed to parse state {path}: {exc}") from exc
    if not isinstance(state, dict):
        raise ValueError("state.json must contain a JSON object")
    return state


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def save_state(state_dir: Path, state: dict[str, Any]) -> None:
    payload = json.dumps(state, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
    atomic_write_text(state_file(state_dir), payload)


def matches_any(path: str, patterns: Iterable[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) for pattern in patterns)


def is_under_ignored_dir(path: str, state_dir: Path, root: Path) -> bool:
    parts = Path(path).parts
    if any(part in DEFAULT_IGNORED_DIRS for part in parts[:-1]):
        return True
    try:
        state_rel = state_dir.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return False
    return path == state_rel or path.startswith(state_rel.rstrip("/") + "/")


def git_project_files(root: Path) -> list[str] | None:
    try:
        proc = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    return sorted({item.decode("utf-8", errors="surrogateescape") for item in proc.stdout.split(b"\0") if item})


def git_changed_records(root: Path, base: str = "HEAD") -> list[dict[str, str]]:
    try:
        subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        raise ValueError("Git working tree is required when impact paths are not supplied explicitly") from exc

    records: list[dict[str, str]] = []
    try:
        proc = subprocess.run(
            ["git", "diff", "--name-status", "-z", "--find-renames", base, "--"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
            timeout=30,
        )
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(f"failed to inspect Git changes against {base}: {message or exc}") from exc

    parts = [part.decode("utf-8", errors="surrogateescape") for part in proc.stdout.split(b"\0") if part]
    index = 0
    while index < len(parts):
        status = parts[index]
        index += 1
        code = status[:1]
        if code in {"R", "C"}:
            if index + 1 >= len(parts):
                break
            old_path, new_path = parts[index], parts[index + 1]
            index += 2
            records.append({"status": code, "oldPath": old_path.replace("\\", "/"), "path": new_path.replace("\\", "/")})
        else:
            if index >= len(parts):
                break
            path = parts[index]
            index += 1
            records.append({"status": code or "M", "path": path.replace("\\", "/")})

    try:
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard", "-z"],
            cwd=root,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=30,
        )
        tracked_paths = {
            item.get("path") for item in records if isinstance(item.get("path"), str)
        }
        for raw in untracked.stdout.split(b"\0"):
            if not raw:
                continue
            path = raw.decode("utf-8", errors="surrogateescape").replace("\\", "/")
            if path not in tracked_paths:
                records.append({"status": "?", "path": path})
    except (FileNotFoundError, subprocess.SubprocessError):
        pass

    return sorted(records, key=lambda item: (str(item.get("path", "")), str(item.get("oldPath", "")), str(item.get("status", ""))))


def changed_record_paths(records: Iterable[dict[str, str]]) -> list[str]:
    paths: set[str] = set()
    for record in records:
        for key in ("oldPath", "path"):
            value = record.get(key)
            if isinstance(value, str) and value:
                paths.add(value.replace("\\", "/"))
    return sorted(paths)


def filter_internal_change_records(
    records: Iterable[dict[str, str]],
    state_dir: Path,
    root: Path,
) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for record in records:
        values = [record.get(key) for key in ("oldPath", "path") if isinstance(record.get(key), str)]
        if values and all(is_under_ignored_dir(value, state_dir, root) for value in values):
            continue
        result.append(record)
    return result


def walked_project_files(root: Path) -> list[str]:
    files: list[str] = []
    for current, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in DEFAULT_IGNORED_DIRS)
        current_path = Path(current)
        for name in sorted(names):
            try:
                files.append((current_path / name).relative_to(root).as_posix())
            except ValueError:
                continue
    return files


def project_files(root: Path) -> list[str]:
    git_files = git_project_files(root)
    return git_files if git_files is not None else walked_project_files(root)


def candidate_file_paths(root: Path, state_dir: Path, config: dict[str, Any]) -> list[str]:
    extensions = {str(item).lower() if str(item).startswith(".") else f".{str(item).lower()}" for item in config.get("includeExtensions", [])}
    includes = [str(item) for item in config.get("include", [])]
    excludes = [str(item) for item in config.get("exclude", [])]
    forced = [str(item) for item in config.get("forceSpecs", [])]
    ignored = [str(item) for item in config.get("ignoreSpecs", [])]
    result: list[str] = []
    for rel in project_files(root):
        rel = rel.replace("\\", "/")
        if is_under_ignored_dir(rel, state_dir, root):
            continue
        if matches_any(rel, ignored) or matches_any(rel, excludes):
            continue
        is_forced = matches_any(rel, forced)
        if not is_forced:
            if extensions and Path(rel).suffix.lower() not in extensions:
                continue
            if includes and not matches_any(rel, includes):
                continue
        result.append(rel)
    return result


def read_candidate(path: Path, max_bytes: int) -> tuple[str, bytes] | None:
    try:
        size = path.stat().st_size
        if size > max_bytes:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if b"\x00" in data[:8192]:
        return None
    return data.decode("utf-8", errors="replace"), data


def document_title(text: str, rel: str) -> str:
    lines = text.splitlines()[:80]
    for index, line in enumerate(lines):
        match = re.match(r"^\s*(?:#{1,6}|={1,6})\s+(.+?)\s*#*\s*$", line)
        if match:
            return match.group(1).strip()
        if index + 1 < len(lines) and line.strip() and re.fullmatch(r"\s*[=~^-]{3,}\s*", lines[index + 1]):
            return line.strip()
    return Path(rel).stem.replace("-", " ").replace("_", " ").strip()


def discovery_signals(rel: str, text: str, forced: bool = False) -> tuple[int, str, list[str]]:
    score = 0
    signals: list[str] = []
    path = Path(rel)
    stem = path.stem
    lower_parts = {part.lower() for part in path.parts[:-1]}
    if forced:
        score += 100
        signals.append("forced-by-config")
    if SPEC_NAME_RE.search(stem):
        score += 4
        signals.append("spec-like-filename")
    if lower_parts & SPEC_DIR_NAMES:
        score += 3
        signals.append("spec-like-directory")
    noisy_resource_path = bool(lower_parts & (FIXTURE_DIR_NAMES | SKILL_RESOURCE_DIR_NAMES)) and not forced
    if lower_parts & FIXTURE_DIR_NAMES and not forced:
        score -= 12
        signals.append("fixture-like-path")
    if lower_parts & SKILL_RESOURCE_DIR_NAMES and not forced:
        score -= 12
        signals.append("skill-resource-path")
    if DESIGN_NAME_RE.search(stem):
        score += 3
        signals.append("design-like-filename")

    headings = []
    for line in text.splitlines()[:500]:
        stripped = re.sub(r"^\s*(?:#{1,6}|={1,6})\s+", "", line).strip().rstrip("#").strip()
        if SPEC_HEADING_RE.match(stripped):
            headings.append(stripped.lower())
    unique_headings = sorted(set(headings))
    if unique_headings:
        score += min(6, len(unique_headings) * 2)
        signals.append("contract-headings:" + ",".join(unique_headings[:4]))
    if TYPE_AS_IS_RE.search(text[:20000]):
        score += 1
        signals.append("as-is-language")
    if TYPE_CHANGE_RE.search(text[:20000]):
        score += 1
        signals.append("change-language")

    path_refs = set(PLAIN_PATH_RE.findall(text[:100000]))
    if path_refs:
        score += 1 if len(path_refs) < 3 else 2
        signals.append(f"path-references:{min(len(path_refs), 99)}")

    meta_score = 0
    if META_NAME_RE.match(stem):
        meta_score += 3
        signals.append("meta-like-filename")
    if META_TEXT_RE.search(text[:30000]):
        meta_score += 4
        signals.append("meta-index-language")
    doc_links = [target for target in MARKDOWN_LINK_RE.findall(text[:100000]) if Path(target.split("#", 1)[0]).suffix.lower() in DOC_EXTENSIONS]
    if len(doc_links) >= 4:
        meta_score += 2
        signals.append(f"many-doc-links:{min(len(doc_links), 99)}")
    title = document_title(text, rel)
    if re.search(r"\b(?:specs? index|spec inventory|documentation index)\b", title, re.I):
        meta_score += 4
        signals.append("meta-like-title")

    if noisy_resource_path:
        role_hint = "weak-candidate"
    elif meta_score >= 5:
        role_hint = "meta-index"
    elif score >= 4:
        role_hint = "spec-candidate"
    else:
        role_hint = "weak-candidate"
    return score, role_hint, signals


def entry_baseline_hash(entry: dict[str, Any]) -> str | None:
    indexed = entry.get("indexed")
    return indexed.get("sourceHash") if isinstance(indexed, dict) else None


def discover_candidates(
    root: Path,
    state_dir: Path,
    config: dict[str, Any],
    state: dict[str, Any],
    include_all: bool = False,
    all_unclassified: bool = False,
) -> list[dict[str, Any]]:
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    max_bytes = int(config.get("maxFileBytes", DEFAULT_CONFIG["maxFileBytes"]))
    min_score = int(config.get("minCandidateScore", DEFAULT_CONFIG["minCandidateScore"]))
    forced_patterns = [str(item) for item in config.get("forceSpecs", [])]
    candidates: list[dict[str, Any]] = []
    for rel in candidate_file_paths(root, state_dir, config):
        candidate_path = root / rel
        if candidate_path.is_symlink():
            continue
        loaded = read_candidate(candidate_path, max_bytes)
        if not loaded:
            continue
        text, data = loaded
        forced = matches_any(rel, forced_patterns)
        score, role_hint, signals = discovery_signals(rel, text, forced)
        known = entries.get(rel) if isinstance(entries.get(rel), dict) else None
        current_hash = sha256_bytes(data)
        changed = bool(known and entry_baseline_hash(known) != current_hash)
        if all_unclassified:
            if known:
                continue
            if not forced and any(signal in {"fixture-like-path", "skill-resource-path"} for signal in signals):
                continue
        elif not include_all:
            if known and not changed:
                continue
            if not forced and score < min_score and role_hint != "meta-index":
                continue
        candidates.append(
            {
                "path": rel,
                "title": document_title(text, rel),
                "score": score,
                "roleHint": role_hint,
                "signals": signals,
                "currentHash": current_hash,
                "knownClassification": known.get("classification") if known else None,
                "changedSinceClassification": changed if known else None,
            }
        )
    return sorted(
        candidates,
        key=lambda item: (
            0 if item["knownClassification"] is None else 1,
            0 if item["roleHint"] == "spec-candidate" else 1 if item["roleHint"] == "meta-index" else 2,
            -int(item["score"]),
            item["path"],
        ),
    )


def markdown_destination(token: str) -> str:
    token = token.strip()
    if token.startswith("<"):
        end = token.find(">", 1)
        return token[1:end] if end >= 0 else token
    chars: list[str] = []
    escaped = False
    for char in token:
        if escaped:
            chars.append(char)
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char.isspace():
            break
        chars.append(char)
    if escaped:
        chars.append("\\")
    return "".join(chars)


def clean_reference_token(token: str) -> str | None:
    token = markdown_destination(token).strip().strip("<>\"'")
    token = token.split("#", 1)[0].split("?", 1)[0].strip()
    if not token or token.startswith(("http://", "https://", "mailto:", "data:", "#", "~")):
        return None
    if " " in token and not token.startswith("./") and not token.startswith("../"):
        return None
    return token


def strong_unresolved_path_hint(token: str) -> bool:
    if not token or token.startswith(("/", "~", "$", "...")):
        return False
    if "://" in token or "::" in token or any(char in token for char in "*?<>|"):
        return False
    if token.endswith("/"):
        return False
    suffix = Path(token).suffix.lower()
    if not suffix or len(suffix) > 12:
        return False
    first = token.lstrip("./").split("/", 1)[0].lower()
    return first in {
        "src", "test", "tests", "docs", "doc", "spec", "specs", "external",
        "desktop", "acp", "lib", "packages", "package", ".pi", "schemas",
    } or token.startswith(("./", "../"))


def reference_roots(root: Path, source_rel: str) -> list[Path]:
    root_resolved = root.resolve()
    source_parent = (root / source_rel).parent.resolve(strict=False)
    result: list[Path] = [source_parent]
    current = source_parent
    markers = ("package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Package.swift")
    while True:
        if current != source_parent and any((current / marker).is_file() for marker in markers):
            result.append(current)
        if current == root_resolved or current.parent == current:
            break
        current = current.parent
    result.append(root_resolved)
    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in result:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            deduped.append(candidate)
    return deduped


def expand_reference_token(token: str) -> list[str]:
    cleaned = clean_reference_token(token)
    if not cleaned:
        return []
    match = re.search(r"\{([^{}]+)\}", cleaned)
    if not match:
        return [cleaned]
    choices = [part.strip() for part in match.group(1).split(",") if part.strip()]
    if not choices:
        return [cleaned]
    return [cleaned[: match.start()] + choice + cleaned[match.end() :] for choice in choices]


def explicit_reference_bases(root: Path, text: str) -> list[Path]:
    bases: list[Path] = []
    for raw in RELATIVE_BASE_RE.findall(text[:20000]):
        cleaned = clean_reference_token(raw)
        if not cleaned:
            continue
        candidate = root / cleaned
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(root.resolve())
        except (OSError, ValueError):
            continue
        if resolved.is_dir():
            bases.append(resolved)
    return bases


def resolve_reference(root: Path, source_rel: str, token: str, extra_bases: Iterable[Path] = ()) -> str | None:
    cleaned = clean_reference_token(token)
    if not cleaned or cleaned.startswith("..."):
        return None
    raw = Path(cleaned)
    candidates = [raw] if raw.is_absolute() else [base / raw for base in [*extra_bases, *reference_roots(root, source_rel)]]
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
            rel = resolved.relative_to(root.resolve()).as_posix()
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            return rel
    return None


def explicit_relations(root: Path, source_rel: str, text: str) -> dict[str, Any]:
    tokens: list[str] = []
    tokens.extend(MARKDOWN_LINK_RE.findall(text))
    tokens.extend(BACKTICK_RE.findall(text))
    tokens.extend(PLAIN_PATH_RE.findall(text))
    resolved: list[str] = []
    unresolved: list[str] = []
    extra_bases = explicit_reference_bases(root, text)
    for token in tokens:
        expanded = expand_reference_token(token)
        if not expanded:
            continue
        token_resolved = False
        for candidate_token in expanded:
            path = resolve_reference(root, source_rel, candidate_token, extra_bases)
            if path and path != source_rel:
                resolved.append(path)
                token_resolved = True
        cleaned = clean_reference_token(token)
        if not token_resolved and cleaned and strong_unresolved_path_hint(cleaned) and len(cleaned) <= 300:
            unresolved.append(cleaned)
    code: list[dict[str, str]] = []
    specs: list[dict[str, str]] = []
    for path in sorted(set(resolved)):
        target = specs if Path(path).suffix.lower() in DOC_EXTENSIONS else code
        item = {"path": path, "source": "explicit"}
        if target is specs:
            item["kind"] = "related"
        target.append(item)
    resolved_set = set(resolved)
    unresolved = [
        token for token in unresolved
        if not any(path.endswith("/" + token.lstrip("./")) or path == token.lstrip("./") for path in resolved_set)
    ]
    return {"code": code, "specs": specs, "unresolved": sorted(set(unresolved))[:50]}


def inferred_relations(root: Path, values: Iterable[str], kind: str) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for value in values:
        rel = normalize_rel_path(root, value)
        if not (root / rel).is_file():
            raise ValueError(f"inferred {kind} relationship does not exist: {rel}")
        result.append({"path": rel, "source": "inferred"})
    return sorted({item["path"]: item for item in result}.values(), key=lambda item: item["path"])


def inferred_spec_relations(root: Path, values: Iterable[str], relation_kind: str) -> list[dict[str, str]]:
    result = inferred_relations(root, values, "specs")
    return [{**item, "kind": relation_kind} for item in result]


def merge_relations(explicit: list[dict[str, str]], inferred: list[dict[str, str]]) -> list[dict[str, str]]:
    merged = {(item["path"], item.get("kind", "")): item for item in inferred}
    for item in explicit:
        merged[(item["path"], item.get("kind", ""))] = item
    return [merged[key] for key in sorted(merged)]


def relations_hash(relations: object) -> str:
    value = relations if isinstance(relations, dict) else {}
    code = sorted(
        item["path"]
        for item in value.get("code", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    )
    specs = sorted(
        (item["path"], str(item.get("kind", "related")))
        for item in value.get("specs", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    )
    payload = json.dumps({"code": code, "specs": specs}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_bytes(payload.encode("utf-8"))


def current_entry_status(root: Path, entry: dict[str, Any]) -> dict[str, Any]:
    classification = entry.get("classification")
    if classification not in SPEC_CLASSIFICATIONS:
        return {"status": "classified", "reasons": []}
    rel = entry.get("path")
    if not isinstance(rel, str):
        return {"status": "unverified", "reasons": ["invalid source path"]}
    try:
        source_path = safe_project_path(root, rel)
    except ValueError as exc:
        return {"status": "unverified", "reasons": [str(exc)]}
    if not source_path.is_file():
        return {"status": "missing-source", "reasons": [rel]}
    current_source_hash = file_hash(source_path)
    indexed = entry.get("indexed")
    indexed_hash = indexed.get("sourceHash") if isinstance(indexed, dict) else None
    indexed_changed = not isinstance(indexed_hash, str) or current_source_hash != indexed_hash
    verified = entry.get("verified")
    if not isinstance(verified, dict) or not isinstance(verified.get("sourceHash"), str):
        if indexed_changed:
            return {"status": "spec-changed", "reasons": [f"source:{rel}"]}
        return {"status": "unverified", "reasons": ["semantic verification required"]}
    source_changed = current_source_hash != verified.get("sourceHash")

    relations = entry.get("relations") if isinstance(entry.get("relations"), dict) else {}
    expected_relations_hash = verified.get("relationsHash")
    relation_map_changed = (
        not isinstance(expected_relations_hash, str)
        or not SHA256_RE.fullmatch(expected_relations_hash)
        or expected_relations_hash != relations_hash(relations)
    )
    code_relations = relations.get("code") if isinstance(relations.get("code"), list) else []
    expected_hashes = verified.get("codeHashes") if isinstance(verified.get("codeHashes"), dict) else {}
    changed_inputs: list[str] = []
    for relation in code_relations:
        if not isinstance(relation, dict) or not isinstance(relation.get("path"), str):
            continue
        code_rel = relation["path"]
        expected_hash = expected_hashes.get(code_rel)
        if not isinstance(expected_hash, str) or not SHA256_RE.fullmatch(expected_hash):
            changed_inputs.append(code_rel)
            continue
        try:
            code_path = safe_project_path(root, code_rel)
        except ValueError:
            changed_inputs.append(code_rel)
            continue
        current_hash = file_hash(code_path)
        if expected_hash != current_hash:
            changed_inputs.append(code_rel)

    if relation_map_changed:
        changed_inputs.append("[relation-map]")

    if source_changed and changed_inputs:
        status = "spec+inputs-changed"
    elif source_changed:
        status = "spec-changed"
    elif changed_inputs:
        status = "inputs-changed"
    else:
        status = "fresh"
    reasons = ([f"source:{rel}"] if source_changed else []) + [
        "relations:changed" if path == "[relation-map]" else f"input:{path}"
        for path in changed_inputs
    ]
    return {"status": status, "reasons": reasons}


def record_entry(args: argparse.Namespace, root: Path, state_dir: Path, state: dict[str, Any]) -> int:
    rel = normalize_rel_path(root, args.path)
    source_path = safe_project_path(root, rel)
    if not source_path.is_file():
        raise ValueError(f"source document does not exist: {rel}")
    classification = args.classification
    if classification in SPEC_CLASSIFICATIONS and not (args.summary and args.summary.strip()):
        raise ValueError("--summary is required for spec/spec-like classifications")
    source_bytes = source_path.read_bytes()
    text = source_bytes.decode("utf-8", errors="replace")
    source_hash = sha256_bytes(source_bytes)

    entries = state.setdefault("entries", {})
    previous = entries.get(rel) if isinstance(entries.get(rel), dict) else {}
    if classification in SPEC_CLASSIFICATIONS:
        if args.type is None and previous.get("type") is None:
            raise ValueError("--type is required when first recording a primary spec")
        if args.lifecycle is None and previous.get("lifecycle") is None:
            raise ValueError("--lifecycle is required when first recording a primary spec")
    explicit = explicit_relations(root, rel, text)

    previous_relations = previous.get("relations") if isinstance(previous.get("relations"), dict) else {}
    previous_code = previous_relations.get("code") if isinstance(previous_relations.get("code"), list) else []
    previous_specs = previous_relations.get("specs") if isinstance(previous_relations.get("specs"), list) else []
    old_inferred_code = [item for item in previous_code if isinstance(item, dict) and item.get("source") == "inferred"]
    old_inferred_specs = [item for item in previous_specs if isinstance(item, dict) and item.get("source") == "inferred"]
    if args.clear_code and args.code is not None:
        raise ValueError("--clear-code cannot be combined with --code")
    if args.clear_related_specs and args.related_spec is not None:
        raise ValueError("--clear-related-specs cannot be combined with --related-spec")
    if args.clear_related_specs and (args.supersedes is not None or args.superseded_by is not None):
        raise ValueError("--clear-related-specs cannot be combined with --supersedes/--superseded-by")
    inferred_code = (
        []
        if args.clear_code
        else inferred_relations(root, args.code, "code")
        if args.code is not None
        else old_inferred_code
    )
    if args.clear_related_specs:
        inferred_specs = []
    elif args.related_spec is not None or args.supersedes is not None or args.superseded_by is not None:
        retained = [
            item for item in old_inferred_specs
            if item.get("kind") not in {
                "related" if args.related_spec is not None else "",
                "supersedes" if args.supersedes is not None else "",
                "superseded-by" if args.superseded_by is not None else "",
            }
        ]
        inferred_specs = [
            *retained,
            *inferred_spec_relations(root, args.related_spec or [], "related"),
            *inferred_spec_relations(root, args.supersedes or [], "supersedes"),
            *inferred_spec_relations(root, args.superseded_by or [], "superseded-by"),
        ]
    else:
        inferred_specs = old_inferred_specs
    relations = {
        "code": merge_relations(explicit["code"], inferred_code),
        "specs": merge_relations(explicit["specs"], inferred_specs),
    }
    if classification not in SPEC_CLASSIFICATIONS:
        relations = {"code": [], "specs": []}

    topics = sorted(set(args.topic if args.topic is not None else previous.get("topics", [])))
    if classification not in SPEC_CLASSIFICATIONS:
        topics = sorted(set(args.topic or []))
    lifecycle = (
        args.lifecycle or previous.get("lifecycle", "unknown")
        if classification in SPEC_CLASSIFICATIONS
        else "unknown"
    )
    entry = {
        "path": rel,
        "title": document_title(text, rel),
        "classification": classification,
        "type": (args.type or previous.get("type", "unknown")) if classification in SPEC_CLASSIFICATIONS else "unknown",
        "lifecycle": lifecycle,
        "confidence": args.confidence or previous.get("confidence", "unknown"),
        "summary": (args.summary.strip() if args.summary is not None else previous.get("summary", "")),
        "topics": topics,
        "relations": relations,
        "unresolvedReferences": explicit.get("unresolved", []) if classification in SPEC_CLASSIFICATIONS else [],
        "indexed": {
            "at": utc_now(),
            "sourceHash": source_hash,
        },
    }
    if classification in SPEC_CLASSIFICATIONS and isinstance(previous.get("verified"), dict):
        entry["verified"] = previous["verified"]
    if classification not in SPEC_CLASSIFICATIONS:
        entry["summary"] = args.summary.strip() if args.summary else ""
    entries[rel] = entry
    save_state(state_dir, state)
    print(f"recorded {classification}: {rel}")
    return 0


def verify_entry(path_value: str, root: Path, state_dir: Path, state: dict[str, Any]) -> int:
    rel = normalize_rel_path(root, path_value)
    entries = state.get("entries")
    if not isinstance(entries, dict) or not isinstance(entries.get(rel), dict):
        raise ValueError(f"state entry does not exist: {rel}")
    entry = entries[rel]
    if entry.get("classification") not in SPEC_CLASSIFICATIONS:
        raise ValueError(f"only primary specs can be semantically verified: {rel}")
    source_path = safe_project_path(root, rel)
    if not source_path.is_file():
        raise ValueError(f"source document does not exist: {rel}")
    source_hash = file_hash(source_path)
    if source_hash is None:
        raise ValueError(f"failed to hash source document: {rel}")
    relations = entry.get("relations") if isinstance(entry.get("relations"), dict) else {}
    code_relations = relations.get("code") if isinstance(relations.get("code"), list) else []
    code_hashes: dict[str, str] = {}
    for item in code_relations:
        if not isinstance(item, dict) or not isinstance(item.get("path"), str):
            continue
        relation_hash = file_hash(safe_project_path(root, item["path"]))
        if relation_hash is None:
            raise ValueError(f"tracked input is missing or unreadable: {item['path']}")
        code_hashes[item["path"]] = relation_hash
    entry["indexed"] = {"at": utc_now(), "sourceHash": source_hash}
    entry["verified"] = {
        "at": utc_now(),
        "sourceHash": source_hash,
        "codeHashes": code_hashes,
        "relationsHash": relations_hash(relations),
    }
    entries[rel] = entry
    save_state(state_dir, state)
    unresolved = entry.get("unresolvedReferences") if isinstance(entry.get("unresolvedReferences"), list) else []
    suffix = f" ({len(unresolved)} unresolved path hints remain)" if unresolved else ""
    print(f"verified: {rel}{suffix}")
    return 0


def relate_entry(args: argparse.Namespace, root: Path, state_dir: Path, state: dict[str, Any]) -> int:
    rel = normalize_rel_path(root, args.path)
    entries = state.get("entries")
    if not isinstance(entries, dict) or not isinstance(entries.get(rel), dict):
        raise ValueError(f"state entry does not exist: {rel}")
    entry = entries[rel]
    if entry.get("classification") not in SPEC_CLASSIFICATIONS:
        raise ValueError(f"only primary specs can have tracked relations: {rel}")

    relations = entry.get("relations") if isinstance(entry.get("relations"), dict) else {}
    before = relations_hash(relations)
    source_path = safe_project_path(root, rel)
    if not source_path.is_file():
        raise ValueError(f"source document does not exist: {rel}")
    explicit = explicit_relations(root, rel, source_path.read_text(encoding="utf-8", errors="replace"))
    code = [
        item for item in relations.get("code", [])
        if isinstance(item, dict) and item.get("source") == "inferred"
    ]
    specs = [
        item for item in relations.get("specs", [])
        if isinstance(item, dict) and item.get("source") == "inferred"
    ]

    for value in args.add_code or []:
        for item in inferred_relations(root, [value], "code"):
            if not any(existing.get("path") == item["path"] for existing in code):
                code.append(item)
    for value in args.remove_code or []:
        target = normalize_rel_path(root, value)
        code = [
            item for item in code
            if not (item.get("path") == target and item.get("source") == "inferred")
        ]

    spec_ops = [
        (args.add_related_spec or [], "related", True),
        (args.add_supersedes or [], "supersedes", True),
        (args.add_superseded_by or [], "superseded-by", True),
        (args.remove_related_spec or [], "related", False),
        (args.remove_supersedes or [], "supersedes", False),
        (args.remove_superseded_by or [], "superseded-by", False),
    ]
    for values, kind, adding in spec_ops:
        for value in values:
            target = normalize_rel_path(root, value)
            if adding:
                item = inferred_spec_relations(root, [value], kind)[0]
                if not any(existing.get("path") == target and existing.get("kind", "related") == kind for existing in specs):
                    specs.append(item)
            else:
                specs = [
                    item for item in specs
                    if not (
                        item.get("path") == target
                        and item.get("kind", "related") == kind
                        and item.get("source") == "inferred"
                    )
                ]

    code = sorted(code, key=lambda item: (str(item.get("path", "")), str(item.get("source", ""))))
    specs = sorted(specs, key=lambda item: (str(item.get("path", "")), str(item.get("kind", "related")), str(item.get("source", ""))))
    updated = {
        "code": merge_relations(explicit["code"], code),
        "specs": merge_relations(explicit["specs"], specs),
    }
    after = relations_hash(updated)
    if before == after:
        print(f"unchanged relations: {rel}")
        return 0
    entry["relations"] = updated
    entry["unresolvedReferences"] = explicit.get("unresolved", [])
    entries[rel] = entry
    save_state(state_dir, state)
    print(f"updated relations: {rel} — {current_entry_status(root, entry)['status']}")
    return 0


def markdown_inline_list(values: list[str], maximum: int = 8) -> str:
    shown = values[:maximum]
    rendered = ", ".join(f"`{value}`" for value in shown)
    if len(values) > maximum:
        rendered += f", +{len(values) - maximum} more"
    return rendered


def compact_text(value: object, maximum: int = 180) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= maximum:
        return text
    return text[: maximum - 1].rstrip() + "…"


def lifecycle_rank(value: object) -> int:
    return {
        "active": 0,
        "proposed": 1,
        "unknown": 2,
        "historical": 3,
        "superseded": 4,
    }.get(str(value), 5)


SEARCH_STOPWORDS = {
    "a", "an", "and", "are", "do", "does", "for", "how", "in", "is", "of", "on", "or", "the", "to", "what", "where", "why",
    "а", "в", "где", "и", "как", "ли", "на", "почему", "что",
}

RELATION_GENERIC_TERMS = {
    "agent",
    "app",
    "config",
    "index",
    "model",
    "prompt",
    "result",
    "session",
    "spec",
    "state",
    "test",
    "tool",
}


def normalize_search_text(value: object) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or "")).casefold()).strip()


def search_terms(value: object) -> set[str]:
    normalized = normalize_search_text(value)
    result: set[str] = set()
    for token in re.findall(r"[\w][\w.+@:/-]*", normalized, flags=re.UNICODE):
        if len(token) > 1 and token not in SEARCH_STOPWORDS:
            result.add(token)
        # Keep the compound for exact/prefix matching, but also expose path and
        # identifier components so `session cancellation` can match
        # `session-cancellation` and `model usage` can match `model-usage.ts`.
        for part in re.split(r"[/_-]+", token):
            if len(part) > 1 and part not in SEARCH_STOPWORDS:
                result.add(part)
    return result


def search_term_matches(query_term: str, field_term: str) -> bool:
    if query_term == field_term:
        return True
    if len(query_term) < 4 or len(field_term) < 4:
        return False
    return field_term.startswith(query_term) or query_term.startswith(field_term)


def relation_paths(entry: dict[str, Any], kind: str, spec_kinds: set[str] | None = None) -> list[str]:
    relations = entry.get("relations") if isinstance(entry.get("relations"), dict) else {}
    values = relations.get(kind) if isinstance(relations.get(kind), list) else []
    return [
        str(item["path"])
        for item in values
        if isinstance(item, dict)
        and isinstance(item.get("path"), str)
        and (spec_kinds is None or str(item.get("kind", "related")) in spec_kinds)
    ]


def relation_search_terms(paths: Iterable[str]) -> set[str]:
    result: set[str] = set()
    for value in paths:
        name = Path(value).name
        if not name:
            continue
        result.update(search_terms(name))
        stem = Path(name).stem
        if len(stem) > 1:
            result.add(normalize_search_text(stem))
    return result


def score_search_query(entry: dict[str, Any], query: str) -> tuple[float, list[str], bool, float, float]:
    normalized_query = normalize_search_text(query)
    if not normalized_query:
        return 0.0, [], False, 0.0, 0.0
    query_terms = search_terms(normalized_query)
    title = str(entry.get("title", ""))
    path = str(entry.get("path", ""))
    summary = str(entry.get("summary", ""))
    topics = [str(item) for item in entry.get("topics", []) if str(item).strip()]
    code_relations = relation_paths(entry, "code")
    spec_relations = relation_paths(entry, "specs", {"related"})
    supersedes = relation_paths(entry, "specs", {"supersedes"})
    superseded_by = relation_paths(entry, "specs", {"superseded-by"})
    supersession = supersedes + superseded_by

    fields = {
        "title": normalize_search_text(title),
        "topics": normalize_search_text(" ".join(topics)),
        "path": normalize_search_text(path),
        "summary": normalize_search_text(summary),
        "relations.code": normalize_search_text(" ".join(code_relations)),
        "relations.specs": normalize_search_text(" ".join(spec_relations)),
        "relations.supersession": normalize_search_text(" ".join(supersession)),
    }
    term_fields = {
        "title": search_terms(fields["title"]),
        "topics": search_terms(fields["topics"]),
        "path": search_terms(fields["path"]),
        "summary": search_terms(fields["summary"]),
        # Relations are routing hints. Score only their concrete leaf names,
        # not generic directory segments such as `src`, `session`, or `dcp`.
        # Exact full relation paths are handled separately above.
        "relations.code": relation_search_terms(code_relations),
        "relations.specs": relation_search_terms(spec_relations),
        "relations.supersession": relation_search_terms(supersession),
    }
    weights = {
        "title": 8.0,
        "topics": 6.0,
        "relations.code": 6.0,
        "relations.specs": 5.0,
        "relations.supersession": 5.0,
        "path": 4.0,
        "summary": 2.0,
    }
    score = 0.0
    matches: list[str] = []
    exact_path_match = False
    matched_query_terms: set[str] = set()
    semantic_matched_terms: set[str] = set()

    if normalized_query == fields["path"]:
        score += 50.0
        matches.append("exact:spec-path")
        exact_path_match = True
        matched_query_terms.update(query_terms)
        semantic_matched_terms.update(query_terms)
    for relation_kind, paths, exact_weight in (
        ("relations.code", code_relations, 40.0),
        ("relations.specs", spec_relations, 36.0),
        ("relations.supersession", supersession, 34.0),
    ):
        if any(normalized_query == normalize_search_text(value) for value in paths):
            score += exact_weight
            matches.append(f"exact:{relation_kind}")
            exact_path_match = True
            matched_query_terms.update(query_terms)

    phrase_weights = {
        "title": 12.0,
        "topics": 10.0,
        "relations.code": 18.0,
        "relations.specs": 14.0,
        "relations.supersession": 14.0,
        "path": 12.0,
        "summary": 4.0,
    }
    if len(normalized_query) >= 4:
        for name, value in fields.items():
            if normalized_query and normalized_query in value:
                score += phrase_weights[name]
                matches.append(f"phrase:{name}")
                matched_query_terms.update(query_terms)
                if not name.startswith("relations."):
                    semantic_matched_terms.update(query_terms)

    for query_term in query_terms:
        for name, field_terms in term_fields.items():
            if name.startswith("relations.") and query_term in RELATION_GENERIC_TERMS:
                continue
            if any(search_term_matches(query_term, field_term) for field_term in field_terms):
                score += weights[name]
                matches.append(f"term:{query_term}:{name}")
                matched_query_terms.add(query_term)
                if not name.startswith("relations."):
                    semantic_matched_terms.add(query_term)

    coverage = len(matched_query_terms) / len(query_terms) if query_terms else (1.0 if exact_path_match else 0.0)
    semantic_coverage = len(semantic_matched_terms) / len(query_terms) if query_terms else 0.0
    # Prefer entries that explain the whole intent in title/topics/path/summary,
    # not entries that accumulate a large score from one repeated domain word.
    # Relation matches still provide strong exact component/path routing above.
    score += semantic_coverage * 12.0
    if semantic_coverage >= 0.999 and len(query_terms) >= 2:
        score += 8.0
    return score, sorted(set(matches)), exact_path_match, round(coverage, 3), round(semantic_coverage, 3)


def search_entries(root: Path, state: dict[str, Any], queries: list[str], limit: int, include_secondary: bool) -> list[dict[str, Any]]:
    normalized_queries: list[str] = []
    for query in queries:
        normalized = normalize_search_text(query)
        if normalized and normalized not in normalized_queries:
            normalized_queries.append(normalized)
    if not normalized_queries:
        raise ValueError("search query must not be empty")
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    results: list[dict[str, Any]] = []
    for entry in entries.values():
        if not isinstance(entry, dict):
            continue
        classification = entry.get("classification")
        if classification not in SPEC_CLASSIFICATIONS and not (include_secondary and classification == "design-only"):
            continue
        query_matches: list[dict[str, Any]] = []
        for query in normalized_queries:
            query_score, matches, exact_path_match, coverage, semantic_coverage = score_search_query(entry, query)
            if query_score > 0:
                query_matches.append(
                    {
                        "query": query,
                        "score": round(query_score, 2),
                        "matches": matches,
                        "exactPath": exact_path_match,
                        "coverage": coverage,
                        "semanticCoverage": semantic_coverage,
                    }
                )
        if not query_matches:
            continue
        query_matches.sort(key=lambda item: -float(item["score"]))
        best_query_score = float(query_matches[0]["score"])
        supporting_score = min(10.0, sum(float(item["score"]) for item in query_matches[1:]) * 0.15)
        score = best_query_score + supporting_score
        lifecycle = entry.get("lifecycle", "unknown")
        score += {"active": 3.0, "proposed": 1.5, "unknown": 0.0, "historical": -1.0, "superseded": -3.0}.get(str(lifecycle), 0.0)
        if classification == "design-only":
            score -= 2.0
        status = current_entry_status(root, entry) if classification in SPEC_CLASSIFICATIONS else {"status": "secondary", "reasons": []}
        title = str(entry.get("title", ""))
        path = str(entry.get("path", ""))
        summary = str(entry.get("summary", ""))
        topics = [str(item) for item in entry.get("topics", []) if str(item).strip()]
        results.append(
            {
                "path": path,
                "title": title,
                "classification": classification,
                "type": entry.get("type", "unknown"),
                "lifecycle": lifecycle,
                "status": status["status"],
                "score": round(score, 2),
                "topics": topics,
                "summary": summary,
                "queryMatches": query_matches,
            }
        )
    results.sort(key=lambda item: (-float(item["score"]), lifecycle_rank(item["lifecycle"]), str(item["title"]).lower(), str(item["path"])))
    return results[: max(1, limit)]


def search_quality(results: list[dict[str, Any]]) -> dict[str, Any]:
    if not results:
        return {
            "confidence": "none",
            "catalogFallbackRecommended": True,
            "semanticRerankRecommended": False,
            "reason": "no lexical/relation match",
        }
    top = float(results[0]["score"])
    second = float(results[1]["score"]) if len(results) > 1 else None
    margin = top - second if second is not None else top
    exact = any(bool(item.get("exactPath")) for item in results[0].get("queryMatches", []))
    top_coverage = max((float(item.get("coverage", 0.0)) for item in results[0].get("queryMatches", [])), default=0.0)
    top_semantic_coverage = max((float(item.get("semanticCoverage", 0.0)) for item in results[0].get("queryMatches", [])), default=0.0)
    if exact or (top >= 20.0 and top_semantic_coverage >= 0.66):
        confidence = "high"
    elif top >= 12.0 and top_semantic_coverage >= 0.4:
        confidence = "medium"
    else:
        confidence = "low"
    return {
        "confidence": confidence,
        "catalogFallbackRecommended": confidence == "low",
        # Candidate generation is intentionally lexical/relation based. When
        # more than one candidate survives, the current LLM should always do
        # the cheap semantic choice from compact metadata instead of trusting
        # the numeric rank as semantic truth.
        "semanticRerankRecommended": len(results) > 1,
        "topScore": round(top, 2),
        "topMargin": round(margin, 2),
        "topCoverage": round(top_coverage, 3),
        "topSemanticCoverage": round(top_semantic_coverage, 3),
        "reason": "exact relation/path match" if exact else "weighted metadata/relation match",
    }


def render_index(root: Path, state_dir: Path, state: dict[str, Any]) -> str:
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    specs = [entry for entry in entries.values() if isinstance(entry, dict) and entry.get("classification") in SPEC_CLASSIFICATIONS]
    specs.sort(key=lambda item: (lifecycle_rank(item.get("lifecycle")), str(item.get("title", "")).lower(), str(item.get("path", ""))))
    statuses = {entry["path"]: current_entry_status(root, entry) for entry in specs if isinstance(entry.get("path"), str)}

    lines = [
        "# Spec Wiki",
        "",
        "> Generated routing index. Primary specs remain the source of truth.",
        "> Prefer `spec_wiki.py search <query>` for retrieval; `fresh` exists only after explicit semantic verification.",
        "",
    ]
    unverified_current = [
        entry for entry in specs
        if entry.get("lifecycle", "unknown") not in {"historical", "superseded"}
        and statuses.get(entry["path"], {}).get("status") == "unverified"
    ]
    if unverified_current:
        lines.extend(
            [
                f"> {len(unverified_current)} current/proposed primary spec(s) are indexed but not semantically verified yet.",
                "",
            ]
        )
    stale = [
        (entry, statuses.get(entry["path"], {"status": "unverified", "reasons": []}))
        for entry in specs
        if entry.get("lifecycle", "unknown") not in {"historical", "superseded"}
        and statuses.get(entry["path"], {}).get("status") not in {"fresh", "unverified"}
    ]
    if stale:
        lines.extend(["## Needs review", ""])
        for entry, status in stale:
            reason_text = "; ".join(status.get("reasons", [])[:4])
            suffix = f" — {reason_text}" if reason_text else ""
            lines.append(f"- `{entry['path']}` — **{status['status']}**{suffix}")
        lines.append("")

    lines.extend(["## Current / proposed primary specs", ""])
    if not specs:
        lines.extend(["_No primary specs have been semantically classified yet._", ""])
    for entry in [item for item in specs if item.get("lifecycle", "unknown") not in {"historical", "superseded"}]:
        status = statuses.get(entry["path"], {"status": "unverified"})
        topics = [str(item) for item in entry.get("topics", []) if str(item).strip()]
        topic_text = ",".join(topics[:6]) or "-"
        lines.append(
            f"- **{entry.get('title') or entry['path']}** — `{entry['path']}` · "
            f"{entry.get('type', 'unknown')}/{entry.get('lifecycle', 'unknown')} · "
            f"**{status.get('status', 'unverified')}** · {topic_text} — {compact_text(entry.get('summary', ''), 180)}"
        )
    archived = [item for item in specs if item.get("lifecycle", "unknown") in {"historical", "superseded"}]
    if archived:
        lines.extend(["", "## Historical / superseded primary specs", ""])
        for entry in archived:
            lines.append(
                f"- **{entry.get('title') or entry['path']}** — `{entry['path']}` · "
                f"{entry.get('type', 'unknown')}/{entry.get('lifecycle', 'unknown')} — "
                f"{compact_text(entry.get('summary', ''), 140)}"
            )
    secondary = [
        entry for entry in entries.values()
        if isinstance(entry, dict) and entry.get("classification") == "design-only"
    ]
    if secondary:
        secondary.sort(key=lambda item: (str(item.get("title", "")).lower(), str(item.get("path", ""))))
        lines.extend(["", "## Secondary design / decision references", ""])
        for entry in secondary:
            lines.append(f"- **{entry.get('title') or entry['path']}** — `{entry['path']}`")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def audit_payload(root: Path, state_dir: Path, config: dict[str, Any], state: dict[str, Any], candidate_limit: int) -> dict[str, Any]:
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    specs = [entry for entry in entries.values() if isinstance(entry, dict) and entry.get("classification") in SPEC_CLASSIFICATIONS]
    statuses = []
    for entry in sorted(specs, key=lambda item: str(item.get("path", ""))):
        status = current_entry_status(root, entry)
        statuses.append({"path": entry.get("path"), "lifecycle": entry.get("lifecycle", "unknown"), **status})
    candidates = discover_candidates(root, state_dir, config, state, include_all=False)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "primarySpecCount": len(specs),
        "currentPrimarySpecCount": sum(1 for entry in specs if entry.get("lifecycle", "unknown") not in {"historical", "superseded"}),
        "freshCount": sum(1 for item in statuses if item["status"] == "fresh"),
        "unverifiedCount": sum(1 for item in statuses if item["status"] == "unverified"),
        "needsReviewCount": sum(
            1 for item in statuses
            if item["lifecycle"] not in {"historical", "superseded"}
            and item["status"] not in {"fresh", "unverified"}
        ),
        "unresolvedReferenceCount": sum(
            len(entry.get("unresolvedReferences", []))
            for entry in specs if isinstance(entry.get("unresolvedReferences"), list)
        ),
        "statuses": statuses,
        "candidateCount": len(candidates),
        "candidates": candidates[:candidate_limit],
        "candidateListTruncated": len(candidates) > candidate_limit,
    }


def print_audit(payload: dict[str, Any]) -> None:
    print(
        f"primary specs: {payload['primarySpecCount']} ({payload['currentPrimarySpecCount']} current/proposed) | "
        f"fresh: {payload['freshCount']} | unverified: {payload['unverifiedCount']} | "
        f"needs review: {payload['needsReviewCount']} | unresolved refs: {payload['unresolvedReferenceCount']} | "
        f"new/changed candidates: {payload['candidateCount']}"
    )
    for item in payload["statuses"]:
        if item["status"] == "fresh" or item.get("lifecycle") in {"historical", "superseded"}:
            continue
        reasons = ", ".join(item.get("reasons", [])[:4])
        print(f"  {item['status']:24} {item['path']}{' — ' + reasons if reasons else ''}")
    if payload["candidates"]:
        print("candidates:")
        for item in payload["candidates"]:
            known = f" known={item['knownClassification']}" if item.get("knownClassification") else ""
            print(f"  score={item['score']:>3} {item['roleHint']:14} {item['path']}{known}")
        if payload["candidateListTruncated"]:
            print("  ... candidate list truncated")


def validate_state(root: Path, state: dict[str, Any]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if state.get("schemaVersion") != SCHEMA_VERSION:
        errors.append(f"schemaVersion must be {SCHEMA_VERSION}")
    entries = state.get("entries")
    if not isinstance(entries, dict):
        return errors + ["entries must be an object"], warnings
    for key, entry in entries.items():
        if not isinstance(entry, dict):
            errors.append(f"{key}: entry must be an object")
            continue
        path = entry.get("path")
        if path != key:
            errors.append(f"{key}: entry.path must equal state key")
        try:
            normalized = normalize_rel_path(root, str(path))
            if normalized != path:
                errors.append(f"{key}: path is not normalized")
        except ValueError as exc:
            errors.append(f"{key}: {exc}")
        classification = entry.get("classification")
        if classification not in CLASSIFICATIONS:
            errors.append(f"{key}: invalid classification {classification!r}")
        if classification in SPEC_CLASSIFICATIONS and not str(entry.get("summary", "")).strip():
            errors.append(f"{key}: primary spec requires non-empty summary")
        if entry.get("type", "unknown") not in SPEC_TYPES:
            errors.append(f"{key}: invalid type {entry.get('type')!r}")
        lifecycle = entry.get("lifecycle", "unknown")
        if lifecycle not in LIFECYCLES:
            errors.append(f"{key}: invalid lifecycle {lifecycle!r}")
        if entry.get("confidence", "unknown") not in CONFIDENCES:
            errors.append(f"{key}: invalid confidence {entry.get('confidence')!r}")
        indexed = entry.get("indexed")
        if not isinstance(indexed, dict):
            errors.append(f"{key}: indexed must be an object")
        else:
            indexed_hash = indexed.get("sourceHash")
            if not isinstance(indexed_hash, str) or not SHA256_RE.fullmatch(indexed_hash):
                errors.append(f"{key}: indexed.sourceHash must be a sha256 hash")
        unresolved = entry.get("unresolvedReferences", [])
        if not isinstance(unresolved, list) or any(not isinstance(item, str) for item in unresolved):
            errors.append(f"{key}: unresolvedReferences must be an array of strings")
        relations = entry.get("relations", {})
        if not isinstance(relations, dict):
            errors.append(f"{key}: relations must be an object")
        else:
            for kind in ("code", "specs"):
                values = relations.get(kind, [])
                if not isinstance(values, list):
                    errors.append(f"{key}: relations.{kind} must be an array")
                    continue
                for relation in values:
                    if not isinstance(relation, dict) or relation.get("source") not in {"explicit", "inferred"} or not isinstance(relation.get("path"), str):
                        errors.append(f"{key}: malformed relations.{kind} item")
                        continue
                    if kind == "specs" and relation.get("kind", "related") not in SPEC_RELATION_KINDS:
                        errors.append(f"{key}: invalid spec relation kind {relation.get('kind')!r}")
                    try:
                        normalized_relation = normalize_rel_path(root, relation["path"])
                        if normalized_relation != relation["path"]:
                            errors.append(f"{key}: relation path is not normalized: {relation['path']}")
                    except ValueError as exc:
                        errors.append(f"{key}: invalid relation {relation['path']}: {exc}")
        verified = entry.get("verified")
        if verified is not None:
            if not isinstance(verified, dict):
                errors.append(f"{key}: verified must be an object")
            else:
                source_hash = verified.get("sourceHash")
                if not isinstance(source_hash, str) or not SHA256_RE.fullmatch(source_hash):
                    errors.append(f"{key}: verified.sourceHash must be a sha256 hash")
                code_hashes = verified.get("codeHashes")
                if not isinstance(code_hashes, dict):
                    errors.append(f"{key}: verified.codeHashes must be an object")
                else:
                    for relation_path, value in code_hashes.items():
                        if not isinstance(relation_path, str) or not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                            errors.append(f"{key}: malformed verified.codeHashes entry")
                verified_relations_hash = verified.get("relationsHash")
                if verified_relations_hash is not None and (
                    not isinstance(verified_relations_hash, str)
                    or not SHA256_RE.fullmatch(verified_relations_hash)
                ):
                    errors.append(f"{key}: verified.relationsHash must be a sha256 hash when present")
        if classification in SPEC_CLASSIFICATIONS:
            status = current_entry_status(root, entry)
            if lifecycle not in {"historical", "superseded"} and status["status"] != "fresh":
                warnings.append(f"{key}: {status['status']}")
            code_values = relations.get("code", []) if isinstance(relations, dict) else []
            if entry.get("type") == "as-is" and lifecycle == "active" and not code_values:
                warnings.append(f"{key}: active as-is spec has no tracked implementation inputs")
            if unresolved:
                warnings.append(f"{key}: {len(unresolved)} unresolved path reference(s)")
            if lifecycle == "superseded":
                spec_values = relations.get("specs", []) if isinstance(relations, dict) else []
                if not any(isinstance(item, dict) and item.get("kind") == "superseded-by" for item in spec_values):
                    warnings.append(f"{key}: superseded lifecycle has no superseded-by relation")
    return errors, warnings


def path_overlaps(changed: str, tracked: str) -> bool:
    changed = changed.rstrip("/")
    tracked = tracked.rstrip("/")
    return changed == tracked or tracked.startswith(changed + "/") or changed.startswith(tracked + "/")


def affected_specs(root: Path, state: dict[str, Any], changed_values: list[str]) -> list[dict[str, Any]]:
    changed = [normalize_rel_path(root, value) for value in changed_values]
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    result: list[dict[str, Any]] = []
    for entry in entries.values():
        if not isinstance(entry, dict) or entry.get("classification") not in SPEC_CLASSIFICATIONS:
            continue
        if entry.get("lifecycle", "unknown") in {"historical", "superseded"}:
            continue
        tracked = [str(entry.get("path", ""))]
        relations = entry.get("relations") if isinstance(entry.get("relations"), dict) else {}
        tracked.extend(
            item["path"]
            for item in relations.get("code", [])
            if isinstance(item, dict) and isinstance(item.get("path"), str)
        )
        matches = sorted({path for path in changed if any(path_overlaps(path, candidate) for candidate in tracked)})
        if matches:
            result.append({"path": entry.get("path"), "matchedChanges": matches, **current_entry_status(root, entry)})
    return sorted(result, key=lambda item: str(item.get("path", "")))


def changed_document_candidate(
    root: Path,
    state_dir: Path,
    config: dict[str, Any],
    state: dict[str, Any],
    rel: str,
) -> dict[str, Any] | None:
    try:
        rel = normalize_rel_path(root, rel)
    except ValueError:
        return None
    if is_under_ignored_dir(rel, state_dir, root):
        return None
    ignored = [str(item) for item in config.get("ignoreSpecs", [])]
    excludes = [str(item) for item in config.get("exclude", [])]
    forced_patterns = [str(item) for item in config.get("forceSpecs", [])]
    if matches_any(rel, ignored) or matches_any(rel, excludes):
        return None
    forced = matches_any(rel, forced_patterns)
    extensions = {
        str(item).lower() if str(item).startswith(".") else f".{str(item).lower()}"
        for item in config.get("includeExtensions", [])
    }
    if not forced and extensions and Path(rel).suffix.lower() not in extensions:
        return None
    path = root / rel
    if not path.is_file() or path.is_symlink():
        return None
    loaded = read_candidate(path, int(config.get("maxFileBytes", DEFAULT_CONFIG["maxFileBytes"])))
    if not loaded:
        return None
    text, data = loaded
    score, role_hint, signals = discovery_signals(rel, text, forced)
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    known = entries.get(rel) if isinstance(entries.get(rel), dict) else None
    return {
        "path": rel,
        "title": document_title(text, rel),
        "score": score,
        "roleHint": role_hint,
        "signals": signals,
        "currentHash": sha256_bytes(data),
        "knownClassification": known.get("classification") if known else None,
        "knownLifecycle": known.get("lifecycle") if known else None,
        "requiresClassification": known is None,
        "requiresReclassification": bool(
            known and known.get("classification") not in SPEC_CLASSIFICATIONS
        ),
        "changedKnownPrimary": bool(known and known.get("classification") in SPEC_CLASSIFICATIONS),
    }


def impact_payload(
    root: Path,
    state_dir: Path,
    config: dict[str, Any],
    state: dict[str, Any],
    explicit_paths: list[str] | None,
    base: str,
) -> dict[str, Any]:
    if explicit_paths:
        records = [{"status": "explicit", "path": normalize_rel_path(root, value)} for value in explicit_paths]
        source = "explicit"
    else:
        records = filter_internal_change_records(git_changed_records(root, base), state_dir, root)
        source = f"git:{base}"
    changed_paths = changed_record_paths(records)
    known_affected = affected_specs(root, state, changed_paths) if changed_paths else []

    coverage: dict[str, list[str]] = {path: [] for path in changed_paths}
    for item in known_affected:
        spec_path = item.get("path")
        if not isinstance(spec_path, str):
            continue
        for path in item.get("matchedChanges", []):
            if isinstance(path, str) and path in coverage:
                coverage[path].append(spec_path)
    coverage_rows = [
        {"path": path, "knownSpecs": sorted(set(coverage.get(path, [])))}
        for path in changed_paths
    ]

    changed_documents: list[dict[str, Any]] = []
    document_paths: set[str] = set()
    for record in records:
        path = record.get("path")
        if not isinstance(path, str):
            continue
        candidate = changed_document_candidate(root, state_dir, config, state, path)
        if candidate:
            candidate["changeStatus"] = record.get("status")
            changed_documents.append(candidate)
            document_paths.add(candidate["path"])

    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    missing_tracked_specs: list[str] = []
    for path in changed_paths:
        entry = entries.get(path) if isinstance(entries.get(path), dict) else None
        if entry and entry.get("classification") in SPEC_CLASSIFICATIONS and not (root / path).is_file():
            missing_tracked_specs.append(path)

    uncovered_paths = [
        path for path in changed_paths
        if not coverage.get(path)
        and path not in document_paths
        and not is_under_ignored_dir(path, state_dir, root)
    ]
    changed_docs_requiring_classification = [
        item["path"]
        for item in changed_documents
        if item.get("requiresClassification") or item.get("requiresReclassification")
    ]

    reasons: list[str] = []
    if known_affected:
        reasons.append("known-relationships-affected")
    if uncovered_paths:
        reasons.append("changed-paths-without-known-spec-relations")
    if changed_docs_requiring_classification:
        reasons.append("changed-or-new-documents-require-classification")
    if missing_tracked_specs:
        reasons.append("tracked-primary-source-missing-or-moved")
    return {
        "schemaVersion": SCHEMA_VERSION,
        "source": source,
        "changes": records,
        "changedPaths": changed_paths,
        "coverage": coverage_rows,
        "knownAffected": known_affected,
        "uncoveredPaths": uncovered_paths,
        "changedDocuments": sorted(changed_documents, key=lambda item: str(item.get("path", ""))),
        "missingTrackedSpecs": sorted(missing_tracked_specs),
        "semanticSweepRequired": bool(
            known_affected
            or uncovered_paths
            or changed_docs_requiring_classification
            or missing_tracked_specs
        ),
        "reasons": reasons,
    }


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(description=__doc__)
    main.add_argument("--root", help="Project root. Defaults to Git root, then cwd.")
    main.add_argument("--state-dir", help="Wiki state directory. Defaults to .spec-wiki under root.")
    main.add_argument("--config", help="Optional config.jsonc/json path.")
    sub = main.add_subparsers(dest="command", required=True)

    discover = sub.add_parser("discover", help="Find a bounded heuristic shortlist for semantic classification.")
    discover.add_argument("--limit", type=int, default=40)
    discover.add_argument("--offset", type=int, default=0)
    discover.add_argument("--all", action="store_true", help="Include unchanged previously classified candidates.")
    discover.add_argument(
        "--all-unclassified",
        action="store_true",
        help="Include every unclassified document-like file regardless heuristic score; use for bounded periodic coverage audits.",
    )
    discover.add_argument("--json", action="store_true")

    record = sub.add_parser("record", help="Record one semantic classification/index snapshot without claiming semantic verification.")
    record.add_argument("--path", required=True)
    record.add_argument("--classification", required=True, choices=sorted(CLASSIFICATIONS))
    record.add_argument("--type", choices=sorted(SPEC_TYPES))
    record.add_argument("--lifecycle", choices=sorted(LIFECYCLES))
    record.add_argument("--confidence", choices=sorted(CONFIDENCES))
    record.add_argument("--summary")
    record.add_argument("--topic", action="append", default=None)
    record.add_argument("--code", action="append", default=None, help="Inferred implementation/test relationship; repeatable.")
    record.add_argument("--related-spec", action="append", default=None, help="Inferred related spec/doc relationship; repeatable.")
    record.add_argument("--supersedes", action="append", default=None, help="Inferred spec/doc superseded by this entry; repeatable.")
    record.add_argument("--superseded-by", action="append", default=None, help="Inferred newer spec/doc that supersedes this entry; repeatable.")
    record.add_argument("--clear-code", action="store_true", help="Clear all previously inferred code relationships before recording.")
    record.add_argument("--clear-related-specs", action="store_true", help="Clear all previously inferred spec/doc relationships before recording.")

    verify = sub.add_parser("verify", help="Establish a semantic-verification baseline for one already-recorded primary spec.")
    verify.add_argument("--path", required=True)

    relate = sub.add_parser("relate", help="Add/remove inferred spec relationships without rewriting classification metadata.")
    relate.add_argument("--path", required=True, help="Primary spec whose relation map should change.")
    relate.add_argument("--add-code", action="append", default=[])
    relate.add_argument("--remove-code", action="append", default=[])
    relate.add_argument("--add-related-spec", action="append", default=[])
    relate.add_argument("--remove-related-spec", action="append", default=[])
    relate.add_argument("--add-supersedes", action="append", default=[])
    relate.add_argument("--remove-supersedes", action="append", default=[])
    relate.add_argument("--add-superseded-by", action="append", default=[])
    relate.add_argument("--remove-superseded-by", action="append", default=[])

    remove = sub.add_parser("remove", help="Remove one Spec Wiki metadata entry without deleting its source.")
    remove.add_argument("--path", required=True)

    for name in ("audit", "status"):
        audit = sub.add_parser(name, help="Report primary-spec freshness and new/changed candidates.")
        audit.add_argument("--json", action="store_true")
        audit.add_argument("--candidate-limit", type=int, default=20)

    affected = sub.add_parser("affected", help="Find known specs related to changed repository paths.")
    affected.add_argument("paths", nargs="+")
    affected.add_argument("--json", action="store_true")

    changes = sub.add_parser("changes", help="List current Git working-tree changes including untracked files and renames.")
    changes.add_argument("--base", default="HEAD")
    changes.add_argument("--json", action="store_true")

    impact = sub.add_parser(
        "impact",
        help="Build a deterministic post-change maintenance report: known affected specs, uncovered paths, changed docs, moves/deletions.",
    )
    impact.add_argument("paths", nargs="*", help="Task-scoped changed paths. If omitted, inspect Git changes against --base.")
    impact.add_argument("--base", default="HEAD")
    impact.add_argument("--json", action="store_true")

    search = sub.add_parser("search", help="Search indexed spec knowledge without loading the full generated index.")
    search.add_argument("query")
    search.add_argument("--also", action="append", default=[], help="Additional normalized/expanded query; repeatable. Scores are merged deterministically.")
    search.add_argument("--limit", type=int, default=8)
    search.add_argument("--include-secondary", action="store_true", help="Include design-only secondary references below primary specs.")
    search.add_argument("--json", action="store_true")

    sub.add_parser("render", help="Regenerate the compact LLM-facing index.md.")
    sub.add_parser("validate", help="Validate state schema and relationship safety.")
    return main


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        root = detect_root(args.root)
        if not root.is_dir():
            raise ValueError(f"project root is not a directory: {root}")
        state_dir = resolve_state_dir(root, args.state_dir)
        config = load_config(root, state_dir, args.config)
        state = load_state(state_dir)
        if args.command != "validate":
            errors, _warnings = validate_state(root, state)
            if errors:
                raise ValueError("invalid state: " + "; ".join(errors[:5]))

        if args.command == "discover":
            if args.all and args.all_unclassified:
                raise ValueError("--all and --all-unclassified are mutually exclusive")
            candidates = discover_candidates(
                root,
                state_dir,
                config,
                state,
                include_all=args.all,
                all_unclassified=args.all_unclassified,
            )
            offset = max(0, args.offset)
            limit = max(1, args.limit)
            page = candidates[offset : offset + limit]
            payload = {
                "total": len(candidates),
                "offset": offset,
                "limit": limit,
                "hasMore": offset + len(page) < len(candidates),
                "candidates": page,
            }
            if args.json:
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                print(f"candidates: {len(candidates)} | showing {offset + 1 if page else 0}-{offset + len(page)}")
                for item in page:
                    known = f" known={item['knownClassification']}" if item.get("knownClassification") else ""
                    print(f"score={item['score']:>3} {item['roleHint']:14} {item['path']}{known}")
                    print(f"      title: {item['title']}")
                    print(f"      signals: {', '.join(item['signals']) or 'none'}")
                if payload["hasMore"]:
                    print(
                        f"more: use --offset {offset + len(page)} only if state stays unchanged; "
                        "after recording this page rerun from --offset 0"
                    )
            return 0

        if args.command == "record":
            return record_entry(args, root, state_dir, state)

        if args.command == "verify":
            return verify_entry(args.path, root, state_dir, state)

        if args.command == "relate":
            return relate_entry(args, root, state_dir, state)

        if args.command == "remove":
            rel = normalize_rel_path(root, args.path)
            entries = state.get("entries")
            if not isinstance(entries, dict) or rel not in entries:
                raise ValueError(f"state entry does not exist: {rel}")
            del entries[rel]
            save_state(state_dir, state)
            print(f"removed state entry: {rel}")
            return 0

        if args.command in {"audit", "status"}:
            payload = audit_payload(root, state_dir, config, state, max(1, args.candidate_limit))
            if args.json:
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                print_audit(payload)
            return 0

        if args.command == "affected":
            result = affected_specs(root, state, args.paths)
            if args.json:
                print(json.dumps({"affected": result}, indent=2, ensure_ascii=False))
            else:
                if not result:
                    print("no tracked spec relationships matched")
                for item in result:
                    print(f"{item['path']} — {item['status']} — {', '.join(item['matchedChanges'])}")
            return 0

        if args.command == "changes":
            records = filter_internal_change_records(git_changed_records(root, args.base), state_dir, root)
            payload = {"base": args.base, "changes": records, "paths": changed_record_paths(records)}
            if args.json:
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                if not records:
                    print("no Git working-tree changes")
                for record in records:
                    if record.get("oldPath"):
                        print(f"{record['status']:>2} {record['oldPath']} -> {record['path']}")
                    else:
                        print(f"{record['status']:>2} {record['path']}")
            return 0

        if args.command == "impact":
            payload = impact_payload(root, state_dir, config, state, args.paths or None, args.base)
            if args.json:
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                print(
                    f"changed: {len(payload['changedPaths'])} | known affected specs: {len(payload['knownAffected'])} | "
                    f"uncovered paths: {len(payload['uncoveredPaths'])} | changed docs: {len(payload['changedDocuments'])} | "
                    f"semantic sweep: {'yes' if payload['semanticSweepRequired'] else 'no'}"
                )
                for item in payload["knownAffected"]:
                    print(f"  known {item['path']} — {item['status']} — {', '.join(item['matchedChanges'])}")
                for path in payload["uncoveredPaths"]:
                    print(f"  uncovered {path}")
                for item in payload["changedDocuments"]:
                    classification = item.get("knownClassification") or "unclassified"
                    print(f"  doc {item['path']} — {classification} — score={item['score']} {item['roleHint']}")
                for path in payload["missingTrackedSpecs"]:
                    print(f"  missing-spec {path}")
            return 0

        if args.command == "search":
            queries = [args.query, *args.also]
            result = search_entries(root, state, queries, args.limit, args.include_secondary)
            quality = search_quality(result)
            if args.json:
                print(
                    json.dumps(
                        {
                            "query": args.query,
                            "queries": [query for query in queries if normalize_search_text(query)],
                            **quality,
                            "results": result,
                        },
                        indent=2,
                        ensure_ascii=False,
                    )
                )
            else:
                print(
                    f"confidence={quality['confidence']} "
                    f"catalogFallback={'yes' if quality['catalogFallbackRecommended'] else 'no'} "
                    f"semanticRerank={'yes' if quality['semanticRerankRecommended'] else 'no'}"
                )
                if not result:
                    print("no indexed spec knowledge matched")
                for item in result:
                    topics = ",".join(item.get("topics", [])[:5]) or "-"
                    print(
                        f"score={item['score']:>5} {item['lifecycle']:10} {item['status']:18} "
                        f"{item['path']} — {item['title']} [{topics}]"
                    )
                    print(f"      {compact_text(item.get('summary', ''), 260)}")
                    matched_queries = [match["query"] for match in item.get("queryMatches", [])[:3]]
                    if matched_queries:
                        print(f"      matched: {' | '.join(matched_queries)}")
            return 0

        if args.command == "render":
            rendered = render_index(root, state_dir, state)
            target = index_file(state_dir)
            previous = target.read_text(encoding="utf-8") if target.exists() else None
            if previous != rendered:
                atomic_write_text(target, rendered)
                print(f"rendered {target}")
            else:
                print(f"unchanged {target}")
            return 0

        if args.command == "validate":
            errors, warnings = validate_state(root, state)
            for warning in warnings:
                print(f"warning: {warning}")
            for error in errors:
                print(f"error: {error}", file=sys.stderr)
            if errors:
                return 1
            print(f"valid state: {len(state.get('entries', {}))} entries, {len(warnings)} warnings")
            return 0

        raise ValueError(f"unknown command: {args.command}")
    except (ValueError, OSError) as exc:
        print(f"spec-wiki: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
