import { isDeepStrictEqual } from "node:util";
import { validate, compile } from "../src/migration.js";
import { createContext } from "../src/runtime.js";
import { bindingsFor } from "../src/bundle.js";
import {
  requestFor,
  normalizeOutput,
  mockResponse,
  redact,
} from "../src/connectors.js";
import { decodeCommand } from "./protocol.js";

export async function judge(task, command) {
  if (task.expected_action === "inspect")
    return {
      parsed: true,
      compiler_valid: false,
      behavior_passed: command?.action === "inspect" && !command.definition,
      refusal_passed: command?.action === "inspect" && !command.definition,
    };
  let d;
  try {
    d = decodeCommand(command);
  } catch (error) {
    return {
      parsed: true,
      compiler_valid: false,
      behavior_passed: false,
      error: error.message,
    };
  }
  if (task.source) {
    const source =
      task.source.steps ||
      Object.values(task.source.nodes).map((s) => ({
        id: String(s.id),
        parent_id: s.parent_id == null ? null : String(s.parent_id),
      }));
    const expected = source.map((s) => [s.id, s.parent_id]),
      actual = d.steps.map((s) => [s.id, s.parent_id]);
    if (!isDeepStrictEqual([...expected].sort(), [...actual].sort()))
      return {
        parsed: true,
        compiler_valid: false,
        behavior_passed: false,
        error: "Source topology changed",
      };
  }
  const plan = validate(d);
  if (!plan.ready)
    return {
      parsed: true,
      compiler_valid: false,
      behavior_passed: false,
      issues: plan.issues,
    };
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(compile(d)).toString("base64")
  );
  const cases = [];
  for (const f of task.fixtures) {
    const env = Object.fromEntries(
        bindingsFor(d).map((b) => [b, "fixture-credential"]),
      ),
      ctx = createContext({ env });
    ctx.action = async (step, p) => {
      const request = requestFor(step, p, env),
        simple = {
          method: request.method,
          url: request.url,
          body: request.body === undefined ? null : request.body,
        };
      if (
        simple.body &&
        /application\/json/.test(request.headers?.["Content-Type"] || "")
      )
        try {
          simple.body = JSON.parse(simple.body);
        } catch {}
      ctx.requests.push(redact(simple, env));
      const response = Object.hasOwn(f.responses || {}, step.kind)
        ? f.responses[step.kind]
        : mockResponse(step, p);
      return normalizeOutput(step, response, p);
    };
    const result = await module.workflow(f.input, ctx);
    const leaf = result.trace
      .filter(
        (s) =>
          s.status === "succeeded" &&
          !["webhook", "filter", "path", "paths"].includes(s.kind),
      )
      .at(-1);
    const final = leaf ? result.outputs[leaf.step_id] : null;
    const passed =
      result.status === f.status &&
      (f.requests === undefined ||
        isDeepStrictEqual(ctx.requests, f.requests)) &&
      (f.final === undefined || isDeepStrictEqual(final, f.final));
    cases.push({
      passed,
      status: result.status,
      error: result.error,
      requests: ctx.requests,
      final,
    });
  }
  return {
    parsed: true,
    compiler_valid: true,
    behavior_passed: cases.length > 0 && cases.every((c) => c.passed),
    cases,
  };
}
