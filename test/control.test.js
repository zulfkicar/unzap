import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";

const token = "synthetic-control-token-for-tests";
async function service(t, file, cwd, env) {
  const child = spawn(process.execPath, [file], {
    cwd,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (b) => (errors += b));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  };
  t.after(stop);
  const ready = await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(() => {
      throw Error("Startup failed: " + errors);
    }),
  ]);
  return {
    base: "http://127.0.0.1:" + JSON.parse(String(ready[0])).port,
    stop,
  };
}
test("control API requires authentication, tests a version, activates it and enforces webhook idempotency", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "unzap-control-"));
  const { base, stop } = await service(
    t,
    new URL("../src/server.js", import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/,
      "$1",
    ),
    process.cwd(),
    { DATA_DIR: dir, CONTROL_TOKEN: token },
  );
  const request = async (path, body, auth = true, origin = base) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(auth ? { Authorization: "Bearer " + token } : {}),
        Origin: origin,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await request("/api/state", undefined, false)).status, 401);
  assert.equal(
    (await request("/api/session", { token }, false, "https://other.example"))
      .status,
    403,
  );
  const login = await request("/api/session", { token }, false);
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const list = await (await request("/api/workflows")).json(),
    id = list.rows.find((w) => w.name.startsWith("Approved")).id;
  assert.equal(
    (await request("/api/workflows/" + id + "/activate", {})).status,
    400,
  );
  const initial = await (await request('/api/workflows/' + id)).json();
  const reordered = { ...initial.fixtures[0], name: 'Equivalent request object key order',
    expected_requests: initial.fixtures[0].expected_requests.map(r=>({body:r.body,url:r.url,method:r.method,step_id:r.step_id})) };
  assert.equal((await request('/api/workflows/'+id+'/fixtures',reordered)).status,201);
  const checks = await (
    await request("/api/workflows/" + id + "/check", {})
  ).json();
  assert.equal(checks.checks.length, 4);
  assert.ok(checks.checks.every((c) => c.passed));
  assert.equal(
    (await request("/api/workflows/" + id + "/activate", { mode: "live" }))
      .status,
    400,
  );
  const active = await (
    await request("/api/workflows/" + id + "/activate", { mode: "mock" })
  ).json();
  assert.equal(active.active_version, 1);
  const endpoint = await (
      await request("/api/workflows/" + id + "/endpoint")
    ).json(),
    input = checks.fixtures[0].input;
  const hook = (auth = true, key = "unique-event", event = input) =>
    fetch(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...(auth ? { Authorization: "Bearer " + endpoint.token } : {}),
      },
      body: JSON.stringify(event),
    });
  assert.equal((await hook(false)).status, 401);
  const a = await (await hook()).json(),
    b = await (await hook()).json();
  assert.equal(a.status, "succeeded");
  assert.equal(a.id, b.id);
  assert.equal(
    (await hook(true, "unique-event", { ...input, amount: 126 })).status,
    409,
  );
  const receipt = await (await request("/api/runs/" + a.id)).json();
  assert.equal(receipt.steps.filter((s) => s.request).length, 2);
  assert.equal(receipt.steps[2].request.headers.Authorization, "[redacted]");
  const changed = structuredClone(checks.definition);
  changed.name = "Updated draft";
  const put = () =>
    fetch(base + "/api/workflows/" + id, {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        Origin: base,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, definition: changed }),
    });
  assert.equal((await put()).status, 200);
  assert.equal((await put()).status, 409);
  const latest = await (await request("/api/workflows/" + id)).json();
  assert.equal(latest.version, 2);
  assert.equal(latest.active_version, 1);
  assert.equal(latest.checks.length, 0);
  assert.equal(
    (await request("/api/workflows/" + id + "/activate", {})).status,
    400,
  );
  assert.equal((await hook(true, "new-event")).status, 200);
  const bundle = await request("/api/workflows/" + id + "/bundle");
  assert.equal(bundle.headers.get("content-type"), "application/gzip");
  assert.ok((await bundle.arrayBuffer()).byteLength > 1000);
  await stop();
  rmSync(dir, { recursive: true, force: true });
});
test("downloaded project boots independently and retains duplicate protection across a process restart", async (t) => {
  const { bundle } = await import("../src/bundle.js"),
    { importDefinitions } = await import("../src/migration.js");
  const input = JSON.parse(
      readFileSync(
        new URL("../fixtures/webhook-filter-http.json", import.meta.url),
      ),
    ),
    def = importDefinitions(input)[0];
  const archive = gunzipSync(await bundle(def)),
    dir = mkdtempSync(join(tmpdir(), "unzap-owned-"));
  for (let i = 0; i < archive.length - 512;) {
    const header = archive.subarray(i, i + 512),
      name = header.subarray(0, 100).toString().split("\0")[0];
    if (!name) break;
    assert.ok(!name.includes("..") && !name.startsWith("/"));
    const size = parseInt(
        header.subarray(124, 136).toString().replaceAll("\0", "").trim(),
        8,
      ),
      path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, archive.subarray(i + 512, i + 512 + size));
    i += 512 + Math.ceil(size / 512) * 512;
  }
  const env = {
    WEBHOOK_TOKEN: "synthetic-export-token-123",
    OUTBOUND_MODE: "mock",
    STEP_3_HEADERS_AUTHORIZATION: "synthetic-secret",
  };
  let running = await service(t, join(dir, "server.mjs"), dir, env);
  const event = {
    status: "ready",
    event_id: "portable-🇵🇰",
    amount: 25,
    active: true,
  };
  const send = () =>
    fetch(running.base + "/webhook", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.WEBHOOK_TOKEN,
        "Idempotency-Key": "portable-event",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
  const first = await (await send()).json();
  assert.equal(first.status, "succeeded");
  await running.stop();
  running = await service(t, join(dir, "server.mjs"), dir, env);
  const repeated = await (await send()).json();
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.status, "succeeded");
  const history = await fetch(running.base + "/runs", {
    headers: { Authorization: "Bearer " + env.WEBHOOK_TOKEN },
  });
  assert.equal((await history.json()).length, 1);
  await running.stop();
  rmSync(dir, { recursive: true, force: true });
});
