"""Segment results and the expect-block contract — the Python twin of
``clients/sdk-cookbook/src/kit/segments.ts`` (spec 638 FR-638-022 / T040).

The journey runs every segment for real. A segment that today cannot pass
because of a named open issue carries an ``expect_block``. The block never
weakens the assertion and never stubs the segment out: the segment still
runs, still asserts the spec-correct behavior, and its real failure text is
kept in the report.

The contract has two directions, and the second one is the point:

- assertion fails with the SIGNATURE the named issues cause →
  ``expectBlocked``. The journey stays green and prints the issue numbers.
- assertion fails with anything else → ``failed``. A block excuses exactly
  the defect it names and nothing else.
- assertion PASSES while an expect-block is declared → ``unblocked``. The
  journey FAILS: the fix landed, so the segment must be promoted by deleting
  its ``expect_block``. A stale block cannot rot silently.
"""

from __future__ import annotations

import re
import time
import traceback
from dataclasses import dataclass
from typing import Awaitable, Callable, Generic, List, Literal, Sequence, TypeVar

_C = TypeVar("_C")

SegmentOutcome = Literal["passed", "expectBlocked", "unblocked", "failed"]
"""What actually happened when a segment ran (the TS vocabulary, verbatim)."""


@dataclass(frozen=True)
class ExpectBlock:
    """Why a segment cannot pass yet, in the issue tracker's own numbers.

    Attributes:
        issues: Open issue numbers. Empty is never valid.
        because: One plain sentence: what those issues do to this segment.
        signature: The failure text those issues produce. The block excuses
            ONLY a failure matching this; anything else is a real failure.
    """

    issues: tuple[int, ...]
    because: str
    signature: "re.Pattern[str]"


@dataclass(frozen=True)
class Segment(Generic[_C]):
    """One named step of the journey.

    Attributes:
        id: The step's stable id — the step-parity unit (FR-638-022).
        title: Plain-words title, used verbatim in the printed report.
        run: Runs the real work and raises on any failed assertion.
        expect_block: Present only while a named open issue stops this
            segment passing.
    """

    id: str
    title: str
    run: Callable[[_C], Awaitable[None]]
    expect_block: ExpectBlock | None = None


@dataclass(frozen=True)
class SegmentResult:
    """One executed segment: its outcome plus the kept failure evidence."""

    id: str
    title: str
    outcome: SegmentOutcome
    duration_ms: int
    expect_block: ExpectBlock | None
    failure: str | None


@dataclass(frozen=True)
class JourneyReport:
    """Every segment result; ``ok`` iff none is ``failed`` or ``unblocked``."""

    segments: tuple[SegmentResult, ...]
    ok: bool


def _describe(error: BaseException) -> str:
    cause = error.__cause__
    suffix = "" if cause is None else f"\n  caused by: {cause!r}"
    text = f"{type(error).__name__}: {error}"
    # One frame of provenance: a journey failure is read off CI logs, and a
    # bare message with no location sends the reader grepping.
    frames = traceback.extract_tb(error.__traceback__)
    where = f" (at {frames[-1].filename}:{frames[-1].lineno})" if frames else ""
    return f"{text}{where}{suffix}"


def classify(
    expect_block: ExpectBlock | None, failure: str | None
) -> SegmentOutcome:
    """The two-direction expect-block verdict (see the module docstring)."""
    if expect_block is None:
        return "passed" if failure is None else "failed"
    if failure is None:
        return "unblocked"
    return "expectBlocked" if expect_block.signature.search(failure) else "failed"


async def run_segment(
    segment: Segment[_C],
    context: _C,
    now: Callable[[], float] = time.monotonic,
) -> SegmentResult:
    """Runs one segment and classifies it (``now`` injected for unit tests)."""
    started = now()
    failure: str | None = None
    try:
        await segment.run(context)
    except Exception as error:  # noqa: BLE001 - kept as report evidence
        failure = _describe(error)
    return SegmentResult(
        id=segment.id,
        title=segment.title,
        outcome=classify(segment.expect_block, failure),
        duration_ms=round((now() - started) * 1000),
        expect_block=segment.expect_block,
        failure=failure,
    )


@dataclass(frozen=True)
class SyncSegment(Generic[_C]):
    """One named step of the SYNC journey rewrite (Scenario 7.1).

    A separate shape rather than a union on :class:`Segment`: the sync verbs
    refuse from a thread with a running event loop (FM-638-4), so the sync
    runner below must be a plain function — typing the run callable
    ``async`` here would reintroduce the loop the rewrite exists to not have.
    """

    id: str
    title: str
    run: Callable[[_C], None]
    expect_block: ExpectBlock | None = None


def run_sync_segment(
    segment: SyncSegment[_C],
    context: _C,
    now: Callable[[], float] = time.monotonic,
) -> SegmentResult:
    """The blocking twin of :func:`run_segment`."""
    started = now()
    failure: str | None = None
    try:
        segment.run(context)
    except Exception as error:  # noqa: BLE001 - kept as report evidence
        failure = _describe(error)
    return SegmentResult(
        id=segment.id,
        title=segment.title,
        outcome=classify(segment.expect_block, failure),
        duration_ms=round((now() - started) * 1000),
        expect_block=segment.expect_block,
        failure=failure,
    )


def run_sync_journey(
    segments: Sequence[SyncSegment[_C]],
    context: _C,
    teardown: Callable[[_C], None],
) -> JourneyReport:
    """The blocking twin of :func:`run_journey` — no event loop anywhere on
    the calling thread, which is exactly the consumer shape Scenario 7.1
    reruns the narrative under."""
    results: List[SegmentResult] = []
    try:
        for segment in segments:
            results.append(run_sync_segment(segment, context))
    finally:
        teardown(context)
    return summarize(results)


async def run_journey(
    segments: Sequence[Segment[_C]],
    context: _C,
    teardown: Callable[[_C], Awaitable[None]],
) -> JourneyReport:
    """Run the segments in order, ALWAYS run ``teardown``, then summarize.

    The ``finally`` is the risky part every journey would otherwise
    hand-copy: a journey that forgets it never asks its spawned host to shut
    down (the TS kit's #24319 lesson, kept verbatim).
    """
    results: List[SegmentResult] = []
    try:
        for segment in segments:
            results.append(await run_segment(segment, context))
    finally:
        await teardown(context)
    return summarize(results)


def summarize(segments: Sequence[SegmentResult]) -> JourneyReport:
    """Folds segment results into the journey verdict."""
    return JourneyReport(
        segments=tuple(segments),
        ok=not any(s.outcome in ("failed", "unblocked") for s in segments),
    )


_MARK: dict[str, str] = {
    "passed": "PASS ",
    "expectBlocked": "BLOCK",
    "unblocked": "STALE",
    "failed": "FAIL ",
}


def _issue_list(block: ExpectBlock) -> str:
    return ", ".join(f"#{issue}" for issue in block.issues)


def _indent(text: str) -> str:
    return text.replace("\n", "\n        ")


def format_report(report: JourneyReport) -> str:
    """The human-facing report: one line per step, then the verdict line."""
    lines: List[str] = []
    for segment in report.segments:
        lines.append(
            f"{_MARK[segment.outcome]} {segment.id:<28}"
            f"{segment.duration_ms:>6}ms  {segment.title}"
        )
        block = segment.expect_block
        if block is not None and segment.outcome == "expectBlocked":
            lines.append(
                f"        expect-blocked on {_issue_list(block)}: {block.because}"
            )
            lines.append(f"        observed: {_indent(segment.failure or '(no detail)')}")
        if block is not None and segment.outcome == "unblocked":
            lines.append(
                f"        EXPECT-BLOCK IS STALE. This segment now passes, so "
                f"{_issue_list(block)} looks fixed."
            )
            lines.append(
                "        Promote it: delete this segment's expect_block so the "
                "journey requires it from now on."
            )
        if segment.outcome == "failed":
            if block is not None:
                lines.append(
                    f"        This failure does NOT match the expect-block "
                    f"signature for {_issue_list(block)} "
                    f"({block.signature.pattern}), so it is a real failure."
                )
            lines.append(f"        {_indent(segment.failure or '(no detail)')}")
    counts: dict[str, int] = {}
    for segment in report.segments:
        counts[segment.outcome] = counts.get(segment.outcome, 0) + 1
    tally = " ".join(
        f"{outcome}={counts.get(outcome, 0)}"
        for outcome in ("passed", "expectBlocked", "unblocked", "failed")
    )
    lines.append(f"journey {'OK' if report.ok else 'NOT OK'} ({tally})")
    return "\n".join(lines)
