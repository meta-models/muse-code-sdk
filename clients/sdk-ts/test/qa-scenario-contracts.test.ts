/**
 * #27399: every shipped scenario's contract, read without a host. The runner
 * judges a run against `QaScenario.expected`, so these asserts pin the same
 * value in the default lane that `qa-real-binary.test.ts` pins only when a
 * binary is present.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { D19764_EXPECTED, D19778_EXPECTED, SDK_QA_SCENARIOS } from "../qa/index.js";

test("#27399: each defect class with an exported contract still carries it", () => {
  const expectedOf = (id: string): string | undefined =>
    SDK_QA_SCENARIOS.find((scenario) => scenario.id === id)?.expected;
  assert.equal(expectedOf("D19764"), D19764_EXPECTED);
  assert.equal(expectedOf("D19778"), D19778_EXPECTED);
});

test("#27399: every shipped scenario declares a non-empty contract", () => {
  for (const scenario of SDK_QA_SCENARIOS) {
    assert.ok(scenario.expected.trim().length > 0, `${scenario.id} declares what it expects`);
  }
});
