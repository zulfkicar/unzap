import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
test("restart classifies newly added write adapters as uncertain while search is safely resumable", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "unzap-adapter-restart-"));
  let store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const id = store.add({
    name: "Restart",
    steps: [{ id: "1", parent_id: null, kind: "webhook", params: {} }],
  });
  store.db
    .prepare(
      "INSERT INTO runs(id,workflow_id,version,idempotency_key,fingerprint,input,mode,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      "r",
      id,
      1,
      "k",
      "h",
      store.seal({}),
      "live",
      "running",
      new Date().toISOString(),
    );
  for (const [step, kind] of [
    ["3", "airtable_find"],
    ["6", "airtable_update"],
    ['7__join', 'slack_join'],
    ['8', 'sheets_append'],
    ['9', 'sheets_update'],
    ['8__sheet', 'sheets_resolve'],
  ])
    store.db
      .prepare(
        "INSERT INTO steps(run_id,step_id,kind,status,started_at) VALUES(?,?,?,?,?)",
      )
      .run("r", step, kind, "running", new Date().toISOString());
  store.close();
  store = new Store(dir);
  const rows = store.run("r").steps;
  assert.equal(rows.find((s) => s.step_id === "6").status, "uncertain");
  assert.equal(rows.find((s) => s.step_id === "3").status, "held");
  for (const id of ['7__join','8','9']) assert.equal(rows.find(s=>s.step_id===id).status,'uncertain');
  assert.equal(rows.find(s=>s.step_id==='8__sheet').status,'held');
});
