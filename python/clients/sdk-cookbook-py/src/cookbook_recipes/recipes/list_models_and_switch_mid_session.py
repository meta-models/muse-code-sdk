"""Recipe twin: list models and switch mid-session.

Runs against the release-built ``muse serve`` binary with no credentials: the
model catalog composes its bundled rows logged out, so listing and switching
are fully headless. Actually RUNNING a turn on the chosen model needs a real
provider — out of scope here, and the docs page says so.

What it teaches: a fresh logged-out session really starts with
``modelId: null`` (no durable selection record until one lands);
``model/list`` is a QUERY whose rows carry everything a picker renders, with
``isActive`` flagging the session's effective model; ``session/setModel`` is
a COMMAND whose ack means admitted — the durable ``session/modelChanged``
notification means it happened; and verification is a read, not a memory.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from typing import Any, Mapping

from muse_code import Session, read_session_durability

from ..kit import (
    array_at,
    equals,
    Host,
    HostOptions,
    JourneyReport,
    object_at,
    require_host,
    run_journey,
    Segment,
    string_at,
    within,
)
from ..runner import Recipe, RecipeHosts

HANDSHAKE_BUDGET_MS = 30_000
COMMAND_BUDGET_MS = 30_000
CLOSE_BUDGET_MS = 30_000


@dataclass(frozen=True)
class CatalogRow:
    """One catalog row, narrowed to the members this recipe reads."""

    provider_id: str
    model_id: str
    display_label: str
    is_active: bool


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    muse_bin: str
    host: Host | None = None
    session_id: str | None = None
    startup_provider_id: str | None = None
    startup_model_id: str | None = None
    startup_read: bool = False
    target: CatalogRow | None = None


def _catalog_rows(result: Mapping[str, Any]) -> list[CatalogRow]:
    """Narrow the untyped ``model/list`` rows, failing with the row's index."""
    rows: list[CatalogRow] = []
    for index, row in enumerate(array_at(result, "models", "model/list result")):
        where = f"model/list row {index}"
        if not isinstance(row, dict):
            raise AssertionError(f"{where} is not an object")
        is_active = row.get("isActive")
        if not isinstance(is_active, bool):
            raise AssertionError(f'{where}: "isActive" is not a boolean (got {is_active!r})')
        rows.append(
            CatalogRow(
                provider_id=string_at(row, "providerId", where),
                model_id=string_at(row, "modelId", where),
                display_label=string_at(row, "displayLabel", where),
                is_active=is_active,
            )
        )
    return rows


def _nullable_string(value: Mapping[str, Any], key: str, where: str) -> str | None:
    member = value.get(key)
    if member is not None and not isinstance(member, str):
        raise AssertionError(f'{where}: "{key}" is neither a string nor null (got {member!r})')
    return member


async def _spawn(context: Context) -> None:
    context.host = await Host.start(
        HostOptions(
            muse_bin=context.muse_bin,
            home=tempfile.mkdtemp(prefix="muse-cookbook-home-"),
            workspace_root=tempfile.mkdtemp(prefix="muse-cookbook-ws-"),
            client_info={"name": "muse_sdk_cookbook_py", "version": "0.0.0"},
        ),
        HANDSHAKE_BUDGET_MS,
    )


async def _session(context: Context) -> None:
    host = require_host(context.host, "spawn")
    result = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/start",
        {"workspaceRoot": tempfile.mkdtemp(prefix="muse-cookbook-session-ws-")},
        max_attempts=1,
    ))
    session = object_at(result, "session", "session/start result")
    equals(session.get("status"), "idle", "a fresh session's status")
    context.session_id = string_at(session, "sessionId", "session/start session")
    # Verbatim, nulls included. A fresh logged-out session has no durable
    # model-selection record yet: modelId is null until a selection lands —
    # the state this recipe switches OUT of.
    context.startup_provider_id = _nullable_string(session, "providerId", "session/start session")
    context.startup_model_id = _nullable_string(session, "modelId", "session/start session")
    context.startup_read = True


async def _list_models(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session_id = context.session_id
    if session_id is None or not context.startup_read:
        raise RuntimeError("`session` did not finish")
    # A query, not a command: request, no commandId. Passing the sessionId is
    # what makes isActive meaningful for THIS session.
    result = await within("the model/list reply", COMMAND_BUDGET_MS, host.connection.request("model/list", {"sessionId": session_id}))
    rows = _catalog_rows(result)
    if not rows:
        raise AssertionError("the bundled catalog served no rows; nothing to switch to")

    # "Is this row the session's current model?" — written once so the sanity
    # check and the target pick cannot quietly disagree. With no selection
    # yet, no row is current.
    def is_current_model(row: CatalogRow) -> bool:
        return (
            context.startup_model_id is not None
            and row.model_id == context.startup_model_id
            and row.provider_id == context.startup_provider_id
        )

    # isActive is a projection of the session's effective model, not an
    # independent opinion.
    for row in rows:
        if row.is_active and not is_current_model(row):
            raise AssertionError(
                f"catalog row {row.provider_id}/{row.model_id} is flagged active "
                f"but the session's model is "
                f"{context.startup_provider_id}/{context.startup_model_id}"
            )
    # Any row that is not already the effective model is a real switch; a
    # fresh session has no effective model, so even a single-row catalog
    # gives a genuine state change.
    target = next((row for row in rows if not is_current_model(row)), None)
    if target is None:
        raise AssertionError(
            f"every one of the {len(rows)} catalog rows is already the "
            "session's model; nothing to switch to"
        )
    context.target = target


async def _switch(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session_id = context.session_id
    target = context.target
    if session_id is None or target is None:
        raise RuntimeError("`list-models` did not finish")
    # A command this time: Connection.command mints the commandId and verifies
    # the ack's echo. The ack says ADMITTED — the durable record it produces
    # is the next segment's frame.
    ack = await within("the session/setModel ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/setModel",
        {
            "sessionId": session_id,
            "model": {"providerId": target.provider_id, "modelId": target.model_id},
        },
        max_attempts=1,
    ))
    equals(ack.get("status"), "accepted", "session/setModel ack status")


async def _model_changed(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session_id = context.session_id
    target = context.target
    if session_id is None or target is None:
        raise RuntimeError("`switch` did not finish")
    # Matched on the target model AND the user source, not just the method: a
    # host is free to fold selection records of its own, and a
    # client-initiated session/setModel folds as source "user" — that pair
    # identifies this switch's record.
    changed = await host.wait_for(
        "the user-sourced session/modelChanged notification for the switched model",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "session/modelChanged"
        and n.params.get("sessionId") == session_id
        and n.params.get("modelId") == target.model_id
        and n.params.get("source") == "user",
    )
    equals(changed.params.get("providerId"), target.provider_id, "the changed model's provider")


async def _fold(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session_id = context.session_id
    target = context.target
    if session_id is None or target is None:
        raise RuntimeError("`switch` did not finish")
    # What a real client does with these frames: fold them. The SDK's Session
    # keeps the latest value per session-state family, so after the switch
    # the session/modelChanged slot holds the new selection.
    session: Session[Any] = Session(
        session_id, read_session_durability(host.msp.initialize_result)
    )
    for notification in host.notifications():
        if notification.params.get("sessionId") != session_id:
            continue
        session.apply({"method": notification.method, "params": dict(notification.params)})
    folded = session.fold.session_state.get("session/modelChanged")
    if folded is None:
        raise AssertionError("the fold holds no session/modelChanged value after the switch")
    equals(folded.get("modelId"), target.model_id, "the folded model change's modelId")
    equals(folded.get("providerId"), target.provider_id, "the folded model change's providerId")


async def _verify(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session_id = context.session_id
    target = context.target
    if session_id is None or target is None:
        raise RuntimeError("`switch` did not finish")
    # Verification is a read, not a memory: session/read serves the session
    # as folded from its durable records.
    read = await within("the session/read reply", COMMAND_BUDGET_MS, host.connection.request("session/read", {"sessionId": session_id}))
    session = object_at(read, "session", "session/read result")
    equals(session.get("providerId"), target.provider_id, "the read-back session's providerId")
    equals(session.get("modelId"), target.model_id, "the read-back session's modelId")
    # ...and the catalog agrees: the switched row is the active one now.
    relisted = _catalog_rows(
        await within("the model/list reply", COMMAND_BUDGET_MS, host.connection.request("model/list", {"sessionId": session_id}))
    )
    active = [row for row in relisted if row.is_active]
    if not active:
        raise AssertionError("no catalog row is flagged active after the switch")
    for row in active:
        if (row.provider_id, row.model_id) != (target.provider_id, target.model_id):
            raise AssertionError(
                f"catalog row {row.provider_id}/{row.model_id} is flagged active "
                f"after switching to {target.provider_id}/{target.model_id}"
            )


async def _drain(context: Context) -> None:
    host = require_host(context.host, "spawn")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the host's exit code after stdin EOF")
    classification = await host.msp.child.exit
    equals(classification.kind, "cleanShutdown", "the SDK's exit classification")
    context.host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment("spawn", "Spawn the release-built host and complete the handshake", _spawn),
    Segment("session", "Start a session and read the model members it started with", _session),
    Segment("list-models", "List the catalog and pick the row to switch to", _list_models),
    Segment("switch", "Switch the session's model and read the admission ack", _switch),
    Segment("model-changed", "Observe the durable session/modelChanged notification", _model_changed),
    Segment("fold", "Fold the notifications and read the change off sessionState", _fold),
    Segment("verify", "Read the session back and re-list: both report the new model", _verify),
    Segment("drain", "Close stdin and let the host exit cleanly", _drain),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.muse_bin is None:
        raise ValueError("muse_bin is required")
    context = Context(muse_bin=hosts.muse_bin)

    async def teardown(owned: Context) -> None:
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="list-models-and-switch-mid-session",
    title="List models and switch mid-session",
    docs_page="developer-docs/src/content/docs/cookbook/list-models-and-switch-mid-session.mdx",
    needs=("muse_bin",),
    run=_run,
)
