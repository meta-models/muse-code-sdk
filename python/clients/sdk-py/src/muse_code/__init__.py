"""Muse Code SDK for MSP: the asyncio-first Python facade.

Owning spec: ``specs/638-muse-sdk-python`` (governing ADR
``docs/adr/638-muse-sdk-python.md``). Wire shapes are imported from the
generated ``muse_code_msp`` package, never restated here (INV-638-01/02).

S1 (the transport-less core) is in: the SS4 fold (``muse_code.fold``), the
SS4.13 pending set (``muse_code.pending``), the transcript replay runner
(``muse_code.replay``), and the typed error family (``muse_code.errors``).
S2 is in: the NDJSON connection machine, the owned-process spawn path, host
discovery, and the strict fingerprint gate (``muse_code.connection``). S3 is in:
the asyncio facade (``muse_code.facade`` — ``MuseClient``, ``Session``,
``Turn``) with the host-death discharge, the approval/user-input round trip,
the SS4.8 gap splice-fill, and the sync loop-runner wrapper
(``muse_code.sync_facade`` — ``SyncMuseClient``).
"""

from __future__ import annotations

from typing import Final

from .errors import (
    GapFillFailureReason,
    MuseForeignSessionError,
    MuseGapFillError,
    MuseSessionDiscardedError,
)
from .fold import ItemStore, SessionFold, SessionStateStore
from .pending import PendingCommandSet
from .replay import Transcript, load_transcript, replay_into_fold, transcript_dirs

__all__ = [
    "EXPECTED_SCHEMA_FINGERPRINT",
    "ApprovalDecisionInput",
    "ApprovalFailure",
    "ApprovalFailureHandler",
    "ApprovalHandler",
    "DiscardedSessions",
    "GapFillFailureHandler",
    "GapFillFailureReason",
    "HostDeathDischarge",
    "HostDeathNotification",
    "ItemStore",
    "MuseClient",
    "MuseClientOptions",
    "MuseClientSpawnOptions",
    "MuseForeignSessionError",
    "MuseGapFillError",
    "MuseHostDiedError",
    "MuseSessionDiscardedError",
    "PendingCommandSet",
    "PendingCommandView",
    "ResumeSessionOptions",
    "SendUserTurnOptions",
    "Session",
    "SessionApplyOutcome",
    "SessionDurabilityProfile",
    "SessionFold",
    "SessionFoldView",
    "SessionGapBuffered",
    "SessionGapOverlap",
    "SessionStateStore",
    "StartSessionOptions",
    "SyncMuseClient",
    "SyncSession",
    "SyncTurn",
    "Transcript",
    "TransportEof",
    "Turn",
    "TurnOutcome",
    "is_abnormal_host_death",
    "is_launch_failure",
    "load_transcript",
    "read_session_durability",
    "replay_into_fold",
    "transcript_dirs",
]

EXPECTED_SCHEMA_FINGERPRINT: Final[str] = (
    "sha256:ab69549a7ebb423fce94068762da0b5ff3cdec1f8fc263dcc17248eda117f852"
)
"""The stable schema-bundle fingerprint this SDK was built against.

The one deliberately duplicated fact (spec 638 FR-638-006, the 14990 FR-006
pattern): ``clients/sdk-py/tests/test_manifests.py`` binds it to
``schema/msp/stable/manifest.json``, so a schema advance that forgets the
Python SDK reds this lane instead of drifting silently.
"""

# D-063 lockstep (ADR 25304 D4): the release train bumps pyproject.toml, the
# distribution-metadata authority; this constant is aligned at publication
# time (the publish itself is owner-run, permitted by D-065, ADR 29534 D1).
__version__: Final[str] = "1.3.0"

# The facade is imported last so the constants above are already bound: the
# spawn path reads ``EXPECTED_SCHEMA_FINGERPRINT`` (lazily, at initialize
# time), and importing the facade first would risk a partially initialized
# module.
from .facade import (  # noqa: E402
    ApprovalDecisionInput,
    ApprovalFailure,
    ApprovalFailureHandler,
    ApprovalHandler,
    DiscardedSessions,
    GapFillFailureHandler,
    HostDeathDischarge,
    HostDeathNotification,
    MuseClient,
    MuseClientOptions,
    MuseClientSpawnOptions,
    MuseHostDiedError,
    PendingCommandView,
    ResumeSessionOptions,
    SendUserTurnOptions,
    Session,
    SessionApplyOutcome,
    SessionDurabilityProfile,
    SessionFoldView,
    SessionGapBuffered,
    SessionGapOverlap,
    StartSessionOptions,
    TransportEof,
    Turn,
    TurnOutcome,
    is_abnormal_host_death,
    is_launch_failure,
    read_session_durability,
)
from .sync_facade import SyncMuseClient, SyncSession, SyncTurn  # noqa: E402
