"""Request a session that excludes the ``workflow`` built-in tool, and
verify the host echoed the restriction -- or fail loudly.

WARNING: experimental, and host-dependent. ``allowedBuiltInTools`` is an
experimental ``SessionConfig`` member, and the ``appliedBuiltInTools``
echo is filled only by a host with the enforcement piece (P8) landed.
Until then, a spelled request is refused by current hosts (P5) or, on
a host that accepts it without enforcing, answered with no echo --
which this example treats as UNAPPLIED and raises for, never as
success. Do not read a clean run of this example as proof that
background workflows are disabled until the host you run against
serves the echo.

Run:

.. code-block:: sh

    python examples/verify_applied_tools.py --workspace-root .

``--allowed`` spells the built-in tools this session may use, as a
comma-separated list of the host's exact, case-sensitive built-in
names, with ``workflow`` omitted. The default (``read,search``) is an
illustrative allowlist: replace it with the names your host serves.
The check is a subset check -- the host may echo fewer tools than
requested (it intersects with what it serves) -- so a name the host
does not serve does not fail the check; an echo that still names
``workflow``, or no echo at all, does.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import cast

from muse_code import (
    MuseClient,
    MuseClientSpawnOptions,
    StartSessionOptions,
    verify_applied_built_in_tools,
)
from muse_code_msp import SessionConfig
from muse_code_msp.experimental import SessionConfig as ExperimentalSessionConfig


async def verify_session(
    client: MuseClient, workspace_root: str, allowed: list[str]
) -> list[str]:
    """Start a session restricted to ``allowed`` and return the echo.

    Raises ``AppliedBuiltInToolsNotApplied`` when the host does not echo
    an applied set, or the echo still names a tool outside ``allowed``.
    """
    experimental: ExperimentalSessionConfig = {"allowedBuiltInTools": allowed}
    session = await client.start_session(
        StartSessionOptions(
            workspace_root=workspace_root,
            # The cast is the experimental opt-in: the facade's stable
            # SessionConfig type does not carry the member, and the
            # config dict is forwarded verbatim. Graduation would
            # remove the cast.
            config=cast(SessionConfig, experimental),
        )
    )
    return verify_applied_built_in_tools(session.opening, allowed)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--muse-bin", help="host binary; defaults to muse on PATH")
    parser.add_argument("--workspace-root", default=".")
    parser.add_argument(
        "--allowed",
        default="read,search",
        help="comma-separated built-in tools the session may use; "
        "omit workflow to request no background-workflow delegation",
    )
    args = parser.parse_args()
    allowed = [name.strip() for name in args.allowed.split(",") if name.strip()]
    if "workflow" in allowed:
        parser.error("--allowed must omit workflow for this example")
    print(
        "warning: allowedBuiltInTools is experimental and host enforcement "
        "(P8) is required for disabling to take effect; an absent echo "
        "fails this check",
        file=sys.stderr,
    )
    client = await MuseClient.spawn(
        MuseClientSpawnOptions(
            muse_bin=args.muse_bin,
            args=["serve"],
            client_info={"name": "verify_applied_tools", "version": "1.4.20"},
        )
    )
    try:
        applied = await verify_session(client, args.workspace_root, allowed)
    finally:
        await client.close()
    print(json.dumps({"allowedBuiltInTools": allowed, "appliedBuiltInTools": applied}))


if __name__ == "__main__":
    asyncio.run(main())
