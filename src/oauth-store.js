// Keep access tokens in the existing encrypted secret column. Refresh tokens,
// PKCE verifiers and installation client credentials have separate sealed rows.
export function prepareOAuthStore(store) {
  const db=store.db, columns=db.prepare('PRAGMA table_info(connections)').all().map(c=>c.name);
  for (const [name,definition] of [['auth_type',"TEXT NOT NULL DEFAULT 'manual'"],['oauth','TEXT'],['oauth_status','TEXT'],['credential_version','INTEGER NOT NULL DEFAULT 1'],['refresh_started_at','INTEGER'],['refresh_retry_at','INTEGER']])
    if (!columns.includes(name)) db.exec(`ALTER TABLE connections ADD COLUMN ${name} ${definition}`);
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients(provider TEXT PRIMARY KEY,config TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_flows(id TEXT PRIMARY KEY,provider TEXT NOT NULL,browser_hash TEXT NOT NULL,payload TEXT,expires_at INTEGER NOT NULL,consumed INTEGER NOT NULL DEFAULT 0,result TEXT);`);
}
