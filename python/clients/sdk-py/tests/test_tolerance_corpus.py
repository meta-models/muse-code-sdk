"""PY-TEST-006: the ``sdk-tolerance`` fixture class, losslessly retained.

Spec ``specs/638-muse-sdk-python`` FR-638-010 (Scenario 5): unknown item
kinds, unknown session-state methods, and unknown dotted stream kinds are
tolerated losslessly — retained with their unknown vocabulary intact and
never dropped or crashed on (SS1.5.4; tdd SS7.5 makes this class permanently
hand-authored).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from muse_code.replay import load_transcript, replay_into_fold, transcript_dirs

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CORPUS = PROJECT_ROOT / "schema" / "msp" / "transcripts"


def _tolerance_dirs() -> list[Path]:
    dirs = [
        d
        for d in transcript_dirs(CORPUS)
        if json.loads((d / "manifest.json").read_text())["provenance"]
        == "sdk-tolerance"
    ]
    assert len(dirs) >= 3, f"the sdk-tolerance class has three fixtures, found {dirs}"
    return dirs


@pytest.mark.parametrize("scenario_dir", _tolerance_dirs(), ids=lambda p: p.name)
def test_tolerance_fixture_folds_losslessly(scenario_dir: Path) -> None:
    transcript = load_transcript(scenario_dir)
    fold = replay_into_fold(transcript)
    # Every item frame the fixture carried is retained: nothing dropped for
    # an unknown kind, and the unknown vocabulary survives verbatim.
    sent_items = {}
    for frame in transcript.server_notifications:
        params = frame.get("params")
        if isinstance(params, dict) and isinstance(params.get("item"), dict):
            item = params["item"]
            sent_items[str(item["itemId"])] = item
    assert sent_items, f"{scenario_dir.name}: fixture carries item frames"
    for item_id, sent in sent_items.items():
        held = fold.items.get(item_id)
        assert held is not None, f"{scenario_dir.name}: item {item_id} was dropped"
        assert held.get("kind") == sent.get("kind"), "unknown kind must survive"
        # Generic-render data (FR-638-010): kind + status always readable.
        assert "status" in held


def test_unknown_state_method_is_tolerated_not_crashed() -> None:
    fixture = CORPUS / "tolerance-unknown-state-method"
    if not fixture.is_dir():  # fixture name is #210's; resolve by scan
        candidates = [d for d in _tolerance_dirs() if "state" in d.name]
        assert candidates, "no unknown-state-method tolerance fixture found"
        fixture = candidates[0]
    fold = replay_into_fold(load_transcript(fixture))
    assert fold is not None
