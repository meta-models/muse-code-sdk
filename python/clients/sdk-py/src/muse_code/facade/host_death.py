"""The ephemeral-profile host-death discard obligation, client side.

Port of the TypeScript SDK's host-death module. The stores landed the
two STORE-LEVEL primitives first, with no production callers:
:meth:`~muse_code.pending.PendingCommandSet.discard_ephemeral` and
:meth:`~muse_code.fold.ItemStore.mark_ephemeral_host_death`. This module holds
the two facts the stores deliberately do not know — which durability profile
the handshake declared, and whether a given process exit was abnormal — and
:class:`~muse_code.facade.session.Session` composes them into the discharge.

The stores stay wire-shape-blind: the ``Item`` probe lives here,
where it reads the generated ``ItemStatus`` vocabulary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Generic, Literal, TypeVar, Union

from muse_code_msp import (
    ITEM_STATUS_KNOWN_VALUES,
    SESSION_DURABILITY_KNOWN_VALUES,
    InitializeResult,
    Item,
)

from ..connection.spawn import ExitClassification

if TYPE_CHECKING:
    from ..fold.item_store import TerminalUnknownItemAnnotation
    from ..pending.pending_command_set import PendingRetirement

_I = TypeVar("_I")

# Read from the generated KNOWN_VALUES tuples so a misspelling is caught by
# the codegen contract rather than compiling green against an open ``str``
# enum — the runtime twin of the TS ``Extract<…>`` closed-vocabulary bind.
_DURABLE = "durable"
_EPHEMERAL = "ephemeral"
_IN_PROGRESS = "inProgress"
assert _DURABLE in SESSION_DURABILITY_KNOWN_VALUES
assert _EPHEMERAL in SESSION_DURABILITY_KNOWN_VALUES
assert _IN_PROGRESS in ITEM_STATUS_KNOWN_VALUES


@dataclass(frozen=True)
class _Durable:
    kind: Literal["durable"] = "durable"


@dataclass(frozen=True)
class _Ephemeral:
    kind: Literal["ephemeral"] = "ephemeral"


@dataclass(frozen=True)
class _Unrecognized:
    """An open-enum value this SDK predates. Guarantees nothing (SS2.13.1)."""

    value: str
    kind: Literal["unrecognized"] = "unrecognized"


SessionDurabilityProfile = Union[_Durable, _Ephemeral, _Unrecognized]
"""Which durability profile the host declared at the handshake (SS2.13.1).

Absent and declared-``durable`` collapse to ONE reading on purpose: nothing
downstream needs to tell them apart, and a ``source`` discriminator would be a
field carried for a future that has not arrived.
"""


def read_session_durability(result: InitializeResult) -> SessionDurabilityProfile:
    """Reads ``sessionDurability`` off the handshake result (SS2.13.1).

    Two readings are easy to conflate and must not be:

    - ABSENT reads as ``durable``, decidable rather than fabricated: the
      member is optional only so the addition was additive (SS1.5.4), and no
      server that omits it has the ephemeral profile.
    - An UNRECOGNIZED value is NOT durable. SS2.13.1: a client that does not
      know the value must infer no durability guarantee from it and must not
      fall through to the absent-means-durable rule — that rule keys on the
      member being MISSING, not on its value being unfamiliar. The open enum
      makes the conservative read "assume nothing survives this host".

    Args:
        result: The typed ``initialize`` result.

    Returns:
        The durability profile every session opened under it inherits.
    """
    declared = result.get("sessionDurability")
    if declared is None or declared == _DURABLE:
        return _Durable()
    if declared == _EPHEMERAL:
        return _Ephemeral()
    return _Unrecognized(value=declared)


def survives_host_death(profile: SessionDurabilityProfile) -> bool:
    """Does a session on this profile survive its host? Only a durable one."""
    return profile.kind == _DURABLE


@dataclass(frozen=True)
class TransportEof:
    """The transport reached EOF with no orderly SS2.1.2 close (FR-638-019d).

    SS2.13.3b names TWO notifications of a host death — process exit OR
    transport EOF — and only the exit half was implementable while nothing in
    this SDK owned the close. A host that closes stdout while still hung emits
    no exit on the timescale that matters, so without this arm its session
    never discharged: every pending command sat as the durable-looking echo
    SS4.13 forbids, and every turn wait hung.

    It carries no evidence fields, and that is the honest shape: EOF IS the
    whole observation. The stderr tail and the SS2.11 row belong to the
    process boundary, which has not reported yet — and when it does,
    :meth:`Session.host_exited` latches the FIRST discharge, so a later exit
    replays the EOF's report rather than overwriting it with a richer one.

    ORDERLINESS IS NOT DECIDABLE HERE. ``Connection`` is duplex-generic and a
    transport cannot tell a peer's hang-up from its own shutdown, so the layer
    that KNOWS whether the close was its own is the one that builds this:
    ``MuseClient``, which owns both ``close()`` and the connection.

    Attributes:
        kind: The notification discriminator, always ``"transportEof"``.
    """

    kind: Literal["transportEof"] = "transportEof"


HostDeathNotification = Union[ExitClassification, TransportEof]
"""How a client learns its host is gone: the process exit, or transport EOF."""

AbnormalExit = HostDeathNotification
"""Every death notification except the orderly ``cleanShutdown`` row.

The TS twin narrows this with ``Exclude<…, {kind: "cleanShutdown"}>``; Python
carries the same intent at the boundary — :func:`is_abnormal_host_death` is
the only gate that constructs a :class:`MuseHostDiedError`, and it refuses a
``cleanShutdown`` — rather than in the type, which has no structural exclude.
"""


def is_abnormal_host_death(notification: HostDeathNotification) -> bool:
    """Was this notification an abnormal death (SS2.13.3b)?

    Exit 0 (``cleanShutdown``) is the ONLY SS2.11 row where the run was
    cancelled, the drain completed, and the durable ``SessionEnd`` records
    were written. Every other row — including tidy-looking names like
    ``configError`` — left no ``SessionEnd``, which is what "abnormal" means
    here. A transport EOF the client did not cause left no ``SessionEnd``
    either, so it joins the same predicate rather than a parallel one that
    could drift.

    Args:
        notification: The process-exit classification or the transport EOF.

    Returns:
        ``True`` for every notification but the orderly ``cleanShutdown``.
    """
    return notification.kind != "cleanShutdown"


def is_item_in_progress(item: Item) -> bool:
    """The in-progress probe the store asks its caller for.

    ``Item.status`` is an open enum whose terminal rule is "anything other
    than ``inProgress``", so this is a positive test on the one non-terminal
    value rather than a negative test against a list a schema advance would
    silently widen.

    Args:
        item: The generated item dict.

    Returns:
        ``True`` iff the item is still ``inProgress``.
    """
    return item.get("status") == _IN_PROGRESS


class MuseHostDiedError(Exception):
    """A durable host died abnormally: its terminals arrive on resume (FM-001).

    Attributes:
        exit: The abnormal notification (never a ``cleanShutdown``).
    """

    def __init__(self, exit_notification: AbnormalExit) -> None:
        """Builds the error from the abnormal notification.

        Args:
            exit_notification: The exit classification or transport EOF; a
                ``cleanShutdown`` is not a death and is never passed here (the
                one gate is :func:`is_abnormal_host_death`).
        """
        super().__init__(
            f"MSP host died: {exit_notification.kind} "
            f"({MuseHostDiedError._cause(exit_notification)})"
        )
        self.exit = exit_notification

    @staticmethod
    def _cause(exit_notification: AbnormalExit) -> str:
        # EOF has no exit code to render, and "exit code None" would read as a
        # missing datum rather than the fact that the process has not reported.
        if isinstance(exit_notification, TransportEof):
            return "transport EOF with no orderly close"
        # A signal kill has a null exit code and the signal is its ONLY
        # diagnostic — rendering "exit code None" throws that away.
        if exit_notification.kind == "crash" and exit_notification.exit_code is None:
            return f"signal {exit_notification.exit_signal}"
        return f"exit code {exit_notification.exit_code}"


@dataclass(frozen=True)
class _NotADeath:
    profile: SessionDurabilityProfile
    exit: HostDeathNotification
    kind: Literal["notADeath"] = "notADeath"


@dataclass(frozen=True)
class _DurableDeath:
    profile: SessionDurabilityProfile
    exit: AbnormalExit
    kind: Literal["durableDeath"] = "durableDeath"


@dataclass(frozen=True)
class _Discharged(Generic[_I]):
    profile: SessionDurabilityProfile
    exit: AbnormalExit
    # Items still ``inProgress`` at death, annotated — never a synthesized
    # ``item/completed``.
    terminal_unknown_items: "tuple[TerminalUnknownItemAnnotation, ...]"
    retired_commands: "tuple[PendingRetirement[_I], ...]"
    kind: Literal["discharged"] = "discharged"


HostDeathDischarge = Union[_NotADeath, _DurableDeath, _Discharged[_I]]
"""What one :meth:`Session.host_exited` call did.

Discriminated on ``kind`` because the three outcomes leave the session in
three different states: after ``notADeath`` it is still usable; after
``durableDeath`` it is dead until resume with every live wait rejected; after
``discharged`` the ephemeral obligation was paid in full. A bare
``discharged: bool`` collapsed the first two, so an embedder had to re-derive
the state from the profile and the exit row this call already read.
"""
