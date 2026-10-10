import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { analyse } from "../src/importer.js";
import { writeProject } from "../src/emitter.js";
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/webhook-filter-http.json", import.meta.url),
  ),
);
test("the generated webhook enforces bearer auth and single-process idempotency", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "zap-service-test-"));
  await writeProject(analyse(fixture.zaps[0]), directory);
  const child = spawn(process.execPath, [join(directory, "server.mjs")], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      WEBHOOK_TOKEN: "synthetic-test-token-123",
      OUTBOUND_MODE: "mock",
      STEP_3_HEADERS_AUTHORIZATION: "Bearer synthetic-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, "exit");
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const ready = await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("Generated service failed to start");
    }),
  ]);
  const port = JSON.parse(String(ready[0])).port,
    base = `http://127.0.0.1:${port}`,
    input = {
      status: "ready",
      event_id: "synthetic-🇵🇰",
      amount: 25,
      active: true,
    };
  const send = (body = input, auth = true) =>
    fetch(base + "/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "same-event",
        ...(auth ? { Authorization: "Bearer synthetic-test-token-123" } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal((await send(input, false)).status, 401);
  const [first, second] = await Promise.all([send(), send()]);
  const a = await first.json(),
    b = await second.json();
  assert.equal(a.status, "succeeded");
  assert.equal(a.id, b.id);
  assert.equal(a.outputs["1"].event_id, "synthetic-🇵🇰");
  assert.equal((await send({ ...input, amount: 26 })).status, 409);
  const history = await fetch(base + "/runs", {
    headers: { Authorization: "Bearer synthetic-test-token-123" },
  });
  assert.equal((await history.json()).length, 1);
});
