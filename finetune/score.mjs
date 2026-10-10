import { readFileSync, writeFileSync } from "node:fs";
import { judge } from "./oracle.js";
const dir = ".data/finetune",
  generation = JSON.parse(
    readFileSync(dir + "/runs/pilot-v1/generations.json"),
  );
const tasks = new Map(
  readFileSync(dir + "/dataset/test.jsonl", "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const task = JSON.parse(line);
      return [task.id, task];
    }),
);
const rows = [];
for (const row of generation.records) {
  const task = tasks.get(row.id),
    result = {
      id: row.id,
      family: row.family,
      expected_action: task.expected_action,
      structural_holdout: row.structural_holdout,
      models: {},
    };
  for (const [model, output] of Object.entries(row.outputs)) {
    let command, score, parsed = false;
    try {
      command = JSON.parse(output.text);
      parsed = true;
      score = await judge(task, command);
    } catch (error) {
      score = {
        parsed,
        compiler_valid: false,
        behavior_passed: false,
        error: error.message,
      };
    }
    result.models[model] = {
      ...score,
      tokens: output.tokens,
      seconds: output.seconds,
      token_limit_reached: output.token_limit_reached,
      deadline_interrupted: output.deadline_interrupted || false,
    };
  }
  rows.push(result);
}
const paired = rows.filter(
    (r) => r.models.base && r.models.adapter &&
      !r.models.base.deadline_interrupted && !r.models.adapter.deadline_interrupted,
  ),
  rates = (subset, model) => ({
    cases: subset.length,
    proposals_requested: subset.filter((r) => r.expected_action !== "inspect")
      .length,
    refusals_requested: subset.filter((r) => r.expected_action === "inspect")
      .length,
    parsed: subset.filter((r) => r.models[model].parsed).length,
    compiler_valid: subset.filter((r) => r.models[model].compiler_valid).length,
    behavior_passed: subset.filter(
      (r) => r.expected_action !== "inspect" && r.models[model].behavior_passed,
    ).length,
    tasks_passed: subset.filter((r) => r.models[model].behavior_passed).length,
    refusal_passed: subset.filter((r) => r.models[model].refusal_passed).length,
  });
const summary = {
  status: generation.status,
  classification:
    "Small synthetic-contract pilot. No claims about live provider parity, broad superiority or 4B-model replacement.",
  paired_cases: paired.length,
  base: rates(paired, "base"),
  adapter: rates(paired, "adapter"),
  structural_holdout: {
    base: rates(
      paired.filter((r) => r.structural_holdout),
      "base",
    ),
    adapter: rates(
      paired.filter((r) => r.structural_holdout),
      "adapter",
    ),
  },
  familiar_families: {
    base: rates(
      paired.filter((r) => !r.structural_holdout),
      "base",
    ),
    adapter: rates(
      paired.filter((r) => !r.structural_holdout),
      "adapter",
    ),
  },
  wins: paired.filter(
    (r) => !r.models.base.behavior_passed && r.models.adapter.behavior_passed,
  ).length,
  regressions: paired.filter(
    (r) => r.models.base.behavior_passed && !r.models.adapter.behavior_passed,
  ).length,
  rows,
};
writeFileSync(
  dir + "/runs/pilot-v1/evaluation-report.json",
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
