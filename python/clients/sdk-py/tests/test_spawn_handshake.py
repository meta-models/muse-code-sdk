"""PY-TEST-009: the SS1.4 handshake and typed errors over `serve-fixture`.

Spec ``specs/638-muse-sdk-python`` Scenario 3 / FR-638-012/013/014, driven
against the real #210 fixture host over the recorded handshake transcripts
(``schema/msp/transcripts/README.md``, "Testing your client against the
canned host").

The recorded ``InitializeResult`` carries the RECORDING-time bundle
fingerprint, not the current stable pin (the additive repin flow re-pins
manifests, never wire bytes). There is deliberately NO expected-fingerprint
parameter (a public knob would switch the strict gate off — PR #30094
review, thread 1): the fixture arms retarget the gate by setting
``muse_code.EXPECTED_SCHEMA_FINGERPRINT`` for the test's scope
(monkeypatch), which the handshake reads at call time. The C-638-4 strict
gate is itself proven against the real host: the unpatched arm must fail
with the exact mismatch error naming the generated required host version.
Skips (never fails) when no fixture host binary is available (the Python CI
lane builds one; see the workflow).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

import muse_code
from helpers_host_lifetime import fixture_host_bin
from muse_code.connection import spawn_msp_connection
from muse_code.errors import MuseHostMismatchError
from muse_code.replay import load_transcript

pytestmark = pytest.mark.asyncio

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CORPUS = PROJECT_ROOT / "schema" / "msp" / "transcripts"
# Failure-path bound only: a healthy serve-fixture answers in milliseconds; a
# run that reaches this wall is wedged and the assertion should say so.
REPORTING_DEADLINE_S = 60.0


def _fixture_bin() -> str:
    binary = fixture_host_bin()
    if binary is None:
        pytest.skip("no muse-conformance fixture host available (Rust build)")
    return binary


def _recorded(scenario: str) -> tuple[dict[str, Any], str]:
    """The recorded initialize params (our identity) + wire fingerprint."""
    transcript = load_transcript(CORPUS / scenario)
    init = next(
        frame
        for frame in transcript.client_frames
        if frame.get("method") == "initialize"
    )
    params = dict(init["params"])
    # Identity is ours (unified by the harness, #23963); ids are ours too.
    params["clientInfo"] = {"name": "muse-code-sdk-py-tests", "version": "0.0.0"}
    result = next(
        frame
        for frame in transcript.server_frames
        if isinstance(frame.get("result"), dict) and "schema" in frame["result"]
    )
    return params, str(result["result"]["schema"]["fingerprint"])


async def _spawn(scenario: str):
    return await spawn_msp_connection(
        command=_fixture_bin(),
        args=["serve-fixture", "--transcript", str(CORPUS / scenario)],
    )


async def test_granted_handshake_surfaces_granted_capabilities(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    params, recorded_fp = _recorded("handshake-usershell-granted")
    monkeypatch.setattr(muse_code, "EXPECTED_SCHEMA_FINGERPRINT", recorded_fp)
    handshake = await _spawn("handshake-usershell-granted")
    # The pre-`initialized` handshake exposes NO traffic verb (FR-638-012):
    # a request/notify/command forward would type-check clean otherwise.
    for verb in ("request", "notify", "command"):
        assert not hasattr(handshake, verb), f"handshake must not expose {verb}"
    connection = await asyncio_wait(handshake.initialize(params))
    granted = connection.initialize_result.get("grantedCapabilities")
    assert granted == ["userShell"], f"grant not surfaced: {granted!r}"
    exit_ = await asyncio_wait(connection.close())
    assert exit_.code == 0 and exit_.signal is None, (
        "a draining fixture host closes clean and unsignalled"
    )


async def test_not_granted_handshake_completes_with_no_grant(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    params, recorded_fp = _recorded("handshake-usershell-not-granted")
    monkeypatch.setattr(muse_code, "EXPECTED_SCHEMA_FINGERPRINT", recorded_fp)
    handshake = await _spawn("handshake-usershell-not-granted")
    connection = await asyncio_wait(handshake.initialize(params))
    granted = connection.initialize_result.get("grantedCapabilities") or []
    assert "userShell" not in granted
    exit_ = await asyncio_wait(connection.close())
    assert exit_.code == 0 and exit_.signal is None, (
        "a non-zero clientEof/frameDivergence exit must not pass silently"
    )


async def test_capability_required_is_a_typed_error_branch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    scenario = "usershell-without-grant"
    transcript = load_transcript(CORPUS / scenario)
    params, recorded_fp = _recorded(scenario)
    monkeypatch.setattr(muse_code, "EXPECTED_SCHEMA_FINGERPRINT", recorded_fp)
    shell_request = next(
        frame
        for frame in transcript.client_frames
        if frame.get("method") == "session/userShell"
    )
    handshake = await _spawn(scenario)
    connection = await asyncio_wait(handshake.initialize(params))
    from muse_code.connection import MspError

    with pytest.raises(MspError) as excinfo:
        await asyncio_wait(
            connection.connection.request(
                "session/userShell", dict(shell_request["params"])
            )
        )
    assert excinfo.value.kind == "capabilityRequired", (
        "the SS1.6 branch is data.kind, never message text (INV-012)"
    )
    exit_ = await asyncio_wait(connection.close())
    assert exit_.code == 0 and exit_.signal is None, (
        "the fixture host closes clean and unsignalled after the typed error"
    )


async def test_default_pin_fails_exactly_on_the_recorded_fingerprint() -> None:
    # The C-638-4 strict gate against a REAL host: the SDK pin applies
    # (nothing is patched) and the recording-time fingerprint must fail with
    # the exact typed error naming the generated required host version — and
    # close still ends the host.
    from muse_code_msp import REQUIRED_HOST_VERSION

    params, recorded_fp = _recorded("handshake-usershell-granted")
    handshake = await _spawn("handshake-usershell-granted")
    with pytest.raises(MuseHostMismatchError) as excinfo:
        await asyncio_wait(handshake.initialize(params))
    assert excinfo.value.served == recorded_fp
    assert excinfo.value.required_host_version == REQUIRED_HOST_VERSION
    assert f"install host version {REQUIRED_HOST_VERSION}" in str(excinfo.value)
    assert "compatibility page" in str(excinfo.value)
    await asyncio_wait(handshake.close())


async def asyncio_wait(awaitable: Any) -> Any:
    import asyncio

    return await asyncio.wait_for(awaitable, timeout=REPORTING_DEADLINE_S)
