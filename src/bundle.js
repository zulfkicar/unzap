import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { compile } from "./migration.js";

const service = `import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Store } from './src/store.js';
import { Runner } from './src/runner.js';
import { workflow } from './workflow.mjs';
import { redact } from './src/connectors.js';
const token=process.env.WEBHOOK_TOKEN;
if (!token || token.length < 16) throw Error('Set WEBHOOK_TOKEN to at least 16 characters.');
const store=new Store(process.env.DATA_DIR || '.data');
const definition=JSON.parse(readFileSync('definition.json','utf8'));
const id=store.list()[0]?.id || store.add(definition);
for (const [name,value] of Object.entries(process.env)) if (value && (definition.bindings || []).some(b=>b.name === name)) store.connect(name,name,value);
for (const s of definition.steps) if (s.params?.connection && process.env[s.params.connection]) store.connect(s.params.connection,s.params.connection,process.env[s.params.connection]);
const runner=new Runner(store,{workflow,hosts:String(process.env.ALLOWED_HOSTS || '').split(',').map(s=>s.trim()).filter(Boolean)});
const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const server=createServer(async(req,res)=>{
 const a=Buffer.from(String(req.headers.authorization || '')), b=Buffer.from('Bearer '+token);
 if (a.length !== b.length || !timingSafeEqual(a,b)) return reply(res,401,{error:'Bearer authentication required'});
 if(req.method==='GET' && req.url==='/runs') return reply(res,200,store.db.prepare('SELECT id,status,error,created_at,finished_at FROM runs ORDER BY created_at DESC LIMIT 100').all());
 if(req.method!=='POST' || req.url!=='/webhook') return reply(res,404,{error:'Not found'});
 try { let bytes=0; const chunks=[]; for await(const chunk of req) {bytes+=chunk.length;if(bytes>65536) return reply(res,413,{error:'Payload too large'});chunks.push(chunk);}
  const key=req.headers['idempotency-key']; if(!key) return reply(res,400,{error:'Idempotency-Key required'});
  const result=await runner.start(id,JSON.parse(Buffer.concat(chunks).toString('utf8')),{key,mode:process.env.OUTBOUND_MODE==='live'?'live':'mock'});
  reply(res,200,redact({id:result.id,status:result.status,error:result.error,outputs:Object.fromEntries(result.steps.filter(s=>s.status==='succeeded').map(s=>[s.step_id,s.output])),steps:result.steps.map(s=>({step_id:s.step_id,status:s.status,error:s.error}))},store.secrets()));
 }catch(e){reply(res,e.status || 400,{error:e.message});}
}).listen(Number(process.env.PORT || 8884),process.env.HOST || '127.0.0.1',()=>console.log(JSON.stringify({service:'owned-workflow',port:server.address().port})));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));
`;
export function bindingsFor(definition) {
  const bindings = new Set();
  function visit(v) {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      if (typeof v.$env === "string") bindings.add(v.$env);
      Object.values(v).forEach(visit);
    }
  }
  for (const s of definition.steps) {
    visit(s.params);
    if (typeof s.params?.connection === "string")
      bindings.add(s.params.connection);
  }
  return [...bindings];
}
export async function bundle(definition) {
  const entries = {
    "workflow.mjs": compile(definition),
    "definition.json": JSON.stringify(
      {
        ...definition,
        bindings: bindingsFor(definition).map((name) => ({ name })),
      },
      null,
      2,
    ),
    "server.mjs": service,
    ".env.example":
      [
        "WEBHOOK_TOKEN=",
        "OUTBOUND_MODE=mock",
        "ALLOWED_HOSTS=",
        ...bindingsFor(definition).map((b) => b + "="),
      ].join("\n") + "\n",
    "package.json": JSON.stringify(
      {
        type: "module",
        engines: { node: ">=24 <25" },
        scripts: { start: "node --env-file-if-exists=.env server.mjs" },
      },
      null,
      2,
    ),
    Dockerfile:
      'FROM node:24.15.0-bookworm-slim\nWORKDIR /app\nCOPY --chown=node:node . .\nRUN mkdir -p .data && chown node:node .data\nUSER node\nENV HOST=0.0.0.0 PORT=8884\nEXPOSE 8884\nCMD ["node","--env-file-if-exists=.env","server.mjs"]\n',
    ".dockerignore": ".env\n.data\nnode_modules\n.git\n",
    "compose.yaml":
      'services:\n  workflow:\n    build: .\n    ports: ["127.0.0.1:8884:8884"]\n    env_file: .env\n    volumes: ["journal:/app/.data"]\n    restart: unless-stopped\nvolumes:\n  journal:\n',
    "README.md":
      "# Owned workflow\n\nYour generated workflow is in `workflow.mjs`. Edit it directly. No Zapier account, SDK or task meter is required by this runtime. Third-party API and hosting fees still apply.\n\nCopy `.env.example` to `.env`, set a strong WEBHOOK_TOKEN and fresh credentials. Run `docker compose up --build -d` or `npm start`. Mock mode makes no external requests. To enable live mode, set OUTBOUND_MODE=live and list exact HTTPS hostnames in ALLOWED_HOSTS. Test the production APIs in a sandbox before cutting over.\n\nPOST /webhook with Authorization: Bearer TOKEN and Idempotency-Key. GET /runs uses the same authentication. The SQLite journal and vault key live in .data. Back up both. Do not lose or publish the key. Completed steps are retained and duplicates reuse a run. Interrupted writes become uncertain and are not automatically retried. This exported service exposes no reconciliation UI. Review and reconcile through the migration control app before cutover, or implement a reconciliation endpoint for your deployment.\n\nThe control app does not certify equivalence with original Zap runs. Compare actual API requests and receipts before disabling the Zap. Imported definitions can contain business data. Keep this bundle private until reviewed.\n",
  };
  for (const name of [
    "runner",
    "store",
    "migration",
    "importer",
    "runtime",
    "connectors",
    "import-adapters",
    "extended-adapters",
    "graph-compiler",
    "logic",
    "dates",
    "sheets",
    "accounts",
    "oauth-store",
  ])
    entries[`src/${name}.js`] = await readFile(
      new URL(`./${name}.js`, import.meta.url),
      "utf8",
    );
  const parts = [];
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content),
      header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100, 8);
    header.write("0000000\0", 108, 8);
    header.write("0000000\0", 116, 8);
    header.write(data.length.toString(8).padStart(11, "0") + "\0", 124, 12);
    header.write("00000000000\0", 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
