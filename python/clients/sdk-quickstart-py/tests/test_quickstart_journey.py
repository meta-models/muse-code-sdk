"""PY-the governing rule ``quickstart_journey_release_host`` — the owning spec the governing rule
, its acceptance scenario: the whole journey against a release-built binary,
asserted segment by segment, plus its acceptance scenario's rerun on the sync wrapper.

It runs in the PROVIDER-CONFIGURED mode — the harness's own loopback fake
first-party endpoint, no live provider and no API key — so every segment is
exercised for real. Nothing is expect-blocked: all twelve are required.

``MUSE_BIN`` is REQUIRED. This test never skips itself (the TS twin's rule:
a skipped acceptance artifact reads as proof and is not proof). Build first:

    cargo build --release -p an internal lane --bin tbh
    MUSE_BIN=$PWD/target/release/tbh python3 -m pytest clients/sdk-quickstart-py/tests
"""

from __future__ import annotations

import asyncio
import os
import re
from pathlib import Path

import pytest

from quickstart_journey import (
    SEGMENT_IDS,
    SYNC_SEGMENT_IDS,
    ConfiguredJourneyResult,
    format_report,
    run_configured_journey,
    run_configured_sync_journey,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
TS_JOURNEY = PROJECT_ROOT / "clients" / "sdk-quickstart" / "src" / "journey.ts"

def _required_binary() -> str:
    configured = os.environ.get("MUSE_BIN", "")
    if not configured:
        raise AssertionError(
            "MUSE_BIN is required and must point at a release-built `muse` "
            "binary (an installed Muse Code CLI, or a release build of the "
            "host).\n"
            "  MUSE_BIN=<path-to-muse> python3 -m pytest "
            "clients/sdk-quickstart-py/tests"
        )
    return configured


_SHARED: dict[str, ConfiguredJourneyResult] = {}


def _configured() -> ConfiguredJourneyResult:
    # One process journey, many assertions: spawning the release host per
    # assertion would multiply a large binary's startup by the segment count.
    if "async" not in _SHARED:
        _SHARED["async"] = asyncio.run(run_configured_journey(_required_binary()))
    return _SHARED["async"]


def _sync_configured() -> ConfiguredJourneyResult:
    if "sync" not in _SHARED:
        _SHARED["sync"] = run_configured_sync_journey(_required_binary())
    return _SHARED["sync"]


def ts_registry() -> tuple[str, ...]:
    """The TS journey's step registry, read from ITS source — the parity
    oracle the governing rule names (never a count, never a copy that can drift)."""
    source = TS_JOURNEY.read_text(encoding="utf-8")
    # `[^"]+`, not a narrow class: an id with a digit or underscore must
    # over-collect and fail the parity assert loudly, never vanish from the
    # parse.
    ids = re.findall(r'^\s*id: "([^"]+)",', source, flags=re.MULTILINE)
    assert ids, f"no segment ids parsed from {TS_JOURNEY}"
    return tuple(ids)


def test_step_parity_with_the_ts_journeys_registry() -> None:
    # Binary-free: the registries must agree before any host is spawned.
    assert SEGMENT_IDS == ts_registry(), (
        "the Python journey's step registry drifted from the TS journey's "
        "(clients/sdk-quickstart/src/journey.ts) — the governing rule step parity"
    )
    assert SYNC_SEGMENT_IDS == SEGMENT_IDS, (
        "the sync rerun's registry drifted from the journey's"
    )


def test_the_journey_runs_every_segment_in_the_documented_order() -> None:
    # The oracle is the TS registry itself (its acceptance scenario: "a count here would be
    # a drift copy") — a hand-written second roster beside it would be the
    # Content Pins churn CLAUDE.md bans.
    report = _configured().report
    assert tuple(s.id for s in report.segments) == ts_registry()


def test_every_segment_passes_against_the_release_host() -> None:
    report = _configured().report
    for segment in report.segments:
        assert segment.outcome == "passed", (
            f"segment {segment.id} must pass against a release-built host:\n"
            f"{format_report(report)}"
        )
        assert segment.expect_block is None, (
            f"segment {segment.id} must carry no expect-block"
        )
    assert report.ok, format_report(report)


def test_the_provider_configured_mode_drives_the_host_and_scripts_one_tool_call() -> None:
    result = _configured()
    # `catalog_gets` is the teeth on "configured": a HOME whose endpoint never
    # reached the host fetches nothing, and this run would be the
    # credential-free one wearing the acceptance run's name.
    assert result.catalog_gets >= 1, (
        "the host never fetched the fake endpoint's model catalog:\n"
        f"{format_report(result.report)}"
    )
    # Exactly once: after the approval turn, the artifact name is in every
    # later turn's replayed history, so a content match with no once-only
    # guard hands the cancel segment a tool call and parks it on an approval
    # nobody answers.
    assert result.scripted_tool_calls == 1, (
        "the endpoint must serve the scripted tool call exactly once:\n"
        f"{format_report(result.report)}"
    )


def test_the_sync_wrapper_rerun_reaches_the_same_verdicts() -> None:
    # its acceptance scenario: the same twelve
    # steps on SyncMuseClient, blocking verbs end to end, same verdicts.
    result = _sync_configured()
    report = result.report
    assert tuple(s.id for s in report.segments) == ts_registry()
    for segment in report.segments:
        assert segment.outcome == "passed", (
            f"sync segment {segment.id} must pass with the same verdict:\n"
            f"{format_report(report)}"
        )
    assert report.ok, format_report(report)
    assert result.catalog_gets >= 1
    assert result.scripted_tool_calls == 1
