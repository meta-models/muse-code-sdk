"""PY-TEST-021 ``cookbook_twins_execute`` (specs/638-muse-sdk-python).

FR-638-024 / ADR 638 D8 ruling 3: a Python twin per cookbook recipe, the set
DISCOVERED from the TS cookbook tree (never a count), each CI-executed
against the release-built host and the ``muse-conformance`` fixture host.

Three properties:

* discovery parity — for every recipe the TS tree exports, a twin with the
  same id, title, and docs page exists here; a NEW TS recipe with no twin
  reds this test, and an orphan twin with no TS recipe reds it too;
* the manifest preserves the TS manifest's ratified order;
* execution — every twin's journey runs to an OK report, one test per
  recipe. The execution arms need the two host binaries; they SKIP (never
  silently pass) when the env does not provide them, and the
  ``cookbook-py-journeys`` CI job provides both, so CI is where the arms are
  always real. The one owner-directed divergence is inside the
  ``fingerprint-mismatch`` twin itself (the strict C-638-4 fork; its
  docstring names it).
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

import pytest

from cookbook_recipes.manifest import RECIPES
from cookbook_recipes.runner import (
    HOST_ENV,
    Recipe,
    RecipeHosts,
    format_cookbook_report,
    run_recipes,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
TS_RECIPES_DIR = PROJECT_ROOT / "clients" / "sdk-cookbook" / "src" / "recipes"
TS_MANIFEST = PROJECT_ROOT / "clients" / "sdk-cookbook" / "src" / "manifest.ts"
TRANSCRIPT_ROOT = PROJECT_ROOT / "schema" / "msp" / "transcripts"

# Anchored to the exported Recipe literal, exactly like the docs example
# publisher's reader: a recipe body is full of its own `id:` fields (approval
# choices, for one), and a file-wide search returns the first of those.
_RECIPE_LITERAL = re.compile(r"^export const (\w+): Recipe = \{$", re.MULTILINE)


def _ts_recipe_metadata(source: str, label: str) -> dict[str, str]:
    matched = _RECIPE_LITERAL.search(source)
    if matched is None:
        raise AssertionError(f"{label}: no exported Recipe literal")
    declaration = source[matched.start() :]
    fields: dict[str, str] = {"export": matched.group(1)}
    for field in ("id", "title", "docsPage"):
        entry = re.search(rf'^\s{{2}}{field}: "((?:[^"\\]|\\.)*)",$', declaration, re.MULTILINE)
        if entry is None:
            raise AssertionError(f"{label}: recipe declares no {field}")
        fields[field] = re.sub(r"\\(.)", r"\1", entry.group(1))
    return fields


def _ts_recipes() -> dict[str, dict[str, str]]:
    """Every TS recipe, DISCOVERED from the source tree, keyed by id."""
    discovered: dict[str, dict[str, str]] = {}
    for path in sorted(TS_RECIPES_DIR.glob("*.ts")):
        metadata = _ts_recipe_metadata(path.read_text(), str(path))
        discovered[metadata["id"]] = metadata
    assert discovered, f"no TS recipes discovered under {TS_RECIPES_DIR}"
    return discovered


def _twins() -> dict[str, Recipe]:
    return {recipe.id: recipe for recipe in RECIPES}


@pytest.mark.parametrize("ts_id", sorted(_ts_recipes()))
def test_every_ts_recipe_has_a_twin(ts_id: str) -> None:
    ts = _ts_recipes()[ts_id]
    twin = _twins().get(ts_id)
    assert twin is not None, (
        f"the TS cookbook exports recipe {ts_id!r} "
        f"({ts['export']}) but the Python manifest has no twin (FR-638-024)"
    )
    assert twin.title == ts["title"], f"{ts_id}: the twin's title drifted from the TS recipe's"
    assert twin.docs_page == ts["docsPage"], (
        f"{ts_id}: the twin backs a different docs page than the TS recipe"
    )


def test_no_orphan_twins_and_the_ratified_order_holds() -> None:
    ts_ids = set(_ts_recipes())
    twin_ids = [recipe.id for recipe in RECIPES]
    orphans = set(twin_ids) - ts_ids
    assert not orphans, f"twins with no TS recipe: {sorted(orphans)}"
    assert len(twin_ids) == len(set(twin_ids)), "the Python manifest repeats a recipe id"
    # The ratified numeric order is the TS manifest's array order: map its
    # export names back to ids through the discovered metadata.
    manifest_source = TS_MANIFEST.read_text()
    array = re.search(r"RECIPES: readonly Recipe\[\] = \[(.*?)\];", manifest_source, re.DOTALL)
    assert array is not None, "the TS manifest lost its RECIPES array; update this parser"
    export_order = [name.strip().rstrip(",") for name in array.group(1).split("\n") if name.strip()]
    by_export = {metadata["export"]: metadata["id"] for metadata in _ts_recipes().values()}
    # An unmappable manifest export must fail LOUD: FR-638-024 says the
    # manifest IS the set, so an entry the discovery cannot map (a second
    # export in one file, a recipe outside the glob) is a gate defect, never
    # a silently-shrunk comparison (review finding on this PR).
    unknown = [name for name in export_order if name not in by_export]
    assert not unknown, f"manifest exports with no discovered recipe file: {unknown}"
    ts_order = [by_export[name] for name in export_order]
    assert twin_ids == ts_order, (
        f"the Python manifest order {twin_ids} differs from the TS ratified order {ts_order}"
    )


def _hosts_or_skip(recipe: Recipe) -> RecipeHosts:
    # HOST_ENV is the single need->env source (review finding: a hand copy
    # here would not know a third HostNeed and would red instead of skip).
    provided = {need: os.environ.get(env) or None for need, env in HOST_ENV.items()}
    for need in recipe.needs:
        if provided.get(need) is None:
            # "A skip is never the CI verdict" is ENFORCED, not narrated: the
            # workflow sets MUSE_COOKBOOK_REQUIRE_HOSTS, so an env-block
            # drift fails the lane instead of green-skipping every twin.
            if os.environ.get("MUSE_COOKBOOK_REQUIRE_HOSTS"):
                pytest.fail(
                    f"recipe {recipe.id} needs {HOST_ENV[need]} but it is unset "
                    "and this run requires the host binaries"
                )
            pytest.skip(
                f"recipe {recipe.id} needs {HOST_ENV[need]}; the "
                "cookbook-py-journeys CI job provides it"
            )
    return RecipeHosts(transcript_root=str(TRANSCRIPT_ROOT), **provided)


@pytest.mark.parametrize("recipe", RECIPES, ids=[recipe.id for recipe in RECIPES])
def test_cookbook_twins_execute(recipe: Recipe) -> None:
    """FR-638-024's execution half: the twin's whole journey, for real."""
    hosts = _hosts_or_skip(recipe)
    report = asyncio.run(run_recipes([recipe], hosts))
    assert report.ok, f"recipe {recipe.id} failed:\n{format_cookbook_report(report)}"
