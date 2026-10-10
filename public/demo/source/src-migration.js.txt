import { digest, secretise, workflowsFrom } from "./importer.js";
import { parseReference } from "./runtime.js";
import { propose } from "./import-adapters.js";
import { conditionOperators, formatterIssue } from "./logic.js";
import { compileGraph } from "./graph-compiler.js";
import { sheetsIssue } from './sheets.js';
import { connectionProvider, importedAccountBinding } from './accounts.js';

export const actions = {
  webhook: { label: "Receive JSON webhook", group: "Trigger", effect: false },
  filter: { label: "Filter conditions", group: "Logic", effect: false },
  transform: { label: "Map output fields", group: "Logic", effect: false },
  paths: {
    label: "Paths · sequential branch group",
    group: "Logic",
    effect: false,
  },
  path: {
    label: "Path · rules / always / fallback",
    group: "Logic",
    effect: false,
  },
  formatter: {
    label: "Formatter · text, lists and arithmetic",
    group: "Logic",
    effect: false,
  },
  airtable_find: {
    label: "Airtable · find record",
    group: "Airtable",
    effect: false,
  },
  airtable_update: {
    label: "Airtable · update record",
    group: "Airtable",
    effect: true,
  },
  http: { label: "HTTP request", group: "HTTP", effect: true },
  slack: { label: "Slack · post message", group: "Slack", effect: true },
  slack_join: { label: "Slack · join public channel", group: "Slack", effect: true },
  sheets_append: { label: 'Google Sheets · append row', group: 'Google Sheets', effect: true },
  sheets_update: { label: 'Google Sheets · update row', group: 'Google Sheets', effect: true },
  sheets_resolve: { label: 'Google Sheets · resolve tab', group: 'Google Sheets', effect: false },
  airtable: {
    label: "Airtable · create record",
    group: "Airtable",
    effect: true,
  },
  unsupported: { label: "Needs an adapter", group: "Review", effect: false },
};
const operators = new Set([
  "iexact",
  "icontains",
  "igreater",
  "iless",
  "istartswith",
  "iendswith",
  "boolean",
  ...conditionOperators,
]);
function inferred(n) {
  const app = n.selected_api || "";
  if (/^WebHook(?:CLI)?API(?:@|$)/.test(app)) {
    if (n.parent_id == null && ["hook", "hook_v2"].includes(n.action))
      return "webhook";
    if (["get", "post", "put", "custom"].includes(n.action)) return "http";
  }
  if (app === "FilterAPI" && n.action === "filter") return "filter";
  // SaaS actions need an explicit mapping review, rather than guessing field semantics.
  return "unsupported";
}
export function importDefinitions(source) {
  const zaps = workflowsFrom(source);
  if (zaps.length > 10000) throw Error("Import is limited to 10,000 workflows");
  return zaps.map((w) => {
    const raw = Object.values(w.nodes || {}),
      bindings = [];
    if (raw.length > 500) throw Error("A workflow is limited to 500 steps");
    const aliases = new Map(),
      ambiguous = new Set();
    for (const n of raw) {
      for (const value of [
        n.triple_stores?.copied_from,
        n.meta?.$editor?.replaced_step_id,
      ]) {
        if (value == null || !/^\d+$/.test(String(value))) continue;
        const key = String(value);
        if (aliases.has(key) && aliases.get(key) !== String(n.id))
          ambiguous.add(key);
        else aliases.set(key, String(n.id));
      }
    }
    const ids = new Set(raw.map((n) => String(n.id)));
    function rewrite(value) {
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, rewrite(v)]),
        );
      if (typeof value !== "string") return value;
      return value.replace(/\{\{([^}]+)\}\}/g, (whole, expression) => {
        const ref = parseReference(expression);
        if (
          !ref ||
          ids.has(ref.step_id) ||
          ambiguous.has(ref.step_id) ||
          !aliases.has(ref.step_id)
        )
          return whole;
        return (
          "{{=gives" +
          [aliases.get(ref.step_id), ...ref.path]
            .map((k) => "[" + JSON.stringify(k) + "]")
            .join("") +
          "}}"
        );
      });
    }
    return {
      name: String(w.title || "Untitled workflow").slice(0, 200),
      source_hash: digest(w),
      bindings,
      steps: raw.map((n) => {
        const params = rewrite(
          secretise(n.params || {}, [], String(n.id), bindings),
        );
        const proposal = propose(n, params);
        const provider = proposal && connectionProvider(proposal.kind);
        if (proposal?.params.connection && provider && ['string','number'].includes(typeof n.authentication_id) && String(n.authentication_id))
          proposal.params.connection = importedAccountBinding(provider,n.authentication_id);
        return {
          id: String(n.id),
          parent_id: n.parent_id == null ? null : String(n.parent_id),
          name: String(
            n.meta?.stepTitle || n.title || n.action || "Step",
          ).slice(0, 160),
          kind: inferred(n),
          source_app: String(n.selected_api || ""),
          source_action: String(n.action || ""),
          params,
          ...(proposal ? { source_params: params, ...proposal } : {}),
        };
      }),
    };
  });
}
export function validate(definition) {
  const issues = [],
    steps = definition.steps,
    byId = new Map(steps.map((s) => [s.id, s])),
    ordered = [],
    seen = new Set();
  const add = (step, code, message) =>
    issues.push({ step_id: step?.id, code, message });
  if (!steps.length || steps.length > 500)
    add(null, "size", "A workflow needs 1–500 steps.");
  if (byId.size !== steps.length)
    add(null, "duplicate", "Step IDs must be unique.");
  const roots = steps.filter((s) => s.parent_id == null);
  if (roots.length !== 1) add(null, "root", "Choose exactly one trigger.");
  function visit(s, stack = new Set()) {
    if (stack.has(s.id)) {
      add(s, "cycle", "The graph contains a cycle.");
      return;
    }
    if (seen.has(s.id)) return;
    seen.add(s.id);
    ordered.push(s);
    const children = steps.filter((x) => x.parent_id === s.id);
    if (children.length > 1 && s.kind !== "paths")
      add(
        s,
        "branch",
        "Only an explicit Paths group may have multiple children.",
      );
    for (const c of children) visit(c, new Set([...stack, s.id]));
    if (s.kind === "paths") {
      if (!children.length || children.some((c) => c.kind !== "path"))
        add(s, "branch", "Paths groups must contain path rule nodes.");
      if (children.filter((c) => c.params?.mode === "fallback").length > 1)
        add(s, "branch", "A Paths group can have only one fallback.");
      if (
        children.some((c) => c.params?.mode === "fallback") &&
        children.some((c) => c.params?.mode === "always")
      )
        add(s, "branch", "Always and fallback modes cannot share a group.");
      const orders = children
        .filter((c) => c.params?.mode !== "fallback")
        .map((c) => c.params?.order);
      if (new Set(orders).size !== orders.length)
        add(s, "branch", "Path order must be unambiguous.");
    }
  }
  for (const r of roots) visit(r);
  if (seen.size !== steps.length)
    add(null, "graph", "Disconnected or cyclic steps need repair.");
  for (const s of steps) {
    if (s.review_required)
      add(
        s,
        "mapping_review",
        s.review_notes || "Review the proposed mapping before compilation.",
      );
    if (!/^\d+$/.test(s.id)) add(s, "id", "Use a numeric step ID.");
    if (!Object.hasOwn(actions, s.kind) || s.kind === "unsupported")
      add(
        s,
        "adapter",
        `Map ${s.source_app || "this app"} / ${s.source_action || "this action"} to a reviewed action.`,
      );
    if (s.parent_id == null && s.kind !== "webhook")
      add(
        s,
        "trigger",
        "This runtime accepts JSON webhook triggers. Polling and scheduled triggers need a separate adapter.",
      );
    if (
      s.kind === "webhook" &&
      (Object.keys(s.params || {}).some(k => k !== 'child_key') ||
       (s.params?.child_key !== undefined && (typeof s.params.child_key !== 'string' || !s.params.child_key || ['__proto__','constructor','prototype'].includes(s.params.child_key))))
    )
      add(
        s,
        "extraction",
        "Webhook parameters accept only an optional nonempty child_key. It must select an object. Array fan-out requires a separate adapter.",
      );
    const p = s.params || {};
    if (String(s.kind).startsWith('sheets_')) {
      const error = sheetsIssue(s.kind, p);
      if (error) add(s, 'parameters', error);
    }
    if (s.kind === "paths" && Object.keys(p).length)
      add(s, "parameters", "Paths groups have no action parameters.");
    if (s.kind === "path") {
      if (!steps.some((c) => c.parent_id === s.id))
        add(s, "branch", "A path must contain an action.");
      if (byId.get(s.parent_id)?.kind !== "paths")
        add(s, "branch", "A path must belong to a Paths group.");
      if (
        !["rules", "always", "fallback"].includes(p.mode) ||
        !Number.isInteger(p.order) ||
        p.order < 0
      )
        add(s, "branch", "Choose a valid path mode and order.");
      if (
        Object.keys(p).some(
          (k) => !["mode", "order", "filter_criteria"].includes(k),
        )
      )
        add(s, "parameters", "Unknown path parameters need review.");
    }
    if (s.kind === "formatter") {
      const error = formatterIssue(p);
      if (error) add(s, "formatter", error);
    }
    if (s.kind === "filter" || (s.kind === "path" && p.mode === "rules")) {
      if (!Array.isArray(p.filter_criteria) || !p.filter_criteria.length)
        add(s, "filter", "Add at least one filter condition.");
      else if (
        p.filter_criteria.some(
          (c) =>
            !operators.has(c.match) ||
            !["continue", "stop"].includes(c.action) ||
            !Number.isInteger(c.group),
        )
      )
        add(
          s,
          "filter",
          "Choose a supported scalar comparison, continue/stop action and integer group.",
        );
      if (
        s.kind === "filter" &&
        Object.keys(p).some((k) => k !== "filter_criteria")
      )
        add(s, "parameters", "Unknown filter parameters need review.");
    }
    if (s.kind === "http") {
      if (
        !p.url ||
        !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
          String(p.method || s.source_action).toUpperCase(),
        )
      )
        add(s, "http", "Set a URL and an explicit supported HTTP method.");
      if (p.pass_through === true)
        add(
          s,
          "http",
          "Implicit trigger pass-through requires an explicit mapping.",
        );
      if (p.payload_type && !["json", "form", "raw"].includes(p.payload_type))
        add(s, "http", "Choose JSON, form, or raw payload encoding.");
      if (
        Object.keys(p).some(
          (k) =>
            ![
              "url",
              "method",
              "headers",
              "data",
              "payload_type",
              "unflatten",
              "pass_through",
              "wrap_in_array",
              "auth",
            ].includes(k),
        )
      )
        add(
          s,
          "parameters",
          "Unknown HTTP parameters need an explicit mapping.",
        );
      if (
        s.source_action === "custom" &&
        p.data !== undefined &&
        !p.payload_type
      )
        add(s, "http", "Specify custom-request payload encoding.");
    }
    const keys = {
      slack: [
        "channel",
        "text",
        "connection",
        "unfurl",
        "thread_ts",
        "blocks",
        "attachments",
        "username",
        "icon_url",
        "icon_emoji",
        "unfurl_links",
        "unfurl_media",
        "reply_broadcast",
        "link_names",
        "join_channel",
      ],
      slack_join: ['channel', 'connection'],
      airtable: ["base", "table", "fields", "connection"],
      airtable_update: ["base", "table", "fields", "connection", "record"],
      transform: ["fields"],
    }[s.kind];
    if (keys) {
      if (
        keys
          .filter(
            (k) =>
              s.kind !== "slack" ||
              ["channel", "text", "connection"].includes(k),
          )
          .some((k) => p[k] === undefined || p[k] === "")
      )
        add(s, "mapping", "Complete the action fields and connection binding.");
      if (Object.keys(p).some((k) => !keys.includes(k)))
        add(
          s,
          "parameters",
          "Unmapped source parameters remain. Review the explicit adapter.",
        );
      if (
        (s.kind === "airtable" ||
          s.kind === "airtable_update" ||
          s.kind === "transform") &&
        (!p.fields || typeof p.fields !== "object" || Array.isArray(p.fields))
      )
        add(s, "mapping", "Fields must be an object.");
      if (p.connection && typeof p.connection !== "string")
        add(s, "mapping", "Connection must be a binding name.");
    }
    if (s.kind === 'slack' && p.join_channel !== undefined && typeof p.join_channel !== 'boolean')
      add(s, 'parameters', 'join_channel must be a boolean.');
    if (s.kind === 'slack' && p.reply_broadcast && !p.thread_ts)
      add(s, 'parameters', 'Broadcast replies require a thread timestamp.');
    if (s.kind === "airtable_find") {
      if (
        !p.base ||
        !p.table ||
        !p.connection ||
        (!p.formula && (!p.field || p.value === undefined))
      )
        add(s, "mapping", "Complete the Airtable search mapping.");
      if (
        !["continue", "hold"].includes(p.on_missing) ||
        !["first", "halt"].includes(p.multiple)
      )
        add(s, "mapping", "Choose search miss and multiple-match behavior.");
      if (
        Object.keys(p).some(
          (k) =>
            ![
              "base",
              "table",
              "connection",
              "formula",
              "field",
              "value",
              "exact",
              "view",
              "on_missing",
              "multiple",
            ].includes(k),
        )
      )
        add(s, "parameters", "Unknown search parameters need review.");
    }
    function templates(v) {
      if (typeof v === "string")
        for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) {
          const ref = parseReference(m[1]);
          if (!ref) {
            add(
              s,
              "expression",
              "Unsupported expression. Replace it with a reviewed field mapping.",
            );
            continue;
          }
          const ancestors = new Set();
          let parent = byId.get(s.parent_id);
          while (parent && !ancestors.has(parent.id)) {
            ancestors.add(parent.id);
            parent = byId.get(parent.parent_id);
          }
          if (!ancestors.has(ref.step_id))
            add(
              s,
              "reference",
              `Step ${ref.step_id} is not an ancestor. Repair this mapping.`,
            );
          if (
            ref.path.some((k) =>
              ["__proto__", "prototype", "constructor"].includes(k),
            )
          )
            add(s, "reference", "Unsafe reference path.");
        }
      else if (Array.isArray(v)) v.forEach(templates);
      else if (v && typeof v === "object") Object.values(v).forEach(templates);
    }
    templates(p);
  }
  return { ready: issues.length === 0, issues, ordered };
}
export function compile(definition) {
  const plan = validate(definition);
  if (!plan.ready) throw Error("Resolve migration issues before compiling.");
  return compileGraph(definition, plan);
}
