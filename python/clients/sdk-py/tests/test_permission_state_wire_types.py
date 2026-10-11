"""The Python SDK's client arms for the served Auto-review active-state contract.

The wire types under ``muse_code_msp`` are GENERATED from the protocol schema
by the producing repository's code generator, so this suite tests them and
never edits them: a wire-type change is a server/schema change, outside the
client arms.

The stable SDK negotiates no ``experimentalApi``: on its connection the
``permissionState`` member is STRIPPED and the facade renders no Auto-review
state. Its arms are therefore the compatibility arms — the stripped member is
unknown evidence, the experimental member arriving anyway (an embedder that
opted in) is tolerated losslessly, and a mode-only change folds the mode
while creating no Auto-review claim. First-run receipts: every arm passes on
the pre-change facade — pins, recorded as such on the owning change.
"""

from __future__ import annotations

import typing
from typing import Any

import muse_code_msp as stable
from muse_code import Session, read_session_durability
from muse_code.fold.session_fold import IgnoredUnrecognizedMethod, SessionStateFold
from muse_code_msp import experimental

SESSION = "s-1"
SOURCE_RANGE: dict[str, Any] = {
    "first": {"recordIndex": 0, "streamOffset": 0},
    "last": {"recordIndex": 0, "streamOffset": 0},
    "stream": {"kind": "run", "runId": "r-1"},
}
TRIPLE: experimental.EffectivePermissionState = {
    "profileId": ":auto-review",
    "reviewerAttached": True,
    "reviewerAuthority": "autoReview",
}


def _keys(typed_dict: Any) -> set[str]:
    return set(typed_dict.__required_keys__) | set(typed_dict.__optional_keys__)


def _fold_only() -> Session[str]:
    return Session(SESSION, read_session_durability({"sessionDurability": "durable"}))


def _claim_surface(value: object) -> list[str]:
    """Every public member name that reads like an Auto-review / permission-state claim.

    ``dir`` lists instance attributes as well as the class surface, so a
    public field planted on the instance trips it too (the TS twin had to
    widen its scan for that).
    """
    words = ("permission", "reviewer", "auto_review", "autoreview")
    return sorted(name for name in dir(value) if any(word in name.lower() for word in words))


# ---- the experimental bundle types the renders-active triple -----------------


def test_the_experimental_bundle_types_the_renders_active_triple() -> None:
    # Membership, not a freeze: the arm needs these three to be required; a
    # later required member on this experimental type must not red it.
    assert {"profileId", "reviewerAttached", "reviewerAuthority"} <= set(
        experimental.EffectivePermissionState.__required_keys__
    ), "a snapshot cannot answer the predicate with a member missing"
    assert "autoReview" in experimental.REVIEWER_AUTHORITY_KNOWN_VALUES
    # Membership here too: a client that renders nothing off the mode must not
    # red on a fifth mode word; classifying one is the renderer's concern.
    assert {"allowAll", "promptUnmatched", "onRequest", "denyUnmatched"} <= set(
        typing.get_args(experimental.ApprovalMode)
    )
    # Both halves of the triple ride the same served snapshot, additive-optional.
    assert "permissionState" in experimental.Session.__optional_keys__
    assert "approvalMode" in experimental.Session.__optional_keys__
    assert "permissionState" in experimental.SessionStatusChangedParams.__optional_keys__
    assert "permissionState" in experimental.SessionSetPermissionProfileResult.__required_keys__
    assert "session/permissionProfileChanged" in experimental.NOTIFICATIONS


def test_a_stable_connection_sees_the_member_stripped() -> None:
    assert "permissionState" not in _keys(stable.Session)
    assert "approvalMode" in _keys(stable.Session), "the mode half stays stable"
    assert "permissionState" not in _keys(stable.SessionStatusChangedParams)
    assert "session/permissionProfileChanged" not in stable.NOTIFICATIONS
    assert not hasattr(stable, "EffectivePermissionState")


# ---- the facade tolerates the experimental member and claims nothing ----------


def test_status_changed_carrying_the_triple_is_tolerated_and_folds_no_state() -> None:
    session = _fold_only()
    outcome = session.apply(
        {
            "method": "session/statusChanged",
            "params": {
                "sessionId": SESSION,
                "status": "idle",
                "viewCursor": None,
                "permissionState": dict(TRIPLE),
            },
        }
    )
    assert isinstance(outcome.fold, IgnoredUnrecognizedMethod)
    assert outcome.fold.method == "session/statusChanged"
    assert session.fold.session_state.families() == []


def test_permission_profile_changed_is_tolerated_as_a_newer_hosts_method() -> None:
    session = _fold_only()
    outcome = session.apply(
        {
            "method": "session/permissionProfileChanged",
            "params": {
                "clientName": "test",
                "commandId": "cmd-9",
                "profileId": ":auto-review",
                "sessionId": SESSION,
                "source": "client",
                "sourceRange": SOURCE_RANGE,
                "viewCursor": "v:2",
                "permissionState": dict(TRIPLE),
            },
        }
    )
    assert isinstance(outcome.fold, IgnoredUnrecognizedMethod)
    assert session.fold.session_state.families() == []


def test_a_mode_only_change_folds_the_mode_and_the_facade_claims_no_auto_review() -> None:
    session = _fold_only()
    modes = ("onRequest", "promptUnmatched", "allowAll", "denyUnmatched")
    for index, mode in enumerate(modes, start=1):
        # A distinct cursor per event: an equal cursor is a replay the store refuses.
        params = {
            "clientName": "test",
            "commandId": "cmd-1",
            "mode": mode,
            "sessionId": SESSION,
            "source": "approvalReconfigure",
            "sourceRange": SOURCE_RANGE,
            "viewCursor": f"v:{index}",
        }
        outcome = session.apply({"method": "session/approvalModeChanged", "params": params})
        assert isinstance(outcome.fold, SessionStateFold), f"{mode} folds as session state"
        assert session.fold.session_state.get("session/approvalModeChanged") == params
    assert session.fold.session_state.families() == ["session/approvalModeChanged"]
    # A later triple on the live projection changes nothing the fold holds.
    session.apply(
        {
            "method": "session/statusChanged",
            "params": {
                "sessionId": SESSION,
                "status": "idle",
                "viewCursor": None,
                "permissionState": dict(TRIPLE),
            },
        }
    )
    assert session.fold.session_state.families() == ["session/approvalModeChanged"]
    # Contract tripwire: a client may report active Auto-review only when the
    # served mode, reviewer authority, and attachment agree in one snapshot.
    # The stable facade exposes NO Auto-review / permission state accessor, so
    # nothing can report "active" off the mode or a label alone; a future
    # accessor must flip this pin AND satisfy the whole triple.
    assert _claim_surface(session) == []


def test_the_claim_surface_tripwire_sees_a_planted_instance_attribute() -> None:
    session = _fold_only()
    setattr(session, "permission_state", {})
    assert _claim_surface(session) == ["permission_state"]
