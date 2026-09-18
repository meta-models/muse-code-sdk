"""The journey's provider-configured mode: a loopback fake first-party
endpoint plus the ``HOME`` that points ``muse serve`` at it — the Python twin
of ``clients/sdk-quickstart/src/provider.ts``.

It serves the same two routes with the same bodies, and the ``HOME`` it seeds
carries the same two files with the same shape:

- ``GET <base>/muse-code/models`` → one visible, dated row, so the host's
  default-model pick yields a model.
- ``POST <base>/responses`` → a text SSE turn, or ONE scripted ``bash`` tool
  call (see below).
- ``$HOME/.config/muse/settings.json`` → ``endpoint_transport`` at that base
  URL with ``auth: "bearer"``.
- ``$HOME/.config/muse/auth.json`` → a stored credential in the ``meta`` slot.

Nothing here reaches the network: the listener binds ``127.0.0.1:0`` and the
stored credential is a fixed dummy the fake never checks. There is no live
provider and no API key, so this mode is safe to run in CI on every PR.
"""

from __future__ import annotations

import json
import tempfile
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, List

FAKE_MODEL_ID = "fake-model"
"""The catalog's single model id."""

DUMMY_API_KEY = "quickstart-journey-dummy-key"
"""The stored credential. It is LOAD-BEARING that one exists at all — a
keyless rig makes the "credentialed" arm credential-independent — but its
value is never checked, so it is a fixed literal and not a secret."""

HOLD_S = 3.0
"""How long each completion is held open between its first delta and its
``response.completed`` — the TS ``HOLD_MS`` twin, same rationale verbatim:
the ``cancel`` segment asserts a RUNNING turn can be cancelled, and an
endpoint that answers instantly turns that into a race the journey loses
intermittently (the turn reaches terminal before ``turn/cancel`` is admitted
and the host rejects the cancel with ``already_terminal``). The hold removes
the race at the source; 3s buys a ~30x margin over the host's own ~100ms
window while keeping the ``turn`` segment near 15s of its 60s budget.
A HARNESS pacing constant, not a test wait: the journey's own budgets are
failure caps and none of them sleeps on this."""


def _sse(value: Any) -> bytes:
    return f"data: {json.dumps(value)}\n\n".encode()


def _catalog_body() -> bytes:
    """One visible, dated row so the host's default-model pick succeeds."""
    return json.dumps(
        {
            "object": "list",
            "data": [
                {
                    "id": FAKE_MODEL_ID,
                    "object": "model",
                    "metadata": {
                        "muse-code": {
                            "release_date": "2026-01-01",
                            "is_hidden": False,
                            "limit": {"context": 1_000_000, "output": 1024},
                        }
                    },
                }
            ],
        }
    ).encode()


def _response_frame(frame_id: str, status: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": frame_id,
        "object": "response",
        "model": FAKE_MODEL_ID,
        "status": status,
        "output": [],
        **extra,
    }


def _completion_head(text: str) -> bytes:
    """The head of a completion: created, then the one content-bearing event."""
    return _sse(
        {
            "type": "response.created",
            "sequence_number": 1,
            "response": _response_frame("resp_journey_text", "in_progress"),
        }
    ) + _sse(
        {
            "type": "response.output_text.delta",
            "sequence_number": 2,
            "output_index": 0,
            "item_id": "msg_journey_text",
            "content_index": 0,
            "delta": text,
        }
    )


def _tool_call_head(call_id: str, command: str) -> bytes:
    """The head of the scripted ``bash`` tool call (serve composes exec's
    managed shell tool family: the model-visible tool is ``bash``, whose
    strict schema also requires ``description``)."""
    return _sse(
        {
            "type": "response.created",
            "sequence_number": 1,
            "response": _response_frame("resp_journey_tool", "in_progress"),
        }
    ) + _sse(
        {
            "type": "response.function_call_arguments.done",
            "sequence_number": 2,
            "output_index": 0,
            "item_id": f"fc_{call_id}",
            "name": "bash",
            "call_id": call_id,
            "arguments": json.dumps(
                {"command": command, "description": "Write the approval artifact"}
            ),
        }
    )


def _completion_tail(frame_id: str) -> bytes:
    return _sse(
        {
            "type": "response.completed",
            "sequence_number": 3,
            "response": _response_frame(
                frame_id,
                "completed",
                usage={"input_tokens": 1, "output_tokens": 1, "total_tokens": 2},
            ),
        }
    )


@dataclass(frozen=True)
class FakeProviderOptions:
    """See the TS twin, verbatim semantics.

    Attributes:
        scripted_tool_call_when: Substrings that appear together in the
            completion request body of the ONE turn that should get the
            scripted tool call. Routing by CONTENT rather than by request
            index is load-bearing: a serve turn also drives the reminder
            plugins' own child sessions against this same endpoint, and one
            of those lands FIRST.
        scripted_tool_call_command: The command the scripted ``bash`` tool
            call asks to run.
        reply_text: The text every other completion answers with.
    """

    scripted_tool_call_when: tuple[str, ...]
    scripted_tool_call_command: str
    reply_text: str


class ConfiguredProvider:
    """A running fake endpoint and the ``HOME`` configured to talk to it.

    The caller owns this handle and MUST :meth:`close` it.

    Attributes:
        home: The seeded ``HOME`` to hand the journey.
        base_url: The loopback base URL the seeded ``HOME`` points at.
    """

    def __init__(self, options: FakeProviderOptions) -> None:
        """Starts the listener and seeds the ``HOME``."""
        self._options = options
        self._lock = threading.Lock()
        self._catalog_gets = 0
        self._scripted_tool_calls = 0
        self._closing = threading.Event()
        provider = self

        class _Handler(BaseHTTPRequestHandler):
            # Silence the default per-request stderr line.
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return

            def do_GET(self) -> None:  # noqa: N802 - http.server's own name
                if self.path.endswith("/muse-code/models"):
                    with provider._lock:
                        provider._catalog_gets += 1
                    body = _catalog_body()
                    self.send_response(200)
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

            def do_POST(self) -> None:  # noqa: N802 - http.server's own name
                length = int(self.headers.get("content-length", "0"))
                body = self.rfile.read(length).decode("utf-8", errors="replace")
                # Once-only, content-routed: see FakeProviderOptions and
                # scripted_tool_calls for why both halves are load-bearing.
                with provider._lock:
                    is_scripted = provider._scripted_tool_calls == 0 and all(
                        needle in body
                        for needle in provider._options.scripted_tool_call_when
                    )
                    if is_scripted:
                        provider._scripted_tool_calls += 1
                        call_index = provider._scripted_tool_calls
                if is_scripted:
                    response_id = "resp_journey_tool"
                    head = _tool_call_head(
                        f"call_journey_{call_index}",
                        provider._options.scripted_tool_call_command,
                    )
                else:
                    response_id = "resp_journey_text"
                    head = _completion_head(provider._options.reply_text)

                try:
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(head)
                    self.wfile.flush()
                    # The hold (see HOLD_S). close() releases every in-flight
                    # hold at once, so teardown is never blocked by one.
                    provider._closing.wait(HOLD_S)
                    if not provider._closing.is_set():
                        self.wfile.write(_completion_tail(response_id))
                except (BrokenPipeError, ConnectionResetError, OSError):
                    # A cancelled turn aborts the request; finishing a dead
                    # response is a no-op, not an error.
                    return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        # Threads must not outlive close(): the hold releases on the closing
        # event and the server joins its handler threads on shutdown.
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )
        self._thread.start()
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"

        self.home = tempfile.mkdtemp(prefix="muse-quickstart-provider-home-")
        config_dir = Path(self.home) / ".config" / "muse"
        config_dir.mkdir(parents=True)
        (config_dir / "settings.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "endpoint_transport": {"base_url": self.base_url, "auth": "bearer"},
                },
                indent=2,
            )
            + "\n"
        )
        (config_dir / "auth.json").write_text(
            json.dumps(
                {"schema_version": 1, "providers": {"meta": {"api_key": DUMMY_API_KEY}}}
            )
            + "\n"
        )

    def catalog_gets(self) -> int:
        """How many times the model catalog was fetched."""
        with self._lock:
            return self._catalog_gets

    def scripted_tool_calls(self) -> int:
        """How many scripted tool calls were served — AT MOST ONE by this
        harness's own contract: after the approval segment's turn, its
        artifact name is in the replayed history of every later turn, so a
        content match with no once-only guard hands the ``cancel`` segment a
        tool call too and parks it on an approval nobody answers."""
        with self._lock:
            return self._scripted_tool_calls

    def close(self) -> None:
        """Stop the listener and release every in-flight hold."""
        self._closing.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=10)


def start_configured_provider(options: FakeProviderOptions) -> ConfiguredProvider:
    """Start the loopback endpoint and seed a ``HOME`` that points at it."""
    return ConfiguredProvider(options)
