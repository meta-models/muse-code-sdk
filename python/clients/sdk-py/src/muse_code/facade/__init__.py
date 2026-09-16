"""The SS7.1 asyncio facade (spec 638 FR-638-019, plan slice S3).

The hand-written surface over the transport-less core and the connection
plane: :class:`~muse_code.facade.client.MuseClient` opens sessions,
:class:`~muse_code.facade.session.Session` folds a session's view and submits
this client's half of the exchange, and
:class:`~muse_code.facade.turn_handle.Turn` follows one turn's items and
deltas to its outcome. Port of ``clients/sdk-ts/src/facade`` (spec 638
INV-638-04 parity).
"""

from __future__ import annotations

# `ApprovalRouter` and `GapFiller` themselves stay OFF the barrel
# (Constitution XI, TS index.ts parity): they are `Session`'s internals with
# no consumer. Their handler/decision TYPES are exported because a consumer
# writes one.
from .approval import (
    ApprovalDecisionInput,
    ApprovalFailure,
    ApprovalFailureHandler,
    ApprovalHandler,
)
from .client import (
    MuseClient,
    MuseClientOptions,
    MuseClientSpawnOptions,
    ResumeSessionOptions,
    StartSessionOptions,
)
from .discarded import DiscardedSessions
from .gap_fill import GapFillFailureHandler
from .host_death import (
    AbnormalExit,
    HostDeathDischarge,
    HostDeathNotification,
    MuseHostDiedError,
    SessionDurabilityProfile,
    TransportEof,
    is_abnormal_host_death,
    read_session_durability,
)
from .session import (
    PendingCommandView,
    Session,
    SessionApplyOutcome,
    SessionApplyRefusal,
    SessionFoldView,
    SessionGapBuffered,
    SessionGapOverlap,
    SessionOpening,
)
from .turn_handle import FoldedItem, Turn, TurnOutcome, is_launch_failure
from .turn_submit import SendUserTurnOptions

__all__ = [
    "AbnormalExit",
    "ApprovalDecisionInput",
    "ApprovalFailure",
    "ApprovalFailureHandler",
    "ApprovalHandler",
    "DiscardedSessions",
    "FoldedItem",
    "GapFillFailureHandler",
    "HostDeathDischarge",
    "HostDeathNotification",
    "MuseClient",
    "MuseClientOptions",
    "MuseClientSpawnOptions",
    "MuseHostDiedError",
    "PendingCommandView",
    "ResumeSessionOptions",
    "SendUserTurnOptions",
    "Session",
    "SessionApplyOutcome",
    "SessionApplyRefusal",
    "SessionDurabilityProfile",
    "SessionFoldView",
    "SessionGapBuffered",
    "SessionGapOverlap",
    "SessionOpening",
    "StartSessionOptions",
    "TransportEof",
    "Turn",
    "TurnOutcome",
    "is_abnormal_host_death",
    "is_launch_failure",
    "read_session_durability",
]
