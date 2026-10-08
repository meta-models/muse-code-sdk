#!/usr/bin/env python3
"""External-audience gate for the published Python and npm packages and
the public python source tree.

The first PyPI publish shipped long descriptions (the package READMEs), a
pyproject ``description``, and module docstrings that cite artifacts only
the producing repository resolves — spec paths, ADR/issue numbers,
requirement ids, protocol-spec section refs, internal dev loops — and a
follow-up sweep found the same class in ledger notes, script comments, and
test fixtures. The first npm publish shipped the same class in the
TypeScript SDK's README. A registry reader has the published package, the
public mirror, and the public docs site — nothing else — so every such
reference is a dead end at best and a disclosure at worst.

Four modes, two pattern tiers:

  (default)         check the committed sources under --repo-root: package
                    METADATA surfaces (each README.md, each pyproject
                    ``description``, every src module-level docstring) with
                    the full table, plus a TREE walk of every hand-written
                    closure file with the tree tier. This is what the
                    pytest suite runs on every CI ride.
  --dist DIR        check built distributions: each wheel's METADATA and
                    packaged module docstrings with the full table, every
                    hand-written packaged .py whole (the sdist ships the
                    tests/ tree), and each sdist's PKG-INFO. This is the
                    publish gate: it audits what the upload step would
                    actually ship, so a leak can never reach the registry
                    again (scripts/publish-sdk-pypi.sh runs it after the
                    build).
  --npm-source      check the committed npm package surface under
                    --repo-root: the TypeScript SDK's README.md (the npm
                    long description) and its package.json ``description``.
                    This is the per-PR CI check.
  --npm-tarball TGZ check a packed npm tarball's package/README.md and
                    package/package.json ``description``. This is the npm
                    publish gate: scripts/publish-sdk-npm.sh runs it after
                    `npm pack`, before any publish, so it audits what the
                    upload step would actually ship.

The METADATA tier bans every repository path; the TREE tier bans only
identifiers that resolve nowhere outside the producing repository, so
closure-internal paths stay legal in tree files. The table is derived from
the producing repository's docs-site citation-class table plus the classes
observed in the leaks; it is deliberately a Python restatement, not an
import — this gate runs where only the dev-lock Python exists (the pytest
lane and the mirror's publish workflow), with no Node available.

The generated ``muse_code_msp`` modules are sanitized at their codegen
seam (schema descriptions render with citations removed) and are scanned
here like every other file; the committed schema bundle is the raw input
that sanitizer normalizes and is not walked.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
import tarfile
import zipfile
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # Python 3.10: tomllib is 3.11+
    import tomli as tomllib  # type: ignore[no-redef]

PACKAGE_DIRS = ("clients/msp-py", "clients/sdk-py")
NPM_PACKAGE_DIR = "clients/sdk-ts"

# Each entry: (class id, compiled pattern). A hit anywhere in a gated text
# fails the run. Keyed to the docs-site citation-class table where a
# class exists there; the path classes are the 1.3.0 leak's own vocabulary.
PRIVATE_REFERENCE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("spec-path", re.compile(r"specs/")),
    ("source-path", re.compile(r"\bcrates/")),
    ("script-path", re.compile(r"\bscripts/")),
    ("schema-path", re.compile(r"\bschema/msp")),
    ("adr-path", re.compile(r"\bdocs/adr")),
    ("client-path", re.compile(r"\bclients/")),
    ("adr-citation", re.compile(r"\bADR \d+")),
    # Tracker numbers (issue/PR '#' + digits). Three digits with a guard against
    # digit-leading hex colors, the citation-class table's lookahead.
    ("tracker-number", re.compile(r"(?<!&)#\d{3,}(?![0-9a-fA-F])")),
    ("requirement-id", re.compile(r"\b(?:INV|FR|FM|AS|TEST)-\d")),
    # Spec clarification ids (the C-<spec>-<n> form) — the class the first
    # review of this gate caught still shipping.
    ("clarification-id", re.compile(r"\bC-\d{3,}-\d")),
    ("task-id", re.compile(r"\bT\d{3}\b")),
    ("decision-id", re.compile(r"\bD-\d{2,}\b")),
    ("scenario-ref", re.compile(r"\bScenario \d", re.IGNORECASE)),
    # Whole-token incl. bare sections (SS2) and dash-joined ranges
    # (SS2-SS5, en/em dashes) — the docs-site table's width.
    ("spec-section", re.compile(r"\bSS\d+(?:\.\d+)*[a-z]?(?:\s?[–—-]\s?SS\d+)*\b")),
    ("appendix-ref", re.compile(r"\bAppendix [A-Z]\b")),
    ("spec-number", re.compile(r"\bspecs? \d{3,}\b", re.IGNORECASE)),
    ("spec-doc", re.compile(r"\btdd\b")),
    # The [h] classes keep these pattern literals from counting as internal
    # references themselves when this file is scanned by the mirrored-source
    # audience profile (the `pkill -f 'tbh-[g]ate'` trick).
    ("dev-loop-path", re.compile(r"\bprojects/tb[h]\b")),
    ("private-repo", re.compile(r"\b(?:mslsrc|par-msl)/tb[h]\b")),
    # Names carrying the internal product prefix (workflow and crate names).
    # The public vocabulary is `muse`/`muse-code-*`.
    ("internal-name", re.compile(r"\btbh-[a-z][a-z0-9-]*")),
    # Spec-plan slice labels ("S0 skeleton", "plan slice S3"): internal
    # delivery vocabulary that also rots — the 1.3.0 description still called
    # the finished SDK an "S0 skeleton". State the real surface instead.
    ("slice-label", re.compile(r"\bS\d\b")),
    ("stale-status", re.compile(r"\bskeleton\b", re.IGNORECASE)),
)

# The TREE tier: identifiers that resolve ONLY inside the producing
# repository, banned in EVERY hand-written file of the public python
# closure — code comments and docstrings included (the owning spec's tree
# contract). Closure-internal path classes (script-path, client-path,
# schema-path) and the metadata-only status classes (slice-label,
# stale-status) are deliberately NOT here: a mirror reader has the tree, so
# a path into it resolves, and status words in code prose are ordinary
# English. Package METADATA keeps the full table above.
TREE_TIER_EXCLUDED_CLASSES = frozenset(
    {"script-path", "client-path", "schema-path", "slice-label", "stale-status"}
)
TREE_PRIVATE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (class_id, pattern)
    for class_id, pattern in PRIVATE_REFERENCE_PATTERNS
    if class_id not in TREE_TIER_EXCLUDED_CLASSES
) + (
    # Producing-repo trees a mirror clone never carries.
    ("producing-docs-path", re.compile(r"\bdeveloper-docs/")),
    # Internal test-charter ids (the docs-site table's requirement-id kin).
    ("test-charter-id", re.compile(r"\bPY-TEST-\d")),
)

# What the tree walk covers: every file in the python closure — the
# generated wire-types modules included, whose codegen sanitizes schema
# description text at render time — relative to --repo-root (the producing
# repo's project root upstream, `python/` in the public mirror; the layouts
# agree below these paths). Not walked: the committed schema bundle (the
# raw input the sanitizer normalizes; also exportable from the public
# binary) and this file itself, which IS the pattern table and cannot avoid
# containing its own patterns — it is audited by review instead.
TREE_WALK_PATHS = (
    "clients/msp-py",
    "clients/py-dev-requirements.txt",
    "clients/sdk-cookbook-py",
    "clients/sdk-py",
    "clients/sdk-quickstart-py",
    "scripts/check-public-mirror-text.py",
    "scripts/publish-sdk-pypi.sh",
    "scripts/sdk-py-wheel-rows.py",
)
# Python-closure manifest entries deliberately NOT in the walk, each with its
# seam: this script is the pattern table (audited by review); the closure
# manifest is the provenance record whose repository fields are a standing
# owner item. Every OTHER "Python closure" manifest entry must be walked —
# check_tree pins that, so a new python package cannot ship unscanned.
TREE_WALK_EXCLUDED_CLOSURE_ENTRIES = frozenset(
    {"scripts/check-sdk-py-external-audience.py", "scripts/sdk-source-closure.json"}
)
TREE_TEXT_SUFFIXES = {".py", ".md", ".toml", ".txt", ".json", ".sh", ".cfg", ".ndjson"}
# Local build/tool litter the walk must never scan: an untracked virtualenv
# under a closure root carries third-party strings that false-red the gate
# on a dev machine (CI and the publish run on fresh checkouts). A closed
# name set plus exactly ONE suffix arm (`*.egg-info`, applied in _pruned);
# any other new directory name defaults to SCANNED.
TREE_WALK_PRUNED_DIR_NAMES = frozenset(
    {".venv", "venv", ".tox", ".pytest_cache", "__pycache__", ".mypy_cache",
     "node_modules", ".ruff_cache"}
)
TREE_WALK_PRUNED_SUFFIXES = frozenset({".egg-info"})


def _pruned(rel_parts: tuple[str, ...]) -> bool:
    return any(
        part in TREE_WALK_PRUNED_DIR_NAMES
        or any(part.endswith(suffix) for suffix in TREE_WALK_PRUNED_SUFFIXES)
        for part in rel_parts[:-1]
    )


def findings_in(
    text: str,
    where: str,
    patterns: tuple[tuple[str, re.Pattern[str]], ...] = PRIVATE_REFERENCE_PATTERNS,
) -> list[str]:
    out = []
    for class_id, pattern in patterns:
        for hit in {m.group(0) for m in pattern.finditer(text)}:
            out.append(f"{where}: {class_id}: {hit!r}")
    return out


def module_docstring(source: str, where: str) -> str:
    try:
        return ast.get_docstring(ast.parse(source)) or ""
    except SyntaxError as err:  # a broken shipped module is its own defect
        raise SystemExit(f"FAILED: {where}: not parseable Python: {err}")


def check_tree(repo_root: Path) -> list[str]:
    findings: list[str] = []
    for package in PACKAGE_DIRS:
        package_dir = repo_root / package
        readme = package_dir / "README.md"
        findings += findings_in(readme.read_text(), f"{package}/README.md")
        with (package_dir / "pyproject.toml").open("rb") as handle:
            description = tomllib.load(handle)["project"].get("description", "")
        findings += findings_in(
            description, f"{package}/pyproject.toml [project] description"
        )
        for module in sorted((package_dir / "src").rglob("*.py")):
            rel = module.relative_to(repo_root)
            findings += findings_in(
                module_docstring(module.read_text(), str(rel)),
                f"{rel} module docstring",
            )
    findings += tree_findings(repo_root)
    _assert_walk_covers_the_closure(repo_root)
    return findings


def _assert_walk_covers_the_closure(repo_root: Path) -> None:
    # The walk roots must never drift below the closure manifest: every
    # manifest entry noted "Python closure" is walked or a named exclusion.
    # Upstream the manifest sits beside this script; the public mirror's
    # python/ tree does not carry it, so absence skips the pin there (the
    # mirror runs the dist mode as its publish gate).
    manifest_path = repo_root / "scripts" / "sdk-source-closure.json"
    if not manifest_path.exists():
        return
    import json

    manifest = json.loads(manifest_path.read_text())
    notes = manifest.get("path_notes", {})
    python_entries = {
        entry
        for entry in manifest.get("closure_paths", [])
        if str(notes.get(entry, "")).startswith("Python closure")
    }
    uncovered = python_entries - set(TREE_WALK_PATHS) - TREE_WALK_EXCLUDED_CLOSURE_ENTRIES
    if uncovered:
        raise SystemExit(
            "FAILED: Python-closure manifest entries missing from the tree "
            f"walk (add to TREE_WALK_PATHS or the named exclusions): {sorted(uncovered)}"
        )


def tree_findings(repo_root: Path) -> list[str]:
    # The TREE tier: whole-file scan of every hand-written closure file, so a
    # producing-repo identifier in a comment, ledger note, or fixture cannot
    # ship in the public tree again.
    findings: list[str] = []
    walked = 0
    for root in TREE_WALK_PATHS:
        path = repo_root / root
        if not path.exists():
            continue
        for file in sorted([path] if path.is_file() else path.rglob("*")):
            if not file.is_file() or file.suffix not in TREE_TEXT_SUFFIXES:
                continue
            rel_parts = file.relative_to(repo_root).parts
            if _pruned(rel_parts):
                continue
            walked += 1
            rel = file.relative_to(repo_root)
            findings += findings_in(
                file.read_text(), str(rel), TREE_PRIVATE_PATTERNS
            )
    if walked < 6:  # both packages' metadata plus a test at minimum; an empty walk is a bad root
        raise SystemExit(
            f"FAILED: the tree walk visited only {walked} files under "
            f"{repo_root}; the closure roots look wrong"
        )
    return findings


def check_dist(dist_root: Path) -> list[str]:
    findings: list[str] = []
    wheels = sorted(dist_root.rglob("*.whl"))
    sdists = sorted(dist_root.rglob("*.tar.gz"))
    if not wheels or not sdists:
        raise SystemExit(
            f"FAILED: no built wheel/sdist under {dist_root}; the audience "
            "gate must audit what would actually ship"
        )
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            for entry in sorted(archive.namelist()):
                where = f"{wheel.name}!{entry}"
                if entry.endswith(".dist-info/METADATA"):
                    findings += findings_in(
                        archive.read(entry).decode("utf-8"), where
                    )
                elif entry.endswith(".py"):
                    source = archive.read(entry).decode("utf-8")
                    findings += findings_in(
                        module_docstring(source, where),
                        f"{where} module docstring",
                    )
                    findings += findings_in(source, where, TREE_PRIVATE_PATTERNS)
    for sdist in sdists:
        with tarfile.open(sdist) as archive:
            for member in archive.getmembers():
                where = f"{sdist.name}!{member.name}"
                if member.name.endswith("PKG-INFO"):
                    payload = archive.extractfile(member)
                    assert payload is not None
                    findings += findings_in(payload.read().decode("utf-8"), where)
                elif member.name.endswith(".py"):
                    # The sdist ships EVERYTHING setuptools collects — the
                    # first sdist carried the whole tests/ tree, so packaged
                    # .py files are public down to their comments (generated
                    # modules included: their codegen sanitizes at render
                    # time, and this is the proof it held).
                    payload = archive.extractfile(member)
                    assert payload is not None
                    findings += findings_in(
                        payload.read().decode("utf-8"), where, TREE_PRIVATE_PATTERNS
                    )
    return findings


def npm_manifest_findings(manifest_text: str, where: str) -> list[str]:
    try:
        description = json.loads(manifest_text).get("description", "")
    except json.JSONDecodeError as err:  # a broken shipped manifest is its own defect
        raise SystemExit(f"FAILED: {where}: not parseable JSON: {err}")
    return findings_in(description, f"{where} description")


def check_npm_source(repo_root: Path) -> list[str]:
    package_dir = repo_root / NPM_PACKAGE_DIR
    findings = findings_in(
        (package_dir / "README.md").read_text(), f"{NPM_PACKAGE_DIR}/README.md"
    )
    findings += npm_manifest_findings(
        (package_dir / "package.json").read_text(), f"{NPM_PACKAGE_DIR}/package.json"
    )
    return findings


def check_npm_tarball(tarball: Path) -> list[str]:
    # Fail closed when an audited entry is absent: the gate exists to audit
    # what would actually ship, and a tarball without its README or manifest
    # is its own packaging defect, never a clean audit.
    findings: list[str] = []
    with tarfile.open(tarball) as archive:
        for entry, audit in (
            ("package/README.md", findings_in),
            ("package/package.json", npm_manifest_findings),
        ):
            try:
                payload = archive.extractfile(entry)
            except KeyError:
                payload = None
            if payload is None:
                raise SystemExit(
                    f"FAILED: {tarball.name} has no {entry}; the audience gate "
                    "must audit what would actually ship"
                )
            findings += audit(
                payload.read().decode("utf-8"), f"{tarball.name}!{entry}"
            )
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dist",
        type=Path,
        default=None,
        help="audit built Python distributions under this directory instead of the tree",
    )
    mode.add_argument(
        "--npm-source",
        action="store_true",
        help="audit the committed npm package surface (README.md + package.json description)",
    )
    mode.add_argument(
        "--npm-tarball",
        type=Path,
        default=None,
        help="audit a packed npm tarball's package/README.md + package/package.json description",
    )
    args = parser.parse_args()

    if args.dist is not None:
        findings = check_dist(args.dist)
    elif args.npm_source:
        findings = check_npm_source(args.repo_root)
    elif args.npm_tarball is not None:
        findings = check_npm_tarball(args.npm_tarball)
    else:
        findings = check_tree(args.repo_root)
    if findings:
        print(
            "FAILED: the published package surface references private "
            "repository artifacts:",
            file=sys.stderr,
        )
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        print(
            "Rewrite the text for a registry reader (they have the package, "
            "https://github.com/meta-models/muse-code-sdk and "
            "https://meta-models.github.io/muse-code-sdk/ — nothing else). "
            "For generated modules, fix the docstring template in the "
            "producing repository's msp-py codegen tool and rerun its "
            "generation script.",
            file=sys.stderr,
        )
        return 1
    print("ok: no private repository references in the published package surface")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
