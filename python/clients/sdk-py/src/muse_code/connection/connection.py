"""Duplex-agnostic MSP NDJSON connection (spec 638 FR-638-011..015).

Faithful asyncio port of ``clients/sdk-ts/src/connection/connection.ts``
(spec 14990 FR-012/014/015/016). The transport supplies decoded UTF-8 text
chunks; chunks may be empty and may split anywhere — Python strings are
whole code points, so the TS surrogate-pair byte reconciliation has no twin
here (spec 638 Edge Cases): the running byte count is exact by construction
and stays O(bytes) per chunk.

One deliberate adaptation, noted per the port rules: in TS "invoking
``write()`` IS submission" because the transport's synchronous prefix runs
before the call returns. Python coroutines have no synchronous prefix, so
submission here is the write task being scheduled on the loop — the
submission tail still settles for every accepted frame even when the peer
never completes the write, which is the property ``close()`` needs.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterable, Awaitable, Callable, Protocol

from muse_code_msp import ErrorKind, RequestId

DEFAULT_FRAME_LIMIT_BYTES = 10_485_760

Params = dict[str, Any]
"""A JSON object payload (params, result, or error data)."""


class DuplexTransport(Protocol):
    """The two-way text stream a :class:`Connection` speaks MSP over.

    Implement it to run the protocol over any duplex channel: yield decoded
    UTF-8 chunks on ``incoming`` and accept outgoing frames through
    ``write``. Chunks may be empty and may split anywhere; if your transport
    decodes bytes itself, use a streaming decoder so a multi-byte character
    split across byte chunks is never decoded into replacement characters.

    A transport MAY additionally define ``close(flushed)`` (additive-optional,
    discovered by ``getattr``): ``flushed`` settles once every frame the
    connection had accepted when ``close()`` was called has been HANDED to
    ``write()`` — submission, not completion. A process-owning transport
    waits for it inside its own shutdown budget before ending the peer's
    input; it is never GATED by completion, because completion is exactly
    what a wedged peer withholds.
    """

    @property
    def incoming(self) -> AsyncIterable[str]:
        """Decoded UTF-8 chunks read from the peer."""
        ...

    async def write(self, chunk: str) -> None:
        """Writes one already-framed line (with its trailing newline)."""
        ...


ServerRequestHandler = Callable[[Params], Awaitable[Params]]
"""Handles one server-initiated request; resolves with the result to send."""

NotificationHandler = Callable[[Params], None]
"""Receives every server notification frame, in arrival order."""

ProtocolErrorHandler = Callable[["ProtocolError"], None]
"""Receives each framing/correlation violation detected inbound."""

RetryDelay = Callable[[int, "MspError"], Awaitable[None]]
"""Waits between command attempts; injectable so tests never sleep."""


class MspError(Exception):
    """The one typed error family consumers branch on (INV-012).

    Attributes:
        code: The JSON-RPC error code.
        kind: ``error.data.kind`` — the branch key; never message text.
        data: The whole ``error.data`` object, verbatim.
        retryable: ``error.data.retryable`` when the server sent one.
    """

    def __init__(self, error: Params) -> None:
        super().__init__(str(error.get("message", "")))
        data = error.get("data")
        data_dict: Params = dict(data) if isinstance(data, dict) else {}
        self.code: int = int(error["code"])
        self.kind: ErrorKind = str(data_dict.get("kind", "unknown"))
        self.data: Params = data_dict
        retryable = data_dict.get("retryable")
        self.retryable: bool | None = retryable if isinstance(retryable, bool) else None

    @property
    def message(self) -> str:
        """The server's human-readable message (wording is not an API)."""
        return str(self.args[0]) if self.args else ""


class ProtocolError(Exception):
    """A local framing/correlation violation, never a server-authored error.

    Attributes:
        line: The offending inbound line, preserved as evidence and bounded
            in UTF-8 bytes (FM-007), when one exists.
    """

    def __init__(self, message: str, line: str | None = None) -> None:
        super().__init__(message)
        self.line = line

    @property
    def message(self) -> str:
        """The violation description."""
        return str(self.args[0]) if self.args else ""


class _UnencodableFrameError(ProtocolError):
    """The OUTBOUND frame itself cannot encode as UTF-8 (a lone surrogate).

    A caller defect, never transport death: it rejects only that frame's
    outcome, so ``notify()``'s finish-on-write-failure rule must not treat
    it as the pipe dying (PR #30094 review).
    """


@dataclass
class _CommandMemory:
    signature: str
    ack: Params | None = None


@dataclass
class _Pending:
    future: asyncio.Future[Params]


def _request_key(request_id: RequestId) -> str:
    kind = "number" if isinstance(request_id, int) else "string"
    return f"{kind}:{request_id}"


def _utf8_len(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


def _truncate_to_utf8_bytes(text: str, limit_bytes: int) -> str:
    """FM-007: error evidence is bounded in UTF-8 BYTES, never characters.

    Encode once and back the cut up over continuation bytes (the
    ``StderrTail._trim_bytes`` pattern): a per-scalar walk re-encoded every
    character and blocked the event loop for seconds at the frame limit
    (PR #30094 review).
    """
    data = text.encode("utf-8", "surrogatepass")
    if len(data) <= limit_bytes:
        return text
    end = max(0, limit_bytes)
    while end > 0 and (data[end] & 0xC0) == 0x80:
        end -= 1
    return data[:end].decode("utf-8", "surrogatepass")


def _canonical(value: Any) -> str:
    """Order-insensitive canonical JSON, for signatures and ack identity."""
    if isinstance(value, list):
        return "[" + ",".join(_canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return (
            "{"
            + ",".join(
                f"{json.dumps(key)}:{_canonical(value[key])}" for key in sorted(value)
            )
            + "}"
        )
    return json.dumps(value)


def create_uuid_v7_mint() -> Callable[[], str]:
    """Creates the SDK-owned UUIDv7 command-id source (INV-013).

    Returns:
        A zero-argument callable minting RFC 9562 v7-shaped ids, strictly
        distinct under same-millisecond bursts via the 12-bit sequence.
    """
    state = {"last_ms": -1, "sequence": 0}

    def mint() -> str:
        now = time.time_ns() // 1_000_000
        if now <= state["last_ms"]:
            now = state["last_ms"]
            state["sequence"] += 1
            if state["sequence"] > 0x0FFF:
                now += 1
                state["sequence"] = 0
        else:
            state["sequence"] = 0
        state["last_ms"] = now
        raw = bytearray(secrets.token_bytes(16))
        timestamp = now
        for index in range(5, -1, -1):
            raw[index] = timestamp & 0xFF
            timestamp //= 256
        raw[6] = 0x70 | ((state["sequence"] >> 8) & 0x0F)
        raw[7] = state["sequence"] & 0xFF
        raw[8] = (raw[8] & 0x3F) | 0x80
        digest = raw.hex()
        return (
            f"{digest[:8]}-{digest[8:12]}-{digest[12:16]}-"
            f"{digest[16:20]}-{digest[20:]}"
        )

    return mint


async def _default_retry_delay(attempt: int, _error: MspError) -> None:
    """FM-006's full-jitter budget: uniform in 0..ceiling, 50 ms doubling, 2 s cap."""
    ceiling_ms = min(2_000, 50 * 2 ** max(0, attempt - 1))
    await asyncio.sleep(secrets.randbelow(ceiling_ms + 1) / 1000)


def _valid_request_id(request_id: object) -> bool:
    if isinstance(request_id, str):
        return True
    return isinstance(request_id, int) and not isinstance(request_id, bool)


def _done_future(loop: asyncio.AbstractEventLoop) -> asyncio.Future[None]:
    future: asyncio.Future[None] = loop.create_future()
    future.set_result(None)
    return future


def _both_done(
    loop: asyncio.AbstractEventLoop,
    first: asyncio.Future[None],
    second: asyncio.Future[None],
) -> asyncio.Future[None]:
    """A future resolving once both inputs settled (never with an error)."""
    joined: asyncio.Future[None] = loop.create_future()

    def check(_f: asyncio.Future[None]) -> None:
        if first.done() and second.done() and not joined.done():
            joined.set_result(None)

    first.add_done_callback(check)
    second.add_done_callback(check)
    return joined


class Connection:
    """One MSP connection over newline-delimited JSON.

    The connection sends your requests and commands, correlates their
    responses, enforces the frame-size limit, and hands inbound
    notifications and server requests to the handlers you register. It is
    transport-agnostic: pair it with any :class:`DuplexTransport`. Construct
    it inside a running event loop (the read loop starts immediately).
    """

    def __init__(
        self,
        transport: DuplexTransport,
        *,
        frame_limit_bytes: int | None = None,
        mint_command_id: Callable[[], str] | None = None,
        mint_request_id: Callable[[], RequestId] | None = None,
    ) -> None:
        """Builds the connection and starts its read loop.

        Args:
            transport: The duplex text channel.
            frame_limit_bytes: Inbound frame-size sanity bound (SS1.1
                default when omitted).
            mint_command_id: Injectable command-id source (INV-013);
                defaults to the UUIDv7 mint.
            mint_request_id: Injectable for deterministic transcript
                clients; values must be unique in flight.
        """
        self._loop = asyncio.get_running_loop()
        self._transport = transport
        self._frame_limit_bytes = (
            DEFAULT_FRAME_LIMIT_BYTES if frame_limit_bytes is None else frame_limit_bytes
        )
        self._mint_command_id = mint_command_id or create_uuid_v7_mint()
        self._mint_request_id = mint_request_id or self._sequential_request_id
        self._next_request_id = 1
        self._pending: dict[str, _Pending] = {}
        self._commands: dict[str, _CommandMemory] = {}
        self._server_request_handler: ServerRequestHandler | None = None
        self._notification_handler: NotificationHandler | None = None
        self._protocol_error_handler: ProtocolErrorHandler | None = None
        self._write_tail: asyncio.Future[None] = _done_future(self._loop)
        self._submit_tail: asyncio.Future[None] = _done_future(self._loop)
        self._write_failure: BaseException | None = None
        self._segments: list[str] = []
        self._buffer_bytes = 0
        self._dropping_oversized = False
        self._finished = False
        self._closed: asyncio.Future[None] = self._loop.create_future()
        self._read_task = self._loop.create_task(self._read_loop())

    def _sequential_request_id(self) -> RequestId:
        request_id = self._next_request_id
        self._next_request_id += 1
        return request_id

    @property
    def closed(self) -> asyncio.Future[None]:
        """Settles when the connection has finished (EOF, failure, close).

        A fresh shield per access: a consumer's ``wait_for`` timeout must
        cancel only its own wait, never the connection's one real future —
        a cancelled ``_closed`` would break ``close()`` for everyone
        (PR #30094 review; a TS Promise cannot be cancelled).
        """
        return asyncio.shield(self._closed)

    def _submission_tail(self) -> asyncio.Future[None]:
        """The friend seam a process-owning transport adopts as ``flushed``.

        Module-private, like the TS twin's Symbol fence (PR #30094 review):
        it lets a close routed around this class — the public
        ``child.close()`` — wait for accepted frames' SUBMISSION the same
        way :meth:`close` does.
        """
        return self._submit_tail

    def mint_command_id(self) -> str:
        """Takes one id from THIS connection's single command-id minter.

        Exposed for callers that need the id BEFORE the ack: the facade's
        ``send_user_turn`` records its optimistic SS4.13 entry under it. A
        second facade-side minter is exactly what INV-013 forbids. Pair with
        ``command(..., command_id=...)``, which reuses the id.

        Returns:
            One freshly minted command id.
        """
        return self._mint_command_id()

    def request(
        self, method: str, params: Params | None = None
    ) -> asyncio.Future[Params]:
        """Sends one request and correlates its response (SS1.3).

        Args:
            method: The MSP method name.
            params: The params object, omitted from the frame when ``None``.

        Returns:
            A future resolving with the result object, or rejecting with an
            :class:`MspError` (typed, INV-012) or :class:`ProtocolError`.
        """
        outcome: asyncio.Future[Params] = self._loop.create_future()
        if self._finished:
            outcome.set_exception(ProtocolError("connection is closed"))
            return outcome
        request_id = self._mint_request_id()
        if not _valid_request_id(request_id):
            outcome.set_exception(
                ProtocolError("request id must be a string or integer")
            )
            return outcome
        key = _request_key(request_id)
        if key in self._pending:
            outcome.set_exception(
                ProtocolError(f"request id {request_id} is already in flight")
            )
            return outcome
        frame: Params = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            frame["params"] = params
        self._pending[key] = _Pending(outcome)
        write_outcome = self._enqueue_write(frame)

        def on_write_done(done: asyncio.Future[None]) -> None:
            error = done.exception()
            if error is not None:
                self._pending.pop(key, None)
                if not outcome.done():
                    outcome.set_exception(error)

        write_outcome.add_done_callback(on_write_done)
        return outcome

    def notify(self, method: str, params: Params | None = None) -> None:
        """Sends one notification; a write failure finishes the connection.

        Exception: a frame this caller cannot serialize/encode (a non-JSON
        value, a lone surrogate) is the caller's defect, detected before
        anything reaches the transport — it raises :class:`ProtocolError`
        synchronously instead of being dropped or finishing a healthy
        connection (spec 638 FM-638-7).

        Raises:
            ProtocolError: The frame is not JSON/UTF-8 encodable.
        """
        frame: Params = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            frame["params"] = params
        outcome = self._enqueue_write(frame)
        if outcome.done():
            rejection = outcome.exception()
            if isinstance(rejection, _UnencodableFrameError):
                raise rejection

        def on_done(done: asyncio.Future[None]) -> None:
            error = done.exception()
            if error is not None and not isinstance(error, _UnencodableFrameError):
                self._finish(error)

        outcome.add_done_callback(on_done)

    def on_server_request(self, handler: ServerRequestHandler) -> None:
        """Registers the handler for server-initiated requests."""
        self._server_request_handler = handler

    def on_notification(self, handler: NotificationHandler) -> None:
        """Registers the notification handler (arrival order preserved)."""
        self._notification_handler = handler

    def on_protocol_error(self, handler: ProtocolErrorHandler) -> None:
        """Registers the inbound framing/correlation violation handler."""
        self._protocol_error_handler = handler

    async def flush(self) -> None:
        """Waits for the write tail; rethrows a recorded write failure."""
        await asyncio.shield(self._write_tail)
        if self._write_failure is not None:
            raise self._write_failure

    def command(
        self,
        method: str,
        params: Params,
        *,
        command_id: str | None = None,
        max_attempts: int | None = None,
        retry_delay: RetryDelay | None = None,
    ) -> asyncio.Future[Params]:
        """Sends one logical command with the INV-013 ``commandId`` contract.

        Same-id retries on the FM-006 retryable pair (``backpressured`` /
        ``overloaded``) with the bounded full-jitter budget; a value-identical
        ack settles a replay; ``inputTooLarge`` (and every other error) is
        never auto-retried.

        Args:
            method: The command method.
            params: The command params, without ``commandId``.
            command_id: Reuse this id for a reconnect/replay of the same
                logical command.
            max_attempts: Total attempts, including the first (default 3).
            retry_delay: Injectable so deterministic tests do not sleep.

        Returns:
            A future for the ack object (eager: the first attempt is in
            flight when this returns) — or one already rejected, with NO
            attempt in flight, when the params are not JSON-serializable
            (:class:`ProtocolError`, FM-638-7 — the same settle-on-the-future
            posture as :meth:`request`) or the ``commandId`` is reused with a
            different payload.
        """
        # The prelude and the FIRST attempt run synchronously so the frame
        # joins the submit tail NOW: a command() immediately followed by
        # close() must still write it (PR #30094 review — a deferred task
        # enqueued nothing until the loop's next yield, silently dropping
        # the frame; request()/notify() already enqueue synchronously).
        cid = command_id if command_id is not None else self._mint_command_id()
        command_params = {**params, "commandId": cid}
        try:
            signature = _canonical({"method": method, "params": command_params})
        except (TypeError, ValueError):
            # A param json.dumps cannot serialize is the caller's defect
            # (FM-638-7), surfaced on the future this method promises — never
            # a raw synchronous TypeError. request() with the same params
            # rejects through _enqueue_write; the two surfaces must agree.
            # Nothing is stranded: no _commands entry, no request in flight
            # (PR #30094 review, round 18).
            rejected: asyncio.Future[Params] = self._loop.create_future()
            rejected.set_exception(
                _UnencodableFrameError("outbound frame is not JSON/UTF-8 encodable")
            )
            return rejected
        memory = self._commands.get(cid)
        if memory is not None and memory.signature != signature:
            outcome: asyncio.Future[Params] = self._loop.create_future()
            outcome.set_exception(
                ProtocolError(f"commandId {cid} was reused with a different payload")
            )
            return outcome
        remembered = memory if memory is not None else _CommandMemory(signature)
        self._commands[cid] = remembered
        first = self.request(method, command_params)
        return self._loop.create_task(
            self._command_impl(
                first, method, command_params, cid, remembered, max_attempts, retry_delay
            )
        )

    async def _command_impl(
        self,
        first: asyncio.Future[Params],
        method: str,
        command_params: Params,
        cid: str,
        remembered: _CommandMemory,
        max_attempts: int | None,
        retry_delay: RetryDelay | None,
    ) -> Params:
        attempts = max(1, 3 if max_attempts is None else max_attempts)
        delay = retry_delay if retry_delay is not None else _default_retry_delay
        pending = first
        for attempt in range(1, attempts + 1):
            try:
                ack = await pending
                # session/start and session/resume results omit the redundant
                # commandId echo (contracts/sdk-surface.md); one that carries
                # it must echo exactly (TEST-018).
                if "commandId" in ack and ack["commandId"] != cid:
                    raise ProtocolError(
                        f"{method} ack commandId {ack['commandId']} did not echo {cid}"
                    )
                if remembered.ack is not None and _canonical(
                    remembered.ack
                ) != _canonical(ack):
                    raise ProtocolError(
                        f"{method} replay for commandId {cid} did not return a "
                        "value-identical ack"
                    )
                remembered.ack = dict(ack)
                return ack
            except MspError as error:
                retryable_nothing_admitted = (
                    error.code == -32001 and error.kind == "overloaded"
                ) or (error.code == -32031 and error.kind == "backpressured")
                if not retryable_nothing_admitted or attempt == attempts:
                    raise
                await delay(attempt, error)
                pending = self.request(method, command_params)
        raise ProtocolError("unreachable command retry state")

    async def close(self) -> None:
        """Closes the connection without gating teardown on the peer.

        COMPLETION must not gate teardown — a peer that stopped reading
        never completes a write (#15943). SUBMISSION must: the submission
        tail goes TO the transport's optional ``close``, which waits for it
        inside its own shutdown budget; this class knows nothing about
        processes, signals, or timeouts. A close-less transport supplies no
        budget, so the connection finishes immediately there — rejecting
        in-flight requests and settling ``closed`` — which is all a
        transport that declared no bound can be held to.
        """
        tail = self._write_tail
        transport_close = getattr(self._transport, "close", None)
        if transport_close is not None:
            result = transport_close(self._submit_tail)
            if result is not None and hasattr(result, "__await__"):
                await result
            await asyncio.shield(tail)
        else:
            self._finish(ProtocolError("connection closed"))
        await asyncio.shield(self._closed)

    def _enqueue_write(self, frame: Params) -> asyncio.Future[None]:
        outcome: asyncio.Future[None] = self._loop.create_future()
        if self._finished:
            outcome.set_exception(ProtocolError("connection is closed"))
            return outcome
        try:
            # allow_nan=False so a NaN/Infinity float raises ValueError here
            # rather than emitting a bare `NaN`/`Infinity` token — invalid
            # JSON the Rust host cannot parse, which would leave the caller's
            # request hanging until EOF (FR-638-013; the TS twin coerces to
            # null). It joins the caller-defect settle below.
            line = json.dumps(
                frame, separators=(",", ":"), ensure_ascii=False, allow_nan=False
            ) + "\n"
            line.encode("utf-8")
        except (TypeError, ValueError, UnicodeEncodeError):
            # A frame this caller cannot serialize/encode — a non-JSON param
            # value (a Path, a set, a NaN float) or a lone surrogate smuggled
            # in via os.fsdecode — is the CALLER's defect, not transport death:
            # reject just this frame and leave the connection (and every
            # sibling in flight) alive. Detected here, the one outbound
            # boundary, so all three writers — request(), notify(), and the
            # server-request reply — get it (PR #30094 review; the TS twin
            # survives the same input).
            outcome.set_exception(
                _UnencodableFrameError("outbound frame is not JSON/UTF-8 encodable")
            )
            return outcome
        submitted: asyncio.Future[None] = self._loop.create_future()
        self._submit_tail = _both_done(self._loop, self._submit_tail, submitted)
        previous_tail = self._write_tail
        next_tail: asyncio.Future[None] = self._loop.create_future()
        self._write_tail = next_tail

        async def run() -> None:
            await asyncio.shield(previous_tail)
            try:
                if self._finished:
                    raise ProtocolError("connection is closed")
                # Scheduling the write task IS submission here (module doc).
                in_flight = self._loop.create_task(self._transport.write(line))
                if not submitted.done():
                    submitted.set_result(None)
                await in_flight
            except BaseException as error:  # noqa: BLE001 — the tail owns it
                # A frame that can never be submitted must not wedge close().
                if not submitted.done():
                    submitted.set_result(None)
                self._write_failure = error
                self._finish(error)
                if not outcome.done():
                    outcome.set_exception(error)
                return
            finally:
                if not next_tail.done():
                    next_tail.set_result(None)
            if not outcome.done():
                outcome.set_result(None)

        self._loop.create_task(run())
        return outcome

    async def _read_loop(self) -> None:
        try:
            async for chunk in self._transport.incoming:
                self._ingest(chunk)
            if not self._dropping_oversized and self._segments:
                self._protocol_error(
                    ProtocolError(
                        "inbound frame ended without a newline",
                        "".join(self._segments),
                    )
                )
            self._finish(ProtocolError("connection reached EOF"))
        except BaseException as error:  # noqa: BLE001 — finish carries it
            self._finish(error)

    def _ingest(self, chunk: str) -> None:
        remaining = chunk
        if self._dropping_oversized:
            newline = remaining.find("\n")
            if newline < 0:
                return
            self._dropping_oversized = False
            remaining = remaining[newline + 1 :]
        if not remaining:
            return
        self._segments.append(remaining)
        self._buffer_bytes += _utf8_len(remaining)
        # FR-638-011: the retained buffer is newline-free on entry (the drain
        # below runs to exhaustion), so only the fresh chunk can carry a
        # newline — ingest stays O(bytes), never a full-buffer rescan.
        if "\n" in remaining:
            buffer = "".join(self._segments)
            while True:
                newline = buffer.find("\n")
                if newline < 0:
                    break
                line = buffer[:newline]
                buffer = buffer[newline + 1 :]
                self._buffer_bytes -= _utf8_len(line) + 1
                self._line(line)
            self._segments = [buffer] if buffer else []
        if self._buffer_bytes > self._frame_limit_bytes:
            joined = "".join(self._segments)
            self._protocol_error(
                ProtocolError(
                    f"inbound frame exceeds {self._frame_limit_bytes} bytes",
                    _truncate_to_utf8_bytes(joined, self._frame_limit_bytes),
                )
            )
            self._segments = []
            self._buffer_bytes = 0
            self._dropping_oversized = True

    def _line(self, raw: str) -> None:
        line = raw[:-1] if raw.endswith("\r") else raw
        if not line.strip():
            return
        if _utf8_len(line) > self._frame_limit_bytes:
            self._protocol_error(
                ProtocolError(
                    f"inbound frame exceeds {self._frame_limit_bytes} bytes",
                    _truncate_to_utf8_bytes(line, self._frame_limit_bytes),
                )
            )
            return
        try:
            parsed = json.loads(line)
        except ValueError:
            self._protocol_error(
                ProtocolError("inbound frame is not valid JSON", line)
            )
            return
        if not isinstance(parsed, dict) or parsed.get("jsonrpc") != "2.0":
            self._protocol_error(
                ProtocolError("inbound frame is not a JSON-RPC 2.0 object", line)
            )
            return
        method = parsed.get("method")
        frame_id = parsed.get("id")
        if isinstance(method, str):
            if isinstance(frame_id, (str, int)) and not isinstance(frame_id, bool):
                if not isinstance(frame_id, int) or frame_id <= 0:
                    self._protocol_error(
                        ProtocolError(
                            "server request id must be a positive integer", line
                        )
                    )
                    return
                task = self._loop.create_task(self._server_request(parsed))

                def on_done(done: asyncio.Future[None]) -> None:
                    # A Ctrl-C that cancels the run cancels this handler task;
                    # `Future.exception()` would then raise CancelledError back
                    # into the callback and log a spurious traceback in the
                    # consumer's shutdown (PR #30094 review).
                    if done.cancelled():
                        return
                    error = done.exception()
                    if error is not None:
                        self._finish(error)

                task.add_done_callback(on_done)
                return
            if self._notification_handler is not None:
                self._notification_handler(parsed)
            return
        if not isinstance(frame_id, (str, int)) or isinstance(frame_id, bool):
            self._protocol_error(ProtocolError("response has no usable id", line))
            return
        self._response(parsed, frame_id, line)

    def _response(self, frame: Params, frame_id: RequestId, line: str) -> None:
        pending = self._pending.get(_request_key(frame_id))
        if pending is None:
            self._protocol_error(
                ProtocolError(f"response for unknown request id {frame_id}", line)
            )
            return
        if pending.future.done():
            # The caller cancelled its await (or an asyncio.wait_for timed
            # out): the request is abandoned, not unknown — the late reply is
            # dropped and the CONNECTION stays healthy (spec 638 Edge Cases:
            # cancellation is a consumer-side act and must not corrupt the
            # connection; PR #30094 review, thread 2 — settling a done future
            # raised InvalidStateError inside the read loop and tore
            # everything down).
            del self._pending[_request_key(frame_id)]
            return
        has_result = "result" in frame
        has_error = "error" in frame
        if has_result == has_error:
            # FR-638-013: the MATCHED caller must settle — with no local
            # timeout (INV-006) an unrejected caller would hang until EOF.
            violation = ProtocolError(
                "response must carry exactly one of result or error", line
            )
            del self._pending[_request_key(frame_id)]
            pending.future.set_exception(violation)
            self._protocol_error(violation)
            return
        del self._pending[_request_key(frame_id)]
        if has_result:
            result = frame.get("result")
            if not isinstance(result, dict):
                pending.future.set_exception(
                    ProtocolError("response result must be an object", line)
                )
                return
            pending.future.set_result(result)
            return
        error = frame.get("error")
        if (
            not isinstance(error, dict)
            or not isinstance(error.get("code"), int)
            or isinstance(error.get("code"), bool)
            or not isinstance(error.get("message"), str)
        ):
            pending.future.set_exception(
                ProtocolError("error response has an invalid error object", line)
            )
            return
        data = error.get("data")
        if not isinstance(data, dict) or not isinstance(data.get("kind"), str):
            pending.future.set_exception(
                ProtocolError("MSP error response has no data.kind", line)
            )
            return
        pending.future.set_exception(MspError(error))

    async def _server_request(self, request: Params) -> None:
        request_id = request["id"]
        try:
            if self._server_request_handler is None:
                raise MspError(
                    {
                        "code": -32601,
                        "message": f"method not found: {request['method']}",
                        "data": {"kind": "methodNotFound", "retryable": False},
                    }
                )
            result = await self._server_request_handler(request)
            # FM-009: a failed reply write finishes the connection; it must
            # not escape this fire-and-forget task as an unhandled exception.
            reply = self._enqueue_write(
                {"jsonrpc": "2.0", "id": request_id, "result": result}
            )
            reply.add_done_callback(
                lambda done: self._reply_done(request_id, done)
            )
        except MspError as typed:
            self._write_error_reply(request_id, typed)
        except Exception as error:  # noqa: BLE001 — mapped to -32603
            self._write_error_reply(
                request_id,
                MspError(
                    {
                        "code": -32603,
                        "message": str(error) or "server request handler failed",
                        "data": {"kind": "internal"},
                    }
                ),
            )

    def _write_error_reply(self, request_id: object, typed: MspError) -> None:
        reply = self._enqueue_write(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {
                    "code": typed.code,
                    "message": typed.message,
                    "data": typed.data,
                },
            }
        )
        reply.add_done_callback(
            lambda done: self._reply_done(request_id, done)
        )  # FM-009

    def _reply_done(self, request_id: object, done: asyncio.Future[None]) -> None:
        """FM-638-7 for reply writes, minus the caller-defect arm.

        A reply frame that cannot serialize/encode (a handler returned or
        raised a non-JSON value — a set, a lone surrogate) is the HANDLER's
        defect, not transport death: the peer is still waiting on this id, so
        answer it with a fixed-ASCII ``-32603`` instead of finishing the
        connection (the third writer after request()/notify()). The fallback
        frame cannot re-enter this arm because ``_line`` admits a server
        request only with a positive-INTEGER id, so ``request_id`` is always
        an int and the fallback is ASCII by construction (spec 638 FM-638-7).
        """
        error = done.exception()
        if error is None:
            return
        if isinstance(error, _UnencodableFrameError):
            fallback = self._enqueue_write(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32603,
                        "message": "server request handler produced a "
                        "non-encodable reply",
                        "data": {"kind": "internal"},
                    },
                }
            )
            fallback.add_done_callback(self._consume_reply_failure)
            return
        self._finish(error)

    def _consume_reply_failure(self, done: asyncio.Future[None]) -> None:
        error = done.exception()
        if error is not None:
            self._finish(error)

    def _protocol_error(self, error: ProtocolError) -> None:
        if self._protocol_error_handler is not None:
            self._protocol_error_handler(error)

    def _finish(self, reason: object) -> None:
        if self._finished:
            return
        self._finished = True
        error = (
            reason
            if isinstance(reason, BaseException)
            else ProtocolError(str(reason))
        )
        for pending in self._pending.values():
            if not pending.future.done():
                pending.future.set_exception(error)
        self._pending.clear()
        if not self._closed.done():
            self._closed.set_result(None)
