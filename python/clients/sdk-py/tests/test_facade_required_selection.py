"""The required-selection arm of the Python SDK facade: a caller that sets
``require_permission_profile`` alongside ``permission_profile`` requires its
selection, and the client proves it instead of proceeding on the host default.

A caller that sets ``require_permission_profile`` alongside
``permission_profile`` requires its selection: the client proves the
committed selection equals the requested id -- from the start result's own
``session.permissionState``, else a ``session/read`` read-back -- and raises
``PermissionProfileNotApplied`` instead of proceeding on the host default.
The refused session is dropped (no orphan); the caller resumes via the
error's ``session_id`` or starts again: no auto-close, no auto-set, never a
silent default.

The blocking twin (``SyncMuseClient.start_session``) delegates verbatim to
the async verb, so these async arms cover it; no sync-surface test needed.

Causal, never time-based: every wait is ``wait_for_writes`` / ``pump``.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    PermissionProfileNotApplied,
    ResumeSessionOptions,
    StartSessionOptions,
    read_session_durability,
)
from muse_code.connection import Connection

from helpers_connection import (
    FakeDuplex,
    answer,
    pump,
    sent_frame,
    sent_params,
    wait_for_writes,
)

Params = dict[str, Any]

REQUIRED = ":unrestricted"
OTHER = ":ask-me"


def _client() -> tuple[MuseClient[Any], FakeDuplex]:
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(
            durability=read_session_durability({"sessionDurability": "durable"})
        ),
    )
    return client, transport


def _start_result(session_id: str, permission_state: Params | None = None) -> Params:
    session: Params = {"sessionId": session_id, "status": "idle"}
    if permission_state is not None:
        session["permissionState"] = permission_state
    return {"session": session, "viewCursor": "v:1"}


def _read_result(session_id: str, permission_state: Params | None = None) -> Params:
    session: Params = {"sessionId": session_id, "status": "idle"}
    if permission_state is not None:
        session["permissionState"] = permission_state
    return {
        "history": {"mode": "none", "items": []},
        "pendingRequests": [],
        "session": session,
        "viewCursor": "v:2",
    }


def _triple(profile_id: str | None) -> Params:
    return {
        "profileId": profile_id,
        "reviewerAuthority": "autoReview",
        "reviewerAttached": True,
    }


@pytest.mark.asyncio
async def test_required_start_whose_read_back_serves_a_different_profile_refuses() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(
                permission_profile=REQUIRED, require_permission_profile=True
            )
        )
    )
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "session/start"
    assert sent_params(transport, 0)["permissionProfile"] == REQUIRED
    assert "requirePermissionProfile" not in sent_params(transport, 0), (
        "the require flag is client-local, never on the wire"
    )
    answer(transport, 0, _start_result("s-1"))

    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "session/read"
    assert sent_params(transport, 1)["sessionId"] == "s-1"
    answer(transport, 1, _read_result("s-1", _triple(OTHER)))

    with pytest.raises(PermissionProfileNotApplied) as refused:
        await pending
    assert refused.value.requested == REQUIRED
    assert refused.value.served == OTHER
    assert refused.value.session_id == "s-1"
    await pump()
    assert len(transport.writes) == 2, "no turn is sent after the refusal"
    await client.close()


@pytest.mark.asyncio
async def test_required_start_whose_read_back_omits_permission_state_refuses_unknown() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(
                permission_profile=REQUIRED, require_permission_profile=True
            )
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, _start_result("s-1"))
    await wait_for_writes(transport, 2)
    answer(transport, 1, _read_result("s-1"))

    with pytest.raises(PermissionProfileNotApplied) as refused:
        await pending
    assert refused.value.requested == REQUIRED
    assert refused.value.served is None
    assert refused.value.session_id == "s-1"
    await pump()
    assert len(transport.writes) == 2
    await client.close()


@pytest.mark.asyncio
async def test_required_start_whose_read_back_serves_null_profile_refuses_unknown() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(
                permission_profile=REQUIRED, require_permission_profile=True
            )
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, _start_result("s-1"))
    await wait_for_writes(transport, 2)
    answer(transport, 1, _read_result("s-1", _triple(None)))

    with pytest.raises(PermissionProfileNotApplied) as refused:
        await pending
    assert refused.value.requested == REQUIRED
    assert refused.value.served is None
    await pump()
    assert len(transport.writes) == 2
    await client.close()


@pytest.mark.asyncio
async def test_require_flag_without_member_is_a_usage_error_before_anything_is_sent() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(StartSessionOptions(require_permission_profile=True))
    )
    await pump()
    if transport.writes:
        # Pre-fix behavior: it sent -- answer so nothing dangles, then fail loudly.
        answer(transport, 0, _start_result("s-1"))
        await pending
        await client.close()
        pytest.fail("usage error must fire before anything is sent")
    with pytest.raises(ValueError):
        await pending
    await client.close()


@pytest.mark.asyncio
async def test_start_without_the_flag_sends_one_frame_and_no_read() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(StartSessionOptions(permission_profile=REQUIRED))
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, _start_result("s-1"))
    session = await pending
    assert session.session_id == "s-1"
    await pump()
    assert len(transport.writes) == 1
    await client.close()


@pytest.mark.asyncio
async def test_start_result_already_carrying_the_required_profile_proceeds_with_no_read() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(
                permission_profile=REQUIRED, require_permission_profile=True
            )
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, _start_result("s-1", _triple(REQUIRED)))
    session = await pending
    assert session.session_id == "s-1"
    await pump()
    assert len(transport.writes) == 1
    await client.close()


@pytest.mark.asyncio
async def test_start_result_carrying_a_different_profile_refuses_with_no_read() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(
                permission_profile=REQUIRED, require_permission_profile=True
            )
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, _start_result("s-1", _triple(OTHER)))

    with pytest.raises(PermissionProfileNotApplied) as refused:
        await pending
    assert refused.value.requested == REQUIRED
    assert refused.value.served == OTHER
    await pump()
    assert len(transport.writes) == 1
    await client.close()


@pytest.mark.asyncio
async def test_refused_session_is_dropped_from_the_client_registry() -> None:
    # The no-orphan pin: the registry has no public accessor (neither SDK
    # exposes its sessions), so the single-underscore set is the only
    # observable for "no unreachable Session keeps folding".
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(
                permission_profile=REQUIRED, require_permission_profile=True
            )
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, _start_result("s-1", _triple(OTHER)))

    with pytest.raises(PermissionProfileNotApplied):
        await pending
    await pump()
    assert {s.session_id for s in client._sessions} == set()
    await client.close()


@pytest.mark.asyncio
async def test_refused_id_stays_resumable_after_the_drop() -> None:
    # Constitution XIII paired evidence (review 5476188067 follow-up-1): the
    # refusal drops the orphan while the client stays usable on the same id.
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(
                permission_profile=REQUIRED, require_permission_profile=True
            )
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, _start_result("s-1", _triple(OTHER)))
    with pytest.raises(PermissionProfileNotApplied):
        await pending
    await pump()

    resumed = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id="s-1"))
    )
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "session/resume"
    assert sent_params(transport, 1)["sessionId"] == "s-1"
    answer(
        transport,
        1,
        {
            "session": {"sessionId": "s-1", "status": "idle"},
            "history": {"mode": "none", "items": []},
            "pendingRequests": [],
            "viewCursor": "v:9",
        },
    )
    session = await resumed
    assert session.session_id == "s-1"
    await client.close()
