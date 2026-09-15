"""The expect-block kit's own contract, binary-free — the Python twin of the
TS quickstart's ``segments.test.ts`` unit arms (PR #32537 review round 2:
ported machinery must be reached by tests, not carried dark).

The kit's arms are unreachable from the real journey alone (nothing is
expect-blocked today, deliberately), so these arms drive them on synthetic
segments — exactly how the TS twin proves classify/unblocked/report before
any block ever exists. The D-013 self-retirement contract is the point: a
block that goes stale must FAIL the journey, and the README disclosure must
mirror the blocked set in BOTH directions.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any

from quickstart_journey.segments import (
    ExpectBlock,
    Segment,
    SyncSegment,
    classify,
    format_report,
    run_segment,
    run_sync_journey,
    summarize,
)

BLOCK = ExpectBlock(
    issues=(12345,),
    because="the host rejects the frobnicate verb",
    signature=re.compile("frobnicate rejected"),
)


def test_classify_covers_all_four_outcomes() -> None:
    assert classify(None, None) == "passed"
    assert classify(None, "anything broke") == "failed"
    assert classify(BLOCK, "frobnicate rejected by host") == "expectBlocked"
    # A block excuses exactly the defect it names and nothing else.
    assert classify(BLOCK, "an unrelated TypeError") == "failed"
    # The stale block: passing while blocked is FATAL, so promotion happens.
    assert classify(BLOCK, None) == "unblocked"


def test_run_segment_keeps_the_failure_evidence_and_times_with_the_injected_clock() -> None:
    async def boom(_context: None) -> None:
        raise AssertionError("frobnicate rejected by host")

    ticks = iter((10.0, 10.25))
    result = asyncio.run(
        run_segment(
            Segment("frob", "Frobnicate", boom, expect_block=BLOCK),
            None,
            now=lambda: next(ticks),
        )
    )
    assert result.outcome == "expectBlocked"
    assert result.duration_ms == 250
    assert result.failure is not None and "frobnicate rejected" in result.failure


def test_an_unblocked_segment_fails_the_journey_and_the_report_says_promote() -> None:
    async def passes(_context: None) -> None:
        return None

    result = asyncio.run(
        run_segment(Segment("frob", "Frobnicate", passes, expect_block=BLOCK), None)
    )
    report = summarize([result])
    assert result.outcome == "unblocked"
    assert report.ok is False, "a stale block must red the journey"
    rendered = format_report(report)
    assert "EXPECT-BLOCK IS STALE" in rendered
    assert "#12345" in rendered
    assert "journey NOT OK" in rendered


def test_an_expect_blocked_segment_keeps_the_journey_green_and_discloses() -> None:
    async def boom(_context: None) -> None:
        raise AssertionError("frobnicate rejected by host")

    result = asyncio.run(
        run_segment(Segment("frob", "Frobnicate", boom, expect_block=BLOCK), None)
    )
    report = summarize([result])
    assert report.ok is True, "a predicted failure is not fatal"
    rendered = format_report(report)
    assert "expect-blocked on #12345" in rendered
    assert "frobnicate rejected" in rendered


def test_teardown_runs_even_when_a_base_exception_escapes_mid_journey() -> None:
    # `run_*_segment` swallows Exception, so the runners' `finally` earns its
    # keep exactly when a BaseException (Ctrl-C, SystemExit) escapes with a
    # spawned host alive — the case the teardown exists for (PR #32537 review
    # round 3). Both runners are guarded here.
    import pytest

    from quickstart_journey.segments import run_journey

    torn_down: list[str] = []

    def sync_interrupt(_context: Any) -> None:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        run_sync_journey(
            [SyncSegment("boom", "Interrupted", sync_interrupt)],
            None,
            lambda _context: torn_down.append("sync"),
        )
    assert torn_down == ["sync"], "the sync runner's finally must still run"

    async def async_interrupt(_context: Any) -> None:
        raise KeyboardInterrupt

    async def async_teardown(_context: Any) -> None:
        torn_down.append("async")

    async def drive() -> None:
        await run_journey(
            [Segment("boom", "Interrupted", async_interrupt)], None, async_teardown
        )

    with pytest.raises(KeyboardInterrupt):
        asyncio.run(drive())
    assert torn_down == ["sync", "async"], "the async runner's finally must still run"


def test_the_async_runner_classifies_failures_and_always_tears_down() -> None:
    # The async twin of the sync-runner arm below: a plain segment failure is
    # kept as evidence, the journey reds, and the teardown runs (PR #32537
    # review round 3's sibling thread).
    from quickstart_journey.segments import run_journey

    torn_down: list[str] = []

    async def boom(_context: Any) -> None:
        raise RuntimeError("async arm broke")

    async def teardown(_context: Any) -> None:
        torn_down.append("yes")

    report = asyncio.run(
        run_journey([Segment("only", "The one async step", boom)], None, teardown)
    )
    assert torn_down == ["yes"]
    assert report.ok is False
    assert report.segments[0].failure is not None
    assert "async arm broke" in report.segments[0].failure


def test_the_sync_runner_classifies_and_always_tears_down() -> None:
    torn_down: list[str] = []

    def boom(_context: Any) -> None:
        raise RuntimeError("sync arm broke")

    report = run_sync_journey(
        [SyncSegment("only", "The one sync step", boom)],
        None,
        lambda _context: torn_down.append("yes"),
    )
    assert torn_down == ["yes"], "teardown must run even when a segment fails"
    assert report.ok is False
    assert report.segments[0].outcome == "failed"
    assert report.segments[0].failure is not None
    assert "sync arm broke" in report.segments[0].failure
