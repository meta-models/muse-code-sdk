"""The the governing rule discharge for the pending set's wire vocabulary.

Port of ``clients/sdk-ts/test/pending-command-wire-binding.test.ts``, adapted
to the Python rendering: the generated ``muse_code_msp`` exposes the protocol
error registry as the ``ERRORS`` table (regen-gated against the bundle), so
the settlement code/kind pins bind against that table — the same pin shape
``EXPECTED_SCHEMA_FINGERPRINT`` uses. The TS compile-time ``Extract<...>``
arms have no Python twin; the source-guard arms below carry that weight.
"""

from __future__ import annotations

import re
from pathlib import Path

import muse_code_msp

from muse_code.pending import (
    COMMAND_REJECTED_CODE,
    COMMAND_REJECTED_KIND,
    CommandErrorResponse,
    PendingCommandSet,
    is_settlement,
)

PENDING_SOURCE = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "muse_code"
    / "pending"
    / "pending_command_set.py"
)


def _registry_row(kind: str) -> muse_code_msp.ErrorSpec:
    for row in muse_code_msp.ERRORS:
        if row["kind"] == kind:
            return row
    raise AssertionError(f"the generated registry must carry an error row for `{kind}`")


# ---- the source arms: nothing is restated locally --------------------------


def test_the_pending_set_imports_its_vocabulary_from_the_generated_layer() -> None:
    source = PENDING_SOURCE.read_text()
    assert re.search(
        r"^from muse_code_msp import .*TurnStartDisposition", source, re.MULTILINE
    ), "the pending set must import TurnStartDisposition from the generated layer"


def test_the_disposition_alias_is_the_generated_one_asserted_positively() -> None:
    # The negative arm below only bans one member order; a re-hand-copied
    # vocabulary in any other order slips through it. Pinning the binding
    # LINE means any restatement — reordered or not — fails here.
    source = PENDING_SOURCE.read_text()
    assert re.search(
        r"^PendingDisposition = TurnStartDisposition$", source, re.MULTILINE
    ), (
        "PendingDisposition must be the generated TurnStartDisposition by "
        "alias, not a copy"
    )


def test_the_disposition_union_is_not_restated_in_the_sdk() -> None:
    source = PENDING_SOURCE.read_text()
    assert not re.search(r'"started",\s*"queued",\s*"steered"', source), (
        "the protocol disposition vocabulary belongs to the generated layer; a"
        "local copy drifts silently because the two are structurally identical"
    )


def test_the_settlement_code_is_named_exactly_once_in_executable_source() -> None:
    # Comments and docstrings may cite the code freely; what must not exist
    # twice is a second executable copy, because only the named constant is
    # pinned to the registry below. AST-counted, so prose never miscounts.
    import ast

    tree = ast.parse(PENDING_SOURCE.read_text())
    executable = sum(
        1
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and node.value == 32030
    )
    assert executable == 1, (
        "a second executable copy of the code is one no pin compares against"
    )


# ---- the registry arms: the settlement vocabulary is pinned ----------------


def test_the_settlement_code_equals_the_generated_command_rejected_row() -> None:
    row = _registry_row("commandRejected")
    assert COMMAND_REJECTED_CODE == row["code"], (
        "a schema advance that moves the code must red this lane, not "
        "silently leave the SDK settling on a code the host no longer sends"
    )


def test_the_settlement_kind_equals_the_generated_row_kind() -> None:
    row = _registry_row("commandRejected")
    assert COMMAND_REJECTED_KIND == row["kind"]


def test_the_queued_disposition_is_a_generated_known_value() -> None:
    assert "queued" in muse_code_msp.TURN_START_DISPOSITION_KNOWN_VALUES, (
        "the queued-disposition literal must stay a member of the generated "
        "the protocol vocabulary"
    )


def test_only_the_registered_code_or_kind_settles_every_other_row_holds() -> None:
    for row in muse_code_msp.ERRORS:
        settles = is_settlement(CommandErrorResponse(code=row["code"], kind=row["kind"]))
        assert settles == (row["kind"] == "commandRejected"), (
            f"`{row['kind']}` ({row['code']}) must "
            f"{'' if row['kind'] == 'commandRejected' else 'NOT '}settle a "
            "pending command"
        )


# ---- the type arm: the generated TurnStartResult IS the ack ----------------


def test_a_generated_turn_start_result_is_the_ack_the_pending_set_accepts() -> None:
    # The connection layer gets a TurnStartResult back from turn/start; the
    # discharge means it hands that value straight to acked() with no local
    # re-shaping (the turnId/disposition pair IS PendingCommandAck —
    # TypedDicts are structural).
    result: muse_code_msp.TurnStartResult = {
        "commandId": "cmd-1",
        "disposition": "queued",
        "startedNewTurn": False,
        "status": "accepted",
        "turnId": "cmd-1",
    }
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("cmd-1", "hi")
    s.acked("cmd-1", result)

    entry = s.get("cmd-1")
    assert entry is not None and entry.ack is not None
    assert entry.ack["disposition"] == "queued"
    assert entry.ack["turnId"] == "cmd-1"
