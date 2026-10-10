import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { modelConfiguration, llamaModel } from "../src/agent.js";
import { judgeExport } from "../finetune/export-oracle.js";
import { taskMessages } from "../finetune/protocol.js";

const dir = ".data/trained-local-verification";
mkdirSync(dir, { recursive: true });
const token = execFileSync("wsl.exe", ["-e", "docker", "exec", "unzap-app-1", "node", "-e", "process.stdout.write(require('node:fs').readFileSync('/app/.data/control/login-token','utf8').trim())"], { encoding: "utf8" }).trim();
const origin = "http://127.0.0.1:8874";
async function api(path, body) {
  const r = await fetch(origin + "/api" + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: "Bearer " + token, Origin: origin, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || `HTTP ${r.status}`);
  return data;
}
async function snapshot() {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const page = await api("/workflows?offset=" + offset);
    rows.push(...page.rows.map(w => ({ id: w.id, version: w.version, active_version: w.active_version, mode: w.mode })));
    if (rows.length >= page.total) break;
  }
  return rows;
}
if (process.argv.includes("--snapshot")) {
  if (existsSync(dir + "/baseline.json")) throw Error("Preserve the existing baseline snapshot");
  const rows = await snapshot();
  writeFileSync(dir + "/baseline.json", JSON.stringify(rows, null, 2));
  console.log(JSON.stringify({ existing_workflows: rows.length }));
} else {
  const resume = process.argv.includes("--resume");
  if (existsSync(dir + "/reservation.json") && !resume) throw Error("This verification is reserved. Read its saved report or use --resume for unfinished cases.");
  const config = await api("/agent");
  if (config.configuration.profile !== "trained-7b" || !config.configuration.available || !config.configuration.installed) throw Error("The trained local model is not ready");
  if (!resume) writeFileSync(dir + "/reservation.json", JSON.stringify({ created: new Date().toISOString(), kind: "Bounded local CPU verification. No cloud calls.", max_model_cases: 3 }));
  const report = resume ? JSON.parse(readFileSync(dir + "/report.json", "utf8")) : { classification: "Fresh local Q4_K_M base plus F16 adapter inference. Authored API fixtures and sanitized held-out export structures. No live SaaS writes.", app: null, export_cases: [] };
  const save = () => writeFileSync(dir + "/report.json", JSON.stringify(report, null, 2));
  if (!report.app) {
  const source = JSON.parse(readFileSync("fixtures/find-or-create-paths.json", "utf8"));
  source.title = "Trained 7B · find or create verification";
  const imported = await api("/import", source), workflowId = imported.ids[0];
  const w = await api("/workflows/" + workflowId);
  if (w.version !== 1 || w.active_version !== null) throw Error("Verification source already changed. Preserve it and use a new run directory.");
  for (const fixture of JSON.parse(readFileSync("fixtures/find-or-create-inputs.json", "utf8"))) await api(`/workflows/${workflowId}/fixtures`, fixture);
  const job = await api("/agent/runs", { workflow_id: workflowId, version: 1 });
  console.log(JSON.stringify({ stage: "app-model", job: job.id, workflow: workflowId }));
  const deadline = Date.now() + 360000;
  let result = job;
  while (result.status === "running" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    result = await api("/agent/runs/" + job.id);
  }
  if (result.status === "running") { await api(`/agent/runs/${job.id}/cancel`, {}); throw Error("Application verification deadline reached"); }
  report.app = { workflow: workflowId, job: job.id, status: result.status, fixtures_passed: result.result?.tests?.passed || false, fixture_cases: result.result?.tests?.cases.length || 0, model_stats: result.log.filter(e => e.tool === "model" && e.status === "completed").map(e => e.feedback), error: result.error };
  if (result.status === "draft_complete" && result.result?.tests?.passed) {
    await api(`/agent/runs/${job.id}/apply`, {});
    const saved = await api("/workflows/" + workflowId);
    report.app.saved_version = saved.version;
    report.app.active_version = saved.active_version;
  }
  save(); console.log(JSON.stringify({ stage: "app-complete", ...report.app }));
  }
  const tasks = readFileSync(".data/finetune/dataset-7b-frozen-20261010/test.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  const audit = JSON.parse(readFileSync(".data/finetune/runs/qwen7b-20261010-v2/control-family-audit.json", "utf8"));
  const families = new Set(), chosen = tasks.filter(t => t.expected_action === "propose" && t.branches > 0 && audit.test[t.id]?.familiar_control_pattern === false).sort((a, b) => Object.keys(a.source.nodes).length - Object.keys(b.source.nodes).length).filter(t => {
    const key = audit.test[t.id].fingerprint || t.family;
    if (families.has(key)) return false; families.add(key); return true;
  }).slice(0, 2);
  const model = llamaModel(modelConfiguration({ UNZAP_MODEL_PROVIDER: "llamacpp", UNZAP_MODEL_PROFILE: "trained-7b" }));
  for (const task of chosen) {
    const previous = report.export_cases.find(row => row.id === task.id);
    if (previous?.score) continue;
    if (previous) {
      report.interrupted_cases ??= [];
      report.interrupted_cases.push(previous);
      report.export_cases = report.export_cases.filter(row => row.id !== task.id);
    }
    console.log(JSON.stringify({ stage: "held-out-model", id: task.id, nodes: Object.keys(task.source.nodes).length }));
    try {
      const command = await model(taskMessages(task));
      // Restore the training wire shape for the independent source oracle.
      const d = command.definition;
      if (d) { const root = d.steps.find(s => s.parent_id === null); d.trigger = root; d.steps = d.steps.filter(s => s.parent_id !== null); }
      const score = await judgeExport(task, command);
      report.export_cases.push({ id: task.id, branches: task.branches, nodes: Object.keys(task.source.nodes).length, score, stats: command.model_stats });
    } catch (error) { report.export_cases.push({ id: task.id, error: error.message }); }
    save(); console.log(JSON.stringify({ stage: "held-out-complete", id: task.id, passed: report.export_cases.at(-1).score?.behavior_passed || false, error: report.export_cases.at(-1).error }));
  }
  try {
    const baseline = JSON.parse(readFileSync(dir + "/baseline.json", "utf8")), now = await snapshot();
    report.existing_workflows_preserved = baseline.every(w => isDeepStrictEqual(w, now.find(row => row.id === w.id)));
  } catch (error) { report.snapshot_error = error.message; report.existing_workflows_preserved = false; }
  report.model_cases = 1 + chosen.length;
  report.passed = report.app.fixtures_passed && report.app.saved_version === 2 && report.app.active_version === null && report.export_cases.every(row => row.score?.behavior_passed) && report.existing_workflows_preserved;
  save(); console.log(JSON.stringify({ passed: report.passed, existing_workflows_preserved: report.existing_workflows_preserved, model_cases: report.model_cases }));
  if (!report.passed) process.exitCode = 1;
}
