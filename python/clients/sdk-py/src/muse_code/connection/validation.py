"""The two C-638-2 pydantic seams: inbound frame parsing and spawn options.

Owner ruling #31276, arm (a) (Constitution IV record in the issue comment):
the seams spec 638 C-638-2 names validate through pydantic models and reject
with the SDK's typed :class:`~muse_code.errors.MuseValidationError` wrapping
pydantic's ``ValidationError`` — never a bare ``isinstance`` check, an
``AttributeError``/``KeyError``, or a silent partial object. pydantic is the
package's one exact-pinned runtime dependency (ADR 638 D2, INV-638-03); this
module is where that grant earns its keep.

The frame models are NARROWED views: they validate exactly the members this
facade dereferences (INV-638-02 — narrow and compose, never restate). A
full-fidelity pydantic restatement of the generated ``InitializeResult`` is
the arm C-638-2 forbids and routes back to the owner; deriving a validator
from the generated declaration is off the table too, because pydantic
refuses stdlib ``typing.TypedDict`` on the 3.10 floor. Unknown members pass
through untouched (``extra="allow"``), so the frame a consumer indexes stays
the generated shape.
"""

from __future__ import annotations

from typing import Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..errors import MuseValidationError

MAX_SHUTDOWN_TIMEOUT_MS = 2_147_483_647
"""The TS boundary's ceiling, kept identical so the two SDKs refuse the same
budgets (a budget past it is a consumer bug on either side)."""


class _SchemaInfoFrame(BaseModel):
    """The ``schema`` member's seam view: the C-638-4 gate's input."""

    model_config = ConfigDict(extra="allow", frozen=True)

    fingerprint: str


class _ServerInfoFrame(BaseModel):
    """The ``serverInfo`` member's seam view: the mismatch error's evidence."""

    model_config = ConfigDict(extra="allow", frozen=True)

    version: str


class InitializeResultFrame(BaseModel):
    """The handshake seam: the members ``initialize()`` reads, validated.

    ``schema`` is aliased because the name shadows ``BaseModel``'s own
    (deprecated) attribute; the wire member is unchanged.
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    schema_info: _SchemaInfoFrame = Field(alias="schema")
    server_info: _ServerInfoFrame = Field(alias="serverInfo")


def parse_initialize_result(raw: object) -> InitializeResultFrame:
    """Validates one inbound ``initialize`` result frame (C-638-2 seam 1).

    Args:
        raw: The decoded result member, verbatim from the wire.

    Returns:
        The validated seam view; the caller keeps binding the raw ``dict``
        as the generated ``InitializeResult``.

    Raises:
        MuseValidationError: The frame is malformed; pydantic's
            ``ValidationError`` rides as the cause.
    """
    try:
        return InitializeResultFrame.model_validate(raw)
    except ValidationError as error:
        raise MuseValidationError("initializeResult", error) from error


class SpawnOptions(BaseModel):
    """The data half of the spawn surface, validated (C-638-2 seam 2).

    Exactly the options that become process state: the callable plumbing
    (``on_stderr``, ``connection_options``, the test-only deadline factory)
    is composition, not data — ``Connection``'s constructor owns its own
    options refusal (the never-orphan arm ``spawn_msp_connection`` already
    guards), and ``ConnectionOptions`` is a stdlib ``TypedDict`` pydantic
    cannot validate on the 3.10 floor.

    ``shutdown_timeout_ms`` is strict — ``True`` and ``"5"`` are not
    budgets — and bounded exactly like the TS boundary; a clamped budget
    would fabricate a crash row for a host that was draining normally
    (the PR #22819 lesson, kept identical).
    """

    model_config = ConfigDict(frozen=True)

    command: str
    args: tuple[str, ...]
    cwd: str | None
    env: dict[str, str] | None
    shutdown_timeout_ms: int = Field(strict=True, ge=0, le=MAX_SHUTDOWN_TIMEOUT_MS)


def parse_spawn_options(
    *,
    command: str,
    args: Sequence[str],
    cwd: str | None,
    env: Mapping[str, str] | None,
    shutdown_timeout_ms: int,
) -> SpawnOptions:
    """Validates spawn options at construction, before any process exists.

    Args:
        command: The host binary to run.
        args: Passed through verbatim once validated.
        cwd: Working directory for the host.
        env: The host's environment (inherited when ``None``).
        shutdown_timeout_ms: The FR-017a drain budget.

    Returns:
        The validated, frozen options the spawn path reads from.

    Raises:
        MuseValidationError: An option is malformed; pydantic's
            ``ValidationError`` rides as the cause. A ``ValueError`` by
            inheritance, so the boundary's pre-#31276 refusal contract
            holds.
    """
    try:
        # The raw values go in untouched: pydantic owns the coercion
        # (list -> tuple, Mapping -> dict) AND the refusals — pre-coercing
        # here would turn a bare-string ``args`` into a tuple of characters
        # before the model could reject it.
        return SpawnOptions(
            command=command,
            # The wider runtime types are deliberate: pydantic owns the
            # Sequence -> tuple / Mapping -> dict coercion and the refusals.
            args=args,  # type: ignore[arg-type]
            cwd=cwd,
            env=env,  # type: ignore[arg-type]
            shutdown_timeout_ms=shutdown_timeout_ms,
        )
    except ValidationError as error:
        raise MuseValidationError("spawnOptions", error) from error
