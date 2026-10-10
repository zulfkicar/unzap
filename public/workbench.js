const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function graph(steps, selected, issues) {
  const byId = new Map(steps.map((s) => [s.id, s])),
    children = new Map(),
    seen = new Set();
  for (const s of steps) {
    const group = children.get(s.parent_id) || [];
    group.push(s);
    children.set(s.parent_id, group);
  }
  function node(s) {
    if (seen.has(s.id))
      return `<div class="graph-warning">Cycle or repeated node ${esc(s.id)}</div>`;
    seen.add(s.id);
    const blocked = issues.some((i) => i.step_id === s.id),
      rows = children.get(s.id) || [];
    const label =
      s.name && s.name !== s.source_action
        ? s.name
        : {
            webhook: "Receive webhook",
            filter: "Check conditions",
            http: "Call endpoint",
            slack: "Post Slack message",
            airtable: "Create record",
            transform: "Map fields",
            paths: "Evaluate paths",
            path:
              "Path " +
              (s.params?.mode === "rules" ? "conditions" : s.params?.mode),
            formatter: "Format data",
            airtable_find: "Find record",
            airtable_update: "Update record",
          }[s.kind] ||
          s.name ||
          s.source_action ||
          s.kind;
    return `<li class="graph-item"><button class="flow-node ${s.id === selected ? "selected" : ""} ${blocked ? "problem" : ""}" data-step="${esc(s.id)}"><span class="node-index">${esc(s.id)}</span><span class="node-copy"><strong>${esc(label)}</strong><small>${esc(s.kind === "unsupported" ? s.source_app : s.kind)}${s.parent_id ? " · from " + esc(s.parent_id) : " · trigger"}</small></span><span class="node-state" aria-label="${blocked ? "Needs review" : "Mapped"}">${blocked ? "!" : "✓"}</span></button>${rows.length > 1 ? '<div class="branch-label">' + rows.length + (s.kind === "paths" ? " paths · sequential execution</div>" : " paths · review required</div>") : ""}${rows.length ? `<ol class="graph-children ${rows.length > 1 ? "branched" : "linear"}">${rows.map(node).join("")}</ol>` : ""}</li>`;
  }
  const roots = steps.filter(
    (s) => s.parent_id == null || !byId.has(s.parent_id),
  );
  let html = roots.map(node).join("");
  for (const s of steps) if (!seen.has(s.id)) html += node(s);
  return `<ol class="workflow-graph">${html}</ol>`;
}
export function stages(w) {
  const checks = w.checks.filter((c) => c.passed).length;
  const rows = [
    ["01", "steps", "Map", w.ready ? "Mapped" : w.issues + " to review"],
    ["02", "tests", "Verify", checks + "/" + w.fixtures.length + " cases"],
    ["03", "code", "Code", w.code ? "Generated" : "Blocked"],
    [
      "04",
      "deploy",
      "Run",
      w.active_version ? "v" + w.active_version + " · " + w.mode : "Not active",
    ],
  ];
  return `<div class="migration-stages">${rows.map(([n, id, title, status]) => `<button data-tab="${id}"><span>${n}</span><strong>${title}</strong><small>${esc(status)}</small></button>`).join("")}</div>`;
}
export function fieldShelf(input, rootId) {
  if (!input || typeof input !== "object")
    return '<p class="field-hint">Add a representative input under Test cases to browse its fields.</p>';
  const fields = [];
  function visit(v, path = []) {
    if (fields.length >= 40) return;
    if (v && typeof v === "object" && !Array.isArray(v))
      for (const [k, x] of Object.entries(v)) visit(x, [...path, k]);
    else fields.push({ path, value: v });
  }
  visit(input);
  return `<div class="field-shelf"><div class="shelf-heading"><strong>Trigger fields</strong><span>from test input</span></div><div class="field-chips">${fields
    .map((f) => {
      const reference =
        "{{=gives" +
        [rootId, ...f.path].map((k) => "[" + JSON.stringify(k) + "]").join("") +
        "}}";
      return `<button type="button" data-reference="${esc(reference)}" title="Insert this field into the last focused mapping"><code>${esc(f.path.join(" / "))}</code><small>${Array.isArray(f.value) ? "array" : typeof f.value}</small></button>`;
    })
    .join(
      "",
    )}</div><p class="field-hint">Focus a value, then insert a source field. In JSON, place the cursor inside a quoted value.</p></div>`;
}
