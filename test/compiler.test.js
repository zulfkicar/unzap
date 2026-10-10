import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { workflowsFrom, analyse } from "../src/importer.js";
import { emitWorkflow, writeProject } from "../src/emitter.js";
import {
  createContext,
  resolve,
  filter,
  httpRequest,
  parseReference,
} from "../src/runtime.js";
const fixture = JSON.parse(
    readFileSync(
      new URL("../fixtures/webhook-filter-http.json", import.meta.url),
    ),
  ),
  input = JSON.parse(
    readFileSync(new URL("../fixtures/input.json", import.meta.url)),
  );
test("real export dictionaries become ordered typed nodes with explicit credential bindings", () => {
  const a = analyse(workflowsFrom(fixture)[0]);
  assert.equal(a.compilable, true);
  assert.deepEqual(
    a.spec.steps.map((n) => n.kind),
    ["webhook", "filter", "http"],
  );
  assert.equal(a.spec.bindings[0].name, "STEP_3_HEADERS_AUTHORIZATION");
  assert.ok(!JSON.stringify(a.spec).includes("SYNTHETIC-EXAMPLE-TOKEN"));
  assert.ok(!emitWorkflow(a).includes("SYNTHETIC-EXAMPLE-TOKEN"));
});
test("unsupported branches, actions and forward references block generation instead of being discarded", () => {
  for (const mutate of [
    (w) => (w.nodes["3"].parent_id = 1),
    (w) => (w.nodes["3"].selected_api = "UnsupportedCLIAPI@1.0.0"),
    (w) => (w.nodes["2"].params.filter_criteria[0].key = "{{3__id}}"),
    (w) => (w.nodes["2"].params.filter_criteria[0].match = "idategreater"),
  ]) {
    const w = structuredClone(fixture.zaps[0]);
    mutate(w);
    const a = analyse(w);
    assert.equal(a.compilable, false);
    assert.throws(() => emitWorkflow(a));
  }
});
test("complete references preserve numeric and boolean types; unsafe and missing mappings fail", () => {
  assert.equal(resolve("{{1__amount}}", { 1: input }), 25);
  assert.equal(resolve("{{1__active}}", { 1: input }), true);
  assert.equal(
    resolve("Request {{1__event_id}}", { 1: input }),
    "Request example-001",
  );
  assert.throws(() => resolve("{{1__unknown}}", { 1: input }));
  assert.throws(() => resolve("{{1__constructor}}", { 1: input }));
});
test("filter groups preserve AND within a group and OR between groups", () => {
  const c = (group, key, value) => ({
    group,
    key,
    value,
    match: "iexact",
    action: "continue",
  });
  assert.equal(
    filter([c(0, "a", "a"), c(0, "b", "wrong"), c(1, "x", "x")]),
    true,
  );
  assert.equal(filter([c(0, "a", "a"), c(0, "b", "wrong")]), false);
  assert.throws(() =>
    filter([{ group: 0, key: [1, 2], value: "1", match: "iexact" }]),
  );
});
test("native HTTP serialization supports reviewed JSON and simple form contracts", () => {
  assert.equal(
    httpRequest(
      { action: "post" },
      {
        url: "https://api.example.test",
        payload_type: "json",
        data: { n: 25, b: true },
      },
    ).body,
    '{"n":25,"b":true}',
  );
  assert.equal(
    httpRequest(
      { action: "post" },
      {
        url: "https://api.example.test",
        payload_type: "form",
        data: { text: "a b" },
      },
    ).body,
    "text=a+b",
  );
  assert.throws(() =>
    httpRequest(
      { action: "post" },
      { payload_type: "form", data: { nested: { n: 1 } } },
    ),
  );
});
test("generated code executes directly with inspectable requests and filtered/held outcomes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "zap-code-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = analyse(fixture.zaps[0]);
  await writeProject(a, dir);
  const { workflow } = await import(pathToFileURL(join(dir, "workflow.mjs")));
  let effects = 0;
  const transport = async (request) => {
    effects++;
    assert.equal(request.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(request.body), {
      event_id: "example-001",
      amount: 25,
      active: true,
      description: "Request example-001",
    });
    return { id: "result-001" };
  };
  const result = await workflow(
    input,
    createContext({
      env: { STEP_3_HEADERS_AUTHORIZATION: "Bearer test-key" },
      transport,
    }),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(effects, 1);
  assert.equal(result.outputs["3"].id, "result-001");
  assert.equal(result.requests[0].headers.Authorization, "[redacted]");
  const blocked = await workflow(
    { ...input, status: "draft" },
    createContext({ transport }),
  );
  assert.equal(blocked.status, "filtered");
  assert.equal(effects, 1);
  const held = await workflow(input, createContext({ transport }));
  assert.equal(held.status, "held");
  assert.equal(effects, 1);
});

test("modern gives references are parsed as data paths without executing expressions", () => {
  const outputs = {
    1: { record: { amount: 25, active: true }, "field with spaces": "value" },
  };
  assert.equal(resolve('{{=gives["1"]["record"]["amount"]}}', outputs), 25);
  assert.equal(resolve("{{=gives['1']['record']['active']}}", outputs), true);
  assert.equal(
    resolve('Value {{=gives["1"]["field with spaces"]}}', outputs),
    "Value value",
  );
  assert.equal(parseReference('=gives["1"]["record"].constructor()'), null);
  assert.throws(() => resolve('{{=gives["1"]["constructor"]}}', outputs));
  const w = structuredClone(fixture.zaps[0]);
  w.nodes["2"].params.filter_criteria[0].key = '{{=gives["1"]["status"]}}';
  assert.equal(analyse(w).compilable, true);
  w.nodes["2"].params.filter_criteria[0].key = "{{zap_meta_human_now}}";
  assert.equal(analyse(w).compilable, false);
});
