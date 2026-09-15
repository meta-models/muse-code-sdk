"""Replay the two owner-ratified SS4.13 golden fixtures through the fold.

Port of ``clients/sdk-ts/test/pending-command-corpus.test.ts`` (the TS
TEST-013 / #210 T064 substrate): the ``pending-command-ack-launch`` and
``pending-command-ack-reject`` transcripts drive the Python
``PendingCommandSet`` and must produce the same anchors, demands, and
retirements as the TS fold (spec 638 Scenario 1.4 parity oracle).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from muse_code.pending import (
    CommandErrorResponse,
    PendingCommandSet,
    PendingRetirement,
    RejectedRetirement,
    ReplayAck,
    ReplayError,
)

PROJECT_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class ReplayResult:
    anchor_at_ack: str | None
    anchor_before_retirement: str | None
    queue_movement_demands: tuple[str, ...]
    retirement: PendingRetirement[str]
    own_turn_started: bool
    own_turn_failed_launch: bool


def _frames(scenario: str) -> list[tuple[str, dict[str, Any]]]:
    path = PROJECT_ROOT / "schema" / "msp" / "transcripts" / scenario / "transcript.ndjson"
    out: list[tuple[str, dict[str, Any]]] = []
    for text in path.read_text().rstrip("\n").split("\n"):
        line = json.loads(text)
        out.append((line["dir"], json.loads(line["raw"])))
    return out


def _replay(scenario: str) -> ReplayResult:
    frames = _frames(scenario)
    queued_ack = next(
        frame
        for _, frame in frames
        if isinstance(frame.get("result"), dict)
        and frame["result"].get("disposition") == "queued"
    )
    ack_result = queued_ack["result"]
    command_id: str = ack_result["commandId"]
    turn_id: str = ack_result["turnId"]

    s: PendingCommandSet[str] = PendingCommandSet()
    queue_movement_demands: list[str] = []
    last_item_id: str | None = None
    anchor_at_ack: str | None = None
    anchor_before_retirement: str | None = None
    retirement: PendingRetirement[str] | None = None
    own_turn_started = False
    own_turn_failed_launch = False

    for direction, frame in frames:
        if direction == "client" and frame.get("method") == "turn/start":
            params = frame["params"]
            if params.get("commandId") == command_id:
                s.submitted(
                    command_id,
                    params["input"][0]["text"],
                    anchor_after_item_id=last_item_id,
                )
            continue
        if direction != "server":
            continue

        if frame.get("result") is not None and frame.get("id") is not None:
            result = frame["result"]
            if isinstance(result, dict) and result.get("commandId") == command_id:
                answer = {
                    "turnId": result["turnId"],
                    "disposition": result["disposition"],
                }
                entry = s.get(command_id)
                if entry is not None and entry.ack is None:
                    s.acked(command_id, answer)
                    refreshed = s.get(command_id)
                    anchor_at_ack = (
                        refreshed.anchor_after_item_id if refreshed is not None else None
                    )
                else:
                    s.replay_answered(command_id, ReplayAck(ack=answer))
            continue
        if frame.get("error") is not None:
            error = frame["error"]
            data = error["data"]
            if data.get("commandId") == command_id:
                entry = s.get(command_id)
                anchor_before_retirement = (
                    entry.anchor_after_item_id if entry is not None else None
                )
                outcome = s.replay_answered(
                    command_id,
                    ReplayError(
                        error=CommandErrorResponse(
                            code=int(error["code"]),
                            kind=data["kind"],
                            reason=data["reason"],
                        )
                    ),
                )
                assert outcome != "held", f"{scenario}: durable rejection must retire"
                retirement = outcome
            continue

        method = frame.get("method")
        params = frame.get("params")
        if not isinstance(params, dict):
            continue
        if method in ("turn/started", "turn/completed"):
            event_turn_id = params["turnId"]
            if event_turn_id == turn_id:
                own_turn_started = own_turn_started or method == "turn/started"
                if method == "turn/completed" and params.get("terminal") == "failed":
                    own_turn_failed_launch = params["error"]["kind"] == "launchError"
            queue_movement_demands.extend(s.observed_queue_movement(event_turn_id))
            continue
        if method in ("item/started", "item/updated", "item/completed"):
            item = params["item"]
            item_id = item["itemId"]
            if item.get("kind") == "userMessage" and item.get("commandId") == command_id:
                entry = s.get(command_id)
                anchor_before_retirement = (
                    entry.anchor_after_item_id if entry is not None else None
                )
                observed = s.observed_user_message(command_id, item_id)
                if observed is not None:
                    retirement = observed
            last_item_id = item_id

    assert retirement is not None, f"{scenario}: fixture retires its PendingCommand"
    return ReplayResult(
        anchor_at_ack=anchor_at_ack,
        anchor_before_retirement=anchor_before_retirement,
        queue_movement_demands=tuple(queue_movement_demands),
        retirement=retirement,
        own_turn_started=own_turn_started,
        own_turn_failed_launch=own_turn_failed_launch,
    )


def test_corpus_folds_ack_launch_with_fixed_anchor_and_command_id_retirement() -> None:
    run = _replay("pending-command-ack-launch")
    assert run.anchor_at_ack == "0198f032-0001-7000-8000-000000000101", (
        "the pending entry anchors after the last item folded before the queued submit"
    )
    assert run.anchor_before_retirement == run.anchor_at_ack, (
        "later running items never float the entry"
    )
    assert run.own_turn_started is True
    assert run.retirement.kind == "materialized"
    assert run.retirement.command_id == "018f6a32-2222-7000-8000-0000000000b2"


def test_corpus_folds_ack_deferred_start_failed_as_rejected() -> None:
    run = _replay("pending-command-ack-reject")
    assert "018f6a32-3333-7000-8000-0000000000c3" in run.queue_movement_demands
    assert run.own_turn_started is False, "the rejected queued turn never starts"
    assert run.own_turn_failed_launch is True, (
        "the pre-minted turn gets the launchError terminal"
    )
    assert run.retirement == RejectedRetirement(
        command_id="018f6a32-3333-7000-8000-0000000000c3",
        reason="deferred_start_failed",
        input="Run the queued deployment checks",
    )
