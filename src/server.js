import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { Runner } from "./runner.js";
import { importDefinitions, validate, compile, actions } from "./migration.js";
import { bindingsFor, bundle } from "./bundle.js";
import { secretise } from "./importer.js";
import { redact } from "./connectors.js";
import { decodeImport } from "./zip-import.js";
import { isDeepStrictEqual } from "node:util";
import { createAgentApi } from "./agent-api.js";
import { providers, accountBinding, inferProvider, assignAccount } from './accounts.js';
import { OAuthManager } from './oauth.js';
import { oauthApi } from './oauth-api.js';

const root = resolve(process.env.DATA_DIR || ".data/control");
await mkdir(root, { recursive: true });
const tokenPath = resolve(root, "login-token");
if (!existsSync(tokenPath))
  await writeFile(tokenPath, randomBytes(24).toString("base64url"), {
    mode: 0o600,
    flag: "wx",
  });
const token =
  process.env.CONTROL_TOKEN || readFileSync(tokenPath, "utf8").trim();
if (token.length < 24)
  throw Error("CONTROL_TOKEN must contain at least 24 characters.");
const store = new Store(root),oauth=new OAuthManager(store),oauthRoutes=oauthApi(oauth),
  runner = new Runner(store, {
    oauth,
    hosts: String(process.env.ALLOWED_HOSTS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  });
const publicOrigin=process.env.PUBLIC_ORIGIN?new URL(process.env.PUBLIC_ORIGIN):null;
if(publicOrigin&&(publicOrigin.username||publicOrigin.password||publicOrigin.search||publicOrigin.hash||publicOrigin.pathname!=='/'||publicOrigin.protocol!=='https:'))throw Error('PUBLIC_ORIGIN must be the trusted HTTPS origin of this installation');
const stopOAuthMaintenance=process.env.ENABLE_LIVE==='true'?oauth.startMaintenance():()=>{};
const sessions = new Set(),
  failedLogins = new Map();
const agentApi = createAgentApi(store);
function equal(a, b) {
  a = Buffer.from(String(a));
  b = Buffer.from(String(b));
  return a.length === b.length && timingSafeEqual(a, b);
}
const reply = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
};
async function body(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(Error("Upload exceeds the size limit."), {
        status: 413,
      });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Error("Expected valid JSON.");
  }
}
function summary(w) {
  const plan = validate(w.definition);
  return {
    id: w.id,
    name: w.name,
    version: w.version,
    active_version: w.active_version,
    mode: w.mode,
    steps: w.definition.steps.length,
    issues: plan.issues.length,
    ready: plan.ready,
    bindings: bindingsFor(w.definition),
    created_at: w.created_at,
  };
}
function fixtureRows(id) {
  return store.db
    .prepare("SELECT * FROM fixtures WHERE workflow_id=? ORDER BY created_at")
    .all(id)
    .map((f) => ({
      ...f,
      input: store.open(f.input),
      expected_requests: store.open(f.expected_requests),
      responses: store.open(f.responses),
      expected_outputs: store.open(f.expected_outputs),
    }));
}
function detail(id) {
  const w = store.get(id);
  if (!w) throw Object.assign(Error("Workflow not found"), { status: 404 });
  return {
    ...summary(w),
    definition: w.definition,
    plan: validate(w.definition),
    code: validate(w.definition).ready ? compile(w.definition) : null,
    versions: store.db
      .prepare(
        "SELECT version,created_at FROM versions WHERE workflow_id=? ORDER BY version DESC",
      )
      .all(id),
    fixtures: fixtureRows(id),
    checks: store.db
      .prepare("SELECT * FROM checks WHERE workflow_id=? AND version=?")
      .all(id, w.version),
    runs: store.db
      .prepare(
        "SELECT id,version,mode,status,error,created_at,finished_at FROM runs WHERE workflow_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(id),
  };
}
function addFixture(id, f) {
  if (!f.input || typeof f.input !== "object" || Array.isArray(f.input))
    throw Error("Fixture input must be an object.");
  if (!["succeeded", "filtered", "held"].includes(f.expected_status))
    throw Error("Choose an expected outcome.");
  if (f.expected_requests != null && !Array.isArray(f.expected_requests))
    throw Error("Expected requests must be an array.");
  for (const field of ["responses", "expected_outputs"])
    if (
      f[field] != null &&
      (typeof f[field] !== "object" || Array.isArray(f[field]))
    )
      throw Error(field + " must be a step-keyed object");
  store.db
    .prepare(
      "INSERT INTO fixtures(id,workflow_id,name,input,expected_status,expected_requests,created_at,responses,expected_outputs) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(
      randomUUID(),
      id,
      String(f.name || "Test case").slice(0, 120),
      store.seal(f.input),
      f.expected_status,
      f.expected_requests == null ? null : store.seal(f.expected_requests),
      new Date().toISOString(),
      f.responses == null ? null : store.seal(f.responses),
      f.expected_outputs == null ? null : store.seal(f.expected_outputs),
    );
}
function requestReceipt(run) {
  return run.steps
    .filter((s) => s.request)
    .map((s) => ({
      step_id: s.step_id,
      method: s.request.method,
      url: s.request.url,
      body: s.request.body ?? null,
    }));
}
async function demo() {
  if (store.list().length) return;
  const source = JSON.parse(
    await readFile(
      new URL("../fixtures/operations.json", import.meta.url),
      "utf8",
    ),
  );
  const defs = importDefinitions(source);
  // These adapters are hand-authored for the original synthetic example, not guessed from a private export.
  defs[0].steps[2] = {
    ...defs[0].steps[2],
    kind: "airtable",
    review_required: false,
    params: {
      base: "app_example",
      table: "Expenses",
      connection: "AIRTABLE_TOKEN",
      fields: {
        Reference: "{{1__reference}}",
        Amount: "{{1__amount}}",
        Team: "{{1__team}}",
      },
    },
  };
  defs[0].steps[3] = {
    ...defs[0].steps[3],
    kind: "slack",
    review_required: false,
    params: {
      connection: "SLACK_TOKEN",
      channel: "C_EXAMPLE",
      text: "Expense {{1__reference}} recorded as {{3__id}}",
    },
  };
  for (const [i, d] of defs.entries()) {
    const id = store.add(d);
    if (i === 0) {
      addFixture(id, {
        name: "Approved expense",
        input: {
          status: "approved",
          reference: "EXP-1042",
          amount: 125,
          team: "Operations",
        },
        expected_status: "succeeded",
        expected_requests: [
          {
            step_id: "3",
            method: "POST",
            url: "https://api.airtable.com/v0/app_example/Expenses",
            body: JSON.stringify({
              records: [
                {
                  fields: {
                    Reference: "EXP-1042",
                    Amount: 125,
                    Team: "Operations",
                  },
                },
              ],
            }),
          },
          {
            step_id: "4",
            method: "POST",
            url: "https://slack.com/api/chat.postMessage",
            body: JSON.stringify({
              channel: "C_EXAMPLE",
              text: "Expense EXP-1042 recorded as rec_demo_001",
            }),
          },
        ],
      });
      addFixture(id, {
        name: "Pending expense is filtered",
        input: { status: "pending" },
        expected_status: "filtered",
        expected_requests: [],
      });
      addFixture(id, {
        name: "Missing amount is held",
        input: { status: "approved", reference: "EXP-1042" },
        expected_status: "held",
        expected_requests: [],
      });
    }
  }
}
if (process.env.SEED_DEMO !== "false") await demo();
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    req.url === '/demo/worker.js'
      ? "default-src 'none'; script-src 'self' blob:; connect-src 'none'; base-uri 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  const host = String(req.headers.host || ""),
    allowedHosts = String(
      process.env.CONTROL_HOSTS || "127.0.0.1,localhost",
    ).split(",").map(v=>v.trim());
  let hostName;
  try{hostName=new URL('http://'+host).hostname;}catch{return reply(res,403,{error:'Invalid Host'});}
  if (!allowedHosts.includes(hostName)&&hostName!==publicOrigin?.hostname)
    return reply(res, 403, { error: "Host is not allowed." });
  const url = new URL(req.url, "http://" + host),
    path = url.pathname;
  const origin=publicOrigin&&new URL(publicOrigin.protocol+'//'+host).origin===publicOrigin.origin?publicOrigin.origin:'http://'+host;
  try {
    if (
      [
        "/",
        "/app.js",
        "/workbench.js",
        "/agent-view.js",
        "/connections-view.js",
        "/oauth-view.js",
        "/style.css",
        "/demo/",
        "/demo/index.html",
        "/demo/demo.css",
        "/demo/demo.js",
        "/demo/worker.js",
        "/demo/engine.js",
        "/demo/sample.json",
        ...['migration.js','importer.js','import-adapters.js','graph-compiler.js','runtime.js','connectors.js','runner.js','store.js','oauth.js','oauth-store.js','agent-api.js'].map(name=>'/demo/source/src-'+name+'.txt'),
        ...['branch-adapters.test.js','restart-adapters.test.js','oauth.test.js','browser-demo.test.js'].map(name=>'/demo/source/test-'+name+'.txt'),
      ].includes(path) &&
      req.method === "GET"
    ) {
      const file = path === "/" ? "index.html" : path === "/demo/" ? "demo/index.html" : path.slice(1),
        data = await readFile(new URL("../public/" + file, import.meta.url));
      res.writeHead(200, {
        "Content-Type": {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".txt": "text/plain; charset=utf-8",
        }[extname(file)],
        "Cache-Control": "no-store",
      });
      return res.end(data);
    }
    // Webhooks use a workflow-specific bearer token, not a browser session.
    if(await oauthRoutes.callback(req,res,url,origin))return;
    const webhook = path.match(/^\/hooks\/([a-f0-9-]+)$/);
    if (webhook && req.method === "POST") {
      const w = store.get(webhook[1]),
        secret = w
          ? store.open(
              store.db
                .prepare("SELECT webhook_secret FROM workflows WHERE id=?")
                .get(w.id).webhook_secret,
            )
          : "";
      if (!w || !equal(req.headers.authorization, "Bearer " + secret))
        return reply(res, 401, { error: "Bearer authentication required." });
      if (!w.active_version)
        return reply(res, 409, {
          error: "Activate a tested version before accepting webhooks.",
        });
      if (!req.headers["idempotency-key"])
        return reply(res, 400, { error: "Idempotency-Key is required." });
      const run = await runner.start(w.id, await body(req), {
        key: req.headers["idempotency-key"],
        mode: w.mode,
        version: w.active_version,
      });
      return reply(res, 200, {
        id: run.id,
        status: run.status,
        error: run.error,
      });
    }
    if (
      req.method !== "GET" &&
      (req.headers.origin !== origin ||
        req.headers["sec-fetch-site"] === "cross-site")
    )
      return reply(res, 403, { error: "Same-origin request required." });
    if (path === "/api/session" && req.method === "POST") {
      const address = req.socket.remoteAddress,
        now = Date.now(),
        record = failedLogins.get(address) || { count: 0, until: now + 60000 };
      if (record.until < now) {
        record.count = 0;
        record.until = now + 60000;
      }
      if (record.count >= 10)
        return reply(res, 429, { error: "Too many attempts. Wait a minute." });
      const input = await body(req);
      if (!equal(input.token, token)) {
        record.count++;
        failedLogins.set(address, record);
        return reply(res, 401, { error: "The control token is incorrect." });
      }
      const session = randomBytes(32).toString("base64url");
      sessions.add(session);
      res.setHeader(
        "Set-Cookie",
        `un_session=${session}; HttpOnly; SameSite=Strict; Path=/${origin.startsWith('https:')?'; Secure':''}`,
      );
      return reply(res, 200, { ok: true });
    }
    const cookie = String(req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("un_session="))
      ?.slice(11);
    if (
      !sessions.has(cookie) &&
      !equal(req.headers.authorization, "Bearer " + token)
    )
      return reply(res, 401, { error: "Sign in to the local control panel." });
    if(await oauthRoutes.authenticated(req,res,path,origin,body,reply))return;
    if (path === "/api/session" && req.method === "DELETE") {
      oauthRoutes.logout(req);
      sessions.delete(cookie);
      res.setHeader(
        "Set-Cookie",
        ["un_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0","un_oauth_browser=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"],
      );
      return reply(res, 200, { ok: true });
    }
    if (path === "/api/state")
      return reply(res, 200, {
        connections: store.connections(),
        providers,
        oauth:oauth.status(origin),
        actions,
        live_enabled: process.env.ENABLE_LIVE === "true",
        hosts: runner.hosts,
        stats: {
          workflows: store.db
            .prepare("SELECT count(*) AS n FROM workflows")
            .get().n,
          runs: store.db.prepare("SELECT count(*) AS n FROM runs").get().n,
        },
      });
    if (path === "/api/workflows" && req.method === "GET") {
      const search = String(url.searchParams.get("q") || "").slice(0, 200),
        offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const rows = store.db
        .prepare(
          "SELECT id FROM workflows WHERE name LIKE ? ORDER BY created_at DESC LIMIT 100 OFFSET ?",
        )
        .all("%" + search + "%", offset)
        .map((r) => summary(store.get(r.id)));
      return reply(res, 200, {
        rows,
        total: store.db
          .prepare("SELECT count(*) AS n FROM workflows WHERE name LIKE ?")
          .get("%" + search + "%").n,
      });
    }
    if (path === "/api/agent" && req.method === "GET")
      return reply(res, 200, {
        configuration: await agentApi.health(),
        runs: agentApi.list(),
      });
    if (path === "/api/agent/example" && req.method === "POST") {
      const source = JSON.parse(
        await readFile(
          new URL("../fixtures/find-or-create-paths.json", import.meta.url),
          "utf8",
        ),
      );
      const id = store.add(importDefinitions(source)[0]);
      if (!fixtureRows(id).length)
        for (const f of JSON.parse(
          await readFile(
            new URL("../fixtures/find-or-create-inputs.json", import.meta.url),
            "utf8",
          ),
        ))
          addFixture(id, f);
      return reply(res, 201, { workflow_id: id });
    }
    if (path === "/api/agent/runs" && req.method === "POST") {
      const b = await body(req, 512 * 1024);
      if (b.workflow_id)
        b.fixtures = fixtureRows(b.workflow_id).map((f) => ({
          name: f.name,
          input: f.input,
          expected_status: f.expected_status,
          expected_requests: f.expected_requests,
          responses: f.responses,
          expected_outputs: f.expected_outputs,
        }));
      return reply(res, 202, agentApi.start(b));
    }
    const agentMatch = path.match(
      /^\/api\/agent\/runs\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
    );
    if (agentMatch) {
      const [, id, operation] = agentMatch;
      if (!operation && req.method === "GET")
        return reply(res, 200, agentApi.read(id));
      if (operation === "apply" && req.method === "POST")
        return reply(res, 200, agentApi.apply(id));
      if (operation === "cancel" && req.method === "POST")
        return reply(res, 200, agentApi.cancel(id));
    }
    if (path === "/api/import" && req.method === "POST") {
      const definitions = importDefinitions(
        decodeImport(await body(req, 70 * 1024 * 1024)),
      );
      const before = store.db
        .prepare("SELECT count(*) AS n FROM workflows")
        .get().n;
      const ids = definitions.map((d) => store.add(d));
      const added =
        store.db.prepare("SELECT count(*) AS n FROM workflows").get().n -
        before;
      return reply(res, 201, {
        imported: added,
        existing: ids.length - added,
        ready: definitions.filter((d) => validate(d).ready).length,
        ids: ids.slice(0, 100),
      });
    }
    if (path === "/api/connections" && req.method === "POST") {
      const b = await body(req);
      const provider=b.provider || inferProvider(b.binding || '');
      if (!Object.hasOwn(providers,provider)) throw Error('Choose an app');
      const binding=b.binding || accountBinding(provider,b.label);
      const existing=store.connections().find(c=>c.binding===binding);
      if (['create','edit'].includes(b.operation) && (typeof b.label!=='string'||!b.label.trim())) throw Error('Enter an account name');
      if (b.operation==='create' && existing) throw Error('That binding already exists. Edit the saved account instead.');
      if (b.operation==='edit' && !existing) throw Error('Account not found');
      if (existing && existing.provider!==provider) throw Error('Existing accounts cannot change apps');
      if (existing && !b.secret) {
        if (typeof b.label!=='string'||!b.label.trim()) throw Error('Enter an account name');
        store.db.prepare('UPDATE connections SET label=? WHERE binding=?').run(b.label.trim().slice(0,120),binding);
      } else store.connect(binding,b.label,b.secret,provider);
      return reply(res, 201, { binding, connections: store.connections() });
    }
    if (path === "/api/connections" && req.method === "DELETE") {
      const b = await body(req);
      store.db
        .prepare("DELETE FROM connections WHERE binding=?")
        .run(b.binding);
      return reply(res, 200, { ok: true });
    }
    if (path === "/api/runs")
      return reply(
        res,
        200,
        store.db
          .prepare(
            "SELECT r.id,r.workflow_id,r.version,r.mode,r.status,r.error,r.created_at,r.finished_at,w.name FROM runs r JOIN workflows w ON w.id=r.workflow_id ORDER BY r.created_at DESC LIMIT 200",
          )
          .all(),
      );
    const match = path.match(/^\/api\/workflows\/([a-f0-9-]+)(?:\/(\w+))?$/);
    if (match) {
      const [, id, action] = match,
        w = store.get(id);
      if (!w) throw Object.assign(Error("Workflow not found"), { status: 404 });
      if (!action && req.method === "GET") return reply(res, 200, detail(id));
      if (!action && req.method === "PUT") {
        const b = await body(req, 512 * 1024),
          d = b.definition;
        if (
          !d ||
          !Array.isArray(d.steps) ||
          d.steps.length > 500 ||
          typeof d.name !== "string" ||
          !d.name.trim() ||
          d.name.length > 200
        )
          throw Error("Invalid workflow definition.");
        const bindings = [];
        for (const s of d.steps) {
          if (
            !s ||
            typeof s.id !== "string" ||
            typeof s.kind !== "string" ||
            typeof s.params !== "object" ||
            !s.params ||
            Array.isArray(s.params)
          )
            throw Error("Invalid step.");
          s.params = secretise(s.params, [], s.id, bindings);
        }
        d.bindings = bindings;
        d.source_hash = w.definition.source_hash;
        store.save(id, d, b.version);
        return reply(res, 200, detail(id));
      }
      if (action === "fixtures" && req.method === "POST") {
        addFixture(id, await body(req));
        return reply(res, 201, detail(id));
      }
      if (action === 'connections' && req.method === 'POST') {
        const b=await body(req), account=store.connections().find(c=>c.binding===b.binding);
        if (!account) throw Error('Add this account before assigning it');
        const d=assignAccount(w.definition,b.step_ids,account);
        d.bindings=bindingsFor(d).map(name=>({name}));
        store.save(id,d,b.version);
        return reply(res,200,detail(id));
      }
      if (action === "check" && req.method === "POST") {
        const fs = fixtureRows(id);
        if (!fs.length) throw Error("Add a test fixture first.");
        for (const f of fs) {
          const run = await runner.start(id, f.input, {
              mode: "mock",
              responses: f.responses || undefined,
            }),
            receipt = requestReceipt(run);
          const passed =
            run.status === f.expected_status &&
            (f.expected_outputs == null ||
              Object.entries(f.expected_outputs).every(([stepId, value]) =>
                isDeepStrictEqual(
                  run.steps.find((s) => s.step_id === stepId)?.output,
                  value,
                ),
              )) &&
            (f.expected_requests == null ||
              isDeepStrictEqual(receipt, f.expected_requests));
          store.db
            .prepare(
              "INSERT INTO checks VALUES(?,?,?,?,?,?) ON CONFLICT(workflow_id,version,fixture_id) DO UPDATE SET passed=excluded.passed,run_id=excluded.run_id,created_at=excluded.created_at",
            )
            .run(
              id,
              w.version,
              f.id,
              passed ? 1 : 0,
              run.id,
              new Date().toISOString(),
            );
        }
        return reply(res, 200, detail(id));
      }
      if (action === "replay" && req.method === "POST") {
        const b = await body(req);
        return reply(
          res,
          200,
          redact(
            await runner.start(id, b.input, {
              key: b.key || randomUUID(),
              mode: "mock",
            }),
            store.secrets(),
          ),
        );
      }
      if (action === "activate" && req.method === "POST") {
        const b = await body(req),
          fs = fixtureRows(id),
          checks = store.db
            .prepare("SELECT * FROM checks WHERE workflow_id=? AND version=?")
            .all(id, w.version);
        if (
          !validate(w.definition).ready ||
          !fs.length ||
          fs.some(
            (f) => !checks.some((c) => c.fixture_id === f.id && c.passed),
          ) ||
          !fs.some(
            (f) =>
              f.expected_status === "succeeded" && f.expected_requests != null,
          )
        )
          throw Error(
            "All fixtures must pass on this version, including a successful case with expected outgoing requests.",
          );
        const mode = b.mode || "mock";
        if (!["mock", "live"].includes(mode)) throw Error("Invalid mode.");
        if (mode === "live") {
          if (process.env.ENABLE_LIVE !== "true")
            throw Error("Live execution is disabled on this installation.");
          if (bindingsFor(w.definition).some((name) => !store.secrets()[name]))
            throw Error(
              "Configure every required connection before live activation.",
            );
          if (!runner.hosts.length)
            throw Error("Configure ALLOWED_HOSTS before live activation.");
        }
        store.db
          .prepare("UPDATE workflows SET active_version=?,mode=? WHERE id=?")
          .run(w.version, mode, id);
        return reply(res, 200, detail(id));
      }
      if (action === "pause" && req.method === "POST") {
        store.db
          .prepare("UPDATE workflows SET active_version=NULL WHERE id=?")
          .run(id);
        return reply(res, 200, detail(id));
      }
      if (action === "endpoint" && req.method === "GET")
        return reply(res, 200, {
          url: "http://" + host + "/hooks/" + id,
          token: store.open(
            store.db
              .prepare("SELECT webhook_secret FROM workflows WHERE id=?")
              .get(id).webhook_secret,
          ),
        });
      if (action === "bundle" && req.method === "GET") {
        const data = await bundle(w.definition);
        res.writeHead(200, {
          "Content-Type": "application/gzip",
          "Content-Disposition": 'attachment; filename="owned-workflow.tar.gz"',
          "Cache-Control": "no-store",
        });
        return res.end(data);
      }
      if (action === "version" && req.method === "POST") {
        const b = await body(req),
          old = store.get(id, Number(b.version));
        store.save(id, old.definition, w.version);
        return reply(res, 200, detail(id));
      }
    }
    const runMatch = path.match(
      /^\/api\/runs\/([a-f0-9-]+)(?:\/(resume|reconcile))?$/,
    );
    if (runMatch) {
      const [, id, action] = runMatch;
      if (!action && req.method === "GET") {
        const run = store.run(id);
        if (!run) throw Object.assign(Error("Run not found"), { status: 404 });
        return reply(res, 200, redact(run, store.secrets()));
      }
      if (action === "resume" && req.method === "POST")
        return reply(
          res,
          200,
          redact(await runner.resume(id), store.secrets()),
        );
      if (action === "reconcile" && req.method === "POST") {
        const b = await body(req);
        runner.reconcile(id, b.step_id, b.output);
        return reply(res, 200, redact(store.run(id), store.secrets()));
      }
    }
    reply(res, 404, { error: "Not found" });
  } catch (e) {
    reply(res, e.status || 400, { error: e.message || "Request failed" });
  }
});
server.listen(
  Number(process.env.PORT || 8874),
  process.env.HOST || "127.0.0.1",
  () =>
    console.log(
      JSON.stringify({
        service: "unzap",
        port: server.address().port,
        login_token_file: tokenPath,
        live_enabled: process.env.ENABLE_LIVE === "true",
      }),
    ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    (stopOAuthMaintenance(),
    server.close(() => {
      store.close();
      process.exit(0);
    })),
  );
