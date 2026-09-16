"""Turns N cookbook recipes into one verdict — the Python twin of
``clients/sdk-cookbook/src/runner.ts``.

Each recipe is a small journey (the quickstart's ``Segment`` contract) plus
a declaration of which host binaries it needs. The runner runs them one at a
time, in manifest order, and fails the whole run when a recipe fails, when a
recipe's journey report is NOT OK, or when a declared host binary was not
provided — a verdict that quietly thinned is not a verdict.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable, Literal, Sequence

from quickstart_journey.segments import JourneyReport, format_report

HostNeed = Literal["muse_bin", "conformance_bin"]

HOST_ENV: dict[str, str] = {
    "muse_bin": "MUSE_BIN",
    "conformance_bin": "MUSE_CONFORMANCE_BIN",
}
"""The env-var spelling for each host, used verbatim in failure messages."""


@dataclass(frozen=True)
class RecipeHosts:
    """The binaries a CI run provides once and every recipe shares.

    Attributes:
        transcript_root: Root of the committed golden-transcript corpus
            (``schema/msp/transcripts``).
        muse_bin: Absolute path to the release-built ``muse`` binary, when
            provided.
        conformance_bin: Absolute path to the ``muse-conformance`` binary,
            when provided.
    """

    transcript_root: str
    muse_bin: str | None = None
    conformance_bin: str | None = None


@dataclass(frozen=True)
class Recipe:
    """One runnable, documented cookbook entry.

    Attributes:
        id: The recipe id — equal to its TS twin's (PY-TEST-021 parity).
        title: Plain-words title, used verbatim in the printed report.
        docs_page: Repository-relative path of the docs page this backs.
        needs: Which of :class:`RecipeHosts` this recipe cannot run without.
        run: Runs the recipe's journey. Raising marks the recipe failed.
    """

    id: str
    title: str
    docs_page: str
    needs: tuple[HostNeed, ...]
    run: Callable[[RecipeHosts], Awaitable[JourneyReport]]


@dataclass(frozen=True)
class RecipeResult:
    """One recipe's outcome: its journey report, or why it never ran.

    Attributes:
        report: The journey report, when the recipe ran to a report at all.
        failure: Why the recipe failed outside its own journey (a missing
            host binary, or a raise).
    """

    id: str
    title: str
    docs_page: str
    report: JourneyReport | None
    failure: str | None


@dataclass(frozen=True)
class CookbookReport:
    """Every recipe result; ``ok`` iff every recipe's journey report is OK."""

    recipes: tuple[RecipeResult, ...]
    ok: bool


def select_recipes(recipes: Sequence[Recipe], only_id: str | None) -> Sequence[Recipe]:
    """Pick one recipe by id for a focused local run (``--only <id>``).

    An unknown id fails loud, naming the known ids — a filter that silently
    matches nothing would print a green verdict over zero recipes.
    """
    if only_id is None:
        return recipes
    matched = [recipe for recipe in recipes if recipe.id == only_id]
    if not matched:
        known = ", ".join(recipe.id for recipe in recipes)
        raise ValueError(f'no recipe with id "{only_id}"; known recipes: {known}')
    return matched


async def run_recipes(recipes: Sequence[Recipe], hosts: RecipeHosts) -> CookbookReport:
    """Run every recipe serially, in manifest order."""
    results = [await _run_one(recipe, hosts) for recipe in recipes]
    return CookbookReport(
        recipes=tuple(results),
        ok=all(r.failure is None and r.report is not None and r.report.ok for r in results),
    )


async def _run_one(recipe: Recipe, hosts: RecipeHosts) -> RecipeResult:
    missing = [
        need for need in recipe.needs if not getattr(hosts, need)
    ]
    if missing:
        plural = "y" if len(missing) == 1 else "ies"
        detail = ", ".join(f"{need} (set {HOST_ENV[need]})" for need in missing)
        return RecipeResult(
            id=recipe.id,
            title=recipe.title,
            docs_page=recipe.docs_page,
            report=None,
            failure=f"missing required host binar{plural}: {detail}",
        )
    try:
        report = await recipe.run(hosts)
    except Exception as error:  # noqa: BLE001 - the verdict carries the text
        return RecipeResult(
            id=recipe.id,
            title=recipe.title,
            docs_page=recipe.docs_page,
            report=None,
            failure=f"{type(error).__name__}: {error}",
        )
    return RecipeResult(
        id=recipe.id, title=recipe.title, docs_page=recipe.docs_page, report=report, failure=None
    )


def format_cookbook_report(report: CookbookReport) -> str:
    """The human-facing report: every recipe, its journey lines, one verdict."""
    lines: list[str] = []
    failed = 0
    for result in report.recipes:
        recipe_failed = result.failure is not None or result.report is None or not result.report.ok
        if recipe_failed:
            failed += 1
        lines.append(f"=== {'FAIL' if recipe_failed else 'OK  '} {result.id}  {result.title}")
        if result.failure is not None:
            lines.append(f"    {result.failure}")
        if result.report is not None:
            lines.extend(f"    {line}" for line in format_report(result.report).split("\n"))
    lines.append(
        f"cookbook {'OK' if report.ok else 'NOT OK'} "
        f"(recipes={len(report.recipes)} failed={failed})"
    )
    return "\n".join(lines)
