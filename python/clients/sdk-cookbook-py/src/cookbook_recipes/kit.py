"""The cookbook recipes' shared kit — the Python side of
``clients/sdk-cookbook/src/kit``.

The heavy machinery (the spawned :class:`Host` with its notification
recorder, the segment runner, the expect-block contract) is the quickstart
harness's (``quickstart_journey.host`` / ``.segments``) — one kit, two
harnesses, the mirrored direction of the TS quickstart consuming the TS
cookbook's kit. What lives HERE is what the TS kit has and the quickstart's
Python kit did not need yet: the generic fixture-host spawn (the quickstart
only ever starts the release ``muse``), and the small typed-read helpers
every recipe leans on.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, List, Mapping, Sequence, TypeVar

import muse_code
from muse_code.replay import load_transcript

from quickstart_journey.host import (
    HOST_DRAIN_WINDOW_MS,
    Host,
    HostOptions,
    RecordedNotification,
    TimeoutBudgetError,
    isolated_host_env,
    within,
)
from quickstart_journey.segments import JourneyReport, Segment, run_journey

from muse_code.connection.spawn import MspHandshake, spawn_msp_connection

__all__ = [
    "HOST_DRAIN_WINDOW_MS",
    "Host",
    "HostOptions",
    "JourneyReport",
    "RecordedNotification",
    "Segment",
    "TimeoutBudgetError",
    "array_at",
    "equals",
    "isolated_host_env",
    "object_at",
    "pinned_to",
    "require_host",
    "run_journey",
    "spawn_fixture_host",
    "string_at",
    "within",
]

_T = TypeVar("_T")


async def _spawn_command_host(
    *,
    command: str,
    args: Sequence[str],
    client_info: Mapping[str, str],
    budget_ms: int,
    env: Mapping[str, str] | None = None,
) -> Host:
    """Spawn an arbitrary MSP host and complete the handshake — the TS kit's
    ``Host.spawn`` twin, private until a second spawn shape needs it
    (:func:`spawn_fixture_host` is its one consumer today).

    Args:
        command: The host binary to run.
        args: Passed through verbatim.
        client_info: The ``clientInfo`` the handshake announces. REQUIRED
            (the TS kit's rule): every caller names itself.
        budget_ms: Handshake wall — a failure cap, never pacing.
        env: The child's environment (inherited when ``None``).

    Returns:
        The initialized :class:`Host`, its notification recorder attached.
    """
    stderr: List[str] = []
    handshake: MspHandshake = await spawn_msp_connection(
        command,
        args=tuple(args),
        env=env,
        on_stderr=stderr.append,
        shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
    )
    try:
        msp = await within(
            "the MSP handshake",
            budget_ms,
            handshake.initialize({"clientInfo": dict(client_info)}),
        )
    except BaseException as error:
        # Bound this peek (the kit's rule): a host that went silent must not
        # hang the caller past the journey's own cleanup.
        try:
            exit_ = await within(
                "the host's exit after a failed handshake", 2_000, handshake.exited
            )
            observed = f"{exit_}"
        except Exception:  # noqa: BLE001 - diagnostic only
            observed = "still running"
        raise RuntimeError(
            f"handshake failed (exit {observed}); stderr: {''.join(stderr)}"
        ) from error
    return Host(msp, stderr)


def _recorded_fingerprint(transcript_dir: Path) -> str:
    """The RECORDING-time bundle fingerprint a transcript's host serves.

    The additive repin flow re-pins manifests, never wire bytes, so a
    transcript's recorded ``InitializeResult`` carries the fingerprint of the
    bundle it was recorded against — not the current stable pin.
    """
    transcript = load_transcript(transcript_dir)
    result = next(
        frame
        for frame in transcript.server_frames
        if isinstance(frame.get("result"), dict) and "schema" in frame["result"]
    )
    return str(result["result"]["schema"]["fingerprint"])


@contextmanager
def pinned_to(fingerprint: str) -> Iterator[None]:
    """Scope ``muse_code.EXPECTED_SCHEMA_FINGERPRINT`` to ``fingerprint``.

    The sanctioned retarget for driving recorded bundles through the C-638-4
    strict gate (the ``test_spawn_handshake.py`` pattern): the SDK
    deliberately has no expected-fingerprint parameter, and the handshake
    reads the module attribute at call time. Recipes run serially, so the
    scope cannot race a concurrent handshake.
    """
    before = muse_code.EXPECTED_SCHEMA_FINGERPRINT
    muse_code.EXPECTED_SCHEMA_FINGERPRINT = fingerprint
    try:
        yield
    finally:
        muse_code.EXPECTED_SCHEMA_FINGERPRINT = before


async def spawn_fixture_host(
    *,
    conformance_bin: str,
    transcript_dir: Path,
    client_info: Mapping[str, str],
    budget_ms: int,
    env: Mapping[str, str] | None = None,
) -> Host:
    """Spawn ``muse-conformance serve-fixture`` on a committed transcript,
    with the strict fingerprint gate retargeted to that transcript's own
    recorded bundle for the handshake's scope."""
    with pinned_to(_recorded_fingerprint(transcript_dir)):
        return await _spawn_command_host(
            command=conformance_bin,
            args=("serve-fixture", "--transcript", str(transcript_dir)),
            client_info=client_info,
            budget_ms=budget_ms,
            env=env,
        )


def require_host(host: Host | None, prior_segment: str) -> Host:
    """The host an earlier segment was to leave behind, or a failure naming it."""
    if host is None:
        raise RuntimeError(f"`{prior_segment}` did not finish")
    return host


def equals(actual: object, expected: object, what: str) -> None:
    """Assert equality with the two values in the failure text."""
    if actual != expected:
        raise AssertionError(f"{what}: expected {expected!r}, got {actual!r}")


def string_at(value: Mapping[str, Any], key: str, where: str) -> str:
    """The string member ``key`` of ``value``, or a failure naming ``where``."""
    member = value.get(key)
    if not isinstance(member, str):
        raise AssertionError(f"{where} has no string {key!r}: {member!r}")
    return member


def object_at(value: Mapping[str, Any], key: str, where: str) -> Mapping[str, Any]:
    """The object member ``key`` of ``value``, or a failure naming ``where``."""
    member = value.get(key)
    if not isinstance(member, Mapping):
        raise AssertionError(f"{where} has no object {key!r}: {member!r}")
    return member


def array_at(value: Mapping[str, Any], key: str, where: str) -> List[Any]:
    """The array member ``key`` of ``value``, or a failure naming ``where``."""
    member = value.get(key)
    if not isinstance(member, list):
        raise AssertionError(f"{where} has no array {key!r}: {member!r}")
    return member
