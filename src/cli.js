import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { importDefinitions, validate } from "./migration.js";
import { writeProject } from "./emitter.js";
import { createContext, mockTransport } from "./runtime.js";
const [command, file, ...args] = process.argv.slice(2);
if (!["inspect", "compile", "replay"].includes(command) || !file) {
  console.error(
    "Usage: node src/cli.js inspect|compile|replay <export.json> [--index N] [--out directory] [--input input.json]",
  );
  process.exitCode = 1;
} else {
  const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const list = importDefinitions(
    JSON.parse(await readFile(resolve(file), "utf8")),
  );
  if (command === "inspect") {
    const rows = list.map(validate),
      issues = {};
    for (const row of rows)
      for (const issue of row.issues)
        issues[issue.code] = (issues[issue.code] || 0) + 1;
    const report = {
      workflow_count: list.length,
      compilable: rows.filter((r) => r.ready).length,
      issue_counts: issues,
      supported_scope:
        "Linear JSON webhook triggers, verified positive scalar filters, and HTTP requests",
    };
    if (option("--out")) {
      const out = resolve(option("--out"));
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify(report, null, 2));
  } else {
    const index = Number(option("--index") || 0);
    if (!Number.isInteger(index) || !list[index])
      throw Error("Select an existing workflow index");
    const plan = validate(list[index]);
    const analysis = {
      compilable: plan.ready,
      issues: plan.issues,
      definition: list[index],
      spec: { bindings: list[index].bindings },
      summary: { steps: list[index].steps.length },
    };
    if (!analysis.compilable) {
      console.log(
        JSON.stringify(
          { status: "needs_review", issues: analysis.issues },
          null,
          2,
        ),
      );
      process.exitCode = 2;
    } else {
      const output = await writeProject(
        analysis,
        option("--out") || ".data/generated",
      );
      if (command === "compile")
        console.log(
          JSON.stringify(
            {
              status: "compiled",
              directory: output,
              summary: analysis.summary,
              bindings: analysis.spec.bindings,
            },
            null,
            2,
          ),
        );
      else {
        if (!option("--input"))
          throw Error("Replay requires a synthetic input JSON file");
        const input = JSON.parse(
            await readFile(resolve(option("--input")), "utf8"),
          ),
          { workflow } = await import(
            pathToFileURL(resolve(output, "workflow.mjs"))
          );
        const env = Object.fromEntries(
          analysis.spec.bindings.map((b) => [
            b.name,
            "synthetic-replay-binding",
          ]),
        );
        const result = await workflow(
          input,
          createContext({ env, transport: mockTransport }),
        );
        await writeFile(
          resolve(output, "replay.json"),
          JSON.stringify(result, null, 2),
        );
        console.log(
          JSON.stringify(
            {
              status: result.status,
              steps: result.trace.length,
              request_count: result.requests.length,
              artifact: resolve(output, "replay.json"),
            },
            null,
            2,
          ),
        );
      }
    }
  }
}
