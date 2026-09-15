"""Run the journey and print the segment report.

    python -m quickstart_journey --bin <path-to-release-built-muse>
    python -m quickstart_journey --bin <...> --no-provider
    python -m quickstart_journey --bin <...> --sync

The default is the provider-configured (acceptance) mode: the harness starts
a loopback fake first-party endpoint and points the host's HOME at it, so
every one of the twelve segments runs for real. Nothing leaves ``127.0.0.1``
and no API key is used.

``--no-provider`` selects the credential-free degradation path: no provider
is configured, so the host cannot run a model and the model-dependent
segments fail for real. That run is useful for isolating the segments that
need no model; it is NOT the acceptance artifact.

``--sync`` runs the Scenario 7.1 rewrite: the same twelve steps on the sync
wrapper (``SyncMuseClient``), blocking verbs end to end.

Exit 0 means every required segment passed and every expect-block is still
accurate. Exit 1 means a required segment failed, or a blocked segment
started passing and now needs promoting.
"""

from __future__ import annotations

import asyncio
import os
import sys

from .journey import (
    JourneyOptions,
    run_configured_journey,
    run_configured_sync_journey,
    run_journey,
)
from .segments import format_report


def main(argv: list[str]) -> int:
    """The CLI: parse, run the selected mode, print the report."""

    def argument(name: str) -> str | None:
        if name not in argv:
            return None
        index = argv.index(name)
        return argv[index + 1] if index + 1 < len(argv) else None

    muse_bin = argument("--bin") or os.environ.get("MUSE_BIN") or ""
    if not muse_bin:
        sys.stderr.write(
            "usage: python -m quickstart_journey --bin <path-to-release-built-muse>"
            " [--no-provider] [--sync]\n"
            "       (or set MUSE_BIN). Build it with:\n"
            "       cargo build --release -p tbh-cli --bin tbh\n"
        )
        return 2

    if "--sync" in argv:
        sync_result = run_configured_sync_journey(muse_bin)
        sys.stdout.write(format_report(sync_result.report) + "\n")
        sys.stdout.write(
            f"\nmode=sync-wrapper provider-configured "
            f"baseUrl={sync_result.base_url} "
            f"catalogGets={sync_result.catalog_gets} "
            f"scriptedToolCalls={sync_result.scripted_tool_calls}\n"
        )
        return 0 if sync_result.report.ok else 1

    if "--no-provider" in argv:
        report = asyncio.run(run_journey(JourneyOptions(muse_bin=muse_bin)))
        sys.stdout.write(format_report(report) + "\n")
        sys.stdout.write(
            "\nmode=credential-free (no provider configured) — this is the "
            "degradation path, not the acceptance run\n"
        )
        return 0 if report.ok else 1

    configured = asyncio.run(run_configured_journey(muse_bin))
    sys.stdout.write(format_report(configured.report) + "\n")
    sys.stdout.write(
        f"\nmode=provider-configured baseUrl={configured.base_url}"
        f" catalogGets={configured.catalog_gets}"
        f" scriptedToolCalls={configured.scripted_tool_calls}\n"
    )
    return 0 if configured.report.ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
