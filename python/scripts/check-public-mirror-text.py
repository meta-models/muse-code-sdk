#!/usr/bin/env python3
"""Refuse private-side references in public-bound text.

The public mirror must never name the producing side: release commit
messages, publish metadata, bridge commits, and the mirror anchor carry
only public vocabulary. This script is the one shared gate every publish
path calls. Three modes:

* ``scan-text`` reads words (an argument, a file, or standard input) and
  refuses any of the eight denied classes.
* ``check-anchor`` verifies a mirror anchor file: it must carry the
  verifiable-version shape (a package version plus a content digest), hold
  no denied text, and match the tree the digest recomputes.
* ``digest-tree`` prints the canonical content digest of a mirror root.

Exit 0 accepts, 1 refuses, 2 is a usage error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

# Each entry: (class id, compiled pattern). The bracketed letters (`tb[h]`,
# `intern[c]ache`) are the `pkill -f 'tbh-[g]ate'` self-evasion trick from
# the sibling audience gate: the patterns match the same text, but this
# file itself stays clean under the repository's source gates, which scan
# this file. Case splits are deliberate. Hosts, pins, org names, and run
# ids match any case: DNS and hosting names are case-insensitive, and a
# 40-hex pin is unambiguous at any case. Issue references and tracker ids
# stay case-sensitive: uppercase `TBH` is ordinary prose ("to be honest"),
# and short `S`/`P` tokens (`S3` copies, `P0` ranks) are too, so only the
# lowercase issue form and the long S/P forms deny; the tracker class
# splits its floor the same way (short task and diff ids deny, since those
# are always internal references).
PRIVATE_REFERENCE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("issue-reference", re.compile(r"\btb[h]#\d{3,}|\btb[h] #\d{3,}")),
    (
        "commit-pin",
        re.compile(
            r"(?:mslsrc|par-msl)/tb[h]@[0-9a-fA-F]{40}\b"
            r"|\btb[h]@[0-9a-fA-F]{40}\b",
            re.IGNORECASE,
        ),
    ),
    (
        "repository-name",
        re.compile(r"\bmslsrc\b|\bpar-msl\b", re.IGNORECASE),
    ),
    (
        "run-identifier",
        re.compile(r"\brun \d{6,}|\bRUN_ID\b", re.IGNORECASE),
    ),
    ("tracker-id", re.compile(r"\b[TD]\d{3,}\b|\b[SP]\d{6,}\b")),
    (
        "commit-sha",
        re.compile(r"(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])"),
    ),
    # Hosts mirror the docs table's internal-host rule (which is itself
    # case-insensitive); gate names ride here too (that table's
    # internal-service class), since a gate name in publish text names the
    # producing side's rollout state.
    (
        "internal-host",
        re.compile(
            r"(?:[\w-]+\.)*(?:internalfb\.com|fburl\.com"
            r"|thefacebook\.com|workplace\.com)"
            r"|\bdevvm\d+[\w.-]*|\b[\w-]+\.corp\.[\w.-]+"
            r"|\bintern[c]ache\b|\btbh_gate_[a-z0-9_]+",
            re.IGNORECASE,
        ),
    ),
    (
        "internal-process-wording",
        re.compile(
            r"owner-directed|Manual bridge per the standing rule",
            re.IGNORECASE,
        ),
    ),
)

# The verifiable-version anchor holds exactly these fields: the lockstep
# host version the mirror release names, a digest recomputable from
# the tree, and the mirror-local hand-authored list (D3 keeps it;
# its strings ride the same content scan). Anything else (old
# provenance fields, the dropped timestamp) refuses fail-closed.
ANCHOR_FIELDS = frozenset({"host_version", "content_sha256", "repo_meta"})

_MANIFEST_RELATIVE = Path("scripts") / "sdk-source-closure.json"


class AnchorError(Exception):
    """A refusal with the operator-facing reason attached.

    ``content`` marks a denied-class content hit anywhere in the
    refusal: publishers classify on the machine-readable verdict line
    derived from it, never on the human prose.
    """

    def __init__(self, message: str, content: bool = False) -> None:
        super().__init__(message)
        self.content = content


def scan_findings(text: str) -> list[tuple[str, str, int, str]]:
    """Every (class id, span, line number, line) denied in ``text``."""
    findings: list[tuple[str, str, int, str]] = []
    lines = text.splitlines()
    for class_id, pattern in PRIVATE_REFERENCE_PATTERNS:
        for match in pattern.finditer(text):
            lineno = text.count("\n", 0, match.start()) + 1
            line = lines[lineno - 1] if lineno - 1 < len(lines) else ""
            findings.append((class_id, match.group(0), lineno, line))
    return findings


def read_closure_manifest(manifest_path: Path) -> tuple[list[str], set[str]]:
    """Closure entries plus the ``python/``-mapped subset.

    An entry is python-marked when its ``path_notes`` note starts with
    "Python closure" — the same rule the re-mirror copy uses, so the
    digest names every file exactly where the mirror carries it.
    Fixture manifests without ``path_notes`` map nothing.
    """
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise AnchorError(f"cannot read closure manifest {manifest_path}: {exc}")
    try:
        manifest = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AnchorError(f"closure manifest {manifest_path} is not JSON: {exc}")
    if not isinstance(manifest, dict):
        raise AnchorError(f"closure manifest {manifest_path} is not a JSON object")
    paths = manifest.get("closure_paths")
    if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        raise AnchorError(
            f"closure manifest {manifest_path} lacks a closure_paths string list"
        )
    notes = manifest.get("path_notes", {})
    if not isinstance(notes, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in notes.items()
    ):
        raise AnchorError(
            f"closure manifest {manifest_path} has a non-string path_notes map"
        )
    marked = {
        path for path, note in notes.items() if note.startswith("Python closure")
    }
    return list(paths), marked


def tracked_closure_files(root: Path, entries: list[str]) -> list[bytes]:
    """Git-tracked paths under the closure entries (one ``ls-files`` call).

    The digest covers the carried set — files the tree tracks — never
    whatever happens to sit on disk: build output, installs, and stray
    junk are untracked, so they cannot perturb the digest and refuse a
    valid anchor. Both the producer tree (at the release commit) and
    the mirror tree (fresh checkout before any build step) track
    exactly the synced files.
    """
    spec: list[str] = []
    for entry in entries:
        spec.append(f":(literal){entry}")
        spec.append(f":(literal)python/{entry}")
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-z", "--", *spec],
            capture_output=True,
            timeout=120,
        )
    except FileNotFoundError:
        raise AnchorError("digest requires git: no git executable found")
    except subprocess.TimeoutExpired:
        raise AnchorError(f"digest listing timed out in {root}")
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip().splitlines()
        raise AnchorError(
            f"digest requires a git checkout: {root} "
            f"({detail[0] if detail else 'ls-files failed'})"
        )
    return [path for path in result.stdout.split(b"\0") if path]


def _under(prefix: bytes, path: bytes) -> bool:
    """True when a tracked path is an entry itself or lives beneath it."""
    return path == prefix or path.startswith(prefix + b"/")


def closure_digest(root: Path, manifest_path: Path) -> str:
    """Canonical content digest (the re-mirror writer contract).

    SHA-256 over the carried closure files: the manifest entries
    resolved to their git-tracked files, named by mirror-relative path
    with the ``python/`` mapping applied, byte-sorted, each
    contributing its path, one NUL byte, and its file bytes. The
    producer tree holds closure paths verbatim while the mirror maps
    the python-marked ones under ``python/``; the reader accepts either
    layout so one gate verifies both trees, and an entry tracked under
    both layouts refuses as ambiguous. Every offending entry is
    collected and reported, never first-wins: a refusal naming only
    the first stray hides the rest behind it and fails the next
    publish one entry later. The re-mirror writer computes
    this exact form when stamping ``content_sha256``; any divergence
    refuses every publish as a digest mismatch, so the two
    implementations must stay character-identical.
    """
    paths, marked = read_closure_manifest(manifest_path)
    tracked = tracked_closure_files(root, paths)
    contributions: list[tuple[bytes, Path]] = []
    errors: list[str] = []
    for relpath in paths:
        entry = os.fsencode(relpath)
        mirror_entry = os.fsencode(
            f"python/{relpath}" if relpath in marked else relpath
        )
        verbatim = [path for path in tracked if _under(entry, path)]
        shadowed = [
            path for path in tracked if _under(b"python/" + entry, path)
        ]
        if verbatim and shadowed:
            errors.append(
                f"digest input is ambiguous: {relpath} is tracked both "
                f"verbatim and under python/ in {root}"
            )
            continue
        if not verbatim and not shadowed:
            errors.append(
                f"digest input missing: {relpath} "
                f"(neither {relpath} nor python/{relpath} tracked under {root})"
            )
            continue
        # Contributed names are always mirror-relative: bytes found
        # under the producer layout map to where the mirror carries
        # them, so both layouts digest identically. Stripped per list,
        # never re-classified: the strip prefix is the same predicate
        # that bucketed the path.
        for source, prefix in ((verbatim, entry), (shadowed, b"python/" + entry)):
            for path in source:
                rest = path[len(prefix):]
                file_path = root / os.fsdecode(path)
                # One lstat classifies all three states: stat failure is
                # unreadable, a link or non-regular mode refuses, anything
                # else digests. (Path.is_symlink raises on stat failure in
                # some versions instead of reporting False, so it cannot
                # carry this check.)
                try:
                    mode = file_path.lstat().st_mode
                except OSError as exc:
                    errors.append(
                        f"digest input unreadable: {os.fsdecode(path)} ({exc})"
                    )
                    continue
                if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
                    errors.append(
                        f"digest input is not a regular file: {os.fsdecode(path)}"
                    )
                    continue
                contributions.append((mirror_entry + rest, file_path))
    # The refusal waits until the hash below: entry-loop errors must not
    # hide unreadable files from the same report.
    contributions.sort(key=lambda item: item[0])
    digest = hashlib.sha256()
    # Hash-phase reads can still fail (permissions, races); collect those
    # too, so one unreadable file never hides another.
    for path_bytes, file_path in contributions:
        digest.update(path_bytes)
        digest.update(b"\x00")
        # An unreadable entry refuses through the verdict like any other
        # digest condition: a bare traceback would skip the verdict line
        # and break the every-refusal-ends-with-verdict contract.
        try:
            digest.update(file_path.read_bytes())
        except OSError as exc:
            errors.append(f"digest input unreadable: {file_path} ({exc})")
    if errors:
        raise AnchorError("\n".join(errors))
    return digest.hexdigest()


def walk_strings(node: object) -> list[tuple[str, str]]:
    """Every (path, string value) under a parsed anchor payload.

    Dict keys are scanned too: a banned token hiding in a key must
    refuse like one in a value, not slip through as a shape-only
    "unexpected field" warning. Iterative over an explicit stack: a
    deeply nested payload must refuse through the verdict, never
    escape as a RecursionError traceback.
    """
    found: list[tuple[str, str]] = []
    stack: list[tuple[object, str]] = [(node, "$")]
    while stack:
        current, path = stack.pop()
        if isinstance(current, str):
            found.append((path, current))
        elif isinstance(current, dict):
            for key, value in current.items():
                found.append((f"{path}.{key} (key)", key))
                stack.append((value, f"{path}.{key}"))
        elif isinstance(current, list):
            for index, value in enumerate(current):
                stack.append((value, f"{path}[{index}]"))
    return found


def default_manifest(root: Path) -> Path:
    return root / _MANIFEST_RELATIVE


def check_anchor(
    anchor: Path,
    root: Path | None,
    manifest: Path | None,
    expect_version: str | None = None,
) -> str:
    """Verify ``anchor`` against the tree; return the recomputed digest."""
    try:
        raw = anchor.read_bytes()
    except OSError as exc:
        raise AnchorError(f"cannot read anchor file {anchor}: {exc}")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise AnchorError(f"anchor {anchor} is not JSON")
    if not isinstance(payload, dict):
        raise AnchorError(f"anchor {anchor} is not a JSON object")
    # Every failure is collected and reported, never first-wins: callers
    # classify content failures from shape/digest failures on the
    # machine-readable verdict line (derived from content_found below),
    # and a shape failure must not hide denied bytes behind it (a raw-bytes
    # pre-scan cannot see JSON-escaped text the decoded value scan catches).
    errors: list[str] = []
    content_found = False
    if "host_version" not in payload or "content_sha256" not in payload:
        errors.append(
            f"anchor {anchor} is not the verifiable version shape "
            "(host_version plus content_sha256 required)"
        )
    for key in payload:
        if key not in ANCHOR_FIELDS:
            errors.append(
                f"unexpected anchor field {key!r} in {anchor}: the "
                "verifiable version shape holds only host_version, "
                "content_sha256, and repo_meta"
            )
    for value_path, value in walk_strings(payload):
        for class_id, span, _, _ in scan_findings(value):
            content_found = True
            errors.append(
                f"denied {class_id} in anchor field {value_path}: "
                f"{value!r} (span {span!r})"
            )
    tree_root = root or anchor.parent
    try:
        digest = closure_digest(tree_root, manifest or default_manifest(tree_root))
    except AnchorError as exc:
        errors.append(f"cannot verify anchor digest: {exc}")
        digest = ""
    if (
        "content_sha256" in payload
        and digest
        and payload["content_sha256"] != digest
    ):
        errors.append(
            f"digest mismatch for {anchor}: the anchor pins "
            f"{payload['content_sha256']!r} but the tree recomputes {digest!r}"
        )
    if (
        expect_version is not None
        and "host_version" in payload
        and payload["host_version"] != expect_version
    ):
        errors.append(
            f"version mismatch for {anchor}: the anchor names "
            f"{payload['host_version']!r}, expected {expect_version!r}"
        )
    if errors:
        raise AnchorError("\n".join(errors), content=content_found)
    return digest


def cmd_scan_text(args: argparse.Namespace) -> int:
    if args.text is not None:
        text, source = args.text, "command line"
    elif args.file is not None:
        try:
            text = args.file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            print(f"cannot read scan-text file {args.file}: {exc}", file=sys.stderr)
            return 1
        source = str(args.file)
    else:
        try:
            text = sys.stdin.buffer.read().decode("utf-8")
        except UnicodeDecodeError as exc:
            print(
                f"cannot read scan-text standard input: {exc}", file=sys.stderr
            )
            return 1
        source = "standard input"
    findings = scan_findings(text)
    for class_id, span, lineno, line in findings:
        print(
            f"public-mirror-text: denied {class_id} in {source} "
            f"line {lineno} (span {span!r}): {line!r}",
            file=sys.stderr,
        )
    return 1 if findings else 0


def cmd_digest_tree(args: argparse.Namespace) -> int:
    try:
        print(closure_digest(args.root, args.manifest or default_manifest(args.root)))
    except AnchorError as exc:
        print(f"public-mirror-text: {exc}", file=sys.stderr)
        return 1
    return 0


def cmd_check_anchor(args: argparse.Namespace) -> int:
    try:
        check_anchor(args.anchor, args.root, args.manifest, args.expect_version)
    except AnchorError as exc:
        print(f"public-mirror-text: {exc}", file=sys.stderr)
        # The machine-readable verdict is the last line, computed once
        # here: publishers match this token, never the human prose above,
        # so rewording a message cannot mute a content refusal.
        verdict = "content-refused" if exc.content else "refused"
        print(f"anchor-verdict: {verdict}", file=sys.stderr)
        return 1
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="check-public-mirror-text.py",
        description="Refuse private-side references in public-bound text.",
    )
    modes = parser.add_subparsers(dest="mode", required=True)

    scan = modes.add_parser("scan-text", help="refuse denied classes in words")
    scan_source = scan.add_mutually_exclusive_group()
    scan_source.add_argument("--text", help="words to check")
    scan_source.add_argument("--file", type=Path, help="file holding words to check")
    scan.set_defaults(func=cmd_scan_text)

    digest = modes.add_parser("digest-tree", help="print a tree content digest")
    digest.add_argument("--root", type=Path, required=True, help="mirror root")
    digest.add_argument("--manifest", type=Path, help="closure manifest override")
    digest.set_defaults(func=cmd_digest_tree)

    anchor = modes.add_parser("check-anchor", help="verify an anchor file")
    anchor.add_argument("--anchor", type=Path, required=True, help="anchor file")
    anchor.add_argument("--root", type=Path, help="mirror root override")
    anchor.add_argument("--manifest", type=Path, help="closure manifest override")
    anchor.add_argument("--expect-version", help="version the anchor must name")
    anchor.set_defaults(func=cmd_check_anchor)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
