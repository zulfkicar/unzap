import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Runner } from "../src/runner.js";
import { importDefinitions } from "../src/migration.js";
const source = JSON.parse(
  readFileSync(
    new URL("../fixtures/find-or-create-paths.json", import.meta.url),
  ),
);
test("recorded response bodies exercise update/create paths, persist securely, and cannot override live execution", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "unzap-response-replay-"));
  let store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const d = importDefinitions(source)[0];
  d.steps.forEach((s) => (s.review_required = false));
  const id = store.add(d),
    runner = new Runner(store),
    input = { email: " member@example.test ", name: "Member" };
  const responses = {
    3: {
      records: [
        { id: "rec_recorded", fields: { Name: "sensitive-replay-value" } },
      ],
    },
  };
  const found = await runner.start(id, input, { key: "recording", responses });
  assert.equal(found.status, "succeeded");
  assert.equal(found.steps.find((s) => s.step_id === "6").status, "succeeded");
  assert.equal(found.steps.find((s) => s.step_id === "8").status, "skipped");
  assert.deepEqual(found.responses, responses);
  const missing = await runner.start(id, input, {
    responses: { 3: { records: [] } },
  });
  assert.equal(
    missing.steps.find((s) => s.step_id === "8").status,
    "succeeded",
  );
  const malformed = await runner.start(id, input, { responses: { 3: null } });
  assert.equal(malformed.status, "held");
  await assert.rejects(
    () =>
      runner.start(id, input, {
        key: "recording",
        responses: { 3: { records: [] } },
      }),
    /different input/,
  );
  await assert.rejects(
    () => runner.start(id, input, { mode: "live", responses }),
    /only in mock mode/,
  );
  store.close();
  store = new Store(dir);
  const duplicate = await new Runner(store).start(id, input, {
    key: "recording",
    responses,
  });
  assert.equal(duplicate.id, found.id);
  assert.deepEqual(duplicate.responses, responses);
  assert.ok(
    !readFileSync(join(dir, "unzap.sqlite"))
      .toString()
      .includes("sensitive-replay-value"),
  );
});
