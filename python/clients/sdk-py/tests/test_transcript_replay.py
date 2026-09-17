"""PY-the governing rule: the transcript replay runner over the whole corpus.

Spec ``the owning spec` the governing rule and the governing rule
: every landed transcript's server
notifications fold without error, delta concatenation equals the final
committed value on the gap-free single-turn scenario, and two runs over the
same lines produce equal fold states. Snapshot checkpoint equality
 follows the same
its task sequencing the TS lane records in ``the owning spec` — the
store-level seed algebra is covered by the ported store tests.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from muse_code.fold import (
    IgnoredMissingParams,
    IgnoredStaleFrame,
    IgnoredUnrecognizedMethod,
)
from muse_code.replay import (
    Transcript,
    load_transcript,
    replay_into_fold,
    transcript_dirs,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CORPUS = PROJECT_ROOT / "schema" / "msp" / "transcripts"


def _scenarios() -> list[Path]:
    dirs = transcript_dirs(CORPUS)
    assert len(dirs) >= 40, f"corpus went missing? found {len(dirs)} scenarios"
    return dirs


def _fold_states(transcript: Transcript) -> tuple[object, ...]:
    fold = replay_into_fold(transcript)
    return (
        [dict(item) for item in fold.items.list()],
        {f: fold.session_state.get(f) for f in fold.session_state.families()},
        fold.turns(),
        fold.active_turn_id,
        fold.current,
    )


@pytest.mark.parametrize("scenario_dir", _scenarios(), ids=lambda p: p.name)
def test_every_transcript_folds_and_is_deterministic(scenario_dir: Path) -> None:
    transcript = load_transcript(scenario_dir)
    fold = replay_into_fold(transcript)
    # Tolerance is lossless, never a crash: the only ignore arms a landed
    # transcript may hit are the classified ones (the protocol; the sdk-tolerance
    # class deliberately carries unknown methods/kinds).
    for outcome in transcript.fold_outcomes:
        assert isinstance(
            outcome,
            (
                IgnoredMissingParams,
                IgnoredStaleFrame,
                IgnoredUnrecognizedMethod,
            ),
        ) or not type(outcome).__name__.startswith("Ignored"), (
            f"{scenario_dir.name}: unexpected ignore outcome {outcome!r}"
        )
    assert _fold_states(transcript) == _fold_states(transcript), (
        f"{scenario_dir.name}: two folds over the same lines diverged "
        ""
    )
    assert fold is not None


def test_text_run_single_turn_delta_concat_and_single_terminal() -> None:
    # Spec its acceptance scenario acceptance 1, on the gap-free single-turn fixture.
    transcript = load_transcript(CORPUS / "text-run-single-turn")
    fold = replay_into_fold(transcript)
    message_items = [
        item for item in fold.items.list() if item.get("kind") == "agentMessage"
    ]
    assert message_items, "the fixture folds at least one agentMessage"
    for item in message_items:
        accumulated = fold.items.accumulated(str(item["itemId"]))
        if accumulated is not None and "text" in item:
            assert accumulated == item["text"], (
                "delta concatenation must equal the final committed value "
                ""
            )
    terminal_turns = [t for t in fold.turns() if t.terminal is not None]
    assert len(terminal_turns) == 1, "exactly one turn terminal in the fixture"


def test_cancel_mid_turn_reaches_cancelled_terminal() -> None:
    # Spec its acceptance scenario acceptance 3.
    transcript = load_transcript(CORPUS / "cancel-mid-turn")
    fold = replay_into_fold(transcript)
    terminals = [t.terminal for t in fold.turns() if t.terminal is not None]
    assert "cancelled" in terminals, f"expected a cancelled terminal, got {terminals}"


def test_client_lines_are_exposed_for_frame_assertions() -> None:
    # the governing rule: the runner is a library — client lines stay available to
    # consumers (the journey and cookbook harnesses assert on them).
    transcript = load_transcript(CORPUS / "approval-round-trip")
    assert transcript.client_frames, "the fixture records client frames"
    assert all("jsonrpc" in frame for frame in transcript.client_frames)
    assert any(
        frame.get("method") == "initialize" for frame in transcript.client_frames
    )
