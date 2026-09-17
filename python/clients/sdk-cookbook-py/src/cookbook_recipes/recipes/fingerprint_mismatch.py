"""Recipe twin: handle a schema fingerprint mismatch — the STRICT fork.

The TS recipe teaches the warning posture (``checkServedFingerprint`` returns
a warning value; the client carries on). The Python SDK's posture is the
OWNER-RULED STRICT fork: at ``initialize``, a mismatch FAILS with the exact
``MuseHostMismatchError`` naming the required host version and the
compatibility page — there is no warning value and no bypass, because the
wheel ships without a host and a wrong pairing must be loud at connect time.

Same segment ids as the TS recipe (the carve-out's rule); the
``mismatch-is-a-warning`` arm is where the fork shows: it constructs a fresh
handshake against a synthetic expected fingerprint (the module-attribute pin,
the same seam the conformance suites drive) and asserts the exact typed
FAILURE where the TS recipe asserts a warning value.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass

import muse_code
from muse_code import EXPECTED_SCHEMA_FINGERPRINT
from muse_code.errors import COMPATIBILITY_PAGE_URL, MuseHostMismatchError
from muse_code_msp import REQUIRED_HOST_VERSION

from ..kit import (
    equals,
    Host,
    HostOptions,
    isolated_host_env,
    JourneyReport,
    object_at,
    pinned_to,
    require_host,
    run_journey,
    Segment,
    string_at,
    within,
)
from ..runner import Recipe, RecipeHosts

HANDSHAKE_BUDGET_MS = 30_000
CLOSE_BUDGET_MS = 30_000

NEWER_HOST_FINGERPRINT = f"sha256:{'f' * 64}"
"""A fingerprint no bundle has ever had: what a newer host might serve."""


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    muse_bin: str
    host: Host | None = None


async def _spawn(context: Context) -> None:
    context.host = await Host.start(
        HostOptions(
            muse_bin=context.muse_bin,
            home=tempfile.mkdtemp(prefix="muse-cookbook-home-"),
            workspace_root=tempfile.mkdtemp(prefix="muse-cookbook-ws-"),
            # Announce the cookbook, not the quickstart, in the host's
            # session/audit attribution.
            client_info={"name": "muse_sdk_cookbook_py", "version": "0.0.0"},
        ),
        HANDSHAKE_BUDGET_MS,
    )


async def _match(context: Context) -> None:
    host = require_host(context.host, "spawn")
    result = host.msp.initialize_result
    schema = object_at(dict(result), "schema", "initialize result")
    served = string_at(schema, "fingerprint", "initialize schema")
    equals(served, EXPECTED_SCHEMA_FINGERPRINT, "the served schema fingerprint vs the SDK pin")
    # Reaching this segment at all is the other half of the same conclusion:
    # the strict gate compared at initialize and let the handshake complete.


async def _mismatch_is_strict(context: Context) -> None:
    # The exact comparison the SDK runs at handshake, against the fingerprint
    # a newer host would serve — driven through the module-attribute pin (the
    # conformance suites' seam; the SDK deliberately has no parameter for it,
    # so nothing here bypasses the gate for real consumers).
    require_host(context.host, "spawn")
    pinned_before = muse_code.EXPECTED_SCHEMA_FINGERPRINT
    # The kit's pinned_to is the ONE sanctioned pin seam (review finding:
    # a second copy of the save/restore protocol drifts).
    with pinned_to(NEWER_HOST_FINGERPRINT):
        home = tempfile.mkdtemp(prefix="muse-cookbook-home-")
        workspace = tempfile.mkdtemp(prefix="muse-cookbook-ws-")
        try:
            await within(
                "the deliberately mismatched handshake failing",
                HANDSHAKE_BUDGET_MS,
                Host.start(
                    HostOptions(
                        muse_bin=context.muse_bin,
                        home=home,
                        workspace_root=workspace,
                        client_info={"name": "muse_sdk_cookbook_py", "version": "0.0.0"},
                    ),
                    HANDSHAKE_BUDGET_MS,
                ),
            )
        except RuntimeError as wrapped:
            # Host.start wraps every handshake failure with the exit/stderr
            # evidence; the typed error is the cause chain's root.
            cause = wrapped.__cause__
            if not isinstance(cause, MuseHostMismatchError):
                raise
            equals(cause.served, pinned_before, "the error's served fingerprint")
            equals(cause.pinned, NEWER_HOST_FINGERPRINT, "the error's pinned fingerprint")
            message = str(cause)
            for needed, what in (
                (REQUIRED_HOST_VERSION, "the required host version"),
                (COMPATIBILITY_PAGE_URL, "the compatibility page"),
            ):
                if needed not in message:
                    raise AssertionError(
                        f"the mismatch error does not name {what}: {message}"
                    ) from None
            return
        except MuseHostMismatchError as error:
            equals(error.served, pinned_before, "the error's served fingerprint")
            equals(error.pinned, NEWER_HOST_FINGERPRINT, "the error's pinned fingerprint")
            return
        raise AssertionError(
            "a mismatched fingerprint completed the handshake; the C-638-4 "
            "strict gate did not fire"
        )


async def _drain(context: Context) -> None:
    host = require_host(context.host, "spawn")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the host's exit code after stdin EOF")
    classification = await host.msp.child.exit
    equals(classification.kind, "cleanShutdown", "the SDK's exit classification")
    context.host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment("spawn", "Spawn the release-built host and complete the handshake", _spawn),
    Segment(
        "match",
        "The served fingerprint matches the SDK's pin, so the handshake completed",
        _match,
    ),
    # The TS id, kept per the governing rule carve-out; what it teaches here is
    # the owner-ruled strict fork.
    Segment(
        "mismatch-is-a-warning",
        "In Python a newer host's fingerprint FAILS initialize with the exact typed error",
        _mismatch_is_strict,
    ),
    Segment("drain", "Close stdin and let the host exit cleanly", _drain),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.muse_bin is None:
        raise ValueError("muse_bin is required")
    context = Context(muse_bin=hosts.muse_bin)

    async def teardown(owned: Context) -> None:
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="fingerprint-mismatch",
    title="Handle a schema fingerprint mismatch",
    docs_page="developer-" "docs/src/content/docs/cookbook/handle-a-fingerprint-mismatch.mdx",
    needs=("muse_bin",),
    run=_run,
)
