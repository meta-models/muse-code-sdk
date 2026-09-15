"""In-memory duplex harness for the connection suites (port of the TS
``FakeDuplex``/``AsyncChunks`` pair in ``clients/sdk-ts/test``).

Causal, never time-based (#25315): waits are event-loop yields
(``asyncio.sleep(0)`` turns, the Python twin of the TS microtask/macrotask
pumps), bounded by turn counts — no wall-clock sleeps anywhere.
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

Params = dict[str, Any]

# Failure-path bound only: green paths settle in a handful of turns.
MAX_TURNS = 400


class AsyncChunks:
    """An awaitable chunk queue: push chunks, end() signals EOF."""

    def __init__(self) -> None:
        self._chunks: list[str] = []
        self._waiters: list[asyncio.Future[Any]] = []
        self._ended = False

    def push(self, chunk: str) -> None:
        """Delivers one chunk to the reader (immediately if it awaits)."""
        if self._waiters:
            self._waiters.pop(0).set_result(("chunk", chunk))
        else:
            self._chunks.append(chunk)

    def end(self) -> None:
        """Signals EOF to the reader."""
        self._ended = True
        for waiter in self._waiters:
            waiter.set_result(("end", None))
        self._waiters.clear()

    def __aiter__(self) -> AsyncIterator[str]:
        return self._iterate()

    async def _iterate(self) -> AsyncIterator[str]:
        while True:
            if self._chunks:
                yield self._chunks.pop(0)
                continue
            if self._ended:
                return
            waiter: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
            self._waiters.append(waiter)
            kind, value = await waiter
            if kind == "end":
                return
            yield value


class FakeDuplex:
    """The transport-less in-memory duplex the connection suites drive."""

    def __init__(self) -> None:
        self.chunks = AsyncChunks()
        self.writes: list[str] = []

    @property
    def incoming(self) -> AsyncChunks:
        """The inbound chunk stream."""
        return self.chunks

    async def write(self, chunk: str) -> None:
        """Records the outgoing frame line."""
        self.writes.append(chunk)

    async def close(self, flushed: object = None) -> None:
        """Ends the inbound stream (EOF), like the TS fake.

        Honors the DuplexTransport contract first: a closing transport waits
        for accepted frames' SUBMISSION before ending the peer's input —
        without this, the fake's instant inbound EOF finishes the connection
        before an accepted write's task ever runs, a failure no real
        process-owning transport exhibits (PR #30094 review, thread 20).
        """
        if flushed is not None and hasattr(flushed, "__await__"):
            await flushed
        self.chunks.end()


class BrokenWriteDuplex:
    """Writes always fail, like a child dead mid-approval (FM-009)."""

    def __init__(self) -> None:
        self.chunks = AsyncChunks()

    @property
    def incoming(self) -> AsyncChunks:
        """The inbound chunk stream."""
        return self.chunks

    async def write(self, chunk: str) -> None:
        """Always raises, as a broken pipe would."""
        raise OSError("EPIPE: broken pipe")

    async def close(self, flushed: object = None) -> None:
        """Ends the inbound stream."""
        self.chunks.end()


def frame(value: Params) -> str:
    """One newline-terminated JSON frame line (raw UTF-8, like the wire)."""
    import json

    return json.dumps(value, ensure_ascii=False) + "\n"


async def pump(turns: int = 10) -> None:
    """Yields the event loop ``turns`` times (the TS macrotask pump twin)."""
    for _ in range(turns):
        await asyncio.sleep(0)


async def wait_for_writes(transport: FakeDuplex, count: int) -> None:
    """Yields until the transport recorded ``count`` writes, bounded."""
    for _ in range(MAX_TURNS):
        if len(transport.writes) >= count:
            break
        await asyncio.sleep(0)
    assert len(transport.writes) == count, (
        f"expected {count} write(s), got {len(transport.writes)}"
    )


def sent_frame(transport: FakeDuplex, index: int) -> Params:
    """The ``index``-th outbound frame, parsed (the TS ``sentFrame`` twin)."""
    import json

    return dict(json.loads(transport.writes[index]))


def sent_params(transport: FakeDuplex, index: int) -> Params:
    """The ``index``-th outbound frame's ``params`` object."""
    params = sent_frame(transport, index).get("params")
    assert isinstance(params, dict), f"write {index} carries no params object"
    return params


def answer(transport: FakeDuplex, index: int, result: Params) -> None:
    """Answer the ``index``-th outbound request with ``result`` on its own id
    (the TS ``answer`` twin)."""
    request_id = sent_frame(transport, index)["id"]
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": request_id, "result": result}))


def answer_error(transport: FakeDuplex, index: int, error: Params) -> None:
    """Answer the ``index``-th outbound request with ``error`` on its own id."""
    request_id = sent_frame(transport, index)["id"]
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": request_id, "error": error}))


async def _await_io(io: Any) -> Any:
    return await io


async def settled_io(io: Any) -> Any:
    """Awaits an ``io`` channel within bounded loop turns (#25315).

    A missed settlement fails ITS OWN test with a message instead of hanging
    the suite into the CI job wall — the same posture as ``settlement``,
    which this routes through.
    """
    state, value = await settlement(asyncio.ensure_future(_await_io(io)))
    if state == "rejected":
        raise AssertionError(f"io rejected, violating its contract: {value!r}")
    assert state == "resolved", "io did not settle within the turn bound"
    return value


async def settlement(
    future: asyncio.Future[Any], turns: int = MAX_TURNS
) -> tuple[str, Any]:
    """Observes a future's settlement within bounded loop turns.

    Returns:
        ``("pending", None)``, ``("resolved", value)``, or
        ``("rejected", error)`` — never hangs the suite.
    """
    for _ in range(turns):
        if future.done():
            break
        await asyncio.sleep(0)
    if not future.done():
        return ("pending", None)
    error = future.exception()
    if error is not None:
        return ("rejected", error)
    return ("resolved", future.result())
