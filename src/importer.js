import { createHash } from "node:crypto";
import { parseReference } from "./runtime.js";
export const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ops = new Set([
  "iexact",
  "icontains",
  "igreater",
  "iless",
  "istartswith",
  "iendswith",
  "boolean",
]);
export function workflowsFrom(input) {
  const list = Array.isArray(input)
    ? input
    : input?.zaps || (input?.nodes ? [input] : null);
  if (!Array.isArray(list))
    throw Error(
      "Expected a Zap export with a zaps array or a single workflow with nodes",
    );
  return list;
}
const blockedKey =
  /(?:authorization|password|secret|api[_-]?key|access[_-]?token|token|auth)$/i;
function classify(node) {
  const app = String(node.selected_api || ""),
    action = String(node.action || "");
  if (/^WebHook(?:CLI)?API(?:@|$)/.test(app)) {
    if (node.parent_id == null && ["hook", "hook_v2"].includes(action))
      return "webhook";
    if (["get", "post", "put", "custom"].includes(action)) return "http";
  }
  if (app === "FilterAPI" && action === "filter") return "filter";
  return "unsupported";
}
export function secretise(value, path, stepId, bindings) {
  if (Array.isArray(value))
    return value.map((v, i) =>
      secretise(v, [...path, String(i)], stepId, bindings),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        secretise(v, [...path, key], stepId, bindings),
      ]),
    );
  const name = path.at(-1) || "";
  let sensitive = blockedKey.test(name);
  if (name === "url" && typeof value === "string")
    try {
      const url = new URL(value);
      sensitive = Boolean(
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((k) => blockedKey.test(k)),
      );
    } catch {}
  if (
    sensitive &&
    typeof value === "string" &&
    value &&
    !value.includes("{{")
  ) {
    const binding = `STEP_${stepId}_${path.join("_")}`
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, "_");
    bindings.push({
      name: binding,
      required: true,
      step_id: stepId,
      purpose: path.join("."),
      kind: "secret",
    });
    return { $env: binding };
  }
  return value;
}
function refs(value, result = []) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\{\{([^}]+)\}\}/g)) {
      const ref = parseReference(match[1]);
      if (ref)
        result.push({
          step_id: ref.step_id,
          path: ref.flat_path,
          segments: ref.path,
        });
    }
  } else if (Array.isArray(value)) value.forEach((v) => refs(v, result));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => refs(v, result));
  return result;
}
export function analyse(workflow) {
  if (!workflow?.nodes || typeof workflow.nodes !== "object")
    throw Error("Workflow nodes must be a dictionary or array");
  const raw = Object.values(workflow.nodes),
    issues = [],
    bindings = [],
    nodes = raw.map((n) => ({
      id: String(n.id),
      parent_id: n.parent_id == null ? null : String(n.parent_id),
      app: String(n.selected_api || ""),
      action: String(n.action || ""),
      kind: classify(n),
      params: secretise(
        structuredClone(n.params || {}),
        [],
        String(n.id),
        bindings,
      ),
      connection_required: n.authentication_id != null,
    }));
  if (nodes.length === 0)
    issues.push({ code: "empty_workflow", message: "The export has no nodes" });
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length)
    issues.push({ code: "duplicate_ids", message: "Node IDs are not unique" });
  if (nodes.some((n) => !/^\d+$/.test(n.id)))
    issues.push({
      code: "invalid_id",
      message: "Node IDs must be numeric identifiers",
    });
  const roots = nodes.filter((n) => n.parent_id === null),
    byId = new Map(nodes.map((n) => [n.id, n]));
  if (roots.length !== 1)
    issues.push({
      code: "root_count",
      message: "Exactly one trigger is required",
    });
  const children = new Map();
  for (const n of nodes)
    if (n.parent_id !== null) {
      if (!byId.has(n.parent_id))
        issues.push({
          code: "missing_parent",
          step_id: n.id,
          message: "Parent node is not present",
        });
      const rows = children.get(n.parent_id) || [];
      rows.push(n);
      children.set(n.parent_id, rows);
    }
  if ([...children.values()].some((rows) => rows.length > 1))
    issues.push({
      code: "branching",
      message:
        "Branching requires an explicit adapter and is not compiled as a linear workflow",
    });
  const ordered = [],
    seen = new Set();
  let current = roots[0];
  while (current && !seen.has(current.id)) {
    ordered.push(current);
    seen.add(current.id);
    current = children.get(current.id)?.[0];
  }
  if (seen.size !== nodes.length)
    issues.push({
      code: "disconnected_or_cyclic",
      message: "All nodes must belong to a single acyclic chain",
    });
  for (const node of nodes) {
    if (node.kind === "unsupported")
      issues.push({
        code: "unsupported_action",
        step_id: node.id,
        app: node.app,
        action: node.action,
        message: "No verified conversion adapter for this action",
      });
    if (node.parent_id === null && node.kind !== "webhook")
      issues.push({
        code: "unsupported_trigger",
        step_id: node.id,
        message: "This release supports JSON webhook triggers",
      });
    if (
      node.kind === "webhook" &&
      Object.values(node.params).some(
        (value) => value !== "" && value !== null && value !== false,
      )
    )
      issues.push({
        code: "trigger_parameters",
        step_id: node.id,
        message: "Trigger extraction parameters need a verified adapter",
      });
    const inspectTemplates = (value) => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/\{\{([^}]+)\}\}/g))
          if (!parseReference(match[1]))
            issues.push({
              code: "unknown_template",
              step_id: node.id,
              message: "Unknown template syntax requires review",
            });
      } else if (Array.isArray(value)) value.forEach(inspectTemplates);
      else if (value && typeof value === "object")
        Object.values(value).forEach(inspectTemplates);
    };
    inspectTemplates(node.params);
    if (node.kind === "filter") {
      if (Object.keys(node.params).some((key) => key !== "filter_criteria"))
        issues.push({
          code: "filter_parameters",
          step_id: node.id,
          message: "Unrecognised filter parameters require review",
        });
      const criteria = node.params.filter_criteria;
      if (!Array.isArray(criteria) || !criteria.length)
        issues.push({
          code: "filter_shape",
          step_id: node.id,
          message: "A filter needs at least one criterion",
        });
      else
        for (const c of criteria)
          if (
            !ops.has(c.match) ||
            c.action !== "continue" ||
            !Number.isInteger(c.group)
          )
            issues.push({
              code: "filter_contract",
              step_id: node.id,
              message:
                "Date, existence, negative, and unverified filter rules require review",
            });
    }
    if (node.kind === "http") {
      const p = node.params;
      const known = new Set([
        "payload_type",
        "wrap_in_array",
        "unflatten",
        "url",
        "data",
        "headers",
        "method",
        "pass_through",
      ]);
      if (Object.keys(p).some((key) => !known.has(key)))
        issues.push({
          code: "http_parameters",
          step_id: node.id,
          message: "Unrecognised HTTP parameters require an explicit adapter",
        });
      if (p.payload_type && !["json", "form", "raw"].includes(p.payload_type))
        issues.push({
          code: "http_payload",
          step_id: node.id,
          message: "Unsupported payload type",
        });
      if (!p.url)
        issues.push({
          code: "missing_url",
          step_id: node.id,
          message: "HTTP action has no destination",
        });
      if (
        p.unflatten === "yes" ||
        p.unflatten === true ||
        p.pass_through === true
      )
        issues.push({
          code: "http_contract",
          step_id: node.id,
          message:
            "Unflatten and pass-through need explicit behavioural adapters",
        });
      const method = String(p.method || node.action).toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
        issues.push({
          code: "http_method",
          step_id: node.id,
          message: "Unsupported HTTP method",
        });
      if (method === "GET" && p.data && Object.keys(p.data).length)
        issues.push({
          code: "query_mapping",
          step_id: node.id,
          message: "GET query data needs an explicit mapping adapter",
        });
      if (node.action === "custom" && p.data !== undefined && !p.payload_type)
        issues.push({
          code: "custom_body",
          step_id: node.id,
          message: "Custom-request body semantics must be reviewed",
        });
    }
    for (const ref of refs(node.params)) {
      const index = ordered.findIndex((n) => n.id === node.id),
        source = ordered.findIndex((n) => n.id === ref.step_id);
      if (source < 0 || source >= index)
        issues.push({
          code: "invalid_reference",
          step_id: node.id,
          reference_step: ref.step_id,
          message: "References must point to an earlier node",
        });
      if (
        ["__proto__", "prototype", "constructor"].includes(ref.path) ||
        ref.segments.some((k) =>
          ["__proto__", "prototype", "constructor"].includes(k),
        )
      )
        issues.push({
          code: "unsafe_reference",
          step_id: node.id,
          message: "Prototype references are not allowed",
        });
    }
  }
  const integrations = [
    ...new Set(
      nodes
        .filter((n) => n.kind === "unsupported" || n.connection_required)
        .map((n) => n.app),
    ),
  ].map((app) => ({
    app,
    connection_required: true,
    portable_credentials: false,
  }));
  const spec = {
    schema_version: 1,
    id: String(workflow.id ?? "import"),
    source_hash: digest(workflow),
    steps: ordered,
    bindings,
    integrations,
  };
  return {
    compilable: issues.length === 0,
    issues,
    spec,
    summary: {
      steps: nodes.length,
      supported_steps: nodes.filter((n) => n.kind !== "unsupported").length,
      credential_bindings: bindings.length,
      integrations: integrations.length,
    },
  };
}
