import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importDefinitions, validate } from "../src/migration.js";
import { Store } from "../src/store.js";
import { Runner } from "../src/runner.js";
import { requestFor, normalizeOutput } from "../src/connectors.js";
import { resolve, httpRequest } from "../src/runtime.js";
import { graph, fieldShelf } from "../public/workbench.js";
const source = JSON.parse(
    readFileSync(
      new URL("../fixtures/slack-thread-export.json", import.meta.url),
      "utf8",
    ),
  ),
  input = JSON.parse(
    readFileSync(
      new URL("../fixtures/ticket-webhook-input.json", import.meta.url),
      "utf8",
    ),
  );
test("export-derived dotted fields, thread timestamps and raw Slack requests survive native compilation", async (t) => {
  const d = importDefinitions(source)[0];
  assert.equal(d.steps[2].kind, "slack");
  assert.equal(validate(d).ready, false);
  d.steps[2].review_required = false;
  assert.equal(validate(d).ready, true);
  const directory = mkdtempSync(join(tmpdir(), "unzap-contract-"));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = store.add(d);
  const run = await new Runner(store).start(id, input);
  assert.equal(run.status, "succeeded");
  const request = run.steps.find((s) => s.request).request;
  assert.equal(request.url, "https://slack.com/api/chat.postMessage");
  assert.deepEqual(JSON.parse(request.body), {
    channel: "C_SUPPORT",
    text: input["message.last"],
    thread_ts: input["message.create_source_id"],
    unfurl_links: false,
    unfurl_media: false,
  });
  assert.equal(request.headers.Authorization, "[redacted]");
  const filtered = await new Runner(store).start(id, {
    ...input,
    "message.ticket_status": "closed",
  });
  assert.equal(filtered.status, "filtered");
  assert.equal(filtered.steps.filter((s) => s.request).length, 0);
});
test("native mappings preserve flattened dotted keys and line-item arrays without inventing projection semantics", () => {
  assert.equal(
    resolve('{{=gives["100"]["message.last"]}}', { 100: input }),
    input["message.last"],
  );
  assert.deepEqual(
    resolve('{{=gives["100"]["assignment"]["events[]message_time"]}}', {
      100: input,
    }),
    input.assignment["events[]message_time"],
  );
  assert.throws(
    () =>
      resolve('{{=gives["100"]["sla_details[]sla_times"]["missing"]}}', {
        100: input,
      }),
    /Missing/,
  );
});
test("Slack success needs a valid receipt and malformed rich payloads hold before network delivery", () => {
  assert.throws(
    () => normalizeOutput({ kind: "slack" }, { ok: true }),
    /receipt/,
  );
  assert.throws(
    () =>
      requestFor(
        { kind: "slack" },
        {
          channel: "C_SUPPORT",
          text: "reply",
          thread_ts: 123,
          connection: "S",
        },
        { S: "placeholder" },
      ),
    /timestamp/,
  );
  assert.throws(
    () =>
      requestFor(
        { kind: "slack" },
        { channel: "C_SUPPORT", text: "reply", blocks: {}, connection: "S" },
        { S: "placeholder" },
      ),
    /array/,
  );
});
test("unsupported raw Slack methods or options cannot disappear into a proposed mapping", () => {
  for (const mutate of [
    (w) => (w.nodes["102"].params.method = "DELETE"),
    (w) => (w.nodes["102"].params.url = "https://other.example.test/api"),
    (w) => (w.nodes["102"].params.body = "{{unknown_body}}"),
  ]) {
    const w = structuredClone(source.zaps[0]);
    mutate(w);
    assert.equal(importDefinitions(w)[0].steps[2].kind, "unsupported");
  }
});
test("source graph renders every branch and field selectors encode hostile labels as text", () => {
  const nodes = [
    { id: "1", parent_id: null, name: "Trigger", kind: "webhook" },
    { id: "2", parent_id: "1", name: "<script>", kind: "unsupported" },
    { id: "3", parent_id: "1", name: "Other path", kind: "filter" },
  ];
  const html = graph(nodes, "2", []);
  assert.match(html, /2 paths/);
  assert.match(html, /data-step="3"/);
  assert.ok(!html.includes("<script>"));
  assert.match(fieldShelf({ "<img>": "value" }, "1"), /&lt;img&gt;/);
});

test("HTTP JSON serialization preserves false, zero and null payloads", () => {
  for (const value of [false, 0, null])
    assert.equal(
      httpRequest(
        { action: "post" },
        { url: "https://example.test", payload_type: "json", data: value },
      ).body,
      JSON.stringify(value),
    );
  assert.throws(
    () =>
      httpRequest({ action: "post" }, { payload_type: "form", data: false }),
    /object/,
  );
});
