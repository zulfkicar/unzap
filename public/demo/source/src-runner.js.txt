import { randomUUID } from "node:crypto";
import { digest } from "./importer.js";
import { compile, validate } from "./migration.js";
import { createContext } from "./runtime.js";
import {
  requestFor,
  normalizeOutput,
  mockResponse,
  redact,
  send,
} from "./connectors.js";

export class Runner {
  constructor(store, { hosts = [], transport, workflow, oauth } = {}) {
    this.store = store;
    this.hosts = hosts;
    this.transport = transport;
    this.workflow = workflow;
    this.oauth = oauth;
    this.pending = new Map();
  }
  async start(
    workflowId,
    input,
    { key = randomUUID(), mode = "mock", version, resumeId, responses } = {},
  ) {
    const store = this.store,
      w = store.get(workflowId, version);
    if (!w) throw Error("Workflow not found");
    if (!validate(w.definition).ready)
      throw Error("Resolve migration issues before running.");
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("Input must be a JSON object.");
    if (!["mock", "live"].includes(mode))
      throw Error("Unknown execution mode.");
    if (
      responses != null &&
      (mode !== "mock" ||
        typeof responses !== "object" ||
        Array.isArray(responses))
    )
      throw Error("Response fixtures are available only in mock mode");
    if (typeof key !== "string" || !key || key.length > 200)
      throw Error("Use an idempotency key of 1–200 characters.");
    let id = resumeId;
    if (id) {
      const old = store.run(id);
      if (
        !old ||
        old.workflow_id !== workflowId ||
        old.status !== "held" ||
        old.mode !== mode ||
        old.version !== w.selected_version
      )
        throw Error("This run cannot be resumed.");
      if (old.steps.some((s) => s.status === "uncertain"))
        throw Error("Reconcile uncertain writes before resuming.");
      store.db
        .prepare(
          "UPDATE runs SET status='running',error=NULL,finished_at=NULL WHERE id=?",
        )
        .run(id);
    } else {
      const existing = store.db
        .prepare(
          "SELECT id,fingerprint FROM runs WHERE workflow_id=? AND idempotency_key=?",
        )
        .get(workflowId, key);
      if (existing) {
        if (
          existing.fingerprint !==
          digest({ input, mode, version: w.selected_version, responses })
        )
          throw Object.assign(
            Error(
              "Idempotency key is already attached to different input or configuration.",
            ),
            { status: 409 },
          );
        if (this.pending.has(existing.id)) await this.pending.get(existing.id);
        return store.run(existing.id);
      }
      id = randomUUID();
      store.db
        .prepare(
          "INSERT INTO runs(id,workflow_id,version,idempotency_key,fingerprint,input,mode,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          workflowId,
          w.selected_version,
          key,
          digest({ input, mode, version: w.selected_version, responses }),
          store.seal(input),
          mode,
          "running",
          new Date().toISOString(),
        );
      if (responses != null)
        store.db
          .prepare("UPDATE runs SET responses=? WHERE id=?")
          .run(store.seal(responses), id);
    }
    const promise = this.execute(w, input, id, mode, responses);
    this.pending.set(id, promise);
    try {
      await promise;
      return store.run(id);
    } finally {
      this.pending.delete(id);
    }
  }
  async execute(w, input, id, mode, responses = {}) {
    const store = this.store,
      env = store.secrets();
    if (mode === "mock") {
      for (const b of w.definition.bindings || [])
        env[b.name] = "mock-credential";
      for (const s of w.definition.steps)
        if (s.params?.connection) env[s.params.connection] = "mock-credential";
    }
    const journal = {
      read: (step) => {
        const row = store.db
          .prepare("SELECT * FROM steps WHERE run_id=? AND step_id=?")
          .get(id, step);
        return row ? { ...row, output: store.open(row.output) } : null;
      },
      start: (step, kind) =>
        store.db
          .prepare(
            "INSERT INTO steps(run_id,step_id,kind,status,started_at,ordinal) VALUES(?,?,?,'running',?,(SELECT COALESCE(MAX(COALESCE(ordinal,rowid)),0)+1 FROM steps WHERE run_id=?)) ON CONFLICT(run_id,step_id) DO UPDATE SET status='running',error=NULL,started_at=excluded.started_at,finished_at=NULL",
          )
          .run(id, step, kind, new Date().toISOString(), id),
      finish: (step, status, output, error = null) =>
        store.db
          .prepare(
            "UPDATE steps SET status=?,output=?,error=?,finished_at=? WHERE run_id=? AND step_id=?",
          )
          .run(
            status,
            store.seal(output),
            error,
            new Date().toISOString(),
            id,
            step,
          ),
    };
    const ctx = createContext({ env, journal });
    ctx.action = async (step, p) => {
      if(mode==='live'&&p.connection){
        const account=store.connections().find(c=>c.binding===p.connection);
        if(account?.auth_type==='oauth'){
          if(!this.oauth)throw Error('OAuth refresh is not configured for this runtime. Connect the account in Unzap or configure this deployment.');
          env[p.connection]=await this.oauth.accessToken(p.connection,step.kind,p);
        }
      }
      const request = requestFor(step, p, env);
      store.db
        .prepare("UPDATE steps SET request=? WHERE run_id=? AND step_id=?")
        .run(store.seal(redact(request, env)), id, step.id);
      const response =
        mode === "mock"
          ? Object.hasOwn(responses || {}, step.id)
            ? responses[step.id]
            : mockResponse(step, p)
          : await (this.transport || ((r) => send(r, this.hosts)))(
              request,
              step,
            );
      try {
        return normalizeOutput(step, response, p);
      } catch (e) {
        if (
          mode === "live" &&
          request.method !== "GET" &&
          !(['slack','slack_join'].includes(step.kind) && response.ok === false)
        )
          e.uncertain = true;
        throw e;
      }
    };
    try {
      const module = await import(
        "data:text/javascript;base64," +
          Buffer.from(compile(w.definition)).toString("base64")
      );
      const result = await (this.workflow || module.workflow)(input, ctx);
      store.db
        .prepare("UPDATE runs SET status=?,error=?,finished_at=? WHERE id=?")
        .run(result.status, result.error, new Date().toISOString(), id);
    } catch (e) {
      store.db
        .prepare(
          "UPDATE runs SET status='held',error=?,finished_at=? WHERE id=?",
        )
        .run(String(e.message), new Date().toISOString(), id);
    }
  }
  async resume(id) {
    const r = this.store.run(id);
    if (!r) throw Error("Run not found");
    return this.start(r.workflow_id, r.input, {
      mode: r.mode,
      version: r.version,
      resumeId: id,
      responses: r.responses || undefined,
    });
  }
  reconcile(id, stepId, output) {
    const s = this.store.db
      .prepare("SELECT * FROM steps WHERE run_id=? AND step_id=?")
      .get(id, stepId);
    if (!s || s.status !== "uncertain")
      throw Error("Only uncertain steps need reconciliation.");
    if (!output || typeof output !== "object" || Array.isArray(output))
      throw Error("Record the verified destination receipt as a JSON object.");
    this.store.db
      .prepare(
        "UPDATE steps SET status='succeeded',output=?,error='Manually reconciled against destination',finished_at=? WHERE run_id=? AND step_id=?",
      )
      .run(this.store.seal(output), new Date().toISOString(), id, stepId);
  }
}
