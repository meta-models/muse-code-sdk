"""The Python SDK's client arms for the ``needsInput`` status.

The wire types under ``muse_code_msp`` are GENERATED from the protocol schema
by the producing repository's code generator, so this suite tests them and
never edits them: a wire-type change is a server/schema change, outside the
client arms.

The stable SDK negotiates no ``experimentalApi``: on its connection the
``needsInput`` word is gate-fallback-rewritten to ``idle`` and the
``needsInputReasons`` member is STRIPPED. Its arms are therefore the
compatibility arms — the stripped member is unknown evidence, and the
experimental frame arriving anyway (an embedder that opted in) is tolerated
losslessly: no fold state, no throw. The SDK's session-table
surface for the push is follow-up work; this suite pins only that the frame
cannot break the fold.
"""

from __future__ import annotations

from typing import Any

import muse_code_msp as stable
from muse_code import Session, read_session_durability
from muse_code.fold.session_fold import IgnoredUnrecognizedMethod
from muse_code_msp import experimental

SESSION = "s-1"


def _keys(typed_dict: Any) -> set[str]:
    return set(typed_dict.__required_keys__) | set(typed_dict.__optional_keys__)


def _fold_only() -> Session[str]:
    return Session(SESSION, read_session_durability({"sessionDurability": "durable"}))


def test_the_experimental_bundle_types_the_reasons() -> None:
    assert "needsInputReasons" in experimental.Session.__optional_keys__
    assert "needsInputReasons" in experimental.SessionStatusChangedParams.__optional_keys__
    assert "needsInput" in experimental.SESSION_STATUS_KNOWN_VALUES
    assert experimental.NEEDS_INPUT_REASON_KNOWN_VALUES == (
        "approvalPending",
        "inputPending",
    )


def test_a_stable_connection_sees_the_member_stripped() -> None:
    assert "needsInputReasons" not in _keys(stable.Session)
    assert "needsInputReasons" not in _keys(stable.SessionStatusChangedParams)
    assert "needsInput" not in stable.SESSION_STATUS_KNOWN_VALUES
    assert not hasattr(stable, "NeedsInputReason")


def test_status_changed_carrying_needs_input_is_tolerated_and_folds_no_state() -> None:
    session = _fold_only()
    outcome = session.apply(
        {
            "method": "session/statusChanged",
            "params": {
                "sessionId": SESSION,
                "status": "needsInput",
                "viewCursor": None,
                "attention": ["approvalPending"],
                "needsInputReasons": ["approvalPending"],
            },
        }
    )
    assert isinstance(outcome.fold, IgnoredUnrecognizedMethod)
    assert outcome.fold.method == "session/statusChanged"
    assert session.fold.session_state.families() == []
