"""The item half of the SS4 client fold: upsert-by-revision plus delta
accumulation (spec 638 FR-638-007 carrying spec 14990 FR-007,
INV-003/INV-004).

Items are the generated ``muse_code_msp`` shapes at runtime — plain dicts
carrying at least ``itemId`` and ``revision`` (the algebraic precondition the
rules need). The store reads only those two members, so it stays
wire-shape-blind exactly as the TS ``ItemStore`` is (INV-638-01/02); the
``SessionFold`` binding supplies wire-aware probes where a rule needs one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, List, Mapping

from ..errors import MuseSessionDiscardedError

# The store's item view: a wire item is a dict at runtime. Reading only
# `itemId`/`revision` here keeps the store wire-shape-blind (INV-638-01).
ItemLike = Mapping[str, object]


@dataclass(frozen=True)
class Inserted:
    """A first sighting: the item was inserted."""

    item_id: str


@dataclass(frozen=True)
class Replaced:
    """A strictly higher revision replaced the held item (INV-003)."""

    item_id: str
    from_revision: int
    to_revision: int


@dataclass(frozen=True)
class IgnoredStaleRevision:
    """A stale or replayed re-emission. The store did not change (INV-003)."""

    item_id: str
    held: int
    offered: int


ItemApplyOutcome = Inserted | Replaced | IgnoredStaleRevision
"""What an apply did — enough for a consumer to render without re-diffing."""


@dataclass(frozen=True)
class Appended:
    """A delta appended to a held item's field accumulator."""

    item_id: str
    field: str
    length: int


@dataclass(frozen=True)
class BufferedForAbsentItem:
    """A delta for an item the store does not hold.

    Deltas are a streaming optimization and are never a fold's only source
    of a fact (tdd SS4.7.3), so this is buffered against the item's arrival
    rather than dropped or treated as an error.
    """

    item_id: str
    field: str


DeltaApplyOutcome = Appended | BufferedForAbsentItem
"""What a delta did. Deltas bump no revision (tdd SS4.4.1)."""


@dataclass(frozen=True)
class TerminalUnknownItemAnnotation:
    """Client-only annotation required when an ephemeral host dies abnormally."""

    item_id: str


def _item_id(item: ItemLike) -> str:
    return str(item["itemId"])


def _revision(item: ItemLike) -> int:
    revision = item["revision"]
    if not isinstance(revision, int):
        raise TypeError(f"item revision is not an integer: {revision!r}")
    return revision


class ItemStore:
    """Items in first-opened order (tdd SS4.9.1), each at its latest revision.

    Holds per-field delta accumulators beside the items, and the
    terminal-unknown annotation set an ephemeral host death produces.
    """

    def __init__(self) -> None:
        """Create an empty store."""
        self._items: dict[str, ItemLike] = {}
        # item id -> field path -> accumulated text.
        self._deltas: dict[str, dict[str, str]] = {}
        # First-opened order; an item id appears exactly once.
        self._order: list[str] = []
        self._terminal_unknown: set[str] = set()
        self._ephemeral_session_discarded = False

    def apply(self, item: ItemLike) -> ItemApplyOutcome:
        """Apply an ``item/started`` | ``item/updated`` | ``item/completed`` payload.

        Replace iff the incoming revision is strictly higher (INV-003).

        Args:
            item: The wire item object, verbatim.

        Returns:
            What the apply did.

        Raises:
            MuseSessionDiscardedError: The ephemeral session was discarded.
        """
        self._assert_session_active()
        item_id = _item_id(item)
        held = self._items.get(item_id)
        if held is None:
            self._items[item_id] = item
            self._order.append(item_id)
            return Inserted(item_id)
        held_revision = _revision(held)
        offered = _revision(item)
        if offered <= held_revision:
            return IgnoredStaleRevision(item_id, held=held_revision, offered=offered)
        self._items[item_id] = item
        return Replaced(item_id, from_revision=held_revision, to_revision=offered)

    def apply_delta(
        self, item_id: str, delta: str, field: str = "text"
    ) -> DeltaApplyOutcome:
        """Apply an ``item/delta``: a lossless append to a field accumulator.

        The concatenation of all deltas for a field path equals that field's
        value on the final ``item/completed`` object (INV-004, tdd SS4.3.1).

        Args:
            item_id: The delta's item.
            delta: The appended text, verbatim.
            field: The streamed field path (wire default ``"text"``).

        Returns:
            ``Appended`` for a held item, ``BufferedForAbsentItem`` otherwise.

        Raises:
            MuseSessionDiscardedError: The ephemeral session was discarded.
        """
        self._assert_session_active()
        fields = self._deltas.setdefault(item_id, {})
        fields[field] = fields.get(field, "") + delta
        if item_id not in self._items:
            return BufferedForAbsentItem(item_id, field)
        return Appended(item_id, field, length=len(fields[field]))

    def accumulated(self, item_id: str, field: str = "text") -> str | None:
        """The accumulated delta text for a field path, or ``None`` if none."""
        fields = self._deltas.get(item_id)
        return None if fields is None else fields.get(field)

    def accumulated_fields(self, item_id: str) -> List[str]:
        """Every field path that has accumulated deltas for this item, sorted."""
        fields = self._deltas.get(item_id)
        return [] if fields is None else sorted(fields)

    def get(self, item_id: str) -> ItemLike | None:
        """The held item at its latest revision, or ``None``."""
        return self._items.get(item_id)

    def has(self, item_id: str) -> bool:
        """Whether the store holds this item."""
        return item_id in self._items

    def list(self) -> List[ItemLike]:
        """Items in first-opened order (tdd SS4.9.1)."""
        return [self._items[item_id] for item_id in self._order if item_id in self._items]

    def last_opened_item_id(self) -> str | None:
        """The id of the most recently opened item, or ``None`` when empty."""
        return self._order[-1] if self._order else None

    @property
    def size(self) -> int:
        """How many items the store holds."""
        return len(self._items)

    def seed(self, items: Iterable[ItemLike]) -> None:
        """Seed from a snapshot's ``state.items`` (tdd SS4.9.1).

        Seeding REPLACES the store — a snapshot is authoritative (tdd SS4.9),
        never merged into stale local state. Delta accumulators are
        intentionally NOT seeded: a snapshot carries streamed fields at their
        accumulated-so-far values on the item itself, and ``view/page`` never
        replays ephemeral-sourced deltas (tdd SS4.7.3).

        Args:
            items: Every item at its latest revision, in first-opened order.

        Raises:
            MuseSessionDiscardedError: The ephemeral session was discarded.
        """
        self._assert_session_active()
        self._items.clear()
        self._deltas.clear()
        self._terminal_unknown.clear()
        self._order.clear()
        for item in items:
            item_id = _item_id(item)
            if item_id not in self._items:
                self._order.append(item_id)
            self._items[item_id] = item

    def mark_ephemeral_host_death(
        self, is_in_progress: Callable[[ItemLike], bool]
    ) -> List[TerminalUnknownItemAnnotation]:
        """Permanently discard an ephemeral session after abnormal host death.

        The last wire item remains byte-for-byte intact: terminal-unknown is a
        client display annotation, never a fabricated ``item/completed`` or
        wire status (SS2.13.3b / SS4.4.3). Further events and snapshot seeding
        are refused because this session has no resume surface.

        Args:
            is_in_progress: The wire-aware probe (the store never knows wire
                shapes, INV-638-01); the ``SessionFold`` binding passes
                ``item["status"] == "inProgress"`` against the generated
                ``Item``.

        Returns:
            The terminal-unknown annotations, in first-opened item order.
        """
        if not self._ephemeral_session_discarded:
            for item in self._items.values():
                if is_in_progress(item):
                    self._terminal_unknown.add(_item_id(item))
            self._ephemeral_session_discarded = True
        return [
            TerminalUnknownItemAnnotation(item_id)
            for item_id in self._order
            if item_id in self._terminal_unknown
        ]

    def is_terminal_unknown(self, item_id: str) -> bool:
        """Whether this item carries the terminal-unknown annotation."""
        return item_id in self._terminal_unknown

    @property
    def ephemeral_session_discarded(self) -> bool:
        """Whether an ephemeral host death discarded this session."""
        return self._ephemeral_session_discarded

    def _assert_session_active(self) -> None:
        if self._ephemeral_session_discarded:
            raise MuseSessionDiscardedError(
                "ephemeral session was discarded after abnormal host death"
            )
