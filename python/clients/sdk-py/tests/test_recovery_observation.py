"""SDK diagnostic wire fixtures; host qualification also needs real producer messages."""

from __future__ import annotations

import asyncio
import copy
import json
import runpy
import sys
from pathlib import Path

import muse_code as sdk
import pytest
from muse_code import EXPECTED_SCHEMA_FINGERPRINT, load_transcript
from muse_code.connection import Connection, MspError

SESSION = "550e8400-e29b-41d4-a716-446655440000"
COMMAND = "0198f0ab-9999-7000-8000-0000000000c1"
CONSTRUCTION = "0198f0ab-2222-7000-8000-0000000000bb"
COMMIT = "recoverySelectionCommitUnknown"
UNSUPPORTED = "recoveryUnavailable"
OBSERVATION = {
    "sessionId": SESSION, "constructionId": CONSTRUCTION,
    "requestedMode": "on", "effectiveMode": "unknown",
    "effectiveSource": "unknown", "qualification": "unavailable",
}
# Provisional wire messages; bind to the real producer when it is available.
MESSAGES = (
    ("The recovery-setting save outcome is unknown. Retry later with the same command ID; "
     "session/read and authorized stop remain usable."),
    ("The saved recovery setting is unsupported and MSP cannot repair it. "
     "Do not retry unchanged; retain the evidence and use session/read or authorized stop."),
)


class WirePeer:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.inbox = asyncio.Queue()
        self.sent = []

    @property
    async def incoming(self):
        while (chunk := await self.inbox.get()) is not None:
            yield chunk

    async def write(self, chunk):
        request = json.loads(chunk)
        self.sent.append(request)
        method, reply = next(self.replies)
        assert request["method"] == method
        self.inbox.put_nowait(json.dumps({"jsonrpc": "2.0", "id": request["id"], **reply}) + "\n")

    async def close(self, flushed):
        await flushed
        self.inbox.put_nowait(None)


@pytest.fixture
def diagnose():
    return runpy.run_path(str(Path(__file__).parents[1] / "examples/recovery_observation.py"))["diagnose"]


async def invoke(diagnose, replies, method="session/resume"):
    peer = WirePeer(replies)
    connection = Connection(peer)
    try:
        # Failure-only cap: success is driven by the correlated wire reply.
        rendered = await asyncio.wait_for(diagnose(connection, method, {
            "commandId": COMMAND, "sessionId": SESSION, "recoveryMode": "on",
        }), timeout=10)
        assert rendered.startswith("{"), "the diagnostic must render the decoded recovery result"
        return json.loads(rendered), rendered, peer.sent
    finally:
        await connection.close()


def refusal(reason, message, observation=OBSERVATION):
    return {"error": {"code": -32603, "message": message, "data": {
        "kind": "internal", "reason": reason, "sessionId": SESSION,
        "recoveryObservation": copy.deepcopy(observation),
    }}}


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["session/start", "session/resume"])
@pytest.mark.parametrize("message", MESSAGES)
@pytest.mark.parametrize("reason", [COMMIT, UNSUPPORTED])
async def test_reason_alone_selects_one_next_step(diagnose, method, message, reason):
    result, rendered, sent = await invoke(diagnose, [(method, refusal(reason, message))], method)
    assert result["commandId"] == COMMAND
    assert result["recoveryObservation"] == OBSERVATION
    assert result["support"] == "recognized"
    assert result["enhancedRecovery"] == "unknown"
    step = result["nextStep"]
    assert "session/read" in step and "authorized stop" in step
    if reason == COMMIT:
        assert "Retry later with the original command ID" in step and COMMAND in step
        assert "Do not retry unchanged" not in rendered
        assert "cannot repair" not in rendered
    else:
        assert "Do not retry unchanged" in step and "Retain the evidence" in step
        assert "MSP cannot repair" in step
        assert "Retry later" not in rendered and "same command ID" not in rendered
    assert len(sent) == 1, "a refusal is rendered directly, without a retry or a replacement read"
    assert sent[0]["params"]["commandId"] == COMMAND


@pytest.mark.asyncio
async def test_ack_observation_never_substitutes_for_a_fresh_read(diagnose):
    stale = {**OBSERVATION, "effectiveMode": "on", "effectiveSource": "request", "qualification": "qualified"}
    fresh = {**OBSERVATION, "constructionId": "0198f0ab-3333-7000-8000-0000000000cc"}
    result, _, sent = await invoke(diagnose, [
        ("session/resume", {"result": {"session": {"sessionId": SESSION}, "recoveryObservation": stale}}),
        ("session/read", {"result": {"session": {"sessionId": SESSION}, "recoveryObservation": fresh}}),
    ])
    assert result["recoveryObservation"] == fresh
    assert result["enhancedRecovery"] == "unknown"
    assert "nextStep" not in result
    assert sent[1]["params"] == {"sessionId": SESSION, "excludeItems": True}


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["requestedMode", "effectiveMode", "effectiveSource", "qualification"])
async def test_future_values_survive_without_support_or_strength_claims(diagnose, field):
    observation = {**OBSERVATION, field: "future-value"}
    result, _, _ = await invoke(diagnose, [("session/resume", refusal(COMMIT, MESSAGES[0], observation))])
    assert result["recoveryObservation"][field] == "future-value"
    assert result["support"] == "unknown" and result["enhancedRecovery"] == "unknown"


@pytest.mark.asyncio
@pytest.mark.parametrize("observation", [
    None, {}, [], {**OBSERVATION, "requestedMode": None},
    {**OBSERVATION, "sessionId": "0198f0aa-1111-7000-8000-0000000000aa"},
    {**OBSERVATION, "constructionId": SESSION},
    *({**OBSERVATION, "constructionId": value} for value in (
        "{" + CONSTRUCTION + "}", CONSTRUCTION.replace("-", ""), CONSTRUCTION.upper(), "urn:uuid:" + CONSTRUCTION,
    )),
    {key: value for key, value in OBSERVATION.items() if key != "qualification"},
])
@pytest.mark.parametrize("reason", [COMMIT, UNSUPPORTED])
async def test_absent_malformed_or_unbound_observation_is_unknown(diagnose, observation, reason):
    result, _, _ = await invoke(diagnose, [("session/resume", refusal(reason, MESSAGES[0], observation))])
    assert result["support"] == "unknown" and result["enhancedRecovery"] == "unknown"
    assert result["recoveryObservation"] is None
    expected = "Retry later with the original command ID" if reason == COMMIT else "Do not retry unchanged"
    assert expected in result["nextStep"]


@pytest.mark.asyncio
@pytest.mark.parametrize("delta, support, expected", [
    ({"effectiveMode": "on", "effectiveSource": "request", "qualification": "qualified"}, "recognized", "qualified"),
    pytest.param(
        {"effectiveMode": "on", "effectiveSource": "retained", "qualification": "qualified"},
        "recognized", "qualified", id="retained-source",
    ),
    pytest.param(
        {"effectiveMode": "off", "effectiveSource": "hostPolicy", "qualification": "notRequired"},
        "recognized", "unknown", id="host-policy-source",
    ),
    pytest.param(
        {"effectiveMode": "on", "effectiveSource": "request", "qualification": "unknown"},
        "recognized", "unknown", id="unknown-qualification",
    ),
    pytest.param(
        {"effectiveMode": "on", "effectiveSource": "request", "qualification": "future-value"},
        "unknown", "unknown", id="future-qualification",
    ),
    ({"effectiveMode": "on", "effectiveSource": "unknown", "qualification": "qualified"}, "unknown", "unknown"),
    ({"requestedMode": "off", "effectiveMode": "off", "effectiveSource": "request", "qualification": "qualified"}, "unknown", "unknown"),
    ({"requestedMode": "unknown", "effectiveMode": "unknown", "effectiveSource": "request"}, "unknown", "unknown"),
    ({"effectiveMode": "off", "effectiveSource": "legacyOmission", "qualification": "notRequired"}, "unknown", "unknown"),
    ({"requestedMode": "off", "effectiveMode": "on", "effectiveSource": "retained", "qualification": "qualified"}, "unknown", "unknown"),
    ({"requestedMode": "off", "effectiveMode": "off", "effectiveSource": "legacyOmission", "qualification": "notRequired"}, "recognized", "unknown"),
    ({"effectiveMode": "on", "effectiveSource": "legacyOmission", "qualification": "qualified"}, "unknown", "unknown"),
    ({"effectiveMode": "on", "effectiveSource": "request", "qualification": "notRequired"}, "unknown", "unknown"),
])
async def test_strength_requires_a_coherent_recognized_observation(diagnose, delta, support, expected):
    observation = {**OBSERVATION, **delta}
    result, _, _ = await invoke(diagnose, [
        ("session/resume", {"result": {"session": {"sessionId": SESSION}}}),
        ("session/read", {"result": {"session": {"sessionId": SESSION}, "recoveryObservation": observation}}),
    ])
    assert result["support"] == support and result["enhancedRecovery"] == expected
    assert result["recoveryObservation"] == observation


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", [COMMIT, UNSUPPORTED])
async def test_refusal_cannot_claim_qualified_recovery(diagnose, reason):
    observation = {**OBSERVATION, "effectiveMode": "on", "effectiveSource": "request", "qualification": "qualified"}
    result, _, _ = await invoke(diagnose, [("session/resume", refusal(reason, MESSAGES[0], observation))])
    assert result["support"] == result["enhancedRecovery"] == "unknown"


@pytest.mark.asyncio
async def test_foreign_ack_cannot_trigger_a_read_or_establish_support(diagnose):
    result, _, sent = await invoke(diagnose, [("session/resume", {"result": {
        "session": {"sessionId": "550e8400-e29b-41d4-a716-446655440001"}, "recoveryObservation": OBSERVATION,
    }})])
    assert result["support"] == result["enhancedRecovery"] == "unknown"
    assert result["recoveryObservation"] is None and len(sent) == 1


@pytest.mark.asyncio
async def test_read_error_is_not_a_recovery_construction_observation(diagnose):
    with pytest.raises(MspError):
        await invoke(diagnose, [
            ("session/resume", {"result": {"session": {"sessionId": SESSION}}}),
            ("session/read", refusal(COMMIT, MESSAGES[0])),
        ])


@pytest.mark.asyncio
async def test_old_server_ignoring_input_does_not_establish_support(diagnose):
    result, _, _ = await invoke(diagnose, [
        ("session/resume", {"result": {"session": {"sessionId": SESSION}}}),
        ("session/read", {"result": {"session": {"sessionId": SESSION}}}),
    ])
    assert result["recoveryObservation"] is None
    assert result["support"] == result["enhancedRecovery"] == "unknown"


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", [COMMIT, UNSUPPORTED, None])
@pytest.mark.parametrize("explicit_binary", [False, True])
async def test_executable_diagnostic_uses_sdk_stdio_and_closes_its_child(tmp_path, monkeypatch, capsys, reason, explicit_binary):
    example = Path(__file__).parents[1] / "examples/recovery_observation.py"
    corpus = example.resolve().parents[3] / "schema/msp/transcripts/session-start"
    transcript = load_transcript(corpus)
    initialize = copy.deepcopy(next(frame["result"] for frame in transcript.server_frames
                                    if "schema" in frame.get("result", {})))
    initialize["schema"]["fingerprint"] = EXPECTED_SCHEMA_FINGERPRINT
    replies = {"initialize": {"result": initialize}}
    replies["session/resume"] = refusal(reason, MESSAGES[0]) if reason else {
        "result": {"session": {"sessionId": SESSION}}}
    replies["session/read"] = {"result": {"session": {"sessionId": SESSION},
                                         "recoveryObservation": OBSERVATION}}
    calls = tmp_path / "calls.jsonl"
    exited = tmp_path / "host-exited"
    host = tmp_path / ("fixture-host" if explicit_binary else "muse")
    host.write_text(f"#!{sys.executable}\n" + "import json, re, sys\nfrom pathlib import Path\n" +
                    f"replies = json.loads({json.dumps(replies)!r})\n" +
                    f"with open({str(calls)!r}, 'w') as calls:\n" +
                    " for line in sys.stdin:\n"
                    "  request = json.loads(line)\n"
                    "  calls.write(line); calls.flush()\n"
                    "  if 'id' in request:\n"
                    "   reply = replies[request['method']]\n"
                    "   if request['method'] == 'initialize' and not re.fullmatch('[a-z0-9_]+', request['params']['clientInfo']['name']):\n"
                    "    reply = {'error': {'code': -32602, 'message': 'clientInfo.name must be a machine identifier', 'data': {'kind': 'invalidParams'}}}\n"
                    "   print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], **reply}), flush=True)\n" +
                    f"Path({str(exited)!r}).write_text('exited')\n")
    host.chmod(0o700)
    argv = [str(example), "session/resume", json.dumps({
        "sessionId": SESSION, "commandId": COMMAND, "recoveryMode": "on",
    })]
    if explicit_binary:
        argv.extend(["--muse-bin", str(host)])
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(sys, "argv", argv)
    # Failure-only cap; main returns after its owned child's exit receipt.
    await asyncio.wait_for(runpy.run_path(str(example))["main"](), timeout=10)
    assert exited.read_text() == "exited", "main must await the owned host exit"
    result = json.loads(capsys.readouterr().out)
    assert result["recoveryObservation"] == OBSERVATION
    assert result["enhancedRecovery"] == "unknown"
    if reason:
        expected = "Retry later" if reason == COMMIT else "Do not retry unchanged"
        assert expected in result["nextStep"]
    else:
        assert "nextStep" not in result
    methods = [json.loads(line)["method"] for line in calls.read_text().splitlines()]
    assert methods == ["initialize", "initialized", "session/resume"] + ([] if reason else ["session/read"])


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["session/start", "session/resume"])
@pytest.mark.parametrize("mode", [None, "on", "off"])
async def test_facade_forwards_recovery_selection_or_omits_it(method, mode):
    result = {"session": {"sessionId": SESSION}, "viewCursor": "v:0"}
    if method == "session/resume":
        result.update(history={"mode": "none", "items": []}, pendingRequests=[])
    peer = WirePeer([(method, {"result": result})])
    client = sdk.MuseClient(Connection(peer), sdk.MuseClientOptions(
        durability=sdk.read_session_durability({"sessionDurability": "durable"}),
    ))
    try:
        pending = (
            client.start_session(sdk.StartSessionOptions(recovery_mode=mode))
            if method == "session/start" else
            client.resume_session(sdk.ResumeSessionOptions(SESSION, recovery_mode=mode))
        )
        # Failure-only cap: the correlated wire reply drives completion.
        await asyncio.wait_for(pending, timeout=10)
        assert len(peer.sent) == 1
        params = dict(peer.sent[0]["params"])
        assert params.pop("commandId"), "the connection must stamp the command"
        expected = {} if method == "session/start" else {"sessionId": SESSION}
        if mode is not None:
            expected["recoveryMode"] = mode
        assert params == expected
    finally:
        await client.close()
