import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { taskMessages, wireDefinition } from "./protocol.js";
import { judge } from "./oracle.js";
const sha = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const root = (id) => ({
  id: String(id),
  parent_id: null,
  kind: "webhook",
  params: {},
});
const step = (id, parent, kind, params) => ({
  id: String(id),
  parent_id: String(parent),
  kind,
  params,
});
const ref = (id, key) => `{{${id}__${key}}}`;
const rule = (id, key, match, value, action = "continue") => ({
  group: 0,
  key: ref(id, key),
  match,
  value,
  action,
});
const req = (url, body, method = "POST") => ({ url, method, body });
const requestStep = (id, parent, url, data) =>
  step(id, parent, "http", { url, method: "POST", payload_type: "json", data });
const families = [
  "map",
  "normalize",
  "gate",
  "route",
  "lookup",
  "date",
  "query",
  "source_linear",
  "source_export",
];
function make(family, index, partition) {
  const prefix =
    partition === "train"
      ? "job"
      : partition === "validation"
        ? "dispatch"
        : "shipment";
  const key = prefix + "_reference_" + index,
    amount = prefix + "_units_" + index,
    label = prefix + "_label_" + index,
    id = family.startsWith("source_")
      ? String(1000 + index * 31 + (partition === "test" ? 40000 : 0))
      : "1";
  const n = (i) => String(Number(id) + i),
    url = `https://example.test/${partition}/${family}/${index}`;
  let d = { name: `${family}-${index}`, steps: [root(id)] },
    description,
    fixtures;
  if (family === "map") {
    d.steps.push(
      step(n(1), id, "transform", {
        fields: {
          reference: ref(id, key),
          units: ref(id, amount),
          active: ref(id, "active"),
        },
      }),
    );
    description = `Accept a JSON webhook with ${key}, ${amount} and active. Return reference, units and active without converting numbers or booleans to text.`;
    fixtures = [
      {
        input: { [key]: "sample-" + index, [amount]: 0, active: false },
        status: "succeeded",
        requests: [],
        final: { reference: "sample-" + index, units: 0, active: false },
      },
      {
        input: { [key]: "مثال", [amount]: index + 7, active: true },
        status: "succeeded",
        requests: [],
        final: { reference: "مثال", units: index + 7, active: true },
      },
    ];
  } else if (family === "normalize" || family === "source_linear") {
    d.steps.push(
      step(n(1), id, "formatter", {
        transform: "string.trim_space",
        inputs: ref(id, label),
      }),
      step(n(2), n(1), "formatter", {
        transform: "string.lower_case",
        inputs: ref(n(1), "output"),
      }),
      step(n(3), n(2), "transform", {
        fields: { label: ref(n(2), "output"), units: ref(id, amount) },
      }),
    );
    description = `A webhook has ${label} and ${amount}. Trim surrounding whitespace from ${label}, lowercase it and return label plus numeric units from ${amount}. Preserve zero.`;
    fixtures = [
      {
        input: { [label]: "  ALPHA  ", [amount]: 0 },
        status: "succeeded",
        requests: [],
        final: { label: "alpha", units: 0 },
      },
      {
        input: { [label]: "  مقامی  ", [amount]: 3 },
        status: "succeeded",
        requests: [],
        final: { label: "مقامی", units: 3 },
      },
    ];
  } else if (family === "gate") {
    const limit = 10 + index;
    d.steps.push(
      step(n(1), id, "filter", {
        filter_criteria: [
          rule(id, amount, "igreater", String(limit)),
          rule(id, label, "icontains", "draft", "stop"),
        ],
      }),
      requestStep(n(2), n(1), url, {
        reference: ref(id, key),
        units: ref(id, amount),
      }),
    );
    description = `Receive JSON. Send POST JSON to ${url} only when ${amount} is greater than ${limit} and ${label} does not contain draft (ignore case). Body fields are reference from ${key} and units from ${amount}, preserving its number type.`;
    fixtures = [
      {
        input: { [key]: "ref", [amount]: limit + 1, [label]: "final" },
        status: "succeeded",
        requests: [req(url, { reference: "ref", units: limit + 1 })],
      },
      {
        input: { [key]: "ref", [amount]: limit, [label]: "final" },
        status: "filtered",
        requests: [],
      },
      {
        input: { [key]: "ref", [amount]: limit + 1, [label]: "DRAFT" },
        status: "filtered",
        requests: [],
      },
    ];
  } else if (family === "route" || family === "nested_route") {
    const limit = 20 + index,
      high = url + "/priority",
      normal = url + "/normal";
    d.steps.push(
      step(n(1), id, "paths", {}),
      step(n(2), n(1), "path", {
        mode: "rules",
        order: 0,
        filter_criteria: [rule(id, amount, "igreater", String(limit))],
      }),
    );
    if (family === "route") {
      d.steps.push(
        requestStep(n(3), n(2), high, { units: ref(id, amount) }),
        step(n(4), n(1), "path", { mode: "fallback", order: 1 }),
        requestStep(n(5), n(4), normal, { units: ref(id, amount) }),
      );
      description = `On a JSON webhook, route ${amount} greater than ${limit} to ${high}. Otherwise use ${normal}. POST {units: the original numeric ${amount}}. Exactly one route may write.`;
      fixtures = [
        {
          input: { [amount]: limit + 1 },
          status: "succeeded",
          requests: [req(high, { units: limit + 1 })],
        },
        {
          input: { [amount]: 0 },
          status: "succeeded",
          requests: [req(normal, { units: 0 })],
        },
      ];
    } else {
      const fast = url + "/fast";
      d.steps.push(
        step(n(3), n(2), "paths", {}),
        step(n(4), n(3), "path", {
          mode: "rules",
          order: 0,
          filter_criteria: [rule(id, "expedited", "boolean", "true")],
        }),
        requestStep(n(5), n(4), fast, { units: ref(id, amount) }),
        step(n(6), n(3), "path", { mode: "fallback", order: 1 }),
        requestStep(n(7), n(6), high, { units: ref(id, amount) }),
        step(n(8), n(1), "path", { mode: "fallback", order: 1 }),
        requestStep(n(9), n(8), normal, { units: ref(id, amount) }),
      );
      description = `Receive JSON. If ${amount}>${limit}, use nested routes: expedited=true goes to ${fast}, otherwise ${high}. If units do not exceed ${limit}, use ${normal}. POST JSON {units: original ${amount}} to exactly one endpoint. Preserve the numeric value.`;
      fixtures = [
        {
          input: { [amount]: limit + 1, expedited: true },
          status: "succeeded",
          requests: [req(fast, { units: limit + 1 })],
        },
        {
          input: { [amount]: limit + 1, expedited: false },
          status: "succeeded",
          requests: [req(high, { units: limit + 1 })],
        },
        {
          input: { [amount]: 0, expedited: true },
          status: "succeeded",
          requests: [req(normal, { units: 0 })],
        },
      ];
    }
  } else if (family === "lookup" || family === "lookup_route") {
    d.steps.push(
      step(n(1), id, "airtable_find", {
        connection: "AIRTABLE_TOKEN",
        base: "app_example",
        table: "Inventory",
        field: "Reference",
        value: ref(id, key),
        exact: true,
        on_missing: "continue",
        multiple: "first",
      }),
    );
    const findUrl =
      "https://api.airtable.com/v0/app_example/Inventory?filterByFormula=%7BReference%7D%3D%22sample%22&maxRecords=1&returnFieldsByFieldId=true";
    if (family === "lookup") {
      d.steps.push(
        step(n(2), n(1), "transform", {
          fields: { found: ref(n(1), "_zap_search_was_found_status") },
        }),
      );
      description = `On a JSON webhook, search Airtable base app_example table Inventory for Reference exactly equal to ${key}. Use connection AIRTABLE_TOKEN, continue on a miss, choose the first match, and return {found: the boolean search-found status}.`;
      fixtures = [
        {
          input: { [key]: "sample" },
          responses: { airtable_find: { records: [] } },
          status: "succeeded",
          requests: [req(findUrl, null, "GET")],
          final: { found: false },
        },
        {
          input: { [key]: "sample" },
          responses: {
            airtable_find: {
              records: [
                { id: "rec_existing", fields: { Reference: "sample" } },
              ],
            },
          },
          status: "succeeded",
          requests: [req(findUrl, null, "GET")],
          final: { found: true },
        },
      ];
    } else {
      const found = url + "/found",
        missing = url + "/missing";
      d.steps.push(
        step(n(2), n(1), "paths", {}),
        step(n(3), n(2), "path", {
          mode: "rules",
          order: 0,
          filter_criteria: [
            rule(n(1), "_zap_search_was_found_status", "boolean", "true"),
          ],
        }),
        requestStep(n(4), n(3), found, { reference: ref(id, key) }),
        step(n(5), n(2), "path", { mode: "fallback", order: 1 }),
        requestStep(n(6), n(5), missing, { reference: ref(id, key) }),
      );
      description = `Receive JSON and search Airtable app_example / Inventory where Reference exactly equals ${key}. Use AIRTABLE_TOKEN, first match, continue if missing. Branch on the boolean found status: POST {reference: ${key}} to ${found} when found, otherwise ${missing}. Preserve one write per event.`;
      fixtures = [
        {
          input: { [key]: "sample" },
          responses: { airtable_find: { records: [] } },
          status: "succeeded",
          requests: [
            req(findUrl, null, "GET"),
            req(missing, { reference: "sample" }),
          ],
        },
        {
          input: { [key]: "sample" },
          responses: {
            airtable_find: {
              records: [
                { id: "rec_existing", fields: { Reference: "sample" } },
              ],
            },
          },
          status: "succeeded",
          requests: [
            req(findUrl, null, "GET"),
            req(found, { reference: "sample" }),
          ],
        },
      ];
    }
  } else if (family === "date") {
    d.steps.push(
      step(n(1), id, "formatter", {
        transform: "date.formatting",
        inputs: ref(id, "timestamp"),
        from_format: "X",
        to_timezone: "UTC",
        to_format: "YYYY-MM-DD",
      }),
      step(n(2), n(1), "transform", {
        fields: { date: ref(n(1), "output"), reference: ref(id, key) },
      }),
    );
    description = `A JSON webhook contains Unix seconds in timestamp and ${key}. Format timestamp as YYYY-MM-DD in UTC and return {date, reference from ${key}}.`;
    fixtures = [
      {
        input: { timestamp: 0, [key]: "sample" },
        status: "succeeded",
        requests: [],
        final: { date: "1970-01-01", reference: "sample" },
      },
    ];
  } else if (family === "query") {
    d.steps.push(
      step(n(1), id, "http", {
        url,
        method: "GET",
        data: { reference: ref(id, key) },
        payload_type: "json",
      }),
    );
    description = `Receive JSON. Make a GET request to ${url} with query parameter reference from ${key}. Do not send a body. Encode spaces and punctuation safely.`;
    fixtures = [
      {
        input: { [key]: "A & B" },
        status: "succeeded",
        requests: [req(url + "?reference=A+%26+B", null, "GET")],
      },
    ];
  } else if (family === "source_export") {
    d.steps.push(
      step(n(1), id, "formatter", {
        transform: "string.trim_space",
        inputs: ref(id, label),
      }),
      requestStep(n(2), n(1), url, {
        reference: ref(id, key),
        label: ref(n(1), "output"),
        units: ref(id, amount),
      }),
    );
    description =
      "Convert the supplied Zap JSON export into an executable Unzap proposal. Preserve every ID and parent link, typed field references and the request body.";
    fixtures = [
      {
        input: { [key]: "sample", [label]: "  ready ", [amount]: 0 },
        status: "succeeded",
        requests: [req(url, { reference: "sample", label: "ready", units: 0 })],
      },
    ];
  } else if (family === "unsupported") {
    d.steps.push(
      step(n(1), id, "unsupported", {
        operation: "launch_private_payroll",
        body: ref(id, key),
      }),
    );
    description =
      "Convert the supplied source. Its proprietary payroll action has no API contract. Do not invent an executable adapter or discard the step.";
    return {
      id: `${partition}-${family}-${index}`,
      family,
      description,
      source: d,
      expected_action: "inspect",
      completion: {
        action: "inspect",
        reason: "Missing native contract for the proprietary action.",
      },
      fixtures: [],
    };
  }
  const task = {
    id: `${partition}-${family}-${index}`,
    family,
    description,
    expected_action: "propose",
    definition: d,
    completion: { action: "propose", definition: wireDefinition(d) },
    fixtures,
  };
  if (family === "source_linear") task.source = structuredClone(d);
  if (family === "source_export")
    task.source = {
      nodes: {
        [id]: {
          id: Number(id),
          parent_id: null,
          selected_api: "WebHookCLIAPI@1.0.29",
          action: "hook_v2",
          params: { key: "" },
        },
        [n(1)]: {
          id: Number(n(1)),
          parent_id: Number(id),
          selected_api: "ZapierFormatterCLIAPI@1.0.8",
          action: "text_line_item",
          params: d.steps[1].params,
        },
        [n(2)]: {
          id: Number(n(2)),
          parent_id: Number(n(1)),
          selected_api: "WebHookCLIAPI@1.0.29",
          action: "post",
          params: {
            url,
            payload_type: "json",
            data: d.steps[2].params.data,
            unflatten: "no",
            wrap_in_array: "no",
          },
        },
      },
    };
  return task;
}
const splits = { train: [], validation: [], test: [] };
for (const family of [...families, "unsupported"])
  for (let i = 0; i < 12; i++) splits.train.push(make(family, i, "train"));
for (const family of [...families, "unsupported"])
  for (let i = 20; i < 22; i++)
    splits.validation.push(make(family, i, "validation"));
for (const family of [
  ...families,
  "unsupported",
  "nested_route",
  "lookup_route",
])
  for (let i = 40; i < 42; i++) splits.test.push(make(family, i, "test"));
const hashes = new Set();
for (const [split, tasks] of Object.entries(splits))
  for (const task of tasks) {
    const result = await judge(task, task.completion);
    if (!result.behavior_passed)
      throw Error("Oracle failed " + task.id + ": " + JSON.stringify(result));
    task.messages = [
      ...taskMessages(task),
      { role: "assistant", content: JSON.stringify(task.completion) },
    ];
    task.content_hash = sha(task.messages);
    if (hashes.has(task.content_hash))
      throw Error("Duplicate example across splits");
    hashes.add(task.content_hash);
    task.structural_holdout =
      split === "test" &&
      ["nested_route", "lookup_route"].includes(task.family);
  }
const out = ".data/finetune/dataset";
mkdirSync(out, { recursive: true });
mkdirSync(".data/finetune/runs", { recursive: true });
for (const [split, tasks] of Object.entries(splits))
  writeFileSync(
    `${out}/${split}.jsonl`,
    tasks.map((task) => JSON.stringify(task)).join("\n") + "\n",
  );
const manifest = {
  version: "unzap-sft-v1",
  seed: 20261010,
  provenance:
    "Authored fictional examples from implemented contracts and inspected export shapes. No customer records, credentials, private code or raw company export literals.",
  counts: Object.fromEntries(
    Object.entries(splits).map(([k, v]) => [k, v.length]),
  ),
  split_policy:
    "Disjoint payload domains and variants. Nested routing and lookup-plus-routing families appear only in test. Familiar-family test cases are reported separately.",
  oracle:
    "All labeled programs compiled and passed independently authored behavioral fixtures. Refusal cases require inspect without executable definition.",
  fingerprints: Object.fromEntries(
    Object.entries(splits).map(([k, v]) => [
      k,
      sha(v.map((t) => t.content_hash)),
    ]),
  ),
};
writeFileSync(out + "/manifest.json", JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
