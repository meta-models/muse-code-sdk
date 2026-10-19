"""Inspect recovery: python recovery_observation.py session/resume '<params JSON>'.

Include the original commandId in params; this diagnostic never retries itself.
"""

import argparse
import asyncio
import json
from uuid import UUID

from muse_code import __version__
from muse_code.connection import (
    Connection,
    MspError,
    Params,
    discover_muse_bin,
    spawn_msp_connection,
)

COMMIT_UNKNOWN = "recoverySelectionCommitUnknown"
UNSUPPORTED = "recoveryUnavailable"
MODES = {"on", "off", "unknown"}
SOURCES = {"request", "retained", "legacyOmission", "hostPolicy", "unknown"}
QUALIFICATIONS = {"qualified", "unavailable", "notRequired", "unknown"}


def render(observation: object, session_id: str, command_id: str, reason: str | None = None) -> str:
    """Preserve open values, but make support claims only from a coherent snapshot."""
    fields = ("sessionId", "constructionId", "requestedMode", "effectiveMode", "effectiveSource", "qualification")
    valid = isinstance(observation, dict) and all(isinstance(observation.get(key), str) for key in fields)
    if valid:
        try:
            parsed = UUID(observation["constructionId"])
            valid = str(parsed) == observation["constructionId"] and parsed.version == 7 and observation["sessionId"] == session_id
            UUID(observation["sessionId"])
        except ValueError:
            valid = False
    snapshot = {key: observation[key] for key in fields} if valid else None
    recognized = False
    if snapshot:
        requested, effective = snapshot["requestedMode"], snapshot["effectiveMode"]
        source, qualification = snapshot["effectiveSource"], snapshot["qualification"]
        recognized = requested in MODES and effective in MODES and source in SOURCES and qualification in QUALIFICATIONS
        if source in {"request", "retained"}:
            recognized &= requested == effective and effective in {"on", "off"}
        if source == "legacyOmission":
            recognized &= requested == effective == "off"
        if qualification == "qualified":
            recognized &= effective == "on" and source != "unknown"
        if qualification == "notRequired":
            recognized &= effective == "off"
        if reason is not None:
            recognized &= qualification == "unavailable"
    result = {
        "sessionId": session_id, "commandId": command_id, "recoveryObservation": snapshot,
        "support": "recognized" if recognized else "unknown",
        "enhancedRecovery": "qualified" if recognized and snapshot["qualification"] == "qualified" else "unknown",
    }
    if reason == COMMIT_UNKNOWN:
        result["nextStep"] = (
            f"Retry later with the original command ID {command_id}. Preserve the unknown save outcome; "
            "inspect with session/read or use authorized stop."
        )
    elif reason == UNSUPPORTED:
        result["nextStep"] = (
            "Do not retry unchanged. Retain the evidence; inspect with session/read or use authorized stop. "
            "MSP cannot repair the unsupported setting."
        )
    return json.dumps(result, indent=2)


async def diagnose(connection: Connection, method: str, params: Params) -> str:
    """Open once, then inspect the current construction through a fresh read."""
    request = dict(params)
    command_id = request.pop("commandId")
    try:
        opened = await connection.command(method, request, command_id=command_id, max_attempts=1)
    except MspError as error:
        reason = error.data.get("reason")
        if error.code != -32603 or error.kind != "internal" or reason not in {COMMIT_UNKNOWN, UNSUPPORTED}:
            raise
        session_id = request.get("sessionId", error.data.get("sessionId"))
        observation = error.data.get("recoveryObservation") if error.data.get("sessionId") == session_id else None
        return render(observation, session_id, command_id, reason)
    session_id = opened["session"]["sessionId"]
    if request.get("sessionId", session_id) != session_id:
        return render(None, request["sessionId"], command_id)
    read = await connection.request("session/read", {
        "sessionId": session_id, "excludeItems": True,
    })
    observation = read.get("recoveryObservation") if read.get("session", {}).get("sessionId") == session_id else None
    return render(observation, session_id, command_id)


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("method", choices=["session/start", "session/resume"])
    parser.add_argument("params", type=json.loads, help="MSP params including the original commandId")
    parser.add_argument("--muse-bin", help="host binary; defaults to muse on PATH")
    args = parser.parse_args()
    handshake = await spawn_msp_connection(discover_muse_bin(args.muse_bin), args=["serve"])
    try:
        ready = await handshake.initialize({"clientInfo": {"name": "recovery_observation", "version": __version__}})
        print(await diagnose(ready.connection, args.method, args.params))
    finally:
        await handshake.close()


if __name__ == "__main__":
    asyncio.run(main())
