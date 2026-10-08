"""The typed failure of :meth:`MuseClient.spawn` when the host is lost before
the handshake completes.

Without it the exception is whatever the transport saw first — usually
``ProtocolError("connection reached EOF")`` — while the evidence that explains
it (the exit classification row and the bounded stderr tail) sits unread on
the child the facade already owns. Every process-exit error carries that
evidence; this module is the handshake-failure arm of that rule.

A binary that cannot be started is not this error: it raises the operating
system's own error (``FileNotFoundError``, ``PermissionError``) from the spawn
call, before any handshake exists, so no process ran and there is no row to
attach.
"""

from __future__ import annotations

from typing import Tuple

from ..connection.connection import MspError, ProtocolError, _UnencodableFrameError
from ..connection.spawn import ExitClassification
from ..errors import MuseHostMismatchError, MuseValidationError

_MESSAGE_TAIL_LINES = 5
"""How many tail lines the message quotes; ``stderr_tail`` carries them all."""


class MuseHostStartError(Exception):
    """:meth:`MuseClient.spawn` lost its host before ``initialize`` was answered.

    Typed rather than a bare ``Exception`` because ``exit.kind`` and
    ``exit.retry`` name STATES an embedder branches on (fix the configuration,
    wait for a lease, give up). The transport error that first surfaced the
    loss rides as ``__cause__``, so nothing the old exception carried is lost.

    Attributes:
        exit: The host's exit classification row — any row, the clean one
            included: a host that wrote its complaint to stderr and exited 0
            before its first frame is still a lost host, and the row says
            only how it ended.
        stderr_tail: The SDK's bounded stderr tail when the host was lost.
            The only carrier of that evidence when the row is
            ``cleanShutdown``, which keeps no tail of its own.
        answered_initialize: Whether the host got as far as an
            ``initialize`` answer before it was lost. ``True`` means it
            started and answered, then died while this client was completing
            the handshake — not a startup problem.
    """

    def __init__(
        self,
        exit: ExitClassification,  # noqa: A002 - mirrors the row's name
        stderr_tail: Tuple[str, ...],
        *,
        answered_initialize: bool,
    ) -> None:
        """Builds the error; raise it ``from`` the transport error.

        Args:
            exit: The observed exit's classification row.
            stderr_tail: The bounded stderr evidence.
            answered_initialize: Whether ``initialize`` was answered first.
        """
        super().__init__(_describe(exit, stderr_tail, answered_initialize))
        self.exit: ExitClassification = exit
        self.stderr_tail: Tuple[str, ...] = stderr_tail
        self.answered_initialize: bool = answered_initialize


def _describe(
    exit: ExitClassification,  # noqa: A002
    tail: Tuple[str, ...],
    answered_initialize: bool,
) -> str:
    if exit.kind == "cleanShutdown":
        how = "exit code 0"
    elif exit.exit_signal is not None:
        how = f"signal {exit.exit_signal}"
    else:
        how = f"exit code {exit.exit_code}"
        if exit.retry is not None:
            how += f", retry: {exit.retry}"
    quoted = tail[-_MESSAGE_TAIL_LINES:]
    if not tail:
        evidence = "stderr tail: (empty)"
    else:
        count = (
            f" (last {len(quoted)} of {len(tail)} lines)" if len(quoted) < len(tail) else ""
        )
        evidence = f"stderr tail{count}:\n  " + "\n  ".join(quoted)
    when = (
        "after answering initialize, before the handshake completed"
        if answered_initialize
        else "before answering initialize"
    )
    return f"muse host exited {when}: {exit.kind} ({how}); {evidence}"


def keeps_its_own_error(error: BaseException) -> bool:
    """Is this handshake failure something other than a lost host?

    "Lost" is decided by whether the failure carries the host's answer,
    never by how it ended:
    its own error, a fingerprint mismatch, a result this SDK refused as
    malformed, or any protocol violation that carries the refused frame are
    all answers, and each is a more useful error than the exit our own
    ``close()`` then caused. An ``initialize`` frame that could not even be
    encoded never reached the host: that is the caller's defect, and the
    host it was meant for is not to blame.
    """
    if isinstance(error, (MspError, MuseHostMismatchError, MuseValidationError)):
        return True
    if isinstance(error, _UnencodableFrameError):
        return True
    return isinstance(error, ProtocolError) and error.line is not None
