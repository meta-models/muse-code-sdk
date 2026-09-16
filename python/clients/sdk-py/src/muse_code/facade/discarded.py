"""What an ephemeral host death discarded, remembered ACROSS the sessions one
client opened (spec 638 FR-638-019d carrying spec 14990 T030 obligation (c);
tdd SS2.13.3b). Port of ``clients/sdk-ts/src/facade/discarded.ts``.

SS2.13.3b's five-clause MUST includes "do not attempt to reattach" and "do
not replay the session's ``commandId``\\ s". Both are statements about what
the CLIENT does next, and "next" outlives the session object that died:

- :class:`~muse_code.pending.PendingCommandSet` already refuses a replay of
  an id IT discarded, but its memory is per-instance, so a FRESH ``Session``
  — the natural thing to build after a host dies — knew nothing and would
  replay those ids at the new host. That is the exactly-once violation the
  clause exists to prevent.
- nothing at all held the discarded ``sessionId``, so ``resume_session`` had
  no fact to withhold on.

This is client state, never a wire shape and never durable (INV-638-05): it
lives exactly as long as the ``MuseClient`` that owns it. It is deliberately
NOT a module-global — two clients in one process are two independent trust
boundaries, and a process-wide set would let one client's dead host silence
another's live one.
"""

from __future__ import annotations


class DiscardedSessions:
    """The two sets, exposed directly rather than behind add/has pairs.

    :class:`~muse_code.pending.PendingCommandSet` takes the ``command_ids``
    set BY REFERENCE and writes to it from ``discard_ephemeral()``, so a
    wrapper would have to re-expose a mutable seam anyway; a ``set[str]`` is
    the honest shape, and it is already the shape that class uses internally.

    Attributes:
        command_ids: ``commandId``\\ s an ephemeral discharge retired. Never
            replayed again.
        session_ids: ``sessionId``\\ s whose ephemeral host died. Never
            reattached.
    """

    def __init__(self) -> None:
        """Builds an empty pair of discard sets."""
        self.command_ids: set[str] = set()
        self.session_ids: set[str] = set()
