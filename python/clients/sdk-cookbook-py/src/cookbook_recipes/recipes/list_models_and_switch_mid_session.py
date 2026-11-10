"""Recipe twin: list models and switch mid-session.

Runs against the release-built ``muse serve`` binary with no credentials: the
model catalog composes its bundled rows logged out, so listing and switching
are fully headless. Actually RUNNING a turn on the chosen model needs a real
provider — out of scope here, and the docs page says so.

What it teaches, all through the SDK facade (``MuseClient.spawn``,
``start_session``, ``list_models``, ``Session.set_model``, and the session's
own fold): a fresh logged-out session really starts with ``modelId: null``
(no durable selection record until one lands); ``list_models`` is a QUERY
whose rows carry everything a picker renders, with ``isActive`` flagging the
session's effective model; ``set_model`` is a COMMAND whose ack means
admitted — the durable ``session/modelChanged`` record means it happened, and
the session ``MuseClient`` hands back folds it for you; and verification is a
read, not a memory.
"""

from __future__ import annotations

import asyncio
import tempfile
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, TypeVar

from muse_code import MuseClient, MuseClientSpawnOptions, Session, StartSessionOptions

from ..kit import (
    array_at,
    equals,
    HOST_DRAIN_WINDOW_MS,
    isolated_host_env,
    JourneyReport,
    object_at,
    run_journey,
    Segment,
    string_at,
    TimeoutBudgetError,
    within,
)
from ..runner import Recipe, RecipeHosts

HANDSHAKE_BUDGET_MS = 30_000
COMMAND_BUDGET_MS = 30_000
CLOSE_BUDGET_MS = 30_000

_T = TypeVar("_T")


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
    client: "MuseClient[Any] | None" = None
    session: "Session[Any] | None" = None
    startup_provider_id: str | None = None
    startup_model_id: str | None = None
    startup_read: bool = False
    target: CatalogRow | None = None


def _catalog_rows(result: Mapping[str, Any]) -> list[CatalogRow]:
    """Check the ``list_models`` rows at run time, failing with the row's
    index: the SDK types the result, but it does not validate what the host
    sent."""
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


async def _until_folded(what: str, budget_ms: int, probe: Callable[[], _T | None]) -> _T:
    """Re-check the session's fold until ``probe`` finds what it wants.

    The facade folds every frame but has no state-change hook, so a short
    bounded re-check is the wait; the budget is a failure cap, not pacing.
    """
    deadline = time.monotonic() + budget_ms / 1000
    while True:
        found = probe()
        if found is not None:
            return found
        if time.monotonic() > deadline:
            raise TimeoutBudgetError(what, budget_ms)
        # Polls because Session has no fold-change event yet (an SDK
        # follow-up tracks adding one).
        await asyncio.sleep(0.025)


def _folded_model_change(session: "Session[Any]") -> Mapping[str, Any] | None:
    """The fold's ``session/modelChanged`` slot, ``None`` when it holds none."""
    record = session.fold.session_state.get("session/modelChanged")
    return record if isinstance(record, Mapping) else None


def _require_client(context: Context) -> "MuseClient[Any]":
    if context.client is None:
        raise RuntimeError("`spawn` did not finish")
    return context.client


def _require_switch(context: Context) -> tuple["Session[Any]", CatalogRow]:
    if context.session is None or context.target is None:
        raise RuntimeError("`switch` did not finish")
    return context.session, context.target


async def _spawn(context: Context) -> None:
    context.client = await within(
        "the host's spawn and MSP handshake",
        HANDSHAKE_BUDGET_MS,
        MuseClient.spawn(
            MuseClientSpawnOptions(
                muse_bin=context.muse_bin,
                args=("serve",),
                cwd=tempfile.mkdtemp(prefix="muse-cookbook-ws-"),
                env=isolated_host_env(tempfile.mkdtemp(prefix="muse-cookbook-home-")),
                client_info={"name": "muse_sdk_cookbook_py", "version": "0.0.0"},
                # The kit's owned drain window, so the drain bound and the
                # SDK's actual window cannot drift apart.
                shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
            )
        ),
    )


async def _session(context: Context) -> None:
    client = _require_client(context)
    session = await within(
        "session/start",
        COMMAND_BUDGET_MS,
        client.start_session(
            StartSessionOptions(workspace_root=tempfile.mkdtemp(prefix="muse-cookbook-session-ws-"))
        ),
    )
    context.session = session
    opening = session.opening
    if opening is None or opening.verb != "session/start":
        raise AssertionError("the session did not open through session/start")
    info = object_at(opening.result, "session", "session/start result")
    equals(info.get("status"), "idle", "a fresh session's status")
    # Verbatim, nulls included. A fresh logged-out session has no durable
    # model-selection record yet: modelId is null until a selection lands —
    # the state this recipe switches OUT of.
    context.startup_provider_id = _nullable_string(info, "providerId", "session/start session")
    context.startup_model_id = _nullable_string(info, "modelId", "session/start session")
    context.startup_read = True


async def _list_models(context: Context) -> None:
    client = _require_client(context)
    session = context.session
    if session is None or not context.startup_read:
        raise RuntimeError("`session` did not finish")
    # A query, not a command: no commandId. Passing the sessionId is what
    # makes isActive meaningful for THIS session.
    rows = _catalog_rows(
        await within(
            "the model/list reply",
            COMMAND_BUDGET_MS,
            client.list_models({"sessionId": session.session_id}),
        )
    )
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
    session = context.session
    target = context.target
    if session is None or target is None:
        raise RuntimeError("`list-models` did not finish")
    # A command this time: the SDK mints the commandId and verifies the ack's
    # echo. The ack says ADMITTED — the durable record it produces is the
    # next segment's evidence.
    ack = await within(
        "the session/setModel ack",
        COMMAND_BUDGET_MS,
        session.set_model({"providerId": target.provider_id, "modelId": target.model_id}),
    )
    equals(ack.get("status"), "accepted", "session/setModel ack status")


async def _model_changed(context: Context) -> None:
    session, target = _require_switch(context)

    # Matched on the target model AND the user source, not just the family: a
    # host is free to land selection records of its own, and a
    # client-initiated set_model folds as source "user" — that pair
    # identifies this switch's record. The host writes it right after the
    # ack, so it may not have arrived the moment set_model returns.
    def user_switch() -> Mapping[str, Any] | None:
        record = _folded_model_change(session)
        if (
            record is not None
            and record.get("source") == "user"
            and record.get("modelId") == target.model_id
        ):
            return record
        return None

    changed = await _until_folded(
        "the user-sourced session/modelChanged record for the switched model",
        COMMAND_BUDGET_MS,
        user_switch,
    )
    equals(changed.get("providerId"), target.provider_id, "the changed model's provider")


async def _fold(context: Context) -> None:
    session, target = _require_switch(context)
    if not context.startup_read:
        raise RuntimeError("`session` did not finish")
    # What a UI reads when it renders: the fold keeps the latest value per
    # session-state family, so the session/modelChanged slot now holds the
    # new selection — no listener of yours was needed to put it there.
    folded = _folded_model_change(session)
    if folded is None:
        raise AssertionError("the fold holds no session/modelChanged value after the switch")
    equals(folded.get("modelId"), target.model_id, "the folded model change's modelId")
    equals(folded.get("providerId"), target.provider_id, "the folded model change's providerId")
    # And it moved: the slot no longer says what the session started with.
    if (folded.get("modelId"), folded.get("providerId")) == (
        context.startup_model_id,
        context.startup_provider_id,
    ):
        raise AssertionError("the folded selection is still the model the session started with")


async def _verify(context: Context) -> None:
    client = _require_client(context)
    session, target = _require_switch(context)
    session_id = session.session_id
    # Verification is a read, not a memory: session/read serves the session
    # as folded from its durable records. The facade wraps no read yet, so it
    # goes through client.command.
    read = await within(
        "the session/read reply",
        COMMAND_BUDGET_MS,
        client.command("session/read", {"sessionId": session_id}),
    )
    info = object_at(read, "session", "session/read result")
    equals(info.get("providerId"), target.provider_id, "the read-back session's providerId")
    equals(info.get("modelId"), target.model_id, "the read-back session's modelId")
    # ...and the catalog agrees: the switched row is the active one now.
    relisted = _catalog_rows(
        await within(
            "the model/list reply",
            COMMAND_BUDGET_MS,
            client.list_models({"sessionId": session_id}),
        )
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
    client = _require_client(context)
    await within("the orderly drain", CLOSE_BUDGET_MS, client.close())
    # cleanShutdown is the SDK's row for exit code 0 after stdin EOF.
    classification = await within("the exit classification", CLOSE_BUDGET_MS, client.exit)
    equals(classification.kind, "cleanShutdown", "the SDK's exit classification")
    context.client = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment("spawn", "Spawn the release-built host and complete the handshake", _spawn),
    Segment("session", "Start a session and read the model members it started with", _session),
    Segment("list-models", "List the catalog and pick the row to switch to", _list_models),
    Segment("switch", "Switch the session's model and read the admission ack", _switch),
    Segment(
        "model-changed",
        "Wait for the durable session/modelChanged record to reach the session",
        _model_changed,
    ),
    Segment("fold", "Read the change off the session's fold", _fold),
    Segment("verify", "Read the session back and re-list: both report the new model", _verify),
    Segment("drain", "Close the client and let the host exit cleanly", _drain),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.muse_bin is None:
        raise ValueError("muse_bin is required")
    context = Context(muse_bin=hosts.muse_bin)

    async def teardown(owned: Context) -> None:
        if owned.client is None:
            return
        try:
            await within("the host's teardown drain", CLOSE_BUDGET_MS, owned.client.close())
        except Exception as error:  # noqa: BLE001 - warned, never raised
            import sys

            print(f"teardown: the host did not drain cleanly: {error}", file=sys.stderr)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="list-models-and-switch-mid-session",
    title="List models and switch mid-session",
    docs_page="cookbook/list-models-and-switch-mid-session",
    needs=("muse_bin",),
    run=_run,
)
