// Replay saved model responses through current application gates. This does not
// call a model or replay original Zapier recordings. Keep private examples local.
import { readFileSync, writeFileSync } from "node:fs";
import { migrateWithAgent, modelConfiguration } from "../src/agent.js";
import { importDefinitions } from "../src/migration.js";
import { judgeExport } from "../finetune/export-oracle.js";

const run = ".data/finetune/runs/qwen7b-20261010-v2/";
const tasks = new Map(readFileSync(".data/finetune/dataset-7b-frozen-20261010/test.jsonl", "utf8").trim().split("\n").map(line => { const row = JSON.parse(line); return [row.id, row]; }));
const saved = JSON.parse(readFileSync(run + "generations.json", "utf8"));
const config = modelConfiguration({ UNZAP_MODEL_PROVIDER: "llamacpp", UNZAP_MODEL_PROFILE: "trained-7b" });
const rows = [];
for (const record of saved.records) {
  const task = tasks.get(record.id);
  const source = importDefinitions(task.source)[0];
  let command, parseError;
  try { command = JSON.parse(record.outputs.adapter.text); }
  catch (error) { parseError = error.message; }
  let modelCalls = 0, result;
  if (!parseError) {
    result = await migrateWithAgent({ config, definition: source, description: task.description, maxTurns: 1, model: async () => {
      modelCalls++;
      // The transport normally merges the separate trigger into steps.
      const choice = structuredClone(command);
      if (choice.definition?.trigger) {
        choice.definition.steps.unshift(choice.definition.trigger);
        delete choice.definition.trigger;
      }
      return choice;
    } });
  }
  const oracle = command ? await judgeExport(task, command) : null;
  const approved = result?.status === "draft_complete";
  rows.push({ id: task.id, branches: task.branches, expected_action: task.expected_action, parse_error: parseError, model_calls: modelCalls, approved, status: result?.status, original_oracle_passed: oracle?.behavior_passed || false, rejection: result?.log.filter(e => e.status === "rejected").map(e => e.detail) || [] });
}
const report = {
  classification: "Saved NF4 model responses replayed through the current application source and compiler gates. No fresh GGUF inference, no live APIs, and no application-provider fixture replay in this audit.",
  tasks: rows.length,
  proposed: rows.filter(r => r.expected_action === "propose").length,
  approved_proposals: rows.filter(r => r.expected_action === "propose" && r.approved).length,
  approved_oracle_failures: rows.filter(r => r.approved && !r.original_oracle_passed).length,
  unsupported_tasks: rows.filter(r => r.expected_action === "inspect").length,
  unsupported_approved: rows.filter(r => r.expected_action === "inspect" && r.approved).length,
  branch_proposals: rows.filter(r => r.expected_action === "propose" && r.branches).length,
  branch_approved: rows.filter(r => r.expected_action === "propose" && r.branches && r.approved).length,
  rows,
};
writeFileSync(".data/trained-integration-audit.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
if (report.approved_oracle_failures || report.unsupported_approved) process.exitCode = 1;
