import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { actions } from "./migration.js";
import { providers, inferProvider } from './accounts.js';
import { prepareOAuthStore } from './oauth-store.js';
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = join(directory, "vault.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32)
      throw Error("Vault key must contain exactly 32 bytes.");
    this.db = new DatabaseSync(join(directory, "unzap.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY,name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,active_version INTEGER,mode TEXT NOT NULL DEFAULT 'mock',webhook_secret TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions(workflow_id TEXT NOT NULL REFERENCES workflows(id),version INTEGER NOT NULL,definition TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(workflow_id,version));
      CREATE TABLE IF NOT EXISTS connections(binding TEXT PRIMARY KEY,label TEXT NOT NULL,secret TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id),version INTEGER NOT NULL,idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,finished_at TEXT,UNIQUE(workflow_id,idempotency_key));
      CREATE TABLE IF NOT EXISTS steps(run_id TEXT NOT NULL REFERENCES runs(id),step_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,output TEXT,error TEXT,request TEXT,started_at TEXT NOT NULL,finished_at TEXT,PRIMARY KEY(run_id,step_id));
      CREATE TABLE IF NOT EXISTS fixtures(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id),name TEXT NOT NULL,input TEXT NOT NULL,expected_status TEXT NOT NULL,expected_requests TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checks(workflow_id TEXT NOT NULL,version INTEGER NOT NULL,fixture_id TEXT NOT NULL,passed INTEGER NOT NULL,run_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(workflow_id,version,fixture_id));`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS import_sources(source_hash TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflows(id));",
    );
    for (const [table, column] of [
      ["runs", "responses"],
      ["fixtures", "responses"],
      ["fixtures", "expected_outputs"],
    ]) {
      if (
        !this.db
          .prepare("PRAGMA table_info(" + table + ")")
          .all()
          .some((c) => c.name === column)
      )
        this.db.exec(
          "ALTER TABLE " + table + " ADD COLUMN " + column + " TEXT",
        );
    }
    // Timestamps can tie within a millisecond. Persist first execution order,
    // including generated adapter substeps, instead of sorting ties by ID.
    if (!this.db.prepare('PRAGMA table_info(steps)').all().some(c=>c.name==='ordinal'))
      this.db.exec('ALTER TABLE steps ADD COLUMN ordinal INTEGER');
    this.db.exec('UPDATE steps SET ordinal=rowid WHERE ordinal IS NULL');
    if (!this.db.prepare('PRAGMA table_info(connections)').all().some(c=>c.name==='provider')) {
      this.db.exec("ALTER TABLE connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'custom'");
      for (const c of this.db.prepare('SELECT binding FROM connections').all())
        this.db.prepare('UPDATE connections SET provider=? WHERE binding=?').run(inferProvider(c.binding),c.binding);
    }
    prepareOAuthStore(this);
    // Existing installations can populate the source registry without rewriting versions.
    for (const w of this.list())
      if (w.definition.source_hash)
        this.db
          .prepare("INSERT OR IGNORE INTO import_sources VALUES(?,?)")
          .run(w.definition.source_hash, w.id);
    // A crash between sending a write and recording its result is ambiguous.
    const writeKinds = Object.keys(actions).filter(
      (kind) => actions[kind].effect,
    );
    this.db
      .prepare(
        "UPDATE steps SET status=CASE WHEN kind IN (" +
          writeKinds.map(() => "?").join(",") +
          ") THEN 'uncertain' ELSE 'held' END,error='Execution interrupted before a receipt was recorded' WHERE status='running'",
      )
      .run(...writeKinds);
    this.db.exec(
      "UPDATE runs SET status='held',error='Runtime restarted. Inspect the step journal before resuming.' WHERE status='running';",
    );
  }
  seal(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
  }
  open(value) {
    if (value == null) return null;
    const bytes = Buffer.from(value, "base64"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        bytes.subarray(0, 12),
      );
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8"),
    );
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  add(definition) {
    if (definition.source_hash) {
      const existing = this.db
        .prepare("SELECT workflow_id FROM import_sources WHERE source_hash=?")
        .get(definition.source_hash);
      if (existing) return existing.workflow_id;
    }
    const id = randomUUID(),
      now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO workflows(id,name,webhook_secret,created_at) VALUES(?,?,?,?)",
        )
        .run(
          id,
          definition.name,
          this.seal(randomBytes(32).toString("base64url")),
          now,
        );
      this.db
        .prepare("INSERT INTO versions VALUES(?,?,?,?)")
        .run(id, 1, this.seal(definition), now);
      if (definition.source_hash)
        this.db
          .prepare("INSERT INTO import_sources VALUES(?,?)")
          .run(definition.source_hash, id);
    });
    return id;
  }
  get(id, version) {
    const row = this.db.prepare("SELECT * FROM workflows WHERE id=?").get(id);
    if (!row) return null;
    const v = this.db
      .prepare("SELECT * FROM versions WHERE workflow_id=? AND version=?")
      .get(id, version || row.version);
    return {
      ...row,
      webhook_secret: undefined,
      definition: this.open(v.definition),
      selected_version: v.version,
    };
  }
  save(id, definition, expected) {
    return this.transaction(() => {
      const current = this.get(id);
      if (!current) throw Error("Workflow not found");
      if (current.version !== expected)
        throw Object.assign(
          Error("This workflow changed. Refresh before saving."),
          { status: 409 },
        );
      const version = current.version + 1;
      this.db
        .prepare("INSERT INTO versions VALUES(?,?,?,?)")
        .run(id, version, this.seal(definition), new Date().toISOString());
      this.db
        .prepare("UPDATE workflows SET version=?,name=? WHERE id=?")
        .run(version, definition.name, id);
      return version;
    });
  }
  list() {
    return this.db
      .prepare("SELECT id FROM workflows ORDER BY created_at DESC")
      .all()
      .map((r) => this.get(r.id));
  }
  secrets() {
    return Object.fromEntries(
      this.db
        .prepare("SELECT * FROM connections")
        .all()
        .map((r) => [r.binding, this.open(r.secret)]),
    );
  }
  connections() {
    return this.db
      .prepare(
        "SELECT binding,label,provider,created_at,auth_type,oauth_status,oauth FROM connections ORDER BY label",
      )
      .all().map(({oauth,...row})=>{
        const meta=oauth?this.open(oauth):null;
        return {...row,expires_at:meta?.expires_at||null,refreshable:!!meta?.refresh_token,scopes:meta?.scopes||[]};
      });
  }
  connect(binding, label, secret, provider = inferProvider(binding)) {
    if (
      !/^[A-Z][A-Z0-9_]{1,100}$/.test(binding) ||
      typeof secret !== "string" ||
      !secret ||
      secret.length > 10000
    )
      throw Error("Use an uppercase binding name and a non-empty secret.");
    if (!Object.hasOwn(providers,provider)) throw Error('Choose a supported connection app');
    const existing=this.connections().find(c=>c.binding===binding);
    if (existing && existing.provider!==provider) throw Error('An existing account cannot change apps. Add a separate account.');
    this.db
      .prepare(
        "INSERT INTO connections(binding,label,secret,created_at,provider) VALUES(?,?,?,?,?) ON CONFLICT(binding) DO UPDATE SET label=excluded.label,secret=excluded.secret,created_at=excluded.created_at,auth_type='manual',oauth=NULL,oauth_status=NULL,credential_version=connections.credential_version+1",
      )
      .run(
        binding,
        String(label || binding).slice(0, 120),
        this.seal(secret),
        new Date().toISOString(),
        provider,
      );
  }
  run(id) {
    const r = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    if (!r) return null;
    return {
      ...r,
      input: this.open(r.input),
      responses: this.open(r.responses),
      steps: this.db
        .prepare(
          "SELECT * FROM steps WHERE run_id=? ORDER BY COALESCE(ordinal,rowid)",
        )
        .all(id)
        .map((s) => ({
          ...s,
          output: this.open(s.output),
          request: this.open(s.request),
        })),
    };
  }
  close() {
    this.db.close();
  }
}
