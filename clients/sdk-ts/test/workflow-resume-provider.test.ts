import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowProvider } from "./helpers/workflow-resume-provider.js";

for (const introduction of [
  "Run this generated workflow host.agent child request.",
  "Run this generated workflow host.parallel child request.",
  "Run this generated Workflow child request.",
]) {
  test(`workflow fixture routes child introduction: ${introduction}`, async (t) => {
    const provider = await workflowProvider();
    t.after(() => provider.close());
    const response = await fetch(`${provider.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Failure-only cap; the actual HTTP reply advances this test.
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        tools: [{ type: "function", name: "submit_result" }],
        input: [{ role: "user", content: `${introduction}\nSDK64_CHILD:probe:1` }],
      }),
    });
    const body = await response.text();
    assert.equal(response.status, 200, body);
    assert.match(body, /"name":"submit_result"/);
    assert.deepEqual(provider.childSteps("probe"), [1]);
    assert.deepEqual(provider.errors, []);
  });
}

test("workflow fixture keeps an ordinary request on its parent route", async (t) => {
  const provider = await workflowProvider();
  t.after(() => provider.close());
  const response = await fetch(`${provider.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Failure-only cap; no timer supplies a successful outcome.
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      tools: [{ type: "function", name: "submit_result" }],
      input: [{ role: "user", content: "SDK64_CHILD:probe:1" }],
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /SDK64 parent acknowledged/);
  assert.deepEqual(provider.childSteps("probe"), []);
  assert.deepEqual(provider.errors, []);
});
