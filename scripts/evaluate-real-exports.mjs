import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readZapArchive } from '../src/zip-import.js';
import { workflowsFrom } from '../src/importer.js';
import { importDefinitions, validate } from '../src/migration.js';
import { sanitizeWorkflow, auditSanitized } from '../finetune/sanitize.js';
import { controlFixtures, judgeExport } from '../finetune/export-oracle.js';
import { taskMessages, wireDefinition } from '../finetune/protocol.js';
import { modelConfiguration, llamaModel } from '../src/agent.js';
import { verifySourceProposal } from '../src/trained-contract.js';

// Read private exports locally. Only allowlist-sanitized structures reach local inference.
const path = process.argv[2];
if (!path) throw Error('Supply the private export ZIP path');
const dir = '.data/real-export-evaluation-20261010';
mkdirSync(dir, { recursive: true });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reportPath = dir + '/report.json';
if (existsSync(reportPath) && !process.argv.includes('--resume')) throw Error('Preserve the recorded evaluation. Use --resume for unfinished cases.');
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {
  classification: 'Complete sanitized real-export structures, without synthetic topology variants. This source corpus was also used for training. Not an independent held-out accuracy estimate. Payloads and API outputs are authored mocks.',
  created: new Date().toISOString(), max_model_calls: 12, cases: [], selected: [], corpus: 0,
};
const save = () => writeFileSync(reportPath, JSON.stringify(report, null, 2));
if (!report.selected.length) {
  const raw = workflowsFrom(readZapArchive(readFileSync(path)));
  const sources = raw.map(sanitizeWorkflow);
  const audit = auditSanitized(sources);
  if (!audit.passed) throw Error('Sanitization audit failed');
  report.corpus = raw.length;
  const unique = new Map();
  for (const source of sources) {
    if (Object.keys(source.nodes).length > 16 || Buffer.byteLength(JSON.stringify(taskMessages({ source }))) > 12000) continue;
    const id = hash(source).slice(0, 16);
    if (unique.has(id)) continue;
    const original = importDefinitions(source)[0];
    const reviewed = { ...original, steps: original.steps.map(s => ({ ...s, review_required: false })) };
    const plan = validate(reviewed);
    if (plan.ready) {
      const fixtures = controlFixtures(source);
      if (!fixtures.some(f => f.expected.status === 'succeeded')) continue;
      const task = { id, source, expected_action: 'propose', fixtures };
      if (!(await judgeExport(task, { action: 'propose', definition: wireDefinition(reviewed) })).behavior_passed) continue;
      unique.set(id, { ...task, branches: reviewed.steps.filter(s => s.kind === 'paths').length });
    } else if (original.steps.some(s => s.kind === 'unsupported')) {
      unique.set(id, { id, source, expected_action: 'inspect', fixtures: [], branches: 0 });
    }
  }
  const all = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
  const branches = all.filter(t => t.expected_action === 'propose' && t.branches).slice(0, 4);
  const linear = all.filter(t => t.expected_action === 'propose' && !t.branches).slice(0, 8 - branches.length);
  const refusal = all.filter(t => t.expected_action === 'inspect').slice(0, 4);
  report.selected = [...branches, ...linear, ...refusal];
  if (report.selected.length !== 12) throw Error('Not enough eligible complete exports for the reserved sample');
  save();
}
const model = llamaModel(modelConfiguration({ UNZAP_MODEL_PROVIDER: 'llamacpp', UNZAP_MODEL_PROFILE: 'trained-7b' }));
for (const task of report.selected) {
  if (report.cases.some(c => c.id === task.id)) continue;
  console.log(JSON.stringify({ stage: 'model', case: report.cases.length + 1, id: task.id, expected_action: task.expected_action, nodes: Object.keys(task.source.nodes).length }));
  const row = { id: task.id, expected_action: task.expected_action, branches: task.branches, nodes: Object.keys(task.source.nodes).length };
  try {
    const command = await model(taskMessages({ ...task, description: 'Convert this complete sanitized real export. Preserve every supplied source node and its semantics. Refuse unsupported actions.' }));
    row.command = command;
    row.stats = command.model_stats;
    if (command.definition) command.definition = wireDefinition(command.definition);
    row.score = await judgeExport(task, command);
    if (task.expected_action === 'propose' && command.definition) {
      try {
        const d = { ...command.definition, steps: [command.definition.trigger, ...command.definition.steps] };
        row.source_guard = verifySourceProposal(d, importDefinitions(task.source)[0]);
      } catch (error) { row.source_guard = { checked: false, error: error.message }; }
    }
    row.passed = task.expected_action === 'inspect' ? row.score.refusal_passed === true : row.score.behavior_passed === true && row.source_guard?.checked === true;
  } catch (error) { row.error = error.message; row.passed = false; }
  report.cases.push(row); save();
  console.log(JSON.stringify({ stage: 'complete', id: row.id, passed: row.passed, error: row.error || row.score?.error || row.source_guard?.error, elapsed_ms: row.stats?.total_ms }));
}
report.finished = new Date().toISOString();
for (const row of report.cases) if (row.expected_action === 'inspect') row.passed = row.score?.refusal_passed === true;
report.summary = {
  completed: report.cases.length,
  conversion_passed: report.cases.filter(c => c.expected_action === 'propose' && c.passed).length,
  conversion_total: report.cases.filter(c => c.expected_action === 'propose').length,
  branch_passed: report.cases.filter(c => c.branches && c.passed).length,
  branch_total: report.cases.filter(c => c.branches).length,
  refusals_passed: report.cases.filter(c => c.expected_action === 'inspect' && c.passed).length,
  refusals_total: report.cases.filter(c => c.expected_action === 'inspect').length,
};
save(); console.log(JSON.stringify(report.summary));
