"""The external-audience gate: package metadata AND the public source tree.

The first PyPI publish shipped long descriptions, a pyproject summary, and
module docstrings citing artifacts only the producing repository resolves;
a follow-up sweep found the same class in the mirrored tree's ledger notes,
script comments, and test fixtures. A PyPI reader has the published
package, the public mirror (meta-models/muse-code-sdk) and the public docs
site — nothing else, and the public tree carries no real internal
identifiers anywhere, code comments included.

Four arms: the tree is clean NOW (each repair's RED), the checker refuses
each leak class (proven under seeded faults, so the pins cannot go
vacuous), the TREE tier catches a leak in any hand-written closure file,
and the publish gate script runs the checker over the BUILT distributions
(so the wiring cannot silently drop out). One shared implementation:
``scripts/check-sdk-py-external-audience.py``. All seeded fault strings
below are SYNTHETIC (never a real internal artifact) and runtime-assembled,
so this file's own text stays clean under the tree tier.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CHECKER = PROJECT_ROOT / "scripts" / "check-sdk-py-external-audience.py"
GATE_SCRIPT = PROJECT_ROOT / "scripts" / "publish-sdk-pypi.sh"


def _checker_pattern_classes() -> tuple[set[str], set[str]]:
    # Load the table FROM the script, so a class added there without a
    # refusal fixture here reds the exhaustiveness pin instead of shipping
    # ungated (the vacuous-regex hole: a pattern edited to never match keeps
    # every seeded test green unless the seed set is exhaustive by name).
    spec = importlib.util.spec_from_file_location("audience_checker", CHECKER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return (
        {class_id for class_id, _ in module.PRIVATE_REFERENCE_PATTERNS},
        {class_id for class_id, _ in module.TREE_PRIVATE_PATTERNS},
    )

# A wall, not a budget: the checker reads a handful of
# small text files; a longer run is a hang.
CHECKER_WALL_SECONDS = 120


def _run_checker(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), *args],
        capture_output=True,
        text=True,
        timeout=CHECKER_WALL_SECONDS,
        check=False,
    )


def test_the_committed_package_surface_is_external_clean() -> None:
    # The repair's RED: on the leaking tree this fails listing every finding;
    # after the scrub it pins the tree clean for every later PR.
    result = _run_checker("--repo-root", str(PROJECT_ROOT))
    assert result.returncode == 0, (
        "the committed READMEs / pyproject descriptions / module docstrings "
        f"reference private repository artifacts:\n{result.stderr}"
    )


def _seeded_tree(tmp_path: Path, readme_line: str, description: str) -> Path:
    # A minimal fixture tree of exactly the files the tree mode reads, so the
    # refusal arms run against a fault we control rather than the real tree
    # (which the arm above requires to stay clean).
    for package, import_name in (
        ("clients/msp-py", "muse_code_msp"),
        ("clients/sdk-py", "muse_code"),
    ):
        package_dir = tmp_path / package
        (package_dir / "src" / import_name).mkdir(parents=True)
        (package_dir / "README.md").write_text(f"# clean\n\n{readme_line}\n")
        (package_dir / "pyproject.toml").write_text(
            f'[project]\nname = "x"\nversion = "0.0.0"\ndescription = "{description}"\n'
        )
        (package_dir / "src" / import_name / "__init__.py").write_text(
            '"""A clean module docstring."""\n'
        )
    # Enough hand-written files for the tree walk's floor.
    tests_dir = tmp_path / "clients" / "sdk-py" / "tests"
    tests_dir.mkdir(parents=True)
    (tests_dir / "test_clean.py").write_text("# a clean test comment\n")
    (tmp_path / "clients" / "py-dev-requirements.txt").write_text("# clean\n")
    return tmp_path


def test_a_clean_fixture_tree_passes(tmp_path: Path) -> None:
    # The positive anchor for the refusal arms: the fixture shape itself is
    # accepted, so a refusal below is the seeded fault and not a fixture
    # artifact.
    tree = _seeded_tree(tmp_path, "Install with pip.", "A clean summary.")
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode == 0, result.stderr


# One SYNTHETIC representative per pattern class — never a real internal
# artifact — exhaustive by name against the script's own table: a class
# added there without a fixture here, or a pattern edited to never match,
# reds the exhaustiveness pin instead of going silently vacuous. Every
# fixture is runtime-assembled so this file's static text carries no
# pattern-matching token (the tree tier scans this file too, and the
# mirrored-source audience profile ships it publicly).
LEAKS = {
    "spec-path": "See " + "spec" + "s/0000-example-feature for the rules.",
    "adr-citation": "the " + "AD" + "R 9999 supply-chain exception",
    "adr-path": "the record is " + "docs/" + "adr/0000-example.md",
    "tracker-number": "chartered by issue " + "#9" + "9999",
    "requirement-id": "No hand-written types, ever (" + "INV-" + "0000-EX).",
    "task-id": "the approval round trip (" + "T9" + "99)",
    "decision-id": "owned by decision record D-" + "999",
    "scenario-ref": "the sync wrapper (" + "Scen" + "ario 9.9)",
    "spec-section": "buffer live events per " + "SS9" + ".99 as they arrive",
    "spec-number": "spec 9" + "999 owns this surface",
    "spec-doc": "the " + "td" + "d spells the recipe out",
    "dev-loop-path": "cd projects/" + "tb" + "h && pytest",
    "internal-name": "CI runs this in the " + "tb" + "h-example workflow",
    "source-path": "the required test " + "crate" + "s/example/tests/x.rs",
    "script-path": "rerun " + "scripts/" + "example-regen.sh instead",
    "schema-path": "rendered from " + "schema/" + "msp bundles",
    "private-repo": "file an issue on mslsrc/" + "tb" + "h",
    "client-path": "mirrors " + "clients/" + "example-kit exactly",
    "slice-label": "lands slice by slice (" + "S1" + " onward)",
    "stale-status": "Status: a " + "skele" + "ton implementation.",
}

# Tree-tier-only classes (banned in every hand-written closure file but not
# part of the metadata table), same synthetic/assembled rules.
TREE_LEAKS = {
    "producing-docs-path": "twin page: " + "developer-" + "docs/example.mdx",
    "test-charter-id": "pinned by " + "PY-TEST-" + "999",
}


def test_the_leak_fixtures_are_exhaustive_by_class() -> None:
    metadata_classes, tree_classes = _checker_pattern_classes()
    assert set(LEAKS) == metadata_classes, (
        f"unseeded classes: {sorted(metadata_classes - set(LEAKS))}; "
        f"stale fixtures: {sorted(set(LEAKS) - metadata_classes)}"
    )
    tree_only = tree_classes - metadata_classes
    assert set(TREE_LEAKS) == tree_only, (
        f"unseeded tree-only classes: {sorted(tree_only - set(TREE_LEAKS))}; "
        f"stale fixtures: {sorted(set(TREE_LEAKS) - tree_only)}"
    )


@pytest.mark.parametrize("class_id", sorted(LEAKS))
def test_each_leak_class_is_refused(tmp_path: Path, class_id: str) -> None:
    line = LEAKS[class_id]
    tree = _seeded_tree(tmp_path, line, "A clean summary.")
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode != 0, (
        f"a README carrying a {class_id} leak ({line!r}) passed the gate"
    )
    assert class_id in result.stderr, (
        f"the refusal must name the {class_id} class:\n{result.stderr}"
    )


def test_the_pyproject_description_is_gated_too(tmp_path: Path) -> None:
    # The 1.3.0 msp summary itself carried the leak; METADATA's Summary line
    # comes from this field, so it is gated independently of the README.
    tree = _seeded_tree(
        tmp_path,
        "Install with pip.",
        "No hand-written types (" + "spec" + "s/0000-example " + "INV-" + "0000-EX).",
    )
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode != 0
    assert "description" in result.stderr


def test_a_module_docstring_leak_is_refused(tmp_path: Path) -> None:
    tree = _seeded_tree(tmp_path, "Install with pip.", "A clean summary.")
    module = tree / "clients" / "sdk-py" / "src" / "muse_code" / "__init__.py"
    module.write_text('"""Owning spec: ' + "spec" + 's/0000-example."""\n')
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode != 0
    assert "module docstring" in result.stderr


@pytest.mark.parametrize("class_id", sorted(TREE_LEAKS))
def test_tree_only_classes_are_refused(tmp_path: Path, class_id: str) -> None:
    tree = _seeded_tree(tmp_path, "Install with pip.", "A clean summary.")
    test_file = tree / "clients" / "sdk-py" / "tests" / "test_clean.py"
    test_file.write_text(f"# {TREE_LEAKS[class_id]}\n")
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode != 0, (
        f"a test-file comment carrying a {class_id} leak passed the tree tier"
    )
    assert class_id in result.stderr


def test_the_tree_tier_scans_comments_and_ledgers(tmp_path: Path) -> None:
    # The follow-up sweep's two shapes: a citation in a code COMMENT of a
    # hand-written closure file, and one in a JSON ledger note. Neither is
    # package metadata; both must refuse.
    tree = _seeded_tree(tmp_path, "Install with pip.", "A clean summary.")
    test_file = tree / "clients" / "sdk-py" / "tests" / "test_clean.py"
    test_file.write_text("# governed by " + "AD" + "R 9999\n")
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode != 0
    assert "adr-citation" in result.stderr
    test_file.write_text("# a clean test comment\n")
    ledger = tree / "clients" / "sdk-py" / "ledger.json"
    ledger.write_text('{"note": "permitted by ' + "D-" + '999"}\n')
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode != 0
    assert "decision-id" in result.stderr


def test_closure_internal_paths_stay_legal_in_tree_files(tmp_path: Path) -> None:
    # The tree tier bans producing-repo identifiers, NOT the closure's own
    # paths: a mirror reader has the tree, so a reference into it resolves.
    tree = _seeded_tree(tmp_path, "Install with pip.", "A clean summary.")
    test_file = tree / "clients" / "sdk-py" / "tests" / "test_clean.py"
    test_file.write_text(
        "# reads " + "clients/" + "sdk-py/pyproject.toml via "
        + "scripts/" + "example.sh\n"
    )
    result = _run_checker("--repo-root", str(tree))
    assert result.returncode == 0, result.stderr


def test_the_publish_gate_runs_the_checker_over_the_built_dist() -> None:
    # The wiring half: the publish gate script must run this checker in
    # --dist mode after the build AND die on its refusal, so what is audited
    # is what the upload step ships. Pinned as the live line shape — a bare
    # substring pin held before this gate existed (Gate 5 already carried a
    # `--dist`), and `|| true` in place of `|| die` would slip past both the
    # substring pin and test_publish_shape's clean build-only run.
    script = GATE_SCRIPT.read_text()
    assert re.search(
        r'^"\$PYTHON" "\$REPO_ROOT/scripts/check-sdk-py-external-audience\.py"'
        r' --dist "\$DISTDIR" \|\|\n\s+die ',
        script,
        re.M,
    ), (
        "the publish gate must run the audience checker in --dist mode and "
        "die on refusal, or the next publish could re-ship the 1.3.0 leak "
        "again"
    )


def _seeded_dist(
    tmp_path: Path,
    *,
    metadata_extra: str = "",
    docstring: str = "A clean module docstring.",
    pkg_info_extra: str = "",
    sdist_extra_py: str | None = None,
) -> Path:
    # A minimal built-distribution pair of exactly the entries the dist walk
    # reads: one wheel (METADATA + a packaged module) and one sdist
    # (PKG-INFO). Faults are seeded per audited site so each refusal arm
    # proves its own filter — a typo'd endswith would pass the empty-dir arm
    # and every clean build forever.
    dist = tmp_path / "dist"
    dist.mkdir()
    with zipfile.ZipFile(dist / "x-0.0.0-py3-none-any.whl", "w") as wheel:
        wheel.writestr(
            "x-0.0.0.dist-info/METADATA",
            f"Metadata-Version: 2.4\nName: x\nSummary: clean\n\nBody. {metadata_extra}\n",
        )
        wheel.writestr("x/__init__.py", f'"""{docstring}"""\n')
    with tarfile.open(dist / "x-0.0.0.tar.gz", "w:gz") as sdist:
        payload = tmp_path / "PKG-INFO"
        payload.write_text(f"Metadata-Version: 2.4\nName: x\n\nBody. {pkg_info_extra}\n")
        sdist.add(payload, arcname="x-0.0.0/PKG-INFO")
        if sdist_extra_py is not None:
            extra = tmp_path / "test_extra.py"
            extra.write_text(sdist_extra_py)
            sdist.add(extra, arcname="x-0.0.0/tests/test_extra.py")
    return dist


def test_a_clean_dist_tree_passes(tmp_path: Path) -> None:
    # The positive anchor for the dist refusal arms below.
    result = _run_checker("--dist", str(_seeded_dist(tmp_path)))
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize(
    ("site", "seed"),
    [
        ("METADATA", {"metadata_extra": "See " + "spec" + "s/0000-example."}),
        ("module docstring", {"docstring": "Owning spec: " + "spec" + "s/0000-example."}),
        ("PKG-INFO", {"pkg_info_extra": "chartered by issue " + "#9" + "9999"}),
    ],
    ids=["wheel-metadata", "packaged-docstring", "sdist-pkg-info"],
)
def test_each_dist_site_is_refused(tmp_path: Path, site: str, seed: dict[str, str]) -> None:
    result = _run_checker("--dist", str(_seeded_dist(tmp_path, **seed)))
    assert result.returncode != 0, f"a leak in the {site} site passed the dist gate"
    assert site in result.stderr, (
        f"the refusal must name the {site} site:\n{result.stderr}"
    )


def test_a_packaged_test_file_comment_is_refused(tmp_path: Path) -> None:
    # The sdist ships the whole tests/ tree, so a citation in a packaged
    # test file's COMMENT is public too (how the first sdist leaked beyond
    # its metadata). Seeded into the sdist fixture as an extra .py member.
    dist = _seeded_dist(
        tmp_path, sdist_extra_py="# governed by " + "AD" + "R 9999\n"
    )
    result = _run_checker("--dist", str(dist))
    assert result.returncode != 0
    assert "adr-citation" in result.stderr


def test_the_dist_mode_refuses_an_empty_dist_tree(tmp_path: Path) -> None:
    # Fail closed, not vacuously green, when there is nothing to audit.
    result = _run_checker("--dist", str(tmp_path))
    assert result.returncode != 0
    assert "no built wheel/sdist" in result.stderr
