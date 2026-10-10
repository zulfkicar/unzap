import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { readZapArchive } from "../src/zip-import.js";
import { importDefinitions, validate, compile } from "../src/migration.js";
import { workflowsFrom } from "../src/importer.js";
const path = process.argv[2];
if (!path)
  throw Error(
    "Pass a private JSON/ZIP export path. No contents are printed or submitted to providers.",
  );
const bytes = readFileSync(path),
  source = path.toLowerCase().endsWith(".zip")
    ? readZapArchive(bytes)
    : JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
const raw = workflowsFrom(source),
  definitions = importDefinitions(source),
  issues = {},
  report = {
    workflows: raw.length,
    nodes: 0,
    structurally_ready: 0,
    review_proposals: 0,
    blocked_workflows: 0,
    branches_preserved: 0,
    supported_nodes: 0,
    code_ready_after_mapping_review: 0,
    review_only_workflows: 0,
    issues,
  };
assert.equal(definitions.length, raw.length);
for (let i = 0; i < raw.length; i++) {
  const nodes = Object.values(raw[i].nodes),
    d = definitions[i],
    plan = validate(d);
  const reviewed={...d,steps:d.steps.map(s=>({...s,review_required:false}))};
  const reviewedPlan=validate(reviewed);
  if(reviewedPlan.ready) {
    assert.match(compile(reviewed),/export async function workflow/);
    report.code_ready_after_mapping_review++;
    if(!plan.ready)report.review_only_workflows++;
  }
  assert.equal(d.steps.length, nodes.length);
  report.nodes += nodes.length;
  for (let j = 0; j < nodes.length; j++) {
    assert.equal(d.steps[j].id, String(nodes[j].id));
    assert.equal(
      d.steps[j].parent_id,
      nodes[j].parent_id == null ? null : String(nodes[j].parent_id),
    );
    if (d.steps[j].review_required) report.review_proposals++;
    if(d.steps[j].kind!=='unsupported')report.supported_nodes++;
  }
  const children = new Map();
  for (const n of nodes)
    if (n.parent_id != null)
      children.set(
        String(n.parent_id),
        (children.get(String(n.parent_id)) || 0) + 1,
      );
  report.branches_preserved += [...children.values()].filter(
    (n) => n > 1,
  ).length;
  for (const issue of plan.issues)
    issues[issue.code] = (issues[issue.code] || 0) + 1;
  if (plan.ready) {
    assert.match(compile(d), /export async function workflow/);
    report.structurally_ready++;
  } else {
    assert.throws(() => compile(d));
    report.blocked_workflows++;
  }
}
mkdirSync(".data", { recursive: true });
writeFileSync(
  resolve(".data/corpus-verification.json"),
  JSON.stringify(
    {
      ...report,
      classification:
        "Structural verification only. No source Zaps or private code were executed, and no native API recording parity is claimed.",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(report));
