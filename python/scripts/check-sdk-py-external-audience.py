#!/usr/bin/env python3
"""External-audience gate for the published Python packages and their
public source tree.

The PyPI 1.3.0 publish shipped long descriptions (the package READMEs), a
pyproject ``description``, and module docstrings that cite artifacts only
this private repository resolves — spec paths, ADR/issue numbers, INV/FR
ids, tdd section refs, internal dev loops. A PyPI reader has the published
package, the public mirror, and the public docs site — nothing else — so
every such reference is a dead end at best and a disclosure at worst.

Two modes, one pattern table:

  (default)         check the committed sources under --repo-root: each
                    package's README.md, its pyproject ``description``, and
                    the module-level docstring of every .py under src/. This
                    is what the pytest suite runs on every CI ride.
  --dist DIR        check built distributions: each wheel's METADATA
                    (summary + long description) and the module-level
                    docstring of every packaged .py, plus each sdist's
                    PKG-INFO. This is the publish gate: it audits what the
                    upload step would actually ship, so a leak can never
                    reach the registry again (scripts/publish-sdk-pypi.sh
                    runs it after the build).

The pattern table is derived from the repository's citation-class table
(the producing repository's docs-site citation-class table) plus the
classes observed in
the 1.3.0 leak; it is deliberately a Python restatement, not an import —
this gate runs where only the dev-lock Python exists (the pytest lane and
the mirror's publish workflow), with no Node available. Scope is likewise
deliberate: METADATA and MODULE-LEVEL docstrings only. Inner (class and
function) docstrings citing specs follow the mirrored-SOURCE posture
(scripts/check-source-audience.mjs: reviewed policy treats source-comment
citations as benign) and are tracked separately.

Deeper docstrings in the generated ``muse_code_msp`` modules come from the
MSP schema bundle descriptions; scrubbing those means changing the schema
export, not this package — also tracked separately.
"""

from __future__ import annotations

import argparse
import ast
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
    ("task-id", re.compile(r"\bT\d{3}\b")),
    ("decision-id", re.compile(r"\bD-\d{2,}\b")),
    ("scenario-ref", re.compile(r"\bScenario \d", re.IGNORECASE)),
    ("spec-section", re.compile(r"\bSS\d+\.\d")),
    ("spec-number", re.compile(r"\bspecs? \d{3,}\b", re.IGNORECASE)),
    ("spec-doc", re.compile(r"\btdd\b")),
    # The [h] classes keep these pattern literals from counting as internal
    # references themselves when this file is scanned by the mirrored-source
    # audience profile (the `pkill -f 'tbh-[g]ate'` trick).
    ("dev-loop-path", re.compile(r"\bprojects/tb[h]\b")),
    ("private-repo", re.compile(r"\b(?:mslsrc|par-msl)/tb[h]\b")),
    # Internal workflow/crate names (tbh-muse-sdk-py, tbh-devtools). The
    # public vocabulary is `muse`/`muse-code-*`; nothing external is `tbh-*`.
    ("internal-name", re.compile(r"\btbh-[a-z][a-z0-9-]*")),
    # Spec-plan slice labels ("S0 skeleton", "plan slice S3"): internal
    # delivery vocabulary that also rots — the 1.3.0 description still called
    # the finished SDK an "S0 skeleton". State the real surface instead.
    ("slice-label", re.compile(r"\bS\d\b")),
    ("stale-status", re.compile(r"\bskeleton\b", re.IGNORECASE)),
)

# The TREE tier: identifiers that resolve ONLY inside the producing
# repository, banned in EVERY hand-written file of the public python
# closure — code comments and docstrings included (owner rule for the
# public tree). Closure-internal path classes (script-path, client-path,
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

# What the tree walk covers: every hand-written file in the python closure,
# relative to --repo-root (which is the producing repo's project root
# upstream, and `python/` in the public mirror — the layouts agree below
# these paths). The exclusions each have their own seam, tracked upstream:
# the generated wire-types modules and the committed schema bundle render
# schema description text (sanitized for the docs site at render time; the
# same treatment at the codegen/schema seam is follow-up work), and this
# file itself IS the pattern table, so it cannot avoid containing its own
# patterns and is audited by review instead.
TREE_WALK_PATHS = (
    "clients/msp-py",
    "clients/py-dev-requirements.txt",
    "clients/sdk-cookbook-py",
    "clients/sdk-py",
    "clients/sdk-quickstart-py",
    "scripts/publish-sdk-pypi.sh",
    "scripts/sdk-py-wheel-rows.py",
)
TREE_WALK_EXCLUDED_DIRS = ("clients/msp-py/src",)
TREE_TEXT_SUFFIXES = {".py", ".md", ".toml", ".txt", ".json", ".sh", ".cfg", ".ndjson"}


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
    return findings


def tree_findings(repo_root: Path) -> list[str]:
    # The TREE tier: whole-file scan of every hand-written closure file, so a
    # producing-repo identifier in a comment, ledger note, or fixture cannot
    # ship in the public tree again.
    findings: list[str] = []
    excluded = tuple(repo_root / d for d in TREE_WALK_EXCLUDED_DIRS)
    walked = 0
    for root in TREE_WALK_PATHS:
        path = repo_root / root
        if not path.exists():
            continue
        for file in sorted([path] if path.is_file() else path.rglob("*")):
            if not file.is_file() or file.suffix not in TREE_TEXT_SUFFIXES:
                continue
            if any(file.is_relative_to(d) for d in excluded):
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
                    if not _generated(entry):
                        findings += findings_in(source, where, TREE_PRIVATE_PATTERNS)
    for sdist in sdists:
        with tarfile.open(sdist) as archive:
            for member in archive.getmembers():
                where = f"{sdist.name}!{member.name}"
                if member.name.endswith("PKG-INFO"):
                    payload = archive.extractfile(member)
                    assert payload is not None
                    findings += findings_in(payload.read().decode("utf-8"), where)
                elif member.name.endswith(".py") and not _generated(member.name):
                    # The sdist ships EVERYTHING setuptools collects — the
                    # 1.3.0 sdist carried the whole tests/ tree, so packaged
                    # .py files are public down to their comments.
                    payload = archive.extractfile(member)
                    assert payload is not None
                    findings += findings_in(
                        payload.read().decode("utf-8"), where, TREE_PRIVATE_PATTERNS
                    )
    return findings


def _generated(entry: str) -> bool:
    # The generated wire-types modules render schema description text; their
    # sanitization seam is the codegen/schema export (tracked upstream), so
    # the whole-file TREE tier does not apply to them. Their module
    # docstrings stay gated above.
    return "muse_code_msp" in entry.split("/")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo-root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument(
        "--dist",
        type=Path,
        default=None,
        help="audit built distributions under this directory instead of the tree",
    )
    args = parser.parse_args()

    findings = (
        check_dist(args.dist) if args.dist is not None else check_tree(args.repo_root)
    )
    if findings:
        print(
            "FAILED: the published Python package surface references private "
            "repository artifacts:",
            file=sys.stderr,
        )
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        print(
            "Rewrite the text for a PyPI reader (they have the package, "
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
