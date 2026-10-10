import test from "node:test";
import assert from "node:assert/strict";
import { judge } from "../finetune/oracle.js";
import { wireDefinition } from "../finetune/protocol.js";

const definition = {
  name: "typed output",
  steps: [
    { id: "1", parent_id: null, kind: "webhook", params: {} },
    { id: "2", parent_id: "1", kind: "transform", params: { fields: { units: "{{1__units}}", active: "{{1__active}}" } } },
  ],
};
const task = {
  expected_action: "propose",
  fixtures: [{ input: { units: 0, active: false }, status: "succeeded", requests: [], final: { units: 0, active: false } }],
};
const proposal = (d) => ({ action: "propose", definition: wireDefinition(d) });

test("fine-tune oracle rejects a compiler-valid semantic mutation", async () => {
  const correct = await judge(task, proposal(definition));
  assert.equal(correct.behavior_passed, true);
  const changed = structuredClone(definition);
  changed.steps[1].params.fields.units = "0";
  const incorrect = await judge(task, proposal(changed));
  assert.equal(incorrect.compiler_valid, true);
  assert.equal(incorrect.behavior_passed, false);
});

test("fine-tune oracle preserves source identity even for equivalent output", async () => {
  const changed = structuredClone(definition);
  changed.steps[1].id = "3";
  const result = await judge({ ...task, source: definition }, proposal(changed));
  assert.equal(result.parsed, true);
  assert.equal(result.behavior_passed, false);
  assert.equal(result.error, "Source topology changed");
});

test("fine-tune oracle distinguishes malformed proposal from invalid JSON", async () => {
  const result = await judge(task, { action: "propose", definition: {} });
  assert.equal(result.parsed, true);
  assert.equal(result.compiler_valid, false);
});

test("fine-tune refusal gate rejects executable definitions attached to inspect", async () => {
  const refusal = { expected_action: "inspect", fixtures: [] };
  assert.equal((await judge(refusal, { action: "inspect", reason: "Unsupported connector" })).refusal_passed, true);
  assert.equal((await judge(refusal, { action: "inspect", definition: wireDefinition(definition) })).refusal_passed, false);
});
