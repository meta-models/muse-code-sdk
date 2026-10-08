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
)

from muse_code_msp import (
    ClientCapabilities,
    ClientInfo,
    InitializeParams,
    InitializeResult,
    SessionResumeParams,
    SessionStartParams,
)

from ..connection.connection import Connection
from ..connection.spawn import (
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ExitClassification,
    MuseServeChild,
    OnStderr,
    SpawnedMspConnection,
    spawn_msp_connection,
)
from ..errors import MuseSessionDiscardedError
from .discarded import DiscardedSessions
from .host_start import MuseHostStartError, keeps_its_own_error
from .host_death import (
    SessionDurabilityProfile,
    TransportEof,
    is_abnormal_host_death,
    read_session_durability,
    survives_host_death,
)
from .session import Session, SessionOpening, _ResumeOpening, _StartOpening
from .turn_submit import _camel

_I = TypeVar("_I")

# OPTIONAL MEANS OMITTED, NEVER null: every member the two option
# builders can leave unset is optional-non-nullable in the generated params,
# so an unset member is dropped from the frame rather than nulled.


@dataclass
class StartSessionOptions:
    """Caller-facing options for ``session/start``.

    Composed from the generated ``SessionStartParams``. ``config`` is excluded as well as ``commandId`` until the facade
    implements the required ``sessionMcp`` grant check and forwarding.

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
    """

    approval_mode: str | None = None
    provider_id: str | None = None
    session_id: str | None = None
    workspace_root: str | None = None
    workspace_roots: List[str] | None = None
    model_id: str | None = None


@dataclass
class ResumeSessionOptions:
    """Caller-facing options for ``session/resume``.

    ``config`` remains excluded until the same capability-checked forwarding
    as ``session/start`` lands.

    Attributes:
        session_id: The session to resume.
        cursor: Resume from this view cursor; omitted = from genesis.
        exclude_items: Ask the host to omit item bodies from the history.
        history: The history preference forwarded as the wire's ``history``
            member.
    """

    session_id: str
    cursor: str | None = None
    exclude_items: bool | None = None
    history: Mapping[str, Any] | None = None


# Drift pins — the Python twin of the TS `AssertNever` on START_FORWARDED /
# RESUME_FORWARDED (client.ts). A schema regen that adds a member to the
# generated params but not to the options dataclass reds THIS import (and thus
# every test), so a regenerated member cannot silently fail to reach the wire
#. The excluded members are the ones the facade owns rather than
# forwards: `commandId` (the connection is the single minter) and `config`
# (temporarily withheld until capability-checked forwarding lands).
_START_EXCLUDED = {"commandId", "config"}
assert {_camel(f.name) for f in fields(StartSessionOptions)} | _START_EXCLUDED == set(
    SessionStartParams.__annotations__
), "StartSessionOptions drifted from SessionStartParams — forward the new member"

_RESUME_EXCLUDED = {"commandId", "config"}
assert {_camel(f.name) for f in fields(ResumeSessionOptions)} | _RESUME_EXCLUDED == set(
    SessionResumeParams.__annotations__
), "ResumeSessionOptions drifted from SessionResumeParams — forward the new member"


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
        muse_bin: The host binary to run.
        client_info: Client identification, forwarded verbatim into
            ``initialize``.
        args: Passed through verbatim (a bare ``muse`` is the TUI — pass
            ``["serve"]`` for the MSP host).
        cwd: Working directory for the host.
        env: The host's environment (inherited when ``None``).
        capabilities: Capability posture; absent means all defaults.
        on_stderr: Raw stderr chunks, drained from birth, never parsed.
        shutdown_timeout_ms: See ``MuseServeChild.spawn``.
    """

    muse_bin: str
    client_info: ClientInfo
    args: Sequence[str] | None = None
    cwd: str | None = None
    env: Mapping[str, str] | None = None
    capabilities: ClientCapabilities | None = None
    on_stderr: OnStderr | None = None
    shutdown_timeout_ms: int | None = None


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
        connection.on_notification(self._route)
        # Registered at construction, not at the first session: an EOF can land
        # before any session exists, and the flag has to be read at that moment.
        self._closed_watch = asyncio.ensure_future(self._watch_closed())

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
            options.muse_bin,
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
        init_params: InitializeParams = {"clientInfo": options.client_info}
        if options.capabilities is not None:
            init_params["capabilities"] = options.capabilities
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
        # Keyed by the id the SERVER named, never the one the caller asked for:
        # ``sessionId`` is a REQUEST on start, and a session keyed by a hopeful
        # id would reject every one of its own events as foreign.
        return await self._open("session/start", params, _StartOpening)

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
        return await self._open("session/resume", params, _ResumeOpening)

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
        """
        self._closing = True
        if self._child is not None:
            exit_classification: ExitClassification = await self._child.close()
            if is_abnormal_host_death(exit_classification):
                for session in self._sessions:
                    session.host_exited(exit_classification)
            return
        await self._connection.close()

    async def _open(
        self,
        verb: str,
        params: dict[str, Any],
        opening: Callable[[Mapping[str, Any]], SessionOpening],
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
                str(result["session"]["sessionId"]), opening(result)
            )
        finally:
            self._opening -= 1
            if self._opening == 0:
                self._held.clear()

    def _open_session(
        self, session_id: str, opening: SessionOpening
    ) -> Session[_I]:
        session: Session[_I] = Session(
            session_id,
            self._durability,
            connection=self._connection,
            discarded=self._discarded,
            opening=opening,
        )
        self._sessions.add(session)
        # The frames that named this session while its verb was in flight
        # fold NOW, in arrival order — synchronously, so nothing the pump
        # routes next can overtake them.
        for held in self._held.pop(session_id, ()):
            session.apply(held)
        return session

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
