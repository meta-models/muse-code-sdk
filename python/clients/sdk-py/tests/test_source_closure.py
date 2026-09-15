"""PY-TEST-025 ``source_closure_covers_python_tree`` (specs/638-muse-sdk-python).

FR-638-031: ``scripts/sdk-source-closure.json`` carries the Python closure —
both packages, the journey and cookbook harnesses, the dev lock, and the
publish-path scripts — each explained in ``path_notes`` and destined for the
mirror's ``python/`` tree (ADR 638 D6). The TS-side guard
(``clients/sdk-ts/test/sdk-source-closure.test.ts``) checks list -> tree
(every listed path exists, is explained, sorted); this file checks the other
direction, tree -> list: the Python source a wheel build needs cannot
silently fall out of what a republish carries.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = PROJECT_ROOT / "scripts" / "sdk-source-closure.json"

# The publish path the mirror workflow calls; both must survive the mirror
# with their execute story intact (the TS PUBLISH_SCRIPT arm's reasoning).
PUBLISH_SCRIPTS = (
    "scripts/publish-sdk-pypi.sh",
    "scripts/sdk-py-wheel-rows.py",
)


def _manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text())


def _python_client_trees() -> list[str]:
    # Derived from the tree, never a hand-kept list: every Python client tree
    # under clients/ (the `-py` naming the plan fixes: the two packages, the
    # journey, the cookbook) is publication source — the docs link readers at
    # the harnesses, and the wheels build from the packages — so a NEW one
    # must join the closure to land at all.
    return sorted(
        f"clients/{entry.name}"
        for entry in (PROJECT_ROOT / "clients").iterdir()
        if entry.is_dir() and entry.name.endswith("-py")
    )


def test_the_closure_covers_the_python_tree() -> None:
    closure = set(_manifest()["closure_paths"])
    missing = [tree for tree in _python_client_trees() if tree not in closure]
    assert not missing, (
        f"Python source missing from the publication closure: {missing} — a "
        "republish would carry less than the wheels are built from (FR-638-031)"
    )
    assert "clients/py-dev-requirements.txt" in closure, (
        "the dev lock pins the mirror's build tooling (build, setuptools); "
        "without it a mirror build resolves different tools than CI proved"
    )
    for script in PUBLISH_SCRIPTS:
        assert script in closure, (
            f"{script} must be a closure path: the mirror's publish-pypi.yml "
            "calls the gate script by path, and the gate script calls the row "
            "generator — a republish without either dead-ends the publish"
        )


def test_every_python_closure_path_is_explained() -> None:
    manifest = _manifest()
    notes = manifest["path_notes"]
    expected = [*_python_client_trees(), "clients/py-dev-requirements.txt", *PUBLISH_SCRIPTS]
    unexplained = [p for p in expected if not notes.get(p, "").strip()]
    assert not unexplained, (
        f"closure paths without a path_note: {unexplained} — the closure is "
        "published source; a path nobody can explain is a path nobody decided "
        "to publish"
    )


def test_the_publish_scripts_survive_the_mirror_executable() -> None:
    for script in PUBLISH_SCRIPTS:
        assert os.access(PROJECT_ROOT / script, os.X_OK), (
            f"{script} lost its execute bit; the mirror workflow's [ -x ] "
            "guard fails exactly as a missing file does"
        )


def test_the_mirror_destination_is_the_python_tree() -> None:
    # ADR 638 D6: the Python closure lands under a `python/` tree of the same
    # mirror, unlike the TS paths, which keep their layout verbatim. The
    # manifest must SAY so where the bridge operator reads it, or the first
    # republish guesses.
    mirror = _manifest()["mirror"]
    note = " ".join(mirror.get("python_tree", []))
    assert "python/" in note, (
        "scripts/sdk-source-closure.json's mirror section must state that the "
        "Python closure paths land under the mirror's python/ tree (ADR 638 "
        "D6, owner bridge one-timer)"
    )
