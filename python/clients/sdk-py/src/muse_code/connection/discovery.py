"""Host discovery for the UNBUNDLED wheel.

The wheel carries no host binary and no code path assumes one. Exactly the
two ruled tiers, first hit wins: an explicit ``muse_bin`` argument, then a
``muse`` on ``PATH``. The LIBRARY reads no environment variable (TS parity:
the TS spawn module takes a required command; ``MUSE_BIN`` is a knob of the
quickstart/cookbook HARNESSES, which read it themselves and pass the
explicit parameter down). No discoverable host fails BEFORE any process is
spawned, with an exact error naming the parameter and the compatibility
page.
"""

from __future__ import annotations

import shutil

from ..errors import COMPATIBILITY_PAGE_URL, MuseHostDiscoveryError

HOST_BINARY_NAME = "muse"
"""What the second tier looks for on ``PATH``."""


def discover_muse_bin(muse_bin: str | None = None) -> str:
    """Resolves the MSP host binary to spawn (spec 638 FR-638-020).

    Exactly two ruled inputs (FR-638-020 / INV-638-08): an explicit
    ``muse_bin``, else the process ``PATH``. There is deliberately no ``env``
    knob — no production caller passes one, the TS twin has none, and a
    harness wanting hermetic discovery exports ``PATH`` itself; a future S3
    consumer that needs the child's own env adds it there (PR #30094 review).

    Args:
        muse_bin: An explicit host path; when given it wins outright and is
            returned verbatim (existence is the spawn's to prove — an
            explicit path is the caller's statement, not a search hint).

    Returns:
        The binary to spawn.

    Raises:
        MuseHostDiscoveryError: Neither tier produced a host. The message
            names the ``muse_bin`` parameter and the compatibility page
            whose Python row states which host versions this SDK supports.
    """
    if muse_bin is not None:
        return muse_bin
    found = shutil.which(HOST_BINARY_NAME)
    if found is not None:
        return found
    raise MuseHostDiscoveryError(
        "no muse host found: pass muse_bin=<path to a muse binary> or put "
        f"`{HOST_BINARY_NAME}` on PATH. The wheel does not bundle a host (it "
        "is installed separately); supported host versions are listed on the "
        f"compatibility page's Python row: {COMPATIBILITY_PAGE_URL}"
    )
