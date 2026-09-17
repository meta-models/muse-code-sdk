"""Typed errors shared by the stores and the facade.

They live here rather than in ``facade/`` because the stores raise them too,
and a store importing from the facade would invert the layering. Typed
rather than bare ``Exception`` because each names a STATE an embedder must
branch on; the only alternative is matching message text, which silently
turns those strings into the package's contract.

Port of the TypeScript SDK's error family.
"""

from __future__ import annotations

from typing import Literal


class MuseSessionDiscardedError(Exception):
    """The session was discarded after an ephemeral host's abnormal death.

    Raised when the operation attempted would either resurrect the discarded
    session or replay one of its ``commandId``\\ s against a new host
    (tdd SS2.13.3b, SS3.1.3).
    """


class MuseForeignSessionError(Exception):
    """An event whose ``sessionId`` names a different session than the one folding it."""


GapFillFailureReason = Literal["noConnection", "pageFailed", "pageStalled"]
"""Why one SS4.8 splice-fill did not complete.

Each arm names a different owner (this SDK's own composition, the transport,
the host), because the repair differs:

- ``noConnection``: the ``Session`` was built fold-only, so it has no seam
  to page through. Composition, not a runtime fault.
- ``pageFailed``: a ``view/page`` round trip failed, or answered with a
  frame this session may not fold. ``cause`` carries it.
- ``pageStalled``: the walk made no progress — a page that neither carried
  events nor ended the view, or a ``nextCursor`` that did not advance. The
  wire is an external boundary and this is the only bound on the walk; an
  attempt cap would silently truncate a legitimate long fill.
"""


class MuseGapFillError(Exception):
    """A gap the client could not fill (spec 14990 FR-020, tdd SS4.8).

    REPORTED to the session's gap-error callback, never raised across the
    pump: the fill is driven from a notification, so an escaping exception
    would land in the consumer's event pump with nothing to catch it. Typed
    because the hole it names is a STATE a consumer must branch on — the
    fold stays not-current until a later recovery, and ``(after, next)``
    names exactly what is missing.

    Attributes:
        reason: Which owner failed (see ``GapFillFailureReason``).
        after: The gap's lower bound, verbatim and opaque (tdd SS4.1).
        next: The gap's upper bound, verbatim and opaque.
    """

    def __init__(
        self,
        reason: GapFillFailureReason,
        after: str,
        next: str,  # noqa: A002 - the wire member's own name
        cause: BaseException | None = None,
    ) -> None:
        """Builds the error; ``cause`` chains like ``raise ... from cause``.

        Args:
            reason: Which owner failed.
            after: The gap's lower bound cursor.
            next: The gap's upper bound cursor.
            cause: The underlying failure for the ``pageFailed`` arm.
        """
        super().__init__(f"view/gap ({after}, {next}) could not be filled: {reason}")
        self.reason: GapFillFailureReason = reason
        self.after: str = after
        self.next: str = next
        if cause is not None:
            self.__cause__ = cause


ValidationSeam = Literal["initializeResult", "spawnOptions"]
"""Which C-638-2 pydantic seam refused its input.

The two seams the contract names (spec 638 C-638-2; owner ruling #31276,
arm (a)): the inbound ``InitializeResult`` frame parse and the spawn
options. Each arm names a different owner — ``initializeResult`` is the
host's frame (a protocol-level malformation), ``spawnOptions`` is the
caller's construction bug — so an embedder branches here to decide whether
to blame its own inputs or the discovered host.
"""


class MuseValidationError(ValueError):
    """A C-638-2 validating seam rejected its input through pydantic.

    Raised instead of a bare ``isinstance`` failure, an ``AttributeError``/
    ``KeyError``, or a silent partial object (spec 638 C-638-2; owner ruling
    #31276, arm (a)). Wraps pydantic's ``ValidationError``, which rides as
    ``__cause__`` and in the message. A ``ValueError`` by inheritance for
    the same reason pydantic's own ``ValidationError`` is one: the spawn
    boundary's pre-existing out-of-range refusal was a ``ValueError``, and
    a consumer catching that must keep working.

    Attributes:
        seam: Which validating seam refused (see :data:`ValidationSeam`).
    """

    def __init__(self, seam: ValidationSeam, cause: Exception) -> None:
        """Builds the typed wrapper; ``cause`` chains like ``raise ... from``.

        Args:
            seam: Which validating seam refused.
            cause: The underlying ``pydantic.ValidationError``.
        """
        described = (
            "initialize result frame"
            if seam == "initializeResult"
            else "spawn options"
        )
        super().__init__(f"malformed {described}: {cause}")
        self.seam: ValidationSeam = seam
        self.__cause__ = cause


COMPATIBILITY_PAGE_URL = "https://meta-models.github.io/muse-code-sdk/compatibility/"
"""The developer-docs compatibility page the discovery errors cite.

The Python row there is the customer-facing statement of the supported
Python floor, the host version + schema fingerprint per wheel, and the exact
pydantic pin (spec 638 FR-638-028); FR-638-020's failures point at it.
"""


class MuseHostDiscoveryError(Exception):
    """No MSP host binary could be found (spec 638 FR-638-020, INV-638-08).

    The wheel is UNBUNDLED (#29216): the SDK discovers an installed ``muse``
    and never carries one. Raised BEFORE any process is spawned.
    """


class MuseHostMismatchError(Exception):
    """The discovered host serves a schema this SDK was not built against.

    Spec 638 C-638-4 / FM-638-2: at ``initialize``, a fingerprint mismatch
    FAILS with an exact message naming the served and required fingerprints,
    the host's self-reported version, and the compatibility page whose
    Python row states the compatible host version per wheel. There is no
    bypass — the posture is owner-directed and deliberately stricter than
    SS1.4.1's warning-only rule for the TS facade.

    Attributes:
        served: The fingerprint the host advertised.
        pinned: The fingerprint this SDK requires.
        host_version: The host's self-reported ``serverInfo.version``, when
            the handshake carried one.
    """

    def __init__(
        self,
        served: str,
        pinned: str,
        host_version: str | None = None,
        *,
        required_host_version: str,
    ) -> None:
        """Builds the exact, page-citing failure.

        Args:
            served: ``InitializeResult.schema.fingerprint``.
            pinned: ``muse_code.EXPECTED_SCHEMA_FINGERPRINT``.
            host_version: ``serverInfo.version`` from the handshake result.
            required_host_version: The generated
                ``muse_code_msp.REQUIRED_HOST_VERSION`` — tree-derived by the
                renderer from the host crate's manifest and kept honest by
                the regen gate (spec 638 FR-638-006), never hand-typed.
                Required, not defaulted: C-638-4 names the exact version, so
                a version-less message is not a state this error can carry
                (PR #30094 review).
        """
        version_note = (
            f" (host version {host_version})" if host_version is not None else ""
        )
        super().__init__(
            f"the muse host{version_note} serves schema fingerprint {served} "
            f"but this muse-code-sdk requires {pinned}; "
            f"install host version {required_host_version} — "
            "see the compatibility page's Python "
            f"row: {COMPATIBILITY_PAGE_URL}"
        )
        self.served: str = served
        self.pinned: str = pinned
        self.host_version: str | None = host_version
        self.required_host_version: str = required_host_version
