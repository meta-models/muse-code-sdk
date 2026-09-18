/** Spec 14990 FR-019: server-offered choices and idempotent client submission.
 * TEST-33067-8 / FR-33067-9 refers forward to the spec 287 amendment in #33166.
 * Policy-store persistence is proved separately by #33166.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { ApprovalChoice, ApprovalRequestParams, ApprovalSubject } from "@muse-code/msp";
import { Connection, Session } from "../src/index.js";
import type { ApprovalFailure } from "../src/index.js";
import {
  answer, FakeDuplex, sentFrame, sentParams, settleMicrotasks, waitForWrites,
} from "./helpers/fake-duplex.js";

const TARGETS: readonly {
  choiceId: string;
  label: string;
  preview: string;
  toolName: string;
  subject: ApprovalSubject;
}[] = [
  {
    choiceId: "allow_local_mcp_tool",
    label: "Always allow this MCP tool",
    preview: "tool `mcp__docs__echo`",
    toolName: "mcp__docs__echo",
    subject: { kind: "tool", toolName: "mcp__docs__echo" },
  },
  {
    choiceId: "allow_local_network",
    label: "Always allow this network destination",
    preview: "example.com:443 (https)",
    toolName: "network",
    subject: { kind: "network", host: "example.com", port: 443, protocol: "https" },
  },
];

function fixture(target: (typeof TARGETS)[number], offerLocal = true) {
  const transport = new FakeDuplex();
  const minted: string[] = [];
  const connection = new Connection(transport, {
    mintCommandId: () => {
      const id = `mint-${minted.length}`;
      minted.push(id);
      return id;
    },
  });
  const session = new Session<string>({
    sessionId: "s-1", durability: { kind: "durable" }, connection,
  });
  const availableChoices: ApprovalChoice[] = [
    { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
    {
      choiceId: "allow_session", decision: "approvedForSession",
      label: "Allow for this session", scope: "session", rulePreview: target.preview,
    },
  ];
  if (offerLocal) {
    availableChoices.push({
      choiceId: target.choiceId, decision: "approvedPolicyAmendment",
      label: target.label, scope: "localPersistent", rulePreview: target.preview,
    });
  }
  availableChoices.push({ choiceId: "abort", decision: "abort", label: "Reject", scope: "once" });
  const params: ApprovalRequestParams = {
    approvalId: "a-1", availableChoices,
    currentRequirementId: { approvalId: "a-1", sourceIndex: 0 },
    itemId: "i-1", judgeEscalated: false, protectedWrite: false, rawArgs: "{}",
    sessionId: "s-1", subject: target.subject, taskId: "task-1",
    toolCallId: "call-1", toolName: target.toolName, turnId: "turn-1", viewCursor: "v:1",
    sourceRange: {
      first: { id: "e-1", sequence: 1 }, last: { id: "e-1", sequence: 1 },
      stream: { id: "str-1", kind: "session" },
    },
  };
  return {
    connection, minted, session, transport,
    request: { method: "approval/requested" as const, params },
  };
}

for (const target of TARGETS) {
  for (const choiceId of ["allow_session", target.choiceId]) {
    test(`TEST-33067-8: ${choiceId} from ${target.choiceId} menu submits once`,
      { timeout: 10_000 }, async () => {
        const { connection, minted, session, transport, request } = fixture(target);
        const seen: ApprovalRequestParams[] = [];
        const failures: ApprovalFailure[] = [];
        session.onApprovalError((failure) => failures.push(failure));
        session.onApproval((offered) => {
          seen.push(offered);
          return { choiceId };
        });
        try {
          const first = session.apply(request);
          const inFlightRedelivery = session.apply(request);
          await waitForWrites(transport, 1);
          assert.equal(sentFrame(transport, 0)["method"], "approval/decide");
          assert.deepEqual(sentParams(transport, 0), {
            approvalId: "a-1", commandId: "mint-0", choiceId,
            requirementId: request.params.currentRequirementId, sessionId: "s-1",
          });
          assert.deepEqual(seen.map((offered) => offered.availableChoices), [request.params.availableChoices]);
          answer(transport, 0, {
            approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: true,
          });
          await Promise.all([first.io, inFlightRedelivery.io]);
          await session.apply(request).io;
          await settleMicrotasks();
          assert.equal(transport.writes.length, 1);
          assert.equal(seen.length, 1);
          assert.deepEqual(minted, ["mint-0"]);
          assert.deepEqual(failures, []);
          // The acknowledgement does not claim the rule was saved or resolve the view.
          assert.equal(session.fold.pendingApprovals().length, 1);
        } finally {
          await connection.close();
        }
      });
  }

  test(`TEST-33067-8: unoffered ${target.choiceId} is refused before submission`,
    { timeout: 10_000 }, async () => {
      const { connection, minted, session, transport, request } = fixture(target, false);
      const failures: ApprovalFailure[] = [];
      session.onApprovalError((failure) => failures.push(failure));
      session.onApproval(() => ({ choiceId: target.choiceId }));
      try {
        await session.apply(request).io;
        await settleMicrotasks();
        assert.equal(transport.writes.length, 0);
        assert.deepEqual(minted, []);
        assert.deepEqual(failures, [{
          kind: "unofferedChoice", approvalId: "a-1", choiceId: target.choiceId,
          availableChoiceIds: ["allow_once", "allow_session", "abort"],
        }]);
      } finally {
        await connection.close();
      }
    });
}
