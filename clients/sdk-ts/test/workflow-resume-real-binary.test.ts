// Spec 6619 TEST-31386-4/9: public SDK, production serve, and real V8 children.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { MuseClient } from "../src/index.js";
import type { Session } from "../src/index.js";
import { hermeticEnv } from "../qa/recorder.js";
import { readTapPids, readWireLog, tappedSpawnOptions } from "../qa/tap.js";
import { Changes, array, at, object, workflowProvider } from "./helpers/workflow-resume-provider.js";
import type { Json } from "./helpers/workflow-resume-provider.js";

const binary = process.env["TBH_SDK_WORKFLOW_RESUME_E2E_BIN"];
const skip = binary === undefined
  ? "NOT RUN: set TBH_SDK_WORKFLOW_RESUME_E2E_BIN to a production V8 muse binary; a skip is not acceptance"
  : process.platform === "win32" ? "This POSIX process-loss journey requires SIGKILL" : false;

async function sessionRecords(root: string): Promise<Json[]> {
  const records: Json[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "session.jsonl") {
        const text = await readFile(path, "utf8");
        // A live writer may not yet have completed its final physical line.
        for (const line of text.split("\n").slice(0, -1)) {
          if (line.trim() !== "") records.push(object(JSON.parse(line)));
        }
      }
    }
  };
  await visit(root);
  const unique = new Map<string, Json>();
  for (const record of records) {
    if (record["id"] === undefined) continue; // Permission transaction frames are not run records.
    const key = `${String(at(record, "stream", "id"))}:${String(record["id"])}`;
    const previous = unique.get(key);
    if (previous !== undefined) assert.deepEqual(previous, record, "a retained identity has one payload");
    unique.set(key, record);
  }
  return [...unique.values()];
}
function event(record: Json): Json { return object(at(record, "payload", "event")); }
function workflowId(phase: string): string { return `workflow-run-model-tool-${phase}`; }
function rootEvidence(records: Json[], sessionId: string): Json {
  const roots = records.filter((r) => at(r, "stream", "id") === sessionId && at(r, "payload", "kind") === "agent_tree_initialized");
  assert.equal(roots.length, 1, "the session retains exactly one logical root initialization");
  const root = object(at(roots[0], "payload", "record"));
  assert.equal(root["root_session_id"], sessionId);
  assert.equal(typeof root["root_agent_id"], "string");
  assert.equal(typeof root["execution_capacity"], "number");
  assert.ok(Number(root["execution_capacity"]) > 0);
  return { initializationId: roots[0]!["id"], rootId: root["root_agent_id"], capacity: root["execution_capacity"] };
}
function assertNoLauncherRefusal(records: Json[], phase: string): void {
  for (const record of records) {
    const result = array(event(record)["results"]).find((r) => at(r, "tool_call_id") === phase);
    const text = at(result, "text");
    assert.ok(typeof text !== "string" || !text.includes("workflow_launch_unavailable"),
      `${phase}: a new workflow must launch after activation; observed ${String(text)}`);
  }
}
function childIdentity(records: Json[], phase: string, childId?: string): Json | undefined {
  return records.map(event).find((e) => e["kind"] === "workflow_child_lifecycle"
    && e["workflow_run_id"] === workflowId(phase)
    && (childId === undefined || e["child_id"] === childId)
    && at(e, "session_stream", "id") !== undefined && at(e, "run_stream", "id") !== undefined);
}
function childStarts(records: Json[], child: Json): Json[] {
  return records.filter((r) => at(r, "stream", "id") === at(child, "session_stream", "id")
    && at(r, "payload", "kind") === "run"
    && at(r, "payload", "run_id") === at(child, "run_stream", "id") && event(r)["kind"] === "started");
}

function inFlightProof(records: Json[], sessionId: string, phase: string): Json {
  const launchIndex = records.findIndex((r) => at(r, "stream", "id") === sessionId
    && event(r)["kind"] === "workflow_run_launched" && event(r)["workflow_run_id"] === workflowId(phase));
  assert.ok(launchIndex >= 0, "the interrupted workflow has its own committed launch");
  const launch = event(records[launchIndex]!);
  const child = childIdentity(records, phase);
  assert.ok(child, "the interrupted workflow admitted a child with durable identity");
  const starts = childStarts(records, child);
  assert.equal(starts.length, 1, "the named child run STARTED before the kill");
  const childId = child["child_id"];
  const taskId = child["task_id"];
  assert.equal(typeof taskId, "string");
  const control = (r: Json): Json => object(at(r, "payload", "record"));
  const controls = records.filter((r) => at(r, "payload", "kind") === "subagent_control");
  const spawn = controls.find((r) => control(r)["kind"] === "spawn_accepted"
    && control(r)["subagent_id"] === childId && control(r)["task_id"] === taskId
    && control(r)["workflow_run_id"] === workflowId(phase));
  assert.ok(spawn, "the live child is linked to the interrupted workflow's SpawnAccepted");
  const attempt = controls.find((r) => control(r)["kind"] === "attempt_admitted"
    && control(r)["subagent_id"] === childId && at(control(r), "attempt_ref", "task_id") === taskId);
  assert.ok(attempt, "the named child has its admitted control attempt");
  const admitted = records.find((r) => at(r, "payload", "kind") === "async_owner_attempt"
    && control(r)["kind"] === "admitted"
    && at(control(r), "attempt_ref", "task_id") === taskId
    && control(r)["admission_command_id"] === control(attempt)["admission_command_id"]);
  assert.ok(admitted, "the same attempt has an async-owner admission");
  assert.deepEqual(control(admitted)["attempt_ref"], control(attempt)["attempt_ref"]);
  assert.equal(control(admitted)["admission_record_ref"], control(attempt)["admission_record_ref"]);
  assert.equal(admitted["causation_id"], spawn["id"]);
  assert.equal(attempt["causation_id"], admitted["id"]);
  for (const kind of ["proposed", "accepted", "scheduled", "started"]) {
    assert.ok(records.some((r) => at(r, "payload", "kind") === "task"
      && at(r, "payload", "task_id") === taskId && event(r)["kind"] === kind), `the actual child task ${kind}`);
  }
  const childSessionId = at(child, "session_stream", "id");
  const childRunId = at(child, "run_stream", "id");
  const attestation = controls.find((r) => control(r)["kind"] === "start_attested"
    && control(r)["subagent_id"] === childId && control(r)["subagent_session_id"] === childSessionId
    && control(r)["run_stream"] === `run/${String(childRunId)}`);
  assert.ok(attestation, "the named STARTED record has matching start attestation");
  assert.ok(controls.some((r) => control(r)["kind"] === "status_updated"
    && control(r)["subagent_id"] === childId && control(r)["control_status"] === "running"));
  assert.ok(!records.some((r) => at(r, "payload", "kind") === "run"
    && at(r, "payload", "run_id") === childRunId
    && ["terminal", "workflow_child_result_submitted"].includes(String(event(r)["kind"]))),
  "the STARTED child had neither a terminal nor a result when killed");
  const terminalKinds = ["rejected", "completed", "failed", "cancelled", "timed_out"];
  assert.ok(!records.some((r) => at(r, "payload", "kind") === "task"
    && [taskId, launch["workflow_task_id"]].includes(at(r, "payload", "task_id"))
    && terminalKinds.includes(String(event(r)["kind"]))), "neither child nor workflow task had settled");
  assert.ok(!records.some((r) => event(r)["kind"] === "workflow_launch_reconciled"
    && event(r)["workflow_run_id"] === workflowId(phase)), "the interrupted workflow had not completed");
  assert.ok(!records.slice(launchIndex).some((r) => at(r, "stream", "id") === sessionId
    && r["payload_type"] === "session.end"), "no orderly session end followed the live launch");
  return { workflowRunId: workflowId(phase), childId, childSessionId, childRunId,
    childStartedRecordId: starts[0]!["id"], spawnRecordId: spawn["id"],
    admissionRecordId: admitted["id"], controlAttemptRecordId: attempt["id"],
    startAttestationRecordId: attestation["id"], root: rootEvidence(records, sessionId) };
}
function assertCompletedView(session: Session, records: Json[], phase: string): void {
  const workflow = session.fold.items.list().find((item) => item.kind === "workflow" && item.workflowRunId === workflowId(phase));
  assert.ok(workflow, "the public SDK fold receives the newly launched workflow");
  assert.equal(workflow.status, "completed");
  assert.ok(typeof workflow.message === "string" && workflow.message.length > 0);
  assert.equal(workflow.children?.length, 2, "the real V8 program finishes both sequential children");
  const results: string[] = [];
  for (const child of workflow.children ?? []) {
    assert.equal(child.terminal, "completed");
    assert.ok(child.resultRef && child.resultRef.length > 0, "SDK child has a persisted result reference");
    const identity = childIdentity(records, phase, child.childId);
    assert.ok(identity, "the SDK child joins its durable session/run identity");
    assert.equal(childStarts(records, identity).length, 1, "the actual child started exactly once");
    const result = records.map(event).find((e) => e["kind"] === "workflow_child_result_submitted" && e["child_id"] === child.childId);
    assert.ok(result, "the child retained its result");
    const text = at(result, "payload", "text");
    assert.equal(typeof text, "string"); results.push(String(text));
  }
  assert.deepEqual(results.sort(), [`SDK64_RESULT:${phase}:1`, `SDK64_RESULT:${phase}:2`]);
}

interface OwnedHost { client: MuseClient; tap: string; closed: boolean; stderr: string[] }

async function sessionHome(root: string, sessionId: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (entry.name === sessionId && await access(join(path, "session.jsonl")).then(() => true, () => false)) return path;
    const found = await sessionHome(path, sessionId);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function seedScheduledTurn(root: string, sessionId: string, phase: string): Promise<Json> {
  const helper = process.env["TBH_SDK_WORKFLOW_RESUME_CRON_FIXTURE_BIN"];
  assert.ok(helper, "build tbh-local-store's workflow_resume_cron_fixture example for real cron acceptance");
  const home = await sessionHome(root, sessionId);
  assert.ok(home, "the exited host retained its session directory");
  // Failure-only child-process cap; the typed store close completes this step.
  const result = await promisify(execFile)(helper, [home, sessionId, `SDK64_WORKFLOW:${phase}`], { timeout: 30_000 });
  return object(JSON.parse(result.stdout));
}

async function fixture(t: TestContext) {
  assert.ok(binary);
  const root = await mkdtemp(join(tmpdir(), "sdk64-workflow-resume-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const sessions = join(home, "data", "muse", "sessions");
  await mkdir(sessions, { recursive: true }); await mkdir(workspace);
  const provider = await workflowProvider();
  const changes = new Changes();
  const watcher = watch(sessions, { recursive: true }, () => changes.notify());
  const hosts: OwnedHost[] = [];
  const receipts: unknown[] = [];
  t.after(async () => {
    try {
      for (const host of hosts) if (!host.closed) {
        try { await host.client.close(); await host.client.exit; }
        finally { host.closed = true; }
      }
    } finally {
      watcher.close(); await provider.close();
      await writeFile(join(root, "provider.json"), JSON.stringify({ requests: provider.requests, errors: provider.errors }, null, 2));
      await writeFile(join(root, "receipts.json"), JSON.stringify({ binary, platform: process.platform, receipts }, null, 2));
      for (const [index, host] of hosts.entries()) await writeFile(join(root, `host-${index}.stderr`), host.stderr.join(""));
      const evidence = process.env["TBH_SDK_WORKFLOW_RESUME_E2E_EVIDENCE"];
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true });
        await cp(root, join(evidence, t.name.replace(/[^a-zA-Z0-9_-]/g, "-")), { recursive: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  const env = {
    ...hermeticEnv(home), META_API_KEY: "sdk64-loopback-fixture-only",
    MUSE_EXPERIMENTAL_WORKFLOW_TOOL: "on", TBH_IS_E2E_TEST: "1",
    TBH_E2E_SESSION_NAME_ACCOUNT_HOME: home,
  };
  const config = join(home, "config", "muse"); await mkdir(config, { recursive: true });
  await writeFile(join(config, "settings.json"), JSON.stringify({
    schema_version: 1, endpoint_transport: { base_url: provider.baseUrl, auth: "bearer" },
    run: { toolset: ["workflow"], workflow_trigger_mode: "auto", reminder_roster: { agents: [] } },
    context_compaction: { periodic_checkpoint_bytes: 0 },
  }));
  await writeFile(join(config, "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: { api_key: env.META_API_KEY } } }));
  const open = async (): Promise<OwnedHost> => {
    const tap = join(root, `host-${hosts.length}.tap.jsonl`);
    const stderr: string[] = [];
    const options = tappedSpawnOptions({ tapFile: tap, command: binary,
      args: ["serve", "--provider", "meta", "--model", "fixture-meta"],
      cwd: workspace, env, onStderr: (text) => stderr.push(text) });
    const client = await MuseClient.spawn({ ...options, museBin: options.command,
      clientInfo: { name: "sdk64_workflow_resume", version: "1" }, shutdownTimeoutMs: 30_000 });
    const host = { client, tap, stderr, closed: false }; hosts.push(host); return host;
  };
  const finish = async (host: OwnedHost, session: Session, phase?: string): Promise<Json | undefined> => {
    await host.client.close(); const exit = await host.client.exit; host.closed = true;
    assert.deepEqual(exit, { kind: "cleanShutdown" }, "healthy EOF must drain without escalation");
    const records = await sessionRecords(sessions);
    const ends = records.filter((r) => at(r, "stream", "id") === session.sessionId && r["payload_type"] === "session.end");
    assert.equal(at(ends.at(-1), "payload", "record", "exit_reason"), "clean", "the host retained an orderly end");
    if (phase !== undefined) assertCompletedView(session, records, phase);
    const hasRoot = records.some((r) => at(r, "stream", "id") === session.sessionId && at(r, "payload", "kind") === "agent_tree_initialized");
    const rootProof = phase === undefined && !hasRoot ? undefined : rootEvidence(records, session.sessionId);
    const receipt = { phase, sessionId: session.sessionId, exit, root: rootProof,
      pids: await readTapPids(host.tap),
      ...(phase === undefined ? {} : { workflowRunId: workflowId(phase), children: provider.childSteps(phase) }) };
    receipts.push(receipt); console.log("SDK64_SDK_ACCEPTANCE", JSON.stringify(receipt));
    assert.deepEqual(provider.errors, []);
    return rootProof;
  };
  const waitForWorkflow = async (phase: string): Promise<void> => {
    await changes.waitFor(`${phase}: durable workflow completion`, async () => {
      const records = await sessionRecords(sessions); assertNoLauncherRefusal(records, phase);
      const terminal = records.map(event).find((e) => e["kind"] === "workflow_launch_reconciled" && e["workflow_run_id"] === workflowId(phase));
      if (terminal === undefined) return undefined;
      const rows = array(at(terminal, "product_projection", "list_rows"));
      assert.equal(at(rows[0], "status"), "completed", JSON.stringify(terminal));
      return terminal;
    });
    await provider.waitForCompletionDelivery(phase);
    assert.deepEqual(provider.childSteps(phase), [1, 2]);
  };
  const complete = async (session: Session, phase: string): Promise<void> => {
    const turn = await session.sendUserTurn({ input: [{ type: "text", text: `SDK64_WORKFLOW:${phase}` }] });
    await waitForWorkflow(phase);
    const outcome = await turn.completed;
    assert.equal(outcome.kind, "completed", "the public SDK turn reaches its terminal");
    if (outcome.kind === "completed") assert.equal(outcome.params.terminal, "completed");
    assert.deepEqual(provider.childSteps(phase), [1, 2]);
  };
  return { root, sessions, workspace, provider, changes, receipts, open, finish, complete, waitForWorkflow };
}

async function firstScheduledWorkflow(t: TestContext, previousWorkflow: boolean): Promise<void> {
  const f = await fixture(t);
  const first = await f.open();
  const seed = await first.client.startSession({ approvalMode: "allowAll", workspaceRoot: f.workspace });
  let before: Json | undefined;
  if (previousWorkflow) {
    await f.complete(seed, "background-seed");
    before = await f.finish(first, seed, "background-seed");
  } else {
    const turn = await seed.sendUserTurn({ input: [{ type: "text", text: "Only ordinary chat before restart." }] });
    assert.equal((await turn.completed).kind, "completed");
    before = await f.finish(first, seed);
    assert.ok(!(await sessionRecords(f.sessions)).some((r) => event(r)["kind"] === "workflow_run_launched"));
  }
  assert.ok(first.closed, "the old OS process must finish before the offline store is seeded");
  const old = await sessionRecords(f.sessions);
  const oldIds = new Set(old.map((r) => r["id"]));
  const phase = previousWorkflow ? "background-after-workflow" : "background-after-chat";
  const scheduled = await seedScheduledTurn(f.sessions, seed.sessionId, phase);
  f.receipts.push({ phase, offlineScheduledJob: scheduled });

  const second = await f.open();
  const resumed = await second.client.resumeSession({ sessionId: seed.sessionId });
  assert.equal(resumed.sessionId, seed.sessionId);
  await f.waitForWorkflow(phase);
  const records = await sessionRecords(f.sessions);
  const freshParent = records.filter((r) => at(r, "stream", "id") === seed.sessionId && !oldIds.has(r["id"]));
  assert.ok(!freshParent.some((r) => at(r, "payload", "record", "payload_type") === "top_level_turn.run_origin"),
    "no retained client turn may prime the resumed runtime");
  const origin = freshParent.find((r) => at(r, "payload", "record", "payload_type") === "inbox_delivery.run_origin");
  assert.ok(origin, "the first new turn has a retained runtime origin");
  assert.equal(at(origin, "payload", "record", "payload", "client_id"), "muse-runtime-cron");
  const runId = at(origin, "payload", "run_id");
  assert.equal(typeof runId, "string");
  const queued = freshParent.filter((r) => event(r)["kind"] === "inbox_item_queued"
    && at(event(r), "source", "idempotency_key") === scheduled["idempotencyKey"]);
  assert.equal(queued.length, 1, "the real scheduler delivers exactly the retained one-shot");
  assert.equal(at(event(queued[0]!), "source", "job_id"), scheduled["jobId"]);
  assert.equal(at(event(queued[0]!), "source", "scheduled_fire_at_ms"), scheduled["scheduledFireAtMs"]);
  const launch = freshParent.find((r) => event(r)["kind"] === "workflow_run_launched"
    && event(r)["workflow_run_id"] === workflowId(phase));
  assert.ok(launch, "the first scheduled turn really launches Workflow");
  assert.equal(at(launch, "payload", "run_id"), runId);
  assert.equal(event(launch)["trigger_source"], "runtime_origin");
  assert.equal(event(launch)["engine_kind"], "v8");
  const configured = freshParent.find((r) => at(r, "payload", "run_id") === runId
    && event(r)["kind"] === "model_request_configured");
  assert.ok(configured, "the scheduled turn records its current model context");
  const context = array(event(configured)["run_context_messages"])
    .map((message) => at(message, "id"))
    .filter((id): id is string => typeof id === "string" && id.startsWith("workflow_"));
  assert.deepEqual(context.sort(), ["workflow_choice", "workflow_cookbook"]);
  const outcome = await resumed.turn(String(runId)).completed;
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") assert.equal(outcome.params.terminal, "completed");
  const after = await f.finish(second, resumed, phase);
  assert.ok(after, "the first Workflow retains exactly one valid root");
  if (before !== undefined) assert.deepEqual(after, before, "cold resume retains existing root identity and capacity");
  const wire = await readWireLog(second.tap);
  assert.equal(wire.outbound.filter((frame) => frame.json?.["method"] === "turn/start").length, 0,
    "the public SDK sent no turn/start in the restarted process");
  assert.equal(wire.outbound.filter((frame) => frame.json?.["method"] === "session/resume").length, 1);
  const priorChildIds = new Set(old.map(event).filter((e) => e["kind"] === "workflow_child_lifecycle").map((e) => e["child_id"]));
  for (const child of records.map(event).filter((e) => e["kind"] === "workflow_child_lifecycle" && e["workflow_run_id"] === workflowId(phase))) {
    assert.ok(!priorChildIds.has(child["child_id"]), "the background workflow starts new children");
  }
  const receipt = { phase, sessionId: seed.sessionId, scheduled, originId: origin["id"], runId,
    launchId: launch["id"], engine: event(launch)["engine_kind"], clientTurns: 0,
    oldPids: await readTapPids(first.tap), resumedPids: await readTapPids(second.tap), rootBefore: before, root: after };
  f.receipts.push(receipt);
  console.log("D2_FIRST_BACKGROUND_SDK_ACCEPTANCE", JSON.stringify(receipt));
}

test("first_scheduled_workflow_after_chat_only_cold_resume", { skip, timeout: 300_000 }, async (t) => {
  await firstScheduledWorkflow(t, false);
});

test("first_scheduled_workflow_after_completed_workflow_cold_resume", { skip, timeout: 300_000 }, async (t) => {
  await firstScheduledWorkflow(t, true);
});

test("healthy_workflows_survive_cold_resume", { skip, timeout: 300_000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const seed = await first.client.startSession({ approvalMode: "allowAll", workspaceRoot: f.workspace });
  await f.complete(seed, "healthy-first");
  const before = await f.finish(first, seed, "healthy-first");
  const second = await f.open();
  const resumed = await second.client.resumeSession({ sessionId: seed.sessionId });
  assert.equal(resumed.sessionId, seed.sessionId);
  await f.complete(resumed, "healthy-cold");
  assert.deepEqual(await f.finish(second, resumed, "healthy-cold"), before, "cold resume reuses the frozen root and capacity");
});

test("new_workflow_completes_after_resumed_host_dies_during_its_first_child", { skip, timeout: 300_000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.open();
  const seed = await first.client.startSession({ approvalMode: "allowAll", workspaceRoot: f.workspace });
  await f.complete(seed, "crash-seed");
  const before = await f.finish(first, seed, "crash-seed");
  const second = await f.open();
  const resumed = await second.client.resumeSession({ sessionId: seed.sessionId });
  assert.equal(resumed.sessionId, seed.sessionId);
  const phase = "crash-repeat";
  f.provider.holdFirstChild(phase);
  await resumed.sendUserTurn({ input: [{ type: "text", text: `SDK64_WORKFLOW:${phase}` }] });
  await f.provider.waitForHeldChild(phase);
  const cut = inFlightProof(await sessionRecords(f.sessions), seed.sessionId, phase);
  assert.deepEqual(cut["root"], before);
  assert.deepEqual(f.provider.childSteps(phase), [1], "the repeat's second step had not started");
  const { child: hostPid } = await readTapPids(second.tap);
  assert.ok(hostPid !== undefined && hostPid > 0, "the wire tap owns the exact host PID");
  process.kill(hostPid, "SIGKILL");
  const killedExit = await second.client.exit;
  second.closed = true;
  assert.notEqual(killedExit.kind, "cleanShutdown");
  const afterKill = inFlightProof(await sessionRecords(f.sessions), seed.sessionId, phase);
  assert.deepEqual(afterKill, cut, "the kill retained the exact named in-flight child proof");
  const killReceipt = { phase, hostPid, signal: "SIGKILL", killedExit, platform: process.platform, cut };
  f.receipts.push(killReceipt);
  console.log("SDK64_SDK_CHILD_IN_FLIGHT", JSON.stringify(killReceipt));
  const third = await f.open();
  const recovered = await third.client.resumeSession({ sessionId: seed.sessionId });
  assert.equal(recovered.sessionId, seed.sessionId);
  await f.complete(recovered, "after-process-loss");
  assert.deepEqual(await f.finish(third, recovered, "after-process-loss"), before);
  const records = await sessionRecords(f.sessions);
  const oldChild = childIdentity(records, phase);
  assert.ok(oldChild);
  assert.deepEqual(childStarts(records, oldChild).map((r) => r["id"]), [cut["childStartedRecordId"]],
    "recovery does not duplicate the interrupted child's start");
  assert.deepEqual(f.provider.childSteps(phase), [1], "recovery does not execute the interrupted second step");
});
