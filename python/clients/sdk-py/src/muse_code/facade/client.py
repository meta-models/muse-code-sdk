"""``MuseClient`` — the facade's session-opening half. Port of the TypeScript
SDK's client module.

It turns the two v1 session verbs into correctly-shaped ``session/start`` /
``session/resume`` params and hands back a WIRED ``Session``. It frames
nothing and mints nothing: ``Connection.command()`` stamps the ``commandId``
from the single injected mint, so the protocol's single-minter property is
preserved by DELEGATION rather than re-implemented here.

It owns two facts no other layer holds, which is why these obligations live
here rather than on ``Session``:

- WHETHER A CLOSE WAS OURS. ``Connection`` is duplex-generic; a transport
  cannot tell a peer's hang-up from its own shutdown. The protocol counts
  "process exit OR transport EOF" as a death, so somebody has to know the
  difference, and only the layer that owns ``close()`` does.
- WHAT AN EARLIER DEATH DISCARDED. :class:`DiscardedSessions` is
  client-scoped, so a ``commandId`` refusal and a withheld reattach survive
  the ``Session`` object that died.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
from dataclasses import dataclass, fields
from typing import (
    Any,
    Awaitable,
    Callable,
    Generic,
    List,
    Mapping,
    Sequence,
    Set,
    TypeVar,
    cast,
)

from muse_code_msp import (
    ClientCapabilities,
    ClientInfo,
    InitializeParams,
    InitializeResult,
    ModelListParams,
    ModelListResult,
    RecoveryMode,
    SessionConfig,
    SessionListParams,
    SessionListResult,
    SessionResumeParams,
    SessionStartParams,
    UsageReadResult,
)

from ..connection.connection import (
    Connection,
    MspError,
    Params,
    ProtocolError,
    RetryDelay,
)
from ..connection.discovery import discover_muse_bin
from ..connection.spawn import (
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    SIGTERM_GRACE_MS,
    ExitClassification,
    MuseServeChild,
    OnStderr,
    SpawnedMspConnection,
    spawn_msp_connection,
)
from ..errors import (
    MuseCapabilityNotGrantedError,
    MuseFacadeOwnedMethodError,
    MuseSessionDiscardedError,
    PermissionProfileNotApplied,
)
from .discarded import DiscardedSessions
from .host_start import MuseHostStartError, keeps_its_own_error
from .host_death import (
    MuseHostDiedError,
    SessionDurabilityProfile,
    TransportEof,
    is_abnormal_host_death,
    read_session_durability,
    survives_host_death,
)
from .approval import ApprovalFailureHandler, ApprovalHandler
from .session import Session, SessionOpening, _ResumeOpening, _StartOpening
from .turn_submit import _camel

_I = TypeVar("_I")
_H = TypeVar("_H")

# Every SessionListParams member list_sessions forwards; the wire-query
# suite asserts this set equals the generated type's members, so a
# regenerated member cannot be silently dropped on the way to the wire.
LIST_FORWARDED: tuple[str, ...] = (
    "cursor",
    "filter",
    "limit",
    "updatedAfter",
    "workspaceRoot",
)

# The wire methods whose state the facade owns, refused by
# ``MuseClient.command`` and ``MuseClient.request``: ``initialize`` is the
# handshake ``spawn`` runs; ``session/start``/``session/resume`` register the
# ``Session`` the pump routes to; ``turn/start``, ``turn/steer``,
# ``turn/unqueue``, ``approval/decide`` and ``userInput/answer`` carry the
# pending-command, approval and answer state their verbs keep (a steer is a
# pending submission and an accepted unqueue retires its queued entry);
# ``view/page`` is the gap fill's; and ``view/subscribe``/``view/unsubscribe`` change the
# subscription set the pump routes by. ``host/shutdown`` (experimental) is
# the orderly stop ``close()`` owns: sent raw, the client would report the
# stop it asked for as a host death. The TS twin lists the stable eleven
# only: its public build may name no experimental-only method.
FACADE_OWNED_METHODS: frozenset[str] = frozenset(
    {
        "initialize",
        "session/start",
        "session/resume",
        "turn/start",
        "turn/steer",
        "turn/unqueue",
        "approval/decide",
        "userInput/answer",
        "view/page",
        "view/subscribe",
        "view/unsubscribe",
        "host/shutdown",
    }
)

# OPTIONAL MEANS OMITTED, NEVER null: every member the two option
# builders can leave unset is optional-non-nullable in the generated params,
# so an unset member is dropped from the frame rather than nulled.


@dataclass
class StartSessionOptions:
    """Caller-facing options for ``session/start``.

    Composed from the generated ``SessionStartParams``. ``commandId`` is
    excluded because the connection mints it; ``previousSessionId`` and
    ``clear`` because the facade starts root sessions, and ``spawnedBy``
    because the facade does not expose a spawner yet.
    Experimental-only members (``switchPolicy``) are invisible here: the
    exclusion set tracks the stable ``SessionStartParams`` below, and a
    graduation reds the drift assert until the facade forwards or
    excludes the new member.

    Attributes:
        approval_mode: The approval enforcement mode to start under; omitted
            = the host's default.
        provider_id: The provider to serve the session with; omitted = the
            host's default.
        session_id: A caller-chosen session id; omitted = the host mints one.
        workspace_root: The workspace the session works in; omitted = the
            host decides.
        workspace_roots: The session's initial runtime workspace-root set
            (wire ``workspaceRoots``; first root = the CWD). When
            ``workspace_root`` is also given the two must agree.
        model_id: The model to serve the session with; omitted = the
            provider's default.
        permission_profile: The permission profile to start the session
            under (wire ``permissionProfile``): a profile id the host offers;
            omitted = the host's configured default. An id the host does not
            offer refuses the start before the session exists.
        require_permission_profile: Require the ``permission_profile``
            selection: when true, the client proves the
            committed selection equals the requested id — from the start
            result's ``session.permissionState``, else a ``session/read``
            read-back — and raises ``PermissionProfileNotApplied`` instead
            of proceeding on the host default. Client-local: never sent on
            the wire. Setting it without ``permission_profile`` is a usage
            error.
        recovery_mode: Optional recovery selection (wire ``recoveryMode``);
            omitted means no selection is sent.
        config: Per-session configuration (wire ``config``). Naming MCP
            servers in ``mcpServers`` needs the host's ``sessionMcp`` grant;
            without it the start raises ``MuseCapabilityNotGrantedError``
            before anything is sent.
    """

    approval_mode: str | None = None
    provider_id: str | None = None
    session_id: str | None = None
    workspace_root: str | None = None
    workspace_roots: List[str] | None = None
    model_id: str | None = None
    permission_profile: str | None = None
    require_permission_profile: bool = False
    recovery_mode: RecoveryMode | None = None
    config: SessionConfig | None = None


@dataclass
class ResumeSessionOptions:
    """Caller-facing options for ``session/resume``.

    Attributes:
        session_id: The session to resume.
        cursor: Resume from this view cursor; omitted = from genesis.
        exclude_items: Ask the host to omit item bodies from the history.
        history: The history preference forwarded as the wire's ``history``
            member.
        permission_profile: The permission profile pick forwarded as the
            wire's ``permissionProfile`` member: the host restores the
            retained authority first, then applies the pick. Omitted means
            no override.
        model_id: The model override forwarded as the wire's ``modelId``
            member: the host applies it after the warm pick, before
            enrichments. Omitted means no override.
        recovery_mode: Optional recovery selection (wire ``recoveryMode``);
            omitted means no selection is sent.
        on_approval: Answers this session's approvals from its first frame,
            so an approval the host re-sends right after the resume reply
            reaches it. The same contract as ``Session.on_approval``,
            installed before the frames that arrived with the reply are
            applied. Never sent on the wire.
        on_approval_error: Hears this session's approval failures from its
            first frame, as ``Session.on_approval_error`` does later, so a
            failure for an approval that arrived with the resume reply is
            heard whatever task the caller registers from. Never sent on the
            wire.
        config: Per-session configuration, as at start: naming MCP servers
            needs the host's ``sessionMcp`` grant.
    """

    session_id: str
    cursor: str | None = None
    exclude_items: bool | None = None
    history: Mapping[str, Any] | None = None
    permission_profile: str | None = None
    model_id: str | None = None
    recovery_mode: RecoveryMode | None = None
    on_approval: ApprovalHandler | None = None
    on_approval_error: ApprovalFailureHandler | None = None
    config: SessionConfig | None = None


# Drift pins — the Python twin of the TS `AssertNever` on START_FORWARDED /
# RESUME_FORWARDED (client.ts). A schema regen that adds a member to the
# generated params but not to the options dataclass reds THIS import (and thus
# every test), so a regenerated member cannot silently fail to reach the wire.
# The excluded members are the ones the facade owns rather than forwards:
# `commandId` (the connection is the single minter) and
# `previousSessionId` and `clear` (the facade starts root sessions; the
# predecessor link and the `/clear` marker belong to a client that switches
# sessions) and `spawnedBy` (the facade
# does not expose a spawner yet). The owned
# members are options-only posture the wire never carries (client-local
# `requirePermissionProfile`, the required-selection check): subtracted from
# the options side, so a regen that adds a same-named wire member reds here.
# Experimental-only members stay out: this set tracks stable
# `SessionStartParams`, and a graduation reds the assert below.
_START_EXCLUDED = {"commandId", "previousSessionId", "clear", "spawnedBy"}
_START_OWNED = {"requirePermissionProfile"}
assert (
    {_camel(f.name) for f in fields(StartSessionOptions)} - _START_OWNED
) | _START_EXCLUDED == set(
    SessionStartParams.__annotations__
), "StartSessionOptions drifted from SessionStartParams — forward the new member"

_RESUME_EXCLUDED = {"commandId"}
_RESUME_OWNED = {"onApproval", "onApprovalError"}
assert (
    {_camel(f.name) for f in fields(ResumeSessionOptions)} - _RESUME_OWNED
) | _RESUME_EXCLUDED == set(
    SessionResumeParams.__annotations__
), "ResumeSessionOptions drifted from SessionResumeParams — forward the new member"


def _with_session_mcp_requested(
    capabilities: ClientCapabilities | None,
) -> ClientCapabilities:
    """The caller's capability posture with ``sessionMcp`` added to its
    requests, each requested name once: the facade requests the grant its
    ``config`` forwarding checks, and a host grants only what was requested.
    """
    merged: ClientCapabilities = {**capabilities} if capabilities is not None else {}
    requested = list(dict.fromkeys(merged.get("requestedCapabilities") or []))
    if "sessionMcp" not in requested:
        requested.append("sessionMcp")
    merged["requestedCapabilities"] = requested
    return merged


def _committed_profile_id(snapshot: Any) -> str | None:
    """The committed profile id a session snapshot claims, or None when the
    snapshot is silent (the stable bundle strips the member; absent and null
    both mean unknown, never applied). Structural on purpose: an unknown wire
    shape reads as unknown rather than raising.
    """
    if not isinstance(snapshot, Mapping):
        return None
    state = snapshot.get("permissionState")
    if not isinstance(state, Mapping):
        return None
    profile_id = state.get("profileId")
    return profile_id if isinstance(profile_id, str) else None


@dataclass
class MuseClientOptions:
    """Options for building a ``MuseClient`` around a connection you own.

    :meth:`MuseClient.spawn` fills these in for you; supply them yourself only
    when you compose the client with your own transport and handshake.

    Attributes:
        durability: The handshake's ``sessionDurability``, read through
            :func:`~muse_code.facade.host_death.read_session_durability`.
            REQUIRED for the same reason ``Session``'s is.
        host: The owned host, set by :meth:`MuseClient.spawn`. A client built
            around a connection somebody else owns has none, and says so by
            omitting it — which is why ``close()`` falls back to closing just
            the connection.
    """

    durability: SessionDurabilityProfile
    host: SpawnedMspConnection | None = None


@dataclass
class MuseClientSpawnOptions:
    """What :meth:`MuseClient.spawn` needs: the host binary, plus the
    handshake identity.

    Attributes:
        muse_bin: The host binary to run, or ``None`` to use the first
            ``muse`` on the process ``PATH``; with neither, ``spawn`` raises
            ``MuseHostDiscoveryError`` before starting anything. Still the
            first field, so positional construction keeps working.
        client_info: Client identification, forwarded verbatim into
            ``initialize``.
        args: Passed through verbatim (a bare ``muse`` is the TUI — pass
            ``["serve"]`` for the MSP host).
        cwd: Working directory for the host.
        env: The host's environment (inherited when ``None``).
        capabilities: Capability posture; absent means all defaults.
            ``spawn`` adds ``sessionMcp`` to ``requestedCapabilities``
            (keeping yours) so per-session MCP servers can be granted.
        on_stderr: Raw stderr chunks, drained from birth, never parsed.
        shutdown_timeout_ms: See ``MuseServeChild.spawn``.
    """

    muse_bin: str | None
    client_info: ClientInfo
    args: Sequence[str] | None = None
    cwd: str | None = None
    env: Mapping[str, str] | None = None
    capabilities: ClientCapabilities | None = None
    on_stderr: OnStderr | None = None
    shutdown_timeout_ms: int | None = None


NotificationObserver = Callable[[Mapping[str, Any]], "None | Awaitable[None]"]
"""Hears one server notification frame. Read-only at the top level, and do not
change nested values: the session folds the same frame, possibly after the
listener runs. An ``async def`` listener is run as a task."""

NotificationFailureHandler = Callable[[Exception, Mapping[str, Any]], "None | Awaitable[None]"]
"""Hears what an ``on_notification`` listener raised, with the notification it was handed."""

ProtocolErrorObserver = Callable[[ProtocolError], "None | Awaitable[None]"]
"""Hears one framing or correlation violation the connection detected."""


class MuseClient(Generic[_I]):
    """Your entry point to the SDK.

    Spawn a host with :meth:`spawn`, then open conversations with
    :meth:`start_session` or :meth:`resume_session`. The client owns the
    connection: it routes every server event to the session it belongs to and
    reports a host death to all of them. Call :meth:`close` to shut the host
    down cleanly.
    """

    def __init__(self, connection: Connection, options: MuseClientOptions) -> None:
        """Builds a client over a connection you own.

        Args:
            connection: A ready :class:`~muse_code.connection.Connection`.
            options: The durability profile and the optional owned host.
        """
        self._connection = connection
        self._durability = options.durability
        # Client-owned, never injected: the protocol is a one-client obligation
        # and no current consumer spans two clients over one host lineage, so a
        # sharing knob would be declared-ahead surface (Constitution XI).
        self._discarded = DiscardedSessions()
        self._sessions: Set[Session[_I]] = set()
        # Frames naming a session this client has not registered YET, held
        # only while a ``session/start``/``session/resume`` is in flight: the
        # host flushes the resume replay BEFORE the result, and the coroutine
        # awaiting that result resumes only after the whole chunk has been
        # routed. ``_route`` holds, ``_open_session`` drains,
        # ``_open`` clears when the last open settles.
        self._opening = 0
        self._held: dict[str, List[Mapping[str, Any]]] = {}
        host = options.host
        self._child: MuseServeChild | None = host.child if host is not None else None
        self._initialize_result: InitializeResult | None = (
            host.initialize_result if host is not None else None
        )
        # Set by close() BEFORE the connection is torn down: the same EOF is an
        # orderly protocol shutdown when we caused it and an abnormal death when
        # we did not, and nothing below this layer can tell.
        self._closing = False
        # Latched by an abnormal EOF, so a later resume_session can be withheld.
        self._host_died = False
        # THE ONE INBOUND PUMP: ``Session.apply`` is the only
        # event entry point and ``_connection`` is private, so without this a
        # spawn-built consumer hears no view frame. ``Connection`` holds ONE
        # notification handler — this client claims it.
        connection.on_notification(self._pump)
        # A question or approval still open when a session is resumed is
        # re-sent as a ``userInput/request`` or ``approval/request`` server
        # request. Each is routed and answered with the empty receipt ``{}``:
        # a question as the ``userInput/requested`` twin it shares params with,
        # so its session lists it, and an approval as itself, which the session
        # routes to its approval handler. Every other server-request method
        # keeps the ``-32601`` a bare ``Connection`` answers.
        connection.on_server_request(self._serve_request)
        # Registered at construction, not at the first session: an EOF can land
        # before any session exists, and the flag has to be read at that moment.
        self._closed_watch = asyncio.ensure_future(self._watch_closed())
        # A call the connection fails because the host died says how it ended;
        # read at the EOF, so a close() of ours leaves the bare error.
        connection._peer_end_cause(self._host_death_cause)
        # Caller observers, one entry per subscription (keyed by a fresh token,
        # so a function added twice unsubscribes once per call).
        self._listeners: dict[object, NotificationObserver] = {}
        self._notification_failure_handlers: dict[object, NotificationFailureHandler] = {}
        self._protocol_error_listeners: dict[object, ProtocolErrorObserver] = {}
        # Claimed on the first ``on_protocol_error``, so a client nobody
        # observes leaves a handler the caller set on the connection alone.
        self._protocol_errors_claimed = False
        # Strong refs to running async observers until they settle.
        self._observer_tasks: Set["asyncio.Future[Any]"] = set()

    @staticmethod
    async def spawn(options: MuseClientSpawnOptions) -> "MuseClient[Any]":
        """Spawn an owned host, run the protocol handshake, and hand back a client
        whose durability profile came from that handshake.

        The profile is READ rather than asked of the caller, which is the whole
        reason this factory exists beside the bare constructor: the protocol makes
        the absent/unrecognized distinction load-bearing, and a caller
        re-deriving it by hand can get it wrong.

        Args:
            options: The host binary and handshake identity.

        Returns:
            A wired client, its connection already initialized.

        Raises:
            MuseHostDiscoveryError: ``muse_bin`` is ``None`` and no ``muse``
                is on ``PATH``; raised before anything is started.
            MuseHostStartError: The host ended before the handshake
                completed; it carries the exit classification row, the
                bounded stderr tail, and ``answered_initialize`` (``True``
                when the host answered ``initialize`` and died while this
                client sent ``initialized``). A host whose answer was itself
                the failure — its own error, a fingerprint mismatch or a
                malformed result — keeps that error; an ``initialize`` frame
                this client cannot encode (for example a non-UTF-8
                ``client_info``) keeps its ``ProtocolError``; a cancellation
                stays a cancellation; and a binary that cannot be started
                raises the operating system's own error from the spawn call.
        """
        handshake = await spawn_msp_connection(
            discover_muse_bin(options.muse_bin),
            args=tuple(options.args) if options.args is not None else (),
            cwd=options.cwd,
            env=options.env,
            on_stderr=options.on_stderr,
            # ``spawn_msp_connection``'s default IS this constant, so passing it
            # when the caller left the option unset is byte-identical to the
            # bare call and keeps the parameter's type an ``int`` for mypy.
            shutdown_timeout_ms=(
                DEFAULT_SHUTDOWN_TIMEOUT_MS
                if options.shutdown_timeout_ms is None
                else options.shutdown_timeout_ms
            ),
        )
        init_params: InitializeParams = {
            "clientInfo": options.client_info,
            "capabilities": _with_session_mcp_requested(options.capabilities),
        }
        try:
            spawned = await handshake.initialize(init_params)
        except BaseException as error:
            # A failed handshake must not leak the process it already spawned.
            # (``initialize`` already closes on its own failure paths; this is
            # the belt-and-braces close for anything that escapes it.)
            try:
                await handshake.close()
            except BaseException:
                pass
            # A cancellation or interrupt is the caller's, a frame that never
            # left this process is the caller's, and a host that ANSWERED was
            # not lost: decided before the exit is read, so our own close
            # ladder can never dress any of them up as a death.
            if not isinstance(error, Exception) or keeps_its_own_error(error):
                raise
            # The host was lost: before answering, or after a usable answer
            # while we sent ``initialized`` (the error then says so). close()
            # ended at its observed exit, so the row is settled: raise it with
            # the stderr tail instead of the transport's first symptom.
            child = handshake.child
            raise MuseHostStartError(
                await child.exit,
                child.stderr_tail,
                answered_initialize=handshake._answered,
            ) from error
        return MuseClient(
            spawned.connection,
            MuseClientOptions(
                durability=read_session_durability(spawned.initialize_result),
                host=spawned,
            ),
        )

    @property
    def initialize_result(self) -> InitializeResult:
        """The handshake result, when this client was built by :meth:`spawn`.

        A plain error, not a typed one: reading this off a client not built by
        ``spawn`` is API misuse, not a protocol STATE an embedder branches on.

        Raises:
            RuntimeError: This client was not built by ``spawn``.
        """
        if self._initialize_result is None:
            raise RuntimeError(
                "initialize_result is only available on a client built by MuseClient.spawn"
            )
        return self._initialize_result

    @property
    def exit(self) -> Awaitable[ExitClassification]:
        """The host's exit-classification row, when this client was built by
        :meth:`spawn`.

        Raises:
            RuntimeError: This client was not built by ``spawn``.
        """
        if self._child is None:
            raise RuntimeError(
                "exit is only available on a client built by MuseClient.spawn"
            )
        return self._child.exit

    @property
    def durability(self) -> SessionDurabilityProfile:
        """The durability profile every session this client opens inherits."""
        return self._durability

    @property
    def closed(self) -> Awaitable[None]:
        """Settles when the connection closes for any reason: :meth:`close`,
        the host hanging up, or a transport failure. Pending while it is live."""
        return self._connection.closed

    def on_notification(self, listener: NotificationObserver) -> Callable[[], None]:
        """Hear every server notification frame in wire order, including those
        naming no session (``usage/changed``, ``account/loginCompleted``) or a
        session this client did not open.

        A frame naming a session this client has opened reaches the listener
        after that session has applied it: folded, or, while the session fills
        a gap, buffered and folded when the fill completes. One that arrives
        while its session's start/resume is still in flight reaches the
        listener first, and the session folds it before the verb returns.
        Re-sent ``approval/request`` / ``userInput/request`` server requests
        are not notifications and never reach it.

        The frame is read-only: it is the one the session folds, which for a
        held or buffered frame happens after the listener runs. The listener
        runs in the connection's read loop, so it must not block;
        an ``async def`` listener is run as a task. An exception it raises goes
        to every :meth:`on_notification_error` handler; the other listeners
        still hear the frame and the connection stays open.

        Returns:
            A function that removes this one subscription (a function added
            twice is two subscriptions).
        """
        return _subscribe(self._listeners, listener)

    def on_notification_error(self, handler: NotificationFailureHandler) -> Callable[[], None]:
        """Hear what an :meth:`on_notification` listener raised. With no
        handler the failure is dropped; either way the pump keeps running. A
        handler's own failure is swallowed: there is no one left to tell.

        Returns:
            A function that removes this one subscription.
        """
        return _subscribe(self._notification_failure_handlers, handler)

    def on_protocol_error(self, handler: ProtocolErrorObserver) -> Callable[[], None]:
        """Hear each framing or correlation violation the connection detects
        (``Connection.on_protocol_error``). A handler's own failure is
        swallowed rather than ending the connection. The first call takes over
        ``Connection.on_protocol_error``, replacing a handler set there
        directly (and a later direct ``connection.on_protocol_error(...)``
        silences these subscribers).

        Returns:
            A function that removes this one subscription.
        """
        if not self._protocol_errors_claimed:
            self._protocol_errors_claimed = True
            self._connection.on_protocol_error(self._protocol_error)
        return _subscribe(self._protocol_error_listeners, handler)

    async def start_session(
        self, options: StartSessionOptions | None = None
    ) -> Session[_I]:
        """Open a new root session."""
        options = options or StartSessionOptions()
        params: dict[str, Any] = {}
        if options.approval_mode is not None:
            params["approvalMode"] = options.approval_mode
        if options.provider_id is not None:
            params["providerId"] = options.provider_id
        if options.session_id is not None:
            params["sessionId"] = options.session_id
        if options.workspace_root is not None:
            params["workspaceRoot"] = options.workspace_root
        if options.workspace_roots is not None:
            params["workspaceRoots"] = options.workspace_roots
        if options.model_id is not None:
            params["modelId"] = options.model_id
        if options.recovery_mode is not None:
            params["recoveryMode"] = options.recovery_mode
        # The initial permission-profile selection, forwarded verbatim like the
        # other start members (None stays omitted).
        if options.permission_profile is not None:
            params["permissionProfile"] = options.permission_profile
        if options.config is not None:
            params["config"] = self._forward_config("session/start", options.config)
        # Required selection: a caller that requires its selection proves it,
        # never assuming the host default. The flag without the member is a
        # usage error, raised pre-wire.
        required = options.require_permission_profile is True
        if required and options.permission_profile is None:
            raise ValueError(
                "require_permission_profile needs permission_profile:"
                " require the selection you pass"
            )
        # Keyed by the id the SERVER named, never the one the caller asked for:
        # ``sessionId`` is a REQUEST on start, and a session keyed by a hopeful
        # id would reject every one of its own events as foreign.
        session = await self._open("session/start", params, _StartOpening)
        if not required:
            return session
        assert options.permission_profile is not None  # the usage guard above
        return await self._prove_selection(session, options.permission_profile)

    async def _prove_selection(
        self, session: Session[_I], requested: str
    ) -> Session[_I]:
        """Prove a required start selection: the start result's own
        ``session.permissionState`` first (absent = unknown,
        never applied); else a point-in-time ``session/read``, which never
        subscribes. Only ``profileId == requested`` proceeds; anything else
        raises ``PermissionProfileNotApplied`` BEFORE any turn is sent. The
        refused session is dropped from the client (no orphan keeps folding
        for an id the caller can never reach — the SDK has no set/close-by-id
        verb); the error's ``session_id`` is the caller's handle to resume via
        ``session_id`` or start again. A failed read-back propagates: the
        client still never proceeds on the default.
        """
        opening = session.opening
        started = (
            _committed_profile_id(opening.result["session"])
            if isinstance(opening, _StartOpening)
            else None
        )
        if started is not None:
            if started == requested:
                return session
            self._sessions.discard(session)
            raise PermissionProfileNotApplied(requested, started, session.session_id)
        read = await self._connection.command(
            "session/read", {"sessionId": session.session_id}
        )
        served = _committed_profile_id(read.get("session"))
        if served == requested:
            return session
        self._sessions.discard(session)
        raise PermissionProfileNotApplied(requested, served, session.session_id)

    async def resume_session(self, options: ResumeSessionOptions) -> Session[_I]:
        """Load an existing session and subscribe this connection to its view.

        WITHHELD after an ephemeral host death, and refused on THIS side of the transport: a
        reattach that reaches the wire has already violated the clause,
        whatever the server answers.
        """
        self._assert_reattach_allowed(options.session_id)
        params: dict[str, Any] = {"sessionId": options.session_id}
        if options.cursor is not None:
            params["cursor"] = options.cursor
        if options.exclude_items is not None:
            params["excludeItems"] = options.exclude_items
        if options.history is not None:
            params["history"] = options.history
        if options.model_id is not None:
            params["modelId"] = options.model_id
        if options.recovery_mode is not None:
            params["recoveryMode"] = options.recovery_mode
        if options.permission_profile is not None:
            params["permissionProfile"] = options.permission_profile
        if options.config is not None:
            params["config"] = self._forward_config("session/resume", options.config)
        return await self._open(
            "session/resume",
            params,
            _ResumeOpening,
            options.on_approval,
            options.on_approval_error,
        )

    async def list_sessions(
        self, options: SessionListParams | None = None
    ) -> SessionListResult:
        """List stored sessions (``session/list``), including text search.

        A read-only list: rides ``request()``, not ``command()`` (see
        ``Session.list_tasks``).
        """
        params: dict[str, Any] = {}
        if options:
            for key in LIST_FORWARDED:
                value = options.get(key)
                if value is not None:
                    params[key] = value
        return cast(
            SessionListResult, await self._connection.request("session/list", params)
        )

    async def list_models(
        self, options: ModelListParams | None = None
    ) -> ModelListResult:
        """List the models the host accepts in ``Session.set_model``
        (``model/list``).

        With ``sessionId``, that session's current model is flagged
        ``isActive``. A query: rides ``request()``, like ``list_sessions``.
        """
        params: dict[str, Any] = {}
        if options and options.get("sessionId") is not None:
            params["sessionId"] = options["sessionId"]
        return cast(ModelListResult, await self._connection.request("model/list", params))

    async def read_usage(self) -> UsageReadResult:
        """Read the host's last-observed subscription usage (``usage/read``)
        without a model call; ``usage`` is absent when nothing was observed."""
        return cast(UsageReadResult, await self._connection.request("usage/read"))

    async def command(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        command_id: str | None = None,
        max_attempts: int | None = None,
        retry_delay: RetryDelay | None = None,
    ) -> Params:
        """Send a wire method directly, typically one the facade does not
        wrap, experimental ones included.

        It rides the same ``Connection.command()`` the verbs use: the
        connection mints the ``commandId``, retries a nothing-admitted refusal
        under the same id, and checks the ack's echo. Frames the command
        causes still reach your sessions through the client's one inbound
        pump; this sends and returns the ack, nothing more. Each call keeps
        one fixed-size fingerprint for the connection's lifetime, so prefer
        ``request`` for a query you poll. An experimental method needs a
        client spawned with ``capabilities={"experimentalApi": True}``
        (otherwise the host refuses it with an ``MspError`` of kind
        ``experimentalRequired``, code -32601) and may change without notice.

        Args:
            method: The wire method.
            params: Its params, without ``commandId``.
            command_id: Reuse this id for a replay of the same logical command.
            max_attempts: Total attempts, including the first (default 3).
            retry_delay: Injectable so deterministic tests do not sleep.

        Returns:
            The host's ack.

        Raises:
            MuseFacadeOwnedMethodError: ``method`` is one whose state the
                facade owns (``FACADE_OWNED_METHODS``); nothing is written.
        """
        if method in FACADE_OWNED_METHODS:
            raise MuseFacadeOwnedMethodError(method)
        return await self._connection.command(
            method,
            dict(params),
            command_id=command_id,
            max_attempts=max_attempts,
            retry_delay=retry_delay,
        )

    async def request(
        self, method: str, params: Mapping[str, Any] | None = None
    ) -> Params:
        """Send a wire request directly, typically a query the facade does
        not wrap, experimental ones included.

        It rides ``Connection.request()``: no ``commandId``, no retry, and
        omitted ``params`` stay off the frame. An experimental method needs
        the same ``experimentalApi`` opt-in as ``command``.

        Args:
            method: The wire method.
            params: Its params, omitted from the frame when ``None``.

        Returns:
            The host's result.

        Raises:
            MuseFacadeOwnedMethodError: ``method`` is one whose state the
                facade owns (``FACADE_OWNED_METHODS``); nothing is written.
        """
        if method in FACADE_OWNED_METHODS:
            raise MuseFacadeOwnedMethodError(method)
        return await self._connection.request(
            method, None if params is None else dict(params)
        )

    async def close(self) -> None:
        """Shut the host down in an orderly way.

        The EOF this close produces is NOT a death, which is what
        ``_closing`` records. ``_closing`` covers only the EOF; it must not
        swallow the EXIT ROW: when the host ignores stdin EOF, the child close
        escalates to SIGTERM/SIGKILL and the exit classifies as a crash — an
        abnormal death under the protocol no matter who started the close, and one
        no transport event will report because ``_closing`` already claimed the
        EOF. So the close's own classification is forwarded to every session;
        ``host_exited`` answers ``notADeath`` for a clean shutdown, keeping the
        orderly arm inert.

        A stop ``Session.run`` left running after a second cancellation has no
        host to send to once the close ends it, so the close cancels it and
        waits for it, leaving no such task pending once the close settles.
        """
        self._closing = True
        try:
            if self._child is not None:
                exit_classification: ExitClassification = await self._child.close()
                if is_abnormal_host_death(exit_classification):
                    for session in self._sessions:
                        session.host_exited(exit_classification)
                return
            await self._connection.close()
        finally:
            held = [task for session in self._sessions for task in session._end_held_stops()]
            if held:
                await asyncio.gather(*held, return_exceptions=True)

    async def _open(
        self,
        verb: str,
        params: dict[str, Any],
        opening: Callable[[Mapping[str, Any]], SessionOpening],
        on_approval: ApprovalHandler | None = None,
        on_approval_error: ApprovalFailureHandler | None = None,
    ) -> Session[_I]:
        # The window ``_route`` holds unknown-session frames for: from the
        # request to the Session's registration. Counted, not flagged, so two
        # concurrent opens keep it open until the LAST settles; cleared on
        # settle so a frame that named no session this client opened is held
        # no longer than the open it rode in with.
        self._opening += 1
        try:
            raw = await self._connection.command(verb, params)
            result: Mapping[str, Any] = raw
            return self._open_session(
                str(result["session"]["sessionId"]),
                opening(result),
                on_approval,
                on_approval_error,
            )
        finally:
            self._opening -= 1
            if self._opening == 0:
                self._held.clear()

    def _open_session(
        self,
        session_id: str,
        opening: SessionOpening,
        on_approval: ApprovalHandler | None = None,
        on_approval_error: ApprovalFailureHandler | None = None,
    ) -> Session[_I]:
        session: Session[_I] = Session(
            session_id,
            self._durability,
            connection=self._connection,
            discarded=self._discarded,
            opening=opening,
        )
        # Before the held frames below: an approval re-sent with the resume
        # reply must find the handler, and its failure the observer.
        if on_approval_error is not None:
            session.on_approval_error(on_approval_error)
        if on_approval is not None:
            session.on_approval(on_approval)
        # ``_route`` drops what ``apply`` returns, so a reclaim folded during
        # this session's own ``unqueue()`` must be held for that call.
        session._apply_results_dropped = True
        self._sessions.add(session)
        # The frames that named this session while its verb was in flight
        # fold NOW, in arrival order — synchronously, so nothing the pump
        # routes next can overtake them.
        for held in self._held.pop(session_id, ()):
            session.apply(held)
        return session

    def _forward_config(self, method: str, config: SessionConfig) -> SessionConfig:
        # Per-session MCP servers need the ``sessionMcp`` grant in the
        # handshake this client was built with (``spawn`` requests it; a
        # caller's own handshake must request it too); a client given no
        # handshake cannot show it. A config naming no server needs no grant,
        # as on the host.
        if not config.get("mcpServers"):
            return config
        handshake = self._initialize_result
        if handshake is not None and "sessionMcp" in handshake.get("grantedCapabilities", []):
            return config
        raise MuseCapabilityNotGrantedError(
            "sessionMcp",
            method,
            "config.mcpServers needs the sessionMcp grant, which this connection's "
            "handshake does not hold (MuseClient.spawn requests it; a host withholds "
            "it when per-session MCP is turned off)",
        )

    def _assert_reattach_allowed(self, session_id: str) -> None:
        # Two facts, both recorded by an ephemeral discharge: THIS session was
        # discarded, or this client's own ephemeral host died (nothing on the
        # other end to reattach TO, whatever id is asked for).
        if session_id in self._discarded.session_ids:
            raise MuseSessionDiscardedError(
                f"session {session_id} was discarded after an ephemeral host "
                "death; it cannot be resumed"
            )
        if self._host_died and not survives_host_death(self._durability):
            raise MuseSessionDiscardedError(
                "this client's ephemeral host died; the protocol forbids "
                "reattaching to it"
            )

    async def _serve_request(self, request: Mapping[str, Any]) -> dict[str, Any]:
        # The connection runs this as its own task, so the twin can land after
        # frames read in the same chunk. The same questions are listed, since
        # the list is keyed by question id and a settled question stays
        # settled; their order can differ when another question arrives in
        # that chunk. The receipt does not depend on ``_route`` finding the
        # session: a request read during an open is held before that session
        # exists.
        method = request.get("method")
        if method == "userInput/request":
            self._route(
                {
                    "jsonrpc": "2.0",
                    "method": "userInput/requested",
                    "params": request.get("params"),
                }
            )
            return {}
        if method == "approval/request":
            self._route(
                {"jsonrpc": "2.0", "method": method, "params": request.get("params")}
            )
            return {}
        raise MspError(
            {
                "code": -32601,
                "message": f"method not found: {method}",
                "data": {"kind": "methodNotFound", "retryable": False},
            }
        )

    def _pump(self, notification: Mapping[str, Any]) -> None:
        # Sessions first, so a listener reading a session's fold sees the frame.
        self._route(notification)

        def failed(error: Exception) -> None:
            for handler in list(self._notification_failure_handlers.values()):
                self._observe(functools.partial(handler, error, notification), _ignore)

        for listener in list(self._listeners.values()):
            self._observe(functools.partial(listener, notification), failed)

    def _protocol_error(self, error: ProtocolError) -> None:
        for handler in list(self._protocol_error_listeners.values()):
            self._observe(functools.partial(handler, error), _ignore)

    def _observe(
        self, call: Callable[[], object], on_failure: Callable[[Exception], None]
    ) -> None:
        # Neither a caller observer's exception nor an async observer's
        # failure may escape: in the read loop it would end the connection
        # every session on this host shares.
        try:
            result = call()
        except Exception as error:  # noqa: BLE001 — routed to the observer
            on_failure(error)
            return
        except BaseException as interrupt:
            # Not a listener failure (Ctrl-C, sys.exit(), a cancellation):
            # hand it back to the loop instead of letting the read loop end a
            # live connection and report the host dead.
            asyncio.get_running_loop().call_soon(_reraise, interrupt)
            return
        if not inspect.isawaitable(result):
            return
        task = asyncio.ensure_future(result)
        self._observer_tasks.add(task)

        def settled(done: "asyncio.Future[Any]") -> None:
            self._observer_tasks.discard(done)
            if done.cancelled():
                return
            error = done.exception()
            if isinstance(error, Exception):
                on_failure(error)
            elif error is not None and not isinstance(error, (KeyboardInterrupt, SystemExit)):
                # As on the sync path; asyncio already lets these two out itself.
                asyncio.get_running_loop().call_soon(_reraise, error)

        task.add_done_callback(settled)

    def _route(self, notification: Mapping[str, Any]) -> None:
        # Deliver one view notification to the session(s) it names. A frame
        # naming NO session is dropped here rather than fed to every session
        # — routing it anywhere would trip the foreign-frame throw.
        params = notification.get("params")
        named = params.get("sessionId") if isinstance(params, dict) else None
        if not isinstance(named, str):
            return
        delivered = False
        for session in self._sessions:
            if session.session_id == named:
                session.apply(notification)
                delivered = True
        # An UNKNOWN session with no open in flight is dropped, for the same
        # reason as a nameless frame.
        if delivered or self._opening == 0:
            return
        # An open is in flight and this may be ITS session, named by the
        # server before the awaiting coroutine has run: hold it for
        # ``_open_session`` to fold, or for ``_open`` to clear.
        self._held.setdefault(named, []).append(notification)

    async def _watch_closed(self) -> None:
        try:
            await self._connection.closed
        except asyncio.CancelledError:
            return
        self._transport_closed()

    def _host_death_cause(self) -> asyncio.Future[BaseException | None] | None:
        # Waits for the exit at most SIGTERM_GRACE_MS: a host that closed
        # stdout but keeps running must not hold the failed calls past today's
        # bare error.
        child = self._child
        if self._closing or child is None:
            return None

        async def read() -> BaseException | None:
            try:
                exit_classification = await asyncio.wait_for(
                    child.exit, SIGTERM_GRACE_MS / 1000
                )
            except Exception:
                return None
            if is_abnormal_host_death(exit_classification):
                return MuseHostDiedError(exit_classification)
            return None

        return asyncio.ensure_future(read())

    def _transport_closed(self) -> None:
        # The transport reached EOF. If this client did not cause it, that is
        # the protocol's second death notification, and every
        # session discharges through the SAME ``host_exited`` path the process
        # exit uses — including its latch, so whichever notification arrives
        # second replays the first one's report.
        if self._closing:
            return
        self._host_died = True
        for session in self._sessions:
            session.host_exited(TransportEof())


def _subscribe(registry: "dict[object, _H]", handler: "_H") -> Callable[[], None]:
    token = object()
    registry[token] = handler

    def unsubscribe() -> None:
        registry.pop(token, None)

    return unsubscribe


def _ignore(_: Exception) -> None:
    return None


def _reraise(interrupt: BaseException) -> None:
    # asyncio lets KeyboardInterrupt/SystemExit out of a callback, so those
    # end the caller's run_until_complete / asyncio.run; any other
    # BaseException goes to the loop's exception handler.
    raise interrupt
