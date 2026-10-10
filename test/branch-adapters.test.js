import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importDefinitions, validate, compile } from "../src/migration.js";
import {
  createContext,
  resolveConditions,
  filter,
  httpRequest,
  unflatten,
} from "../src/runtime.js";
import { format } from "../src/logic.js";
import { requestFor, normalizeOutput } from "../src/connectors.js";
import { Store } from "../src/store.js";
import { Runner } from "../src/runner.js";
const source = JSON.parse(
  readFileSync(
    new URL("../fixtures/find-or-create-paths.json", import.meta.url),
  ),
);
const reviewed = () => {
  const d = importDefinitions(source)[0];
  d.steps.forEach((s) => (s.review_required = false));
  return d;
};
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "unzap-paths-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}
test("native exported find-or-create graph executes both outcomes with exact requests and skipped siblings", async (t) => {
  for (const found of [false, true]) {
    const store = setup(t),
      d = reviewed(),
      id = store.add(d),
      requests = [];
    for (const s of d.steps)
      if (s.params.connection)
        store.connect(s.params.connection, "Test", "synthetic-key");
    const runner = new Runner(store, {
      transport: async (request) => {
        requests.push(request);
        if (request.method === "GET")
          return {
            records: found
              ? [{ id: "rec_demo_found", fields: { Name: "Old" } }]
              : [],
          };
        if (request.method === "PATCH")
          return {
            id: "rec_demo_found",
            fields: JSON.parse(request.body).fields,
          };
        return {
          records: [
            {
              id: "rec_demo_created",
              fields: JSON.parse(request.body).records[0].fields,
            },
          ],
        };
      },
    });
    const run = await runner.start(
      id,
      { email: "  member@example.test ", name: "Example Member" },
      { mode: "live", key: "one" },
    );
    assert.equal(run.status, "succeeded");
    assert.equal(requests.length, 2);
    const search = new URL(requests[0].url);
    assert.equal(
      search.searchParams.get("filterByFormula"),
      '{Email}="member@example.test"',
    );
    assert.equal(requests[1].method, found ? "PATCH" : "POST");
    assert.deepEqual(
      JSON.parse(requests[1].body),
      found
        ? { fields: { Name: "Example Member" } }
        : {
            records: [
              {
                fields: {
                  Email: "member@example.test",
                  Name: "Example Member",
                },
              },
            ],
          },
    );
    assert.equal(
      run.steps.find((s) => s.step_id === (found ? "8" : "6")).status,
      "skipped",
    );
    await runner.start(
      id,
      { email: "  member@example.test ", name: "Example Member" },
      { mode: "live", key: "one" },
    );
    assert.equal(requests.length, 2);
  }
});
test("nested paths execute all matching branches in order while a branch-local filter stops only its descendants", async () => {
  const d = {
    name: "Nested",
    steps: [
      { id: "1", parent_id: null, kind: "webhook", params: {} },
      { id: "2", parent_id: "1", kind: "paths", params: {} },
      {
        id: "3",
        parent_id: "2",
        kind: "path",
        params: { mode: "always", order: 0 },
      },
      {
        id: "4",
        parent_id: "3",
        kind: "filter",
        params: {
          filter_criteria: [
            {
              group: 0,
              key: "x",
              value: "y",
              match: "iexact",
              action: "continue",
            },
          ],
        },
      },
      {
        id: "5",
        parent_id: "4",
        kind: "transform",
        params: { fields: { a: 1 } },
      },
      {
        id: "6",
        parent_id: "2",
        kind: "path",
        params: { mode: "always", order: 1 },
      },
      { id: "7", parent_id: "6", kind: "paths", params: {} },
      {
        id: "8",
        parent_id: "7",
        kind: "path",
        params: { mode: "always", order: 0 },
      },
      {
        id: "9",
        parent_id: "8",
        kind: "transform",
        params: { fields: { b: 2 } },
      },
    ],
  };
  const ctx = createContext(),
    module = await import(
      "data:text/javascript;base64," +
        Buffer.from(compile(d)).toString("base64")
    );
  const result = await module.workflow({}, ctx);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.outputs["9"], { b: 2 });
  assert.equal(result.trace.find((s) => s.step_id === "5").status, "skipped");
  assert.deepEqual(
    result.trace.map((s) => s.step_id),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
  );
});
test("fallback runs only if no rule matches and ambiguous or cross-branch graphs remain blocked", () => {
  const d = reviewed();
  assert.equal(validate(d).ready, true);
  d.steps[6].params.mode = "always";
  assert.equal(validate(d).ready, true);
  d.steps.push({
    id: "9",
    parent_id: "4",
    kind: "path",
    params: { mode: "fallback", order: 2 },
  });
  assert.ok(validate(d).issues.some((i) => i.code === "branch"));
  const cross = reviewed();
  cross.steps[7].params.fields.Other = "{{6__id}}";
  assert.ok(validate(cross).issues.some((i) => i.code === "reference"));
  const unsafe = structuredClone(source);
  unsafe.nodes["5"].params.ignore_dependency_errors = true;
  assert.equal(importDefinitions(unsafe)[0].steps[4].kind, "unsupported");
});
test("existence and inverse conditions handle absent, empty, false and zero without swallowing invalid paths", () => {
  const c = (key, action = "continue") => ({
    group: 0,
    key,
    match: "iexist",
    action,
  });
  for (const value of [false, 0])
    assert.equal(
      filter(resolveConditions([c("{{1__field}}")], { 1: { field: value } })),
      true,
    );
  assert.equal(
    filter(resolveConditions([c("{{1__field}}", "stop")], { 1: {} })),
    true,
  );
  assert.equal(
    filter(resolveConditions([c("{{1__field}}")], { 1: { field: "" } })),
    false,
  );
  assert.throws(() => resolveConditions([c("{{1__constructor}}")], { 1: {} }));
  assert.equal(
    filter([
      {
        group: 0,
        key: "draft invoice",
        value: "draft",
        match: "icontains",
        action: "stop",
      },
    ]),
    false,
  );
});
test("formatter contracts preserve split segments, whitespace, Unicode, list outputs and numeric errors", () => {
  assert.deepEqual(
    format({
      transform: "string.split",
      inputs: "one, two, three",
      separator: ",[:space:]",
      index: "fields",
    }),
    { output__0: "one", output__1: "two", output__2: "three" },
  );
  assert.equal(
    format({
      transform: "string.split",
      inputs: "one/two",
      separator: "/",
      index: "-1",
    }).output,
    "two",
  );
  assert.deepEqual(
    format({
      transform: "string.split",
      inputs: "one,two",
      separator: ",",
      index: "all",
    }).output,
    ["one", "two"],
  );
  assert.equal(
    format({ transform: "string.replace", inputs: "é-é", old: "é", new: "✅" })
      .output,
    "✅-✅",
  );
  assert.equal(
    format({ transform: "number.math_v2", inputs: [10, 4], operation: "mul" })
      .output,
    40,
  );
  assert.throws(() =>
    format({ transform: "number.math_v2", inputs: [10, 0], operation: "div" }),
  );
  assert.throws(() =>
    format({ transform: "string.re_extract", inputs: "x", pattern: "(x+)+" }),
  );
});
test("Unix dates render across daylight-saving boundaries with source token semantics preserved", () => {
  assert.throws(() =>
    format({ transform: "date.formatting", inputs: "2026-02-30" }),
  );
  assert.deepEqual(
    format({ transform: "string.trim_space", inputs: [" a ", " b "] }),
    { output: ["a", "b"] },
  );
  assert.equal(
    format({
      transform: "date.formatting",
      inputs: "1710053940",
      from_format: "X",
      to_timezone: "America/New_York",
      to_format: "YYYY-MM-DD HH:mm:ss Z",
    }).output,
    "2024-03-10 01:59:00 -05:00",
  );
  assert.equal(
    format({
      transform: "date.formatting",
      inputs: "1710054060",
      from_format: "X",
      to_timezone: "America/New_York",
      to_format: "YYYY-MM-DD HH:mm:ss Z",
    }).output,
    "2024-03-10 03:01:00 -04:00",
  );
  assert.equal(
    format({
      transform: "date.formatting",
      inputs: "2026-10-10T00:00:00Z",
      to_timezone: "Asia/Karachi",
      to_format: "HH:MM",
    }).output,
    "05:10",
  );
  assert.throws(() =>
    format({
      transform: "date.formatting",
      inputs: "10/10/2026",
      from_format: "MM/DD/YYYY",
    }),
  );
});
test("HTTP adapters handle nested JSON, array wrapping, query encoding and Basic auth without prototype pollution", () => {
  const p = {
    url: "https://example.test",
    method: "POST",
    data: { user__name: "A", user__active: false },
    unflatten: true,
    wrap_in_array: true,
    auth: "user|pass",
  };
  assert.deepEqual(JSON.parse(httpRequest({}, p).body), [
    { user: { name: "A", active: false } },
  ]);
  assert.equal(httpRequest({}, p).headers.Authorization, "Basic dXNlcjpwYXNz");
  assert.equal(
    new URL(
      httpRequest(
        {},
        { ...p, method: "GET", data: { q: "A & B" }, unflatten: false },
      ).url,
    ).searchParams.get("q"),
    "A & B",
  );
  assert.throws(() => unflatten(JSON.parse('{"__proto____bad":true}')));
  assert.throws(() => unflatten({ a: 1, a__b: 2 }));
});
test("search adapter handles misses and duplicate matches as safe holds, preserves flattened record outputs", () => {
  const s = { kind: "airtable_find" };
  assert.throws(() =>
    normalizeOutput(s, { records: [] }, { on_missing: "hold" }),
  );
  assert.deepEqual(
    normalizeOutput(s, { records: [] }, { on_missing: "continue" }),
    { _zap_search_was_found_status: false },
  );
  assert.throws(() =>
    normalizeOutput(
      s,
      { records: [{ id: "rec1" }, { id: "rec2" }] },
      { multiple: "halt" },
    ),
  );
  assert.equal(
    normalizeOutput(s, { records: [{ id: "rec1", fields: { Email: "e" } }] })
      .fields__Email,
    "e",
  );
  assert.throws(() =>
    requestFor(
      s,
      { connection: "A", base: "b", table: "t", field: "x} & bad", value: "e" },
      { A: "key" },
    ),
  );
});
test("Slack proposals retain native mention, identity, image and thread options without dropping unsupported writes", () => {
  const source = {
    nodes: {
      1: {
        id: 1,
        parent_id: null,
        selected_api: "WebHookAPI",
        action: "hook",
        params: {},
      },
      2: {
        id: 2,
        parent_id: 1,
        selected_api: "SlackAPI",
        action: "channel_message",
        params: {
          channel: "C_EXAMPLE",
          text: "Hello",
          as_bot: "true",
          link_names: "yes",
          username: "Example Bot",
          icon: ":robot_face:",
          thread_ts: "1700000000.000001",
          reply_broadcast: "true",
          image_url: "https://example.test/demo.png",
        },
      },
    },
  };
  const step = importDefinitions(source)[0].steps[1];
  assert.equal(step.kind, "slack");
  const body = JSON.parse(
    requestFor(step, step.params, { SLACK_STEP_2_TOKEN: "key" }).body,
  );
  assert.equal(body.link_names, 1);
  assert.equal(body.icon_emoji, ":robot_face:");
  assert.equal(body.reply_broadcast, true);
  assert.equal(body.attachments[0].image_url, "https://example.test/demo.png");
  source.nodes["2"].params.file = "https://example.test/file";
  assert.equal(importDefinitions(source)[0].steps[1].kind, "unsupported");
});
