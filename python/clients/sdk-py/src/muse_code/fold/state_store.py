"""The session-state half of the SS4 client fold (spec 638 FR-638-007
carrying spec 14990 FR-007, INV-005).

State events are NOT items: they carry replace-wholesale session facts,
cursor-ordered, latest-wins (tdd SS4.6). An explicit ``None`` is a fact — it
clears the family — never "unchanged" (the ``session/goalChanged`` and
``session/branchChanged`` rules). ``session/tokenUsage`` is the one
accumulate-only family; its running totals arrive server-computed in
``cumulative``, so the client stores rather than sums (tdd SS4.6.5).

The family KEY is the notification method name — protocol vocabulary treated
as an opaque string, so a family added additively (tdd SS1.5.4) folds without
a code change.

Absent versus cleared, the Python spelling: ``get`` answers ``None`` for
both, and ``has`` distinguishes — ``has(family)`` is ``False`` when no fact
has ever landed and ``True`` when a fact (including an explicit clear)
holds. Absent is never fabricated (tdd SS4.9.1). (The TS store spells the
same three states as ``undefined`` / ``null`` / value.)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

StateValue = object | None
"""A stored family value. ``None`` is a real value: the family was cleared."""


@dataclass(frozen=True)
class StateApplyOutcome:
    """What one state event changed.

    Attributes:
        family: The family it targeted.
        previous: The value it replaced (``None`` when absent or cleared;
            ``had_previous`` distinguishes).
        had_previous: Whether the family held any fact before this event.
        current: The value now stored.
        applied: ``False`` when the incoming value was refused as an
            exact-cursor replay.
    """

    family: str
    previous: StateValue
    had_previous: bool
    current: StateValue
    applied: bool


class SessionStateStore:
    """Last-write-wins per family, in arrival order.

    Cursors are opaque strings and MUST NOT be parsed or ordered (tdd SS4.1),
    so ordering here is by arrival: the server emits view events in cursor
    order on every connection, and a page's events are ascending. The one
    cursor use is EXACT-EQUALITY replay de-duplication, and it remembers only
    the family's LATEST cursor — it refuses only a back-to-back replay of the
    family's most recent event. The SS4.8 splice caller must skip
    already-applied page events itself, which it does by construction: the
    splice pages forward from ``after`` and discards paged events at cursors
    >= ``next`` as duplicates of the live buffer. No relational comparison
    exists: string order diverges from cursor order at every digit rollover
    ("v:s:10" < "v:s:9" as strings), which would drop genuinely newer events.
    """

    def __init__(self) -> None:
        """Create an empty store."""
        self._values: dict[str, StateValue] = {}
        self._cursors: dict[str, str] = {}

    def apply(
        self, family: str, value: StateValue, cursor: str | None = None
    ) -> StateApplyOutcome:
        """Apply a state event.

        Args:
            family: The notification method name (opaque vocabulary).
            value: The event's params object, or ``None`` for a clear.
            cursor: The event's ``viewCursor``; when omitted (a snapshot
                seed, which carries one cursor for the whole state) the value
                is taken unconditionally.

        Returns:
            What changed, and whether the event applied.
        """
        had_previous = family in self._values
        previous = self._values.get(family)
        if cursor is not None:
            seen = self._cursors.get(family)
            # An equal cursor is a replay of the same event (idempotent):
            # refuse. That is the ONLY cursor comparison — cursors are opaque
            # (SS4.1) and any relational order mis-sorts at a digit rollover;
            # arrival order carries the LWW truth.
            if seen is not None and cursor == seen:
                return StateApplyOutcome(
                    family=family,
                    previous=previous,
                    had_previous=had_previous,
                    current=previous,
                    applied=False,
                )
            self._cursors[family] = cursor
        self._values[family] = value
        return StateApplyOutcome(
            family=family,
            previous=previous,
            had_previous=had_previous,
            current=value,
            applied=True,
        )

    def get(self, family: str) -> StateValue:
        """Read a family: the held value, or ``None`` when absent or cleared.

        Pair with :meth:`has` to distinguish never-landed from cleared
        (module docstring, "Absent versus cleared").
        """
        return self._values.get(family)

    def has(self, family: str) -> bool:
        """Whether the family holds any fact (an explicit clear counts)."""
        return family in self._values

    def families(self) -> list[str]:
        """Every family that holds a value, in insertion order."""
        return list(self._values)

    def seed(
        self,
        entries: Iterable[tuple[str, StateValue]],
        cursor: str | None = None,
    ) -> None:
        """Seed from a snapshot's state block: authoritative, replaces wholesale."""
        self._values.clear()
        self._cursors.clear()
        for family, value in entries:
            self._values[family] = value
            if cursor is not None:
                self._cursors[family] = cursor
