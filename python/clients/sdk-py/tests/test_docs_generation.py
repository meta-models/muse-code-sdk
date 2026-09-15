"""PY-TEST-022 ``docs_reference_generation_gates`` (specs/638-muse-sdk-python).

FR-638-026 / ADR 638 D8 ruling 2: the ``python/`` reference tree is generated
from Google-style docstrings + type hints through the site's existing
``generate`` script — the extraction half of that script is
``developer-docs/scripts/extract-python-reference.py``, exercised here
directly (stdlib-only, so this suite needs no Node toolchain):

* clean extraction over the real tree succeeds, covers exactly
  ``muse_code.__all__``, and is deterministic (byte-identical double run —
  the regen-clean substrate; the docs build's double-build manifest
  comparison enforces the same property over the rendered tree);
* a seeded missing docstring fails extraction NAMING the symbol (FM-638-5).

FR-638-025's language-tab arm of this test id lives in the docs-lane
suite ``developer-docs/tests/language-tabs.test.mjs`` — ONE copy, in the
lane that triggers on every page-changing PR (see the spec's arm-homes
note on PY-TEST-022).
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
EXTRACTOR = PROJECT_ROOT / "developer-docs" / "scripts" / "extract-python-reference.py"
MUSE_CODE_SRC = PROJECT_ROOT / "clients" / "sdk-py" / "src"

# A wall, not a budget: extraction is a sub-second AST pass (deadlock cap).
EXTRACT_WALL_SECONDS = 120


def _run_extractor(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(EXTRACTOR), "--repo-root", str(PROJECT_ROOT), *args],
        capture_output=True,
        text=True,
        timeout=EXTRACT_WALL_SECONDS,
        check=False,
    )


def test_extraction_over_the_real_tree_is_clean_and_covers_all() -> None:
    result = _run_extractor()
    assert result.returncode == 0, (
        f"reference extraction reds over the shipped tree (FR-638-026):\n{result.stderr}"
    )
    model = json.loads(result.stdout)
    sys.path.insert(0, str(MUSE_CODE_SRC))
    try:
        import muse_code
    finally:
        sys.path.pop(0)
    assert {s["name"] for s in model["symbols"]} == set(muse_code.__all__), (
        "the generated reference and __all__ disagree about the public surface"
    )
    for symbol in model["symbols"]:
        assert symbol["doc"]["summary"], f"{symbol['name']} extracted with no summary"


def test_extraction_is_deterministic() -> None:
    first = _run_extractor()
    second = _run_extractor()
    assert first.returncode == 0 and second.returncode == 0
    assert first.stdout == second.stdout, (
        "two extractions over one tree differ; the docs build's determinism "
        "gate would red on this (FR-638-026 regen-clean)"
    )


def test_a_seeded_missing_docstring_fails_naming_the_symbol(tmp_path: Path) -> None:
    seeded = tmp_path / "src"
    shutil.copytree(
        MUSE_CODE_SRC / "muse_code",
        seeded / "muse_code",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    init = seeded / "muse_code" / "__init__.py"
    text = init.read_text()
    anchor = '"""The stable schema-bundle fingerprint'
    assert anchor in text, "the seed anchor moved; update this test's anchor"
    # Turning the attribute docstring into an ordinary assignment strips the
    # pin's documentation without touching any other symbol.
    init.write_text(text.replace(anchor, f"_SEED = {anchor}", 1))
    result = _run_extractor("--sdk-src", str(seeded))
    assert result.returncode != 0, "extraction accepted an undocumented public symbol"
    assert "EXPECTED_SCHEMA_FINGERPRINT" in result.stderr, (
        f"the refusal does not name the symbol:\n{result.stderr}"
    )
    assert "docstring" in result.stderr
