"""PY-TEST-020 ``readme_matches_journey`` — spec 638 FR-638-023 (T041, ADR
638 D8 ruling 3): the code on the page is the code that runs.

Binary-free, two contracts:

1. Every ``python`` code fence in README.md is a VERBATIM excerpt of this
   package's sources (whitespace-normalized), so a page edit that drifts from
   the program — or a program edit that strands the page — reds here rather
   than shipping a quickstart that teaches code nobody runs.
2. The FR-638-023 disclosure: README carries a "What does not work yet"
   section IF AND ONLY IF the journey declares expect-blocks, and the section
   then mirrors them exactly (the TS quickstart's D-013 self-retirement
   contract, both directions).
"""

from __future__ import annotations

import re
from pathlib import Path

from quickstart_journey import EXPECT_BLOCKED

HERE = Path(__file__).resolve().parent
README = HERE.parent / "README.md"
SOURCES = sorted((HERE.parent / "src" / "quickstart_journey").glob("*.py"))

BLOCKED_HEADING = "## What does not work yet"


def _normalize(code: str) -> str:
    # Whitespace-normalized containment: indentation on the page may differ
    # from the module's nesting, but every non-blank LINE must appear, in
    # order, in one source file.
    return "\n".join(
        line.strip() for line in code.strip().splitlines() if line.strip()
    )


def _python_fences(markdown: str) -> list[str]:
    return re.findall(r"```python\n(.*?)```", markdown, flags=re.DOTALL)


def _is_excerpt(wanted: str, sources: list[str]) -> bool:
    # Anchored on line boundaries: a raw substring would let a half line on
    # the page pass (PR #32537 review round 2; the synthetic-RED arm below
    # keeps this predicate honest).
    return any(f"\n{wanted}\n" in f"\n{source}\n" for source in sources)


def test_the_excerpt_predicate_rejects_half_lines() -> None:
    source = _normalize("alpha one\nbeta two\ngamma three\n")
    assert _is_excerpt(_normalize("beta two"), [source])
    assert _is_excerpt(_normalize("alpha one\nbeta two"), [source])
    # A first-line SUFFIX and a last-line PREFIX are page typos, not excerpts.
    assert not _is_excerpt(_normalize("pha one\nbeta two"), [source])
    assert not _is_excerpt(_normalize("beta two\ngamma th"), [source])


def test_every_readme_python_fence_is_a_verbatim_excerpt_of_the_journey() -> None:
    markdown = README.read_text(encoding="utf-8")
    fences = _python_fences(markdown)
    assert fences, "the README teaches a Python journey; it must show Python code"
    normalized_sources = [
        (path.name, _normalize(path.read_text(encoding="utf-8"))) for path in SOURCES
    ]
    for index, fence in enumerate(fences):
        wanted = _normalize(fence)
        if not _is_excerpt(wanted, [source for _name, source in normalized_sources]):
            raise AssertionError(
                f"README python fence #{index + 1} is not an excerpt of any "
                f"quickstart_journey source — the code on the page must be the "
                f"code that runs (FR-638-023). Fence:\n{fence}"
            )


def _assert_blocked_disclosure(markdown: str, blocked: tuple[dict, ...]) -> None:
    """FR-638-023's D-013 self-retirement contract, both directions."""
    if not blocked:
        # A heading that promises a list of gaps and delivers the word
        # "nothing" is scaffolding, not disclosure.
        assert BLOCKED_HEADING not in markdown, (
            "nothing is expect-blocked, so the README must not carry the "
            f"'{BLOCKED_HEADING}' section at all"
        )
        return
    assert BLOCKED_HEADING in markdown, (
        f"{[b['id'] for b in blocked]} carry an expect_block, so the "
        f"README must have a '{BLOCKED_HEADING}' section"
    )
    for block in blocked:
        for issue in block["issues"]:
            assert f"#{issue}" in markdown, (
                f"blocked segment {block['id']} cites #{issue}, which the "
                "README's disclosure must mirror"
            )


def test_the_blocked_disclosure_matches_the_journeys_expect_blocks() -> None:
    _assert_blocked_disclosure(README.read_text(encoding="utf-8"), EXPECT_BLOCKED)


def test_the_disclosure_contract_binds_in_both_directions() -> None:
    # The blocked direction is unreachable from the real README alone (nothing
    # is expect-blocked today, deliberately), so both directions are proven on
    # synthetic fixtures — the TS twin's own shape (PR #32537 review round 2).
    import pytest

    blocked = ({"id": "frob", "issues": [12345]},)
    # Direction 1: a block with no disclosure section must fail.
    with pytest.raises(AssertionError, match="must have"):
        _assert_blocked_disclosure("# Quickstart\n", blocked)
    # …and a section without the block's issue number must fail.
    with pytest.raises(AssertionError, match="#12345"):
        _assert_blocked_disclosure(f"{BLOCKED_HEADING}\n\n- something else\n", blocked)
    # A mirroring section passes.
    _assert_blocked_disclosure(f"{BLOCKED_HEADING}\n\n- frob: #12345\n", blocked)
    # Direction 2: a lingering section with nothing blocked must fail.
    with pytest.raises(AssertionError, match="must not carry"):
        _assert_blocked_disclosure(f"{BLOCKED_HEADING}\n", ())
