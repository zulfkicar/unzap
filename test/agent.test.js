import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateWithAgent as runAgent,
  modelConfiguration,
  ollamaModel,
  testDraft,
} from "../src/agent.js";
import { importDefinitions } from "../src/migration.js";
import { Store } from "../src/store.js";
import { createAgentApi } from "../src/agent-api.js";
import { agentView } from "../public/agent-view.js";
// Exercise the legacy agent contract regardless of deployment profile.
const migrateWithAgent = (options) => runAgent({ config: modelConfiguration({}), ...options });
const source = JSON.parse(
  readFileSync(
    new URL("../fixtures/find-or-create-paths.json", import.meta.url),
  ),
);
const draft = () => {
  const d = importDefinitions(source)[0];
  d.steps.forEach((s) => (s.review_required = false));
  return d;
};
test("mapping review preserves decoded source semantics and accumulates approvals without bypassing unknown adapters", async () => {
  const d = importDefinitions(source)[0],
    choices = [
      { action: "review_mappings", ids: ["3"] },
      { action: "review_mappings", ids: ["6", "8"] },
    ];
  const result = await migrateWithAgent({
    definition: d,
    model: async () => choices.shift(),
    maxTurns: 2,
  });
  assert.equal(result.status, "draft_complete");
  assert.deepEqual(
    result.definition.steps.map((s) => s.params),
    d.steps.map((s) => s.params),
  );
  const bad = structuredClone(d);
  bad.steps[2].kind = "unsupported";
  const rejected = await migrateWithAgent({
    definition: bad,
    model: async () => ({ action: "review_mappings", ids: ["3"] }),
    maxTurns: 1,
  });
  assert.equal(rejected.status, "needs_work");
  assert.equal(rejected.code, null);
});
test("agent repairs a rejected proposal, tests independent requests, then produces code with complete source topology", async () => {
  const d = draft(),
    bad = structuredClone(d);
  bad.steps.pop();
  const choices = [
    { action: "propose", definition: bad },
    { action: "propose", definition: d },
    { action: "test" },
    { action: "finish" },
  ];
  const fixture = {
    name: "Miss",
    input: { email: " e@example.test ", name: "Member" },
    expected_status: "succeeded",
    expected_requests: [
      {
        url: "https://api.airtable.com/v0/app_example/Contacts?filterByFormula=%7BEmail%7D%3D%22e%40example.test%22&maxRecords=1&returnFieldsByFieldId=true",
        method: "GET",
        headers: { Authorization: "[redacted]" },
      },
      {
        url: "https://api.airtable.com/v0/app_example/Contacts",
        method: "POST",
        headers: {
          Authorization: "[redacted]",
          "Content-Type": "application/json",
        },
        body: '{"records":[{"fields":{"Email":"e@example.test","Name":"Member"}}]}',
      },
    ],
  };
  const result = await migrateWithAgent({
    definition: importDefinitions(source)[0],
    fixtures: [fixture],
    model: async () => choices.shift(),
  });
  assert.equal(result.status, "draft_complete");
  assert.equal(result.tests.passed, true);
  assert.match(result.code, /matched/);
  assert.equal(result.definition.steps.length, 8);
  assert.ok(result.log.some((e) => e.status === "rejected"));
  assert.equal(result.external_writes, false);
});
test("agent cannot invent supported replacements, discard branches, or claim completion without independent fixtures passing", async () => {
  const original = draft();
  original.steps[1].kind = "unsupported";
  original.steps[1].source_app = "UnknownAPI";
  const result = await migrateWithAgent({
    definition: original,
    model: async () => ({ action: "propose", definition: draft() }),
    maxTurns: 1,
  });
  assert.equal(result.status, "needs_work");
  assert.equal(result.code, null);
  assert.ok(result.plan.issues.some((i) => i.code === "mapping_review"));
  const choices = [
    { action: "propose", definition: draft() },
    { action: "test" },
    { action: "finish" },
  ];
  const failed = await migrateWithAgent({
    definition: draft(),
    fixtures: [
      { input: { email: "e", name: "n" }, expected_status: "filtered" },
    ],
    model: async () => choices.shift(),
    maxTurns: 3,
  });
  assert.equal(failed.status, "needs_work");
  assert.equal(failed.tests.passed, false);
});
test("Ollama endpoint stays local and the client uses schema-constrained bounded non-streaming inference", async () => {
  assert.throws(() =>
    modelConfiguration({ OLLAMA_URL: "https://remote.example.test" }),
  );
  assert.throws(() =>
    modelConfiguration({ OLLAMA_URL: "http://localhost:11434/redirect" }),
  );
  let request;
  const model = ollamaModel(modelConfiguration({}), async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        message: { content: '{"action":"finish","reason":"Complete"}' },
      }),
    };
  });
  assert.equal(
    (await model([{ role: "user", content: "Hello" }])).action,
    "finish",
  );
  const body = JSON.parse(request.options.body);
  assert.equal(body.stream, false);
  assert.equal(body.options.temperature, 0);
  assert.equal(body.format.type, "object");
  assert.equal(request.options.redirect, "error");
});
test("agent journal persists restart state and saving a draft respects optimistic versions without activation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "unzap-agent-")),
    store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = store.add(draft()),
    choices = [
      { action: "propose", definition: draft() },
      { action: "finish" },
    ],
    api = createAgentApi(store, { model: async () => choices.shift() }),
    job = api.start({ workflow_id: id, version: 1 });
  for (let i = 0; i < 10 && api.read(job.id).status === "running"; i++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(api.read(job.id).status, "draft_complete");
  assert.equal(api.apply(job.id).workflow_id, id);
  assert.equal(store.get(id).version, 2);
  assert.equal(store.get(id).active_version, null);
  assert.throws(() => api.apply(job.id));
  const interrupted = "test-interrupted";
  store.db
    .prepare("INSERT INTO agent_runs VALUES(?,?,?,?,?)")
    .run(
      interrupted,
      "running",
      store.seal({ log: [] }),
      new Date().toISOString(),
      new Date().toISOString(),
    );
  createAgentApi(store);
  assert.equal(api.read(interrupted).status, "interrupted");
});
test("description-generated drafts sanitize embedded credential values and display model evidence as escaped text", async () => {
  const d = {
    name: "New",
    steps: [
      { id: "1", parent_id: null, kind: "webhook", params: {} },
      {
        id: "2",
        parent_id: "1",
        kind: "http",
        params: {
          url: "https://example.test",
          method: "POST",
          headers: { Authorization: "sensitive-value-123" },
          data: { n: "{{1__n}}" },
        },
      },
    ],
  };
  const choices = [{ action: "propose", definition: d }, { action: "finish" }];
  const result = await migrateWithAgent({
    description: "Send a webhook to an approved endpoint",
    model: async () => choices.shift(),
  });
  assert.equal(result.status, "draft_complete");
  assert.ok(!JSON.stringify(result.definition).includes("sensitive-value-123"));
  assert.ok(result.bindings.includes("STEP_2_HEADERS_AUTHORIZATION"));
  const html = agentView(
    {},
    {},
    {
      status: "failed",
      model: "<svg onload=x>",
      log: [{ tool: "<script>", status: "rejected", detail: "<img src=x>" }],
      id: "a",
      error: "bad",
    },
    null,
  );
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});
