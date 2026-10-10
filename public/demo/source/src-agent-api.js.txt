import { randomUUID } from "node:crypto";
import { migrateWithAgent, modelConfiguration, localModel } from "./agent.js";
import { validate } from "./migration.js";
export function createAgentApi(
  store,
  { model, config = modelConfiguration() } = {},
) {
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS agent_runs(id TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  store.db
    .prepare(
      "UPDATE agent_runs SET status='interrupted' WHERE status='running'",
    )
    .run();
  const pending = new Map();
  const read = (id) => {
    const row = store.db.prepare("SELECT * FROM agent_runs WHERE id=?").get(id);
    if (!row) throw Error("Agent run not found");
    return {
      ...store.open(row.payload),
      id: row.id,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  };
  const write = (id, status, data) =>
    store.db
      .prepare(
        "UPDATE agent_runs SET status=?,payload=?,updated_at=? WHERE id=?",
      )
      .run(status, store.seal(data), new Date().toISOString(), id);
  return {
    config,
    async health() {
      try {
        const r = await fetch(config.url + (config.provider === "llamacpp" ? "/v1/models" : "/api/tags"), {
          signal: AbortSignal.timeout(2500),
          redirect: "error",
        });
        const data = await r.json();
        const names = config.provider === "llamacpp" ? (data.data || []).map(m => m.id) : (data.models || []).map((m) => m.name);
        return {
          ...config,
          available: r.ok,
          installed: names.includes(config.model),
          models: names,
        };
      } catch {
        return { ...config, available: false, installed: false, models: [] };
      }
    },
    start({ workflow_id, version, description = "", fixtures = [] }) {
      if (pending.size)
        throw Object.assign(Error("A local agent run is already in progress"), {
          status: 409,
        });
      const w = workflow_id ? store.get(workflow_id) : null;
      if (workflow_id && (!w || w.version !== version))
        throw Error("Reload the source workflow before starting the agent");
      if (
        typeof description !== "string" ||
        description.length > 12000 ||
        !Array.isArray(fixtures) ||
        fixtures.length > 12
      )
        throw Error("Invalid migration request");
      if (!w && !description.trim())
        throw Error("Describe the workflow to build");
      const id = randomUUID(),
        now = new Date().toISOString(),
        controller = new AbortController();
      const data = {
        workflow_id,
        source_version: w?.version,
        description,
        log: [],
        result: null,
        error: null,
        model: config.model,
      };
      store.db
        .prepare("INSERT INTO agent_runs VALUES(?,?,?,?,?)")
        .run(id, "running", store.seal(data), now, now);
      pending.set(id, controller);
      void migrateWithAgent({
        definition: w?.definition,
        description,
        fixtures,
        config,
        model: model || localModel(config),
        signal: controller.signal,
        onProgress: (entry) => {
          data.log.push(entry);
          write(id, "running", data);
        },
      })
        .then((result) => {
          data.result = result;
          write(id, result.status, data);
        })
        .catch((error) => {
          data.error = controller.signal.aborted
            ? "Cancelled by operator"
            : String(error.message);
          write(id, controller.signal.aborted ? "cancelled" : "failed", data);
        })
        .finally(() => pending.delete(id));
      return read(id);
    },
    read,
    list: () =>
      store.db
        .prepare(
          "SELECT id,status,created_at,updated_at FROM agent_runs ORDER BY created_at DESC LIMIT 20",
        )
        .all(),
    cancel(id) {
      if (!pending.has(id)) throw Error("This run is no longer active");
      pending.get(id).abort();
      return { id, status: "cancelling" };
    },
    apply(id) {
      const job = read(id),
        d = job.result?.definition;
      if (job.status !== "draft_complete" || !d || !validate(d).ready)
        throw Error("Only a compiler-valid completed draft can be saved");
      let workflow_id = job.workflow_id;
      if (workflow_id) store.save(workflow_id, d, job.source_version);
      else workflow_id = store.add(d);
      write(id, "applied", { ...job, workflow_id });
      return { workflow_id };
    },
  };
}
