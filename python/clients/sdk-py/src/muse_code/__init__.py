"""Muse Code SDK for MSP: the asyncio-first Python facade.

Wire shapes are imported from the generated ``muse_code_msp`` package,
never restated here.

The transport-less core: the client fold (``muse_code.fold``), the pending
command set (``muse_code.pending``), the transcript replay runner
(``muse_code.replay``), and the typed error family (``muse_code.errors``).
The connection plane: the NDJSON connection machine, the owned-process spawn
path, host discovery, and the strict fingerprint gate
(``muse_code.connection``). The surface: the asyncio facade
(``muse_code.facade`` — ``MuseClient``, ``Session``, ``Turn``) with the
host-death discharge, the approval/user-input round trip, the gap
splice-fill, and the sync loop-runner wrapper (``muse_code.sync_facade`` —
``SyncMuseClient``).
"""

from __future__ import annotations

from typing import Final

import muse_code_msp

from .errors import (
    GapFillFailureReason,
    MuseCapabilityNotGrantedError,
    MuseFacadeOwnedMethodError,
    MuseForeignSessionError,
    MuseGapFillError,
    MuseHostDiscoveryError,
    MuseSessionDiscardedError,
    PermissionProfileNotApplied,
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
    "MuseCapabilityNotGrantedError",
    "MuseClient",
    "MuseClientOptions",
    "MuseClientSpawnOptions",
    "MuseFacadeOwnedMethodError",
    "MuseForeignSessionError",
    "MuseGapFillError",
    "MuseHostDiedError",
    "MuseHostDiscoveryError",
    "MuseHostStartError",
    "MuseSessionDiscardedError",
    "NotificationFailureHandler",
    "NotificationObserver",
    "PendingCommandSet",
    "PendingCommandView",
    "PermissionProfileNotApplied",
    "ProtocolErrorObserver",
    "ResumeSessionOptions",
    "RunResult",
    "SendUserTurnOptions",
    "Session",
    "SessionApplyOutcome",
    "SessionDurabilityProfile",
    "SessionEvent",
    "SessionFold",
    "SessionFoldView",
    "SessionGapBuffered",
    "SessionGapOverlap",
    "SessionStateStore",
    "StartSessionOptions",
    "SteerTurnOptions",
    "SyncMuseClient",
    "SyncSession",
    "SyncTurn",
    "Transcript",
    "TransportEof",
    "Turn",
    "TurnOutcome",
    "TurnUnqueueOutcome",
    "ViewFrame",
    "is_abnormal_host_death",
    "is_launch_failure",
    "load_transcript",
    "read_session_durability",
    "replay_into_fold",
    "transcript_dirs",
]

EXPECTED_SCHEMA_FINGERPRINT: Final[str] = muse_code_msp.SCHEMA_FINGERPRINT
"""The stable schema-bundle fingerprint this SDK was built against.

No second port and no second copy: this is the generated package's stable
``SCHEMA_FINGERPRINT``, derived at import from the schema bytes. The
manifests suite binds it to the value derived from the stable bundle, so a
drift between the port the package vendors and the shared derivation reds
that lane instead of passing silently.
"""

# The lockstep rule: the release train bumps pyproject.toml, the
# distribution-metadata authority; this constant is aligned at publication
# time.
__version__: Final[str] = "1.4.20"

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
    MuseHostStartError,
    NotificationFailureHandler,
    NotificationObserver,
    PendingCommandView,
    ProtocolErrorObserver,
    ResumeSessionOptions,
    RunResult,
    SendUserTurnOptions,
    Session,
    SessionApplyOutcome,
    SessionDurabilityProfile,
    SessionEvent,
    SessionFoldView,
    SessionGapBuffered,
    SessionGapOverlap,
    StartSessionOptions,
    SteerTurnOptions,
    TransportEof,
    Turn,
    TurnOutcome,
    TurnUnqueueOutcome,
    ViewFrame,
    is_abnormal_host_death,
    is_launch_failure,
    read_session_durability,
)
from .sync_facade import SyncMuseClient, SyncSession, SyncTurn  # noqa: E402
