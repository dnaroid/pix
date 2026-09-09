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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
SPEC_CLASSIFICATIONS = {"spec", "spec-like"}
CLASSIFICATIONS = SPEC_CLASSIFICATIONS | {"meta-index", "design-only", "guide", "other"}
SPEC_TYPES = {"as-is", "change", "mixed", "unknown"}
CONFIDENCES = {"high", "medium", "low", "unknown"}
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

    if meta_score >= 5:
        role_hint = "meta-index"
    elif score >= 4:
        role_hint = "spec-candidate"
    else:
        role_hint = "weak-candidate"
    return score, role_hint, signals


def entry_baseline_hash(entry: dict[str, Any]) -> str | None:
    verified = entry.get("verified")
    return verified.get("sourceHash") if isinstance(verified, dict) else None


def discover_candidates(
    root: Path,
    state_dir: Path,
    config: dict[str, Any],
    state: dict[str, Any],
    include_all: bool = False,
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
        if not include_all:
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


def resolve_reference(root: Path, source_rel: str, token: str) -> str | None:
    cleaned = clean_reference_token(token)
    if not cleaned or cleaned.startswith("..."):
        return None
    source_parent = (root / source_rel).parent
    raw = Path(cleaned)
    candidates = [raw] if raw.is_absolute() else [source_parent / raw, root / raw]
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
            rel = resolved.relative_to(root.resolve()).as_posix()
        except (OSError, ValueError):
            continue
        if resolved.is_file():
            return rel
    return None


def explicit_relations(root: Path, source_rel: str, text: str) -> dict[str, list[dict[str, str]]]:
    tokens: list[str] = []
    tokens.extend(MARKDOWN_LINK_RE.findall(text))
    tokens.extend(BACKTICK_RE.findall(text))
    tokens.extend(PLAIN_PATH_RE.findall(text))
    resolved: list[str] = []
    for token in tokens:
        path = resolve_reference(root, source_rel, token)
        if path and path != source_rel:
            resolved.append(path)
    code: list[dict[str, str]] = []
    specs: list[dict[str, str]] = []
    for path in sorted(set(resolved)):
        target = specs if Path(path).suffix.lower() in DOC_EXTENSIONS else code
        target.append({"path": path, "source": "explicit"})
    return {"code": code, "specs": specs}


def inferred_relations(root: Path, values: Iterable[str], kind: str) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    for value in values:
        rel = normalize_rel_path(root, value)
        if not (root / rel).is_file():
            raise ValueError(f"inferred {kind} relationship does not exist: {rel}")
        result.append({"path": rel, "source": "inferred"})
    return sorted({item["path"]: item for item in result}.values(), key=lambda item: item["path"])


def merge_relations(explicit: list[dict[str, str]], inferred: list[dict[str, str]]) -> list[dict[str, str]]:
    merged = {item["path"]: item for item in inferred}
    for item in explicit:
        merged[item["path"]] = item
    return [merged[path] for path in sorted(merged)]


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
    verified = entry.get("verified")
    if not isinstance(verified, dict) or not isinstance(verified.get("sourceHash"), str):
        return {"status": "unverified", "reasons": ["no verified source hash"]}
    current_source_hash = file_hash(source_path)
    source_changed = current_source_hash != verified.get("sourceHash")

    relations = entry.get("relations") if isinstance(entry.get("relations"), dict) else {}
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

    if source_changed and changed_inputs:
        status = "spec+inputs-changed"
    elif source_changed:
        status = "spec-changed"
    elif changed_inputs:
        status = "inputs-changed"
    else:
        status = "fresh"
    reasons = ([f"source:{rel}"] if source_changed else []) + [f"input:{path}" for path in changed_inputs]
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
    inferred_code = (
        []
        if args.clear_code
        else inferred_relations(root, args.code, "code")
        if args.code is not None
        else old_inferred_code
    )
    inferred_specs = (
        []
        if args.clear_related_specs
        else inferred_relations(root, args.related_spec, "specs")
        if args.related_spec is not None
        else old_inferred_specs
    )
    relations = {
        "code": merge_relations(explicit["code"], inferred_code),
        "specs": merge_relations(explicit["specs"], inferred_specs),
    }
    if classification not in SPEC_CLASSIFICATIONS:
        relations = {"code": [], "specs": []}
    code_hashes: dict[str, str] = {}
    for item in relations["code"]:
        relation_hash = file_hash(safe_project_path(root, item["path"]))
        if relation_hash is None:
            raise ValueError(f"failed to hash tracked input: {item['path']}")
        code_hashes[item["path"]] = relation_hash

    topics = sorted(set(args.topic if args.topic is not None else previous.get("topics", [])))
    if classification not in SPEC_CLASSIFICATIONS:
        topics = sorted(set(args.topic or []))
    entry = {
        "path": rel,
        "title": document_title(text, rel),
        "classification": classification,
        "type": (args.type or previous.get("type", "unknown")) if classification in SPEC_CLASSIFICATIONS else "unknown",
        "confidence": args.confidence or previous.get("confidence", "unknown"),
        "summary": (args.summary.strip() if args.summary is not None else previous.get("summary", "")),
        "topics": topics,
        "relations": relations,
        "verified": {
            "at": utc_now(),
            "sourceHash": source_hash,
            "codeHashes": code_hashes,
        },
    }
    if classification not in SPEC_CLASSIFICATIONS:
        entry["summary"] = args.summary.strip() if args.summary else ""
    entries[rel] = entry
    save_state(state_dir, state)
    print(f"recorded {classification}: {rel}")
    return 0


def markdown_inline_list(values: list[str], maximum: int = 8) -> str:
    shown = values[:maximum]
    rendered = ", ".join(f"`{value}`" for value in shown)
    if len(values) > maximum:
        rendered += f", +{len(values) - maximum} more"
    return rendered


def render_index(root: Path, state_dir: Path, state: dict[str, Any]) -> str:
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    specs = [entry for entry in entries.values() if isinstance(entry, dict) and entry.get("classification") in SPEC_CLASSIFICATIONS]
    specs.sort(key=lambda item: (str(item.get("title", "")).lower(), str(item.get("path", ""))))
    statuses = {entry["path"]: current_entry_status(root, entry) for entry in specs if isinstance(entry.get("path"), str)}

    lines = [
        "# Spec Wiki",
        "",
        "> Generated navigation over primary specification documents. This file is derived metadata, not a primary spec.",
        "> Use source documents for facts; freshness is hash-based and `inputs-changed` requires semantic verification.",
        "",
    ]
    stale = [(entry, statuses.get(entry["path"], {"status": "unverified", "reasons": []})) for entry in specs if statuses.get(entry["path"], {}).get("status") != "fresh"]
    if stale:
        lines.extend(["## Needs review", ""])
        for entry, status in stale:
            reason_text = "; ".join(status.get("reasons", [])[:4])
            suffix = f" — {reason_text}" if reason_text else ""
            lines.append(f"- `{entry['path']}` — **{status['status']}**{suffix}")
        lines.append("")

    lines.extend(["## Primary specs", ""])
    if not specs:
        lines.extend(["_No primary specs have been semantically classified yet._", ""])
    for entry in specs:
        status = statuses.get(entry["path"], {"status": "unverified"})
        lines.append(f"### {entry.get('title') or entry['path']}")
        lines.append("")
        lines.append(
            f"`{entry['path']}` · {entry.get('classification', 'spec')} · {entry.get('type', 'unknown')} · **{status.get('status', 'unverified')}**"
        )
        lines.append("")
        summary = str(entry.get("summary", "")).strip()
        if summary:
            lines.append(summary)
            lines.append("")
        topics = [str(item) for item in entry.get("topics", []) if str(item).strip()]
        if topics:
            lines.append("Topics: " + ", ".join(topics))
        relations = entry.get("relations") if isinstance(entry.get("relations"), dict) else {}
        code = [item.get("path") for item in relations.get("code", []) if isinstance(item, dict) and isinstance(item.get("path"), str)]
        related_specs = [item.get("path") for item in relations.get("specs", []) if isinstance(item, dict) and isinstance(item.get("path"), str)]
        if code:
            lines.append("Related implementation: " + markdown_inline_list(code))
        if related_specs:
            lines.append("Related specs/docs: " + markdown_inline_list(related_specs))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def audit_payload(root: Path, state_dir: Path, config: dict[str, Any], state: dict[str, Any], candidate_limit: int) -> dict[str, Any]:
    entries = state.get("entries", {}) if isinstance(state.get("entries"), dict) else {}
    specs = [entry for entry in entries.values() if isinstance(entry, dict) and entry.get("classification") in SPEC_CLASSIFICATIONS]
    statuses = []
    for entry in sorted(specs, key=lambda item: str(item.get("path", ""))):
        status = current_entry_status(root, entry)
        statuses.append({"path": entry.get("path"), **status})
    candidates = discover_candidates(root, state_dir, config, state, include_all=False)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "primarySpecCount": len(specs),
        "freshCount": sum(1 for item in statuses if item["status"] == "fresh"),
        "needsReviewCount": sum(1 for item in statuses if item["status"] != "fresh"),
        "statuses": statuses,
        "candidateCount": len(candidates),
        "candidates": candidates[:candidate_limit],
        "candidateListTruncated": len(candidates) > candidate_limit,
    }


def print_audit(payload: dict[str, Any]) -> None:
    print(
        f"primary specs: {payload['primarySpecCount']} | fresh: {payload['freshCount']} | "
        f"needs review: {payload['needsReviewCount']} | new/changed candidates: {payload['candidateCount']}"
    )
    for item in payload["statuses"]:
        if item["status"] == "fresh":
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
        if entry.get("confidence", "unknown") not in CONFIDENCES:
            errors.append(f"{key}: invalid confidence {entry.get('confidence')!r}")
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
                    tracked_code = []
                    if isinstance(relations, dict) and isinstance(relations.get("code"), list):
                        tracked_code = [
                            relation.get("path")
                            for relation in relations["code"]
                            if isinstance(relation, dict) and isinstance(relation.get("path"), str)
                        ]
                    for relation_path in tracked_code:
                        value = code_hashes.get(relation_path)
                        if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                            errors.append(
                                f"{key}: verified.codeHashes missing/invalid for {relation_path}"
                            )
                    for relation_path, value in code_hashes.items():
                        if not isinstance(relation_path, str) or not isinstance(value, str) or not SHA256_RE.fullmatch(value):
                            errors.append(f"{key}: malformed verified.codeHashes entry")
        if classification in SPEC_CLASSIFICATIONS:
            status = current_entry_status(root, entry)
            if status["status"] != "fresh":
                warnings.append(f"{key}: {status['status']}")
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
    discover.add_argument("--json", action="store_true")

    record = sub.add_parser("record", help="Record one semantic classification and verified baseline.")
    record.add_argument("--path", required=True)
    record.add_argument("--classification", required=True, choices=sorted(CLASSIFICATIONS))
    record.add_argument("--type", choices=sorted(SPEC_TYPES))
    record.add_argument("--confidence", choices=sorted(CONFIDENCES))
    record.add_argument("--summary")
    record.add_argument("--topic", action="append", default=None)
    record.add_argument("--code", action="append", default=None, help="Inferred implementation/test relationship; repeatable.")
    record.add_argument("--related-spec", action="append", default=None, help="Inferred related spec/doc relationship; repeatable.")
    record.add_argument("--clear-code", action="store_true", help="Clear all previously inferred code relationships before recording.")
    record.add_argument("--clear-related-specs", action="store_true", help="Clear all previously inferred spec/doc relationships before recording.")

    remove = sub.add_parser("remove", help="Remove one Spec Wiki metadata entry without deleting its source.")
    remove.add_argument("--path", required=True)

    for name in ("audit", "status"):
        audit = sub.add_parser(name, help="Report primary-spec freshness and new/changed candidates.")
        audit.add_argument("--json", action="store_true")
        audit.add_argument("--candidate-limit", type=int, default=20)

    affected = sub.add_parser("affected", help="Find known specs related to changed repository paths.")
    affected.add_argument("paths", nargs="+")
    affected.add_argument("--json", action="store_true")

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
            candidates = discover_candidates(root, state_dir, config, state, include_all=args.all)
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
