import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Runner } from "../src/runner.js";
import { importDefinitions, validate, compile } from "../src/migration.js";
import { requestFor, normalizeOutput, redact } from "../src/connectors.js";
import { bundle } from "../src/bundle.js";
import { gunzipSync } from "node:zlib";

test("common Airtable and Slack exports receive explicit reviewable proposals without dropping unknown options", () => {
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
        selected_api: "AirtableCLIAPI@3.15.0",
        action: "createRecord",
        params: {
          applicationId: "app_example",
          tableName: "Expenses",
          fields__Amount: "{{1__amount}}",
        },
      },
      3: {
        id: 3,
        parent_id: 2,
        selected_api: "SlackCLIAPI@1.39.3",
        action: "channel_message",
        params: {
          channel: "C_EXAMPLE",
          text: "Recorded {{2__id}}",
          unfurl: false,
        },
      },
    },
  };
  const d = importDefinitions(source)[0];
  assert.deepEqual(
    d.steps.map((s) => s.kind),
    ["webhook", "airtable", "slack"],
  );
  assert.equal(d.steps[1].params.fields.Amount, "{{1__amount}}");
  assert.equal(d.steps[2].params.unfurl, false);
  assert.equal(d.steps[1].source_params.tableName, "Expenses");
  assert.equal(validate(d).ready, false);
  d.steps.forEach((s) => (s.review_required = false));
  assert.equal(validate(d).ready, true);
  source.nodes[3].params.add_edit_link = true;
  assert.equal(importDefinitions(source)[0].steps[2].kind, "unsupported");
});

const source = JSON.parse(
  readFileSync(new URL("../fixtures/operations.json", import.meta.url)),
);
test("re-importing the same definition reuses the existing workflow and its versions", (t) => {
  const { store } = setup(t),
    d = importDefinitions(source.zaps[1])[0],
    id = store.add(d);
  store.save(id, { ...d, name: "Reviewed name" }, 1);
  assert.equal(store.add(d), id);
  assert.equal(store.list().length, 1);
  assert.equal(store.get(id).version, 2);
  assert.equal(store.get(id).name, "Reviewed name");
});
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "unzap-test-"));
  const store = new Store(dir);
  t.after(() => {
    try {
      store.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}
function workflow() {
  return {
    name: "Two writes",
    bindings: [],
    steps: [
      { id: "1", parent_id: null, kind: "webhook", params: {} },
      {
        id: "2",
        parent_id: "1",
        kind: "http",
        source_action: "post",
        params: {
          url: "https://example.test/first",
          method: "POST",
          data: { amount: "{{1__amount}}" },
        },
      },
      {
        id: "3",
        parent_id: "2",
        kind: "http",
        source_action: "post",
        params: {
          url: "https://example.test/second",
          method: "POST",
          headers: { Authorization: { $env: "SECOND_TOKEN" } },
          data: { receipt: "{{2__id}}" },
        },
      },
    ],
  };
}
test("import preserves all branches and unknown actions; ambiguous aliases remain blocked", () => {
  const defs = importDefinitions(source);
  assert.equal(defs.length, 3);
  assert.equal(defs[0].steps.length, 4);
  assert.equal(validate(defs[0]).ready, false);
  const w = structuredClone(source.zaps[1]);
  w.nodes["13"] = {
    id: 13,
    parent_id: 10,
    selected_api: "Unknown",
    action: "branch",
    params: {},
  };
  const d = importDefinitions(w)[0];
  assert.equal(d.steps.length, 4);
  assert.ok(validate(d).issues.some((i) => i.code === "branch"));
  assert.throws(() => compile(d));
  const alias = structuredClone(source.zaps[1]);
  alias.nodes["10"].meta = { $editor: { replaced_step_id: "99" } };
  alias.nodes["11"].params.filter_criteria[0].key = "{{99__status}}";
  assert.equal(validate(importDefinitions(alias)[0]).ready, true);
  alias.nodes["12"].triple_stores = { copied_from: 99 };
  assert.ok(
    validate(importDefinitions(alias)[0]).issues.some(
      (i) => i.code === "reference",
    ),
  );
});
test("compiled field mappings preserve object, number and boolean values", async (t) => {
  const { store } = setup(t),
    d = {
      name: "Types",
      steps: [
        { id: "1", parent_id: null, kind: "webhook", params: {} },
        {
          id: "2",
          parent_id: "1",
          kind: "transform",
          params: {
            fields: {
              n: "{{1__n}}",
              b: "{{1__b}}",
              record: '{{=gives["1"]["record"]}}',
            },
          },
        },
      ],
    };
  const id = store.add(d),
    r = await new Runner(store).start(id, {
      n: 25,
      b: false,
      record: { x: "y" },
    });
  assert.equal(r.status, "succeeded");
  assert.deepEqual(r.steps[1].output, { n: 25, b: false, record: { x: "y" } });
});
test("SaaS adapters build explicit requests and validate destination receipts", () => {
  const s = { kind: "slack" },
    p = { connection: "SLACK_TOKEN", channel: "C_EXAMPLE", text: "hello" };
  const request = requestFor(s, p, { SLACK_TOKEN: "private-token" });
  assert.equal(request.url, "https://slack.com/api/chat.postMessage");
  assert.deepEqual(JSON.parse(request.body), {
    channel: "C_EXAMPLE",
    text: "hello",
  });
  assert.throws(() => normalizeOutput(s, { ok: false, error: "invalid_auth" }));
  assert.equal(
    normalizeOutput(s, {
      ok: true,
      ts: "1700000001.000001",
      channel: "C_EXAMPLE",
    }).ts,
    "1700000001.000001",
  );
  assert.equal(
    requestFor(
      { kind: "airtable" },
      {
        connection: "A",
        base: "app1",
        table: "Expense items",
        fields: { Amount: 25 },
      },
      { A: "token" },
    ).url,
    "https://api.airtable.com/v0/app1/Expense%20items",
  );
  assert.throws(() => normalizeOutput({ kind: "airtable" }, { records: [] }));
  const redacted = redact(
    {
      headers: { Authorization: "Bearer private-token" },
      body: "private-token",
      url: "https://a.test/?api_key=hello",
    },
    { SLACK_TOKEN: "private-token" },
  );
  assert.ok(!JSON.stringify(redacted).includes("private-token"));
  assert.ok(!redacted.url.includes("hello"));
});
test("idempotency survives restart; completed writes are not sent again", async (t) => {
  const { dir, store } = setup(t),
    id = store.add(workflow());
  store.connect("SECOND_TOKEN", "Second", "sensitive-test-key");
  let effects = 0;
  const transport = async () => ({ id: "receipt-" + ++effects }),
    runner = new Runner(store, { transport });
  const [a, b] = await Promise.all([
    runner.start(id, { amount: 25 }, { key: "event-1", mode: "live" }),
    runner.start(id, { amount: 25 }, { key: "event-1", mode: "live" }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal(effects, 2);
  assert.equal(a.status, "succeeded");
  await assert.rejects(
    () => runner.start(id, { amount: 26 }, { key: "event-1", mode: "live" }),
    /different input/,
  );
  store.close();
  const reopened = new Store(dir);
  const duplicate = await new Runner(reopened, { transport }).start(
    id,
    { amount: 25 },
    { key: "event-1", mode: "live" },
  );
  assert.equal(duplicate.id, a.id);
  assert.equal(effects, 2);
  const bytes = readFileSync(join(dir, "unzap.sqlite")).toString("utf8");
  assert.ok(!bytes.includes("sensitive-test-key"));
  assert.ok(!bytes.includes("receipt-1"));
  reopened.close();
});
test("a safe held step can resume after a connection is supplied without repeating its first write", async (t) => {
  const { store } = setup(t),
    id = store.add(workflow());
  let effects = 0;
  const runner = new Runner(store, {
    transport: async () => ({ id: "receipt-" + ++effects }),
  });
  const held = await runner.start(id, { amount: 25 }, { mode: "live" });
  assert.equal(held.status, "held");
  assert.equal(effects, 1);
  assert.equal(held.steps[1].status, "succeeded");
  store.connect("SECOND_TOKEN", "Second", "new-token");
  const resumed = await runner.resume(held.id);
  assert.equal(resumed.status, "succeeded");
  assert.equal(effects, 2);
  assert.equal(resumed.steps[1].output.id, "receipt-1");
});
test("uncertain writes cannot resume until a verified destination receipt is recorded", async (t) => {
  const { store } = setup(t),
    id = store.add(workflow());
  store.connect("SECOND_TOKEN", "Second", "token");
  let effects = 0;
  const runner = new Runner(store, {
    transport: async () => {
      effects++;
      if (effects === 1)
        throw Object.assign(Error("timeout after send"), { uncertain: true });
      return { id: "second" };
    },
  });
  const run = await runner.start(id, { amount: 25 }, { mode: "live" });
  assert.equal(run.steps[1].status, "uncertain");
  await assert.rejects(() => runner.resume(run.id), /Reconcile/);
  assert.equal(effects, 1);
  runner.reconcile(run.id, "2", { id: "verified-first" });
  const resumed = await runner.resume(run.id);
  assert.equal(resumed.status, "succeeded");
  assert.equal(effects, 2);
  assert.equal(resumed.steps[1].output.id, "verified-first");
});
test("an unreadable successful HTTP write receipt is held as uncertain rather than retried", async (t) => {
  const { store } = setup(t),
    id = store.add(workflow());
  let effects = 0;
  const runner = new Runner(store, {
    transport: async () => {
      effects++;
      return [];
    },
  });
  const run = await runner.start(id, { amount: 25 }, { mode: "live" });
  assert.equal(run.status, "held");
  assert.equal(run.steps[1].status, "uncertain");
  assert.equal(effects, 1);
  await assert.rejects(() => runner.resume(run.id), /Reconcile/);
  assert.equal(effects, 1);
});
test("interrupted external steps become uncertain on startup and vault detects tampering", (t) => {
  const { dir, store } = setup(t),
    id = store.add(workflow()),
    run = "interrupted";
  store.db
    .prepare(
      "INSERT INTO runs(id,workflow_id,version,idempotency_key,fingerprint,input,mode,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(run, id, 1, "k", "h", store.seal({}), "live", "running", "2026-01-01");
  store.db
    .prepare(
      "INSERT INTO steps(run_id,step_id,kind,status,started_at) VALUES(?,?,?,?,?)",
    )
    .run(run, "2", "http", "running", "2026-01-01");
  const sealed = store.seal({ secret: "x" }),
    bytes = Buffer.from(sealed, "base64");
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => store.open(bytes.toString("base64")));
  store.close();
  const reopened = new Store(dir);
  assert.equal(reopened.run(run).status, "held");
  assert.equal(reopened.run(run).steps[0].status, "uncertain");
  reopened.close();
});
test("portable bundle contains executable native code and durable runtime, but no supplied credential", async () => {
  const d = importDefinitions(source.zaps[1])[0],
    bytes = await bundle(d),
    tar = gunzipSync(bytes).toString("utf8");
  assert.ok(tar.includes("workflow.mjs"));
  assert.ok(tar.includes("DatabaseSync"));
  assert.ok(tar.includes("Idempotency-Key"));
  assert.ok(!tar.includes("SYNTHETIC-TOKEN"));
  assert.ok(tar.includes("node:24.15.0-bookworm-slim"));
});
