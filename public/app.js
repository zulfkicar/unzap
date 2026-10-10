import { graph, stages, fieldShelf } from "./workbench.js";
import { agentView } from "./agent-view.js";
import { accountSelector, connectionsPage, credentialHelp, connectionForm, assignmentForm, providerFor } from './connections-view.js';
import { oauthConnectForm, oauthSettingsForm, adminSettingsPage } from './oauth-view.js';
const app = document.querySelector("#app"),
  modal = document.querySelector("#modal");
let state,
  current,
  selected,
  tab = "steps",
  page = "migrations",
  search = "",
  offset = 0,
  noticeTimer;
const escape = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const pretty = (v) => JSON.stringify(v, null, 2);
const pill = (status, label = status) =>
  `<span class="pill ${escape(status)}">${escape(label)}</span>`;
const symbols = {
  webhook: "↳",
  filter: "ƒ",
  transform: "{}",
  http: "↗",
  slack: "#",
  airtable: "▦",
  unsupported: "?",
};
const date = (v) =>
  v
    ? new Date(v).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
async function api(path, options = {}) {
  const response = await fetch("/api" + path, {
    signal: AbortSignal.timeout(path === "/import" ? 90000 : 30000),
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) login();
    throw Error(data.error || "Request failed");
  }
  return data;
}
const post = (path, body = {}) =>
  api(path, { method: "POST", body: JSON.stringify(body) });
function notice(text, error = false) {
  const el = document.querySelector("#notice");
  el.textContent = text;
  el.className = "visible" + (error ? " error" : "");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.className = ""), 7000);
}
function login() {
  app.innerHTML = `<main class="login"><form id="login" class="panel"><div class="brand"><span class="brandmark">//</span>Unzap</div><div class="eyebrow">Local workspace</div><h1>Sign in to Unzap</h1><p>This installation keeps workflow definitions, credentials and run data on your machine.</p><label for="token">Control token</label><input id="token" name="token" type="password" required autocomplete="current-password"><p class="field-hint">Find your token in <code>.data/control/login-token</code>. With Docker, run <code>docker compose exec app cat .data/control/login-token</code>.</p><button class="primary">Sign in</button></form></main>`;
}
function frame(content, breadcrumb = "Migration desk") {
  app.innerHTML = `<div class="shell"><aside class="sidebar"><a class="brand" href="#migrations"><span class="brandmark">u/</span><span>unzap<span class="brand-sub">workflow engineering</span></span></a><div class="workspace">WORKBENCH / 01</div><nav>${[
    ["migrations", "01", "Migration desk"],
    ["runs", "02", "Run journal"],
    ["connections", "03", "Connections"],
    ["agent", "04", "Migration agent"],
    ["admin", "05", "Admin settings"],
  ]
    .map(
      ([id, n, label]) =>
        `<a href="#${id}" class="${page === id ? "active" : ""}"><span class="navsymbol">${n}</span>${label}<span class="nav-arrow">↗</span></a>`,
    )
    .join(
      "",
    )}</nav><div class="sidebar-note"><span class="status-led"></span><strong>Local runtime</strong><p>Definitions and credentials stay on this host.</p></div><div class="sidebar-bottom"><span class="mono">NODE / SQLITE</span><button class="quiet" data-action="logout">Sign out ↗</button></div></aside><div class="content"><header class="topbar"><div class="breadcrumb"><span class="muted">UNZAP</span><span>/</span>${escape(breadcrumb)}</div><div class="environment"><span class="status-led"></span>${state?.live_enabled ? "Live execution available" : "External writes disabled"}</div></header><main class="page">${content}</main><footer class="workspace-footer"><span>OWNED WORKFLOWS / NATIVE JAVASCRIPT</span><span>Review → verify → run</span></footer></div></div>`;
}
async function refreshState() {
  state = await api("/state");
}
async function route() {
  clearTimeout(agentPoll);
  try {
    await refreshState();
    const hash = location.hash.slice(1).split("/");
    page = ["runs", "connections", "agent", "admin"].includes(hash[0])
      ? hash[0]
      : "migrations";
    if (hash[0] === "workflow" && hash[1]) {
      current = await api("/workflows/" + hash[1]);
      selected =
        selected && current.definition.steps.some((s) => s.id === selected)
          ? selected
          : current.definition.steps[0]?.id;
      renderWorkflow();
    } else if (page === "runs") await allRuns();
    else if (page === "connections") renderConnections();
    else if (page === "admin") frame(adminSettingsPage(state), "Admin settings");
    else if (page === "agent") await showAgent(hash);
    else await migrations();
    const oauthResult=(await api('/oauth/result')).result;
    if(oauthResult){
      if(oauthResult.status==='connected'){
        notice('Account connected through OAuth. Tokens will renew automatically when needed.');
        if(oauthResult.workflow_id&&oauthResult.step_id){
          current=await api('/workflows/'+oauthResult.workflow_id);page='migrations';selected=oauthResult.step_id;
          location.hash='workflow/'+current.id;renderWorkflow();
          const target=current.definition.steps.find(s=>s.id===selected),account=state.connections.find(c=>c.binding===oauthResult.binding);
          if(target&&account&&providerFor(target.kind,state.providers)===account.provider){
            dialog(assignmentForm(current,state,selected));document.querySelector('#assign-binding').value=oauthResult.binding;
          }else notice('Account connected. The original step changed, so choose where to use this account.');
        }
      }else notice(oauthResult.message||'Sign-in was not completed.',oauthResult.status==='failed');
    }
  } catch (e) {
    notice(e.message, true);
  }
}
let agentPoll, agentWorkspace;
async function showAgent(hash) {
  agentWorkspace = await api("/agent");
  const job = hash[1] === "run" ? await api("/agent/runs/" + hash[2]) : null;
  const source =
    hash[1] === "source" ? await api("/workflows/" + hash[2]) : null;
  frame(
    agentView(agentWorkspace.configuration, agentWorkspace.runs, job, source),
    "Migration agent",
  );
  if (job?.status === "running")
    agentPoll = setTimeout(() => pollAgent(job.id), 3000);
}
async function pollAgent(id) {
  if (!location.hash.endsWith(id) || page !== "agent") return;
  try {
    const job = await api("/agent/runs/" + id);
    frame(
      agentView(agentWorkspace.configuration, agentWorkspace.runs, job),
      "Migration agent",
    );
    if (job.status === "running")
      agentPoll = setTimeout(() => pollAgent(id), 3000);
  } catch (error) {
    notice(error.message, true);
  }
}
async function migrations() {
  const data = await api(
    "/workflows?q=" + encodeURIComponent(search) + "&offset=" + offset,
  );
  frame(
    `<div class="heading"><div><div class="eyebrow">Workflow migration</div><h1>Migration desk</h1><p>Inspect the source, resolve mappings, and verify the code before moving traffic.</p></div><div class="actions"><a class="button-link primary" href="#agent">Describe a process ↗</a><button data-action="new">Manual workflow</button></div></div><section class="import-banner"><div><div class="banner-title"><span class="banner-icon">⇄</span><h2>Import your source workflows</h2></div><p>JSON or ZIP → source graph → reviewed mappings → verified code. Start with representative inputs before moving traffic.</p></div><button class="primary" data-action="import">Import export ↗</button></section><section class="table-panel"><div class="table-tools"><div><strong>Workflows</strong><span class="count">${data.total}</span></div><input id="search" aria-label="Search workflows" placeholder="Search workflows…" value="${escape(search)}"></div><table><thead><tr><th>Workflow</th><th>Conversion</th><th>Steps</th><th>Deployment</th><th></th></tr></thead><tbody>${data.rows.map((w) => `<tr data-workflow="${w.id}" tabindex="0" role="link" aria-label="Open ${escape(w.name)}"><td><strong>${escape(w.name)}</strong><small>Version ${w.version} · ${w.bindings.length} connection bindings</small></td><td>${w.ready ? pill("ready", "Ready to test") : pill("review", w.issues + " to review")}</td><td class="mono">${w.steps}</td><td>${w.active_version ? pill(w.mode, "v" + w.active_version + " · " + w.mode) : '<span class="muted">Not active</span>'}</td><td>→</td></tr>`).join("") || '<tr><td colspan="5" class="empty">No workflows found. Import an export or start a new workflow.</td></tr>'}</tbody></table>${data.total > 100 ? `<div class="table-tools"><span class="muted">${offset + 1}–${Math.min(offset + 100, data.total)} of ${data.total}</span><div class="actions"><button data-action="previous" ${offset === 0 ? "disabled" : ""}>Previous</button><button data-action="next" ${offset + 100 >= data.total ? "disabled" : ""}>Next</button></div></div>` : ""}</section><p class="footnote">The starter workflows are original synthetic examples. A “ready” conversion still needs behavioral tests and a sandbox cutover.</p>`,
    "Migrations",
  );
}
function renderWorkflow() {
  const w = current;
  frame(
    `<div class="heading"><div><div class="eyebrow"><a href="#migrations">← Migrations</a> / Version ${w.version}</div><h1>${escape(w.name)}</h1><p>${w.ready ? pill("ready", "Ready to test") : pill("review", w.issues + " migration issues")} ${w.active_version ? pill(w.mode, "Active v" + w.active_version) : pill("mock", "Not active")} <span class="count">${w.steps} steps · ${w.bindings.length} bindings</span></p></div><div class="actions"><a class="button-link" href="#agent/source/${w.id}">Agent migration ↗</a><button data-action="versions">Versions</button><button data-action="rename">Rename</button><button class="primary" data-action="replay" ${!w.ready ? "disabled" : ""}>▷ Replay input</button></div></div>${stages(w)}<div class="tabs" role="tablist">${[
      ["steps", "Workflow"],
      ["tests", "Test cases"],
      ["code", "Generated code"],
      ["runs", "Runs"],
      ["deploy", "Deployment"],
    ]
      .map(
        ([id, label]) =>
          `<button role="tab" aria-selected="${tab === id}" class="${tab === id ? "active" : ""}" data-tab="${id}">${label}${id === "tests" ? ` <span class="count">${w.fixtures.length}</span>` : ""}</button>`,
      )
      .join(
        "",
      )}</div>${{ steps: stepsView, tests: testsView, code: codeView, runs: () => runsTable(w.runs), deploy: deployView }[tab]()}`,
    "Migration / " + w.name,
  );
}
function stepsView() {
  const w = current,
    s = w.definition.steps.find((s) => s.id === selected),
    issues = w.plan.issues.filter((i) => !i.step_id || i.step_id === selected);
  return `<div class="workflow-area"><section><div class="flow-head"><h3>Source graph</h3><span>${w.steps} nodes</span></div><div class="flow-nodes">${graph(w.definition.steps, selected, w.plan.issues)}</div><button data-action="add-step" class="quiet">＋ Add a step</button><div class="end-note">An imported Paths graph remains intact. Paths execute matching branches sequentially, including nested groups and fallback rules. Polling, delays and arbitrary code steps still need adapters.</div></section><section class="panel">${
    s
      ? `<div class="panel-header"><span class="appicon ${escape(s.kind)}">${escape(symbols[s.kind] || "?")}</span><div><h2>Step ${escape(s.id)}</h2><p>${escape(s.name || s.source_action)}</p></div></div>${issues.map((i) => `<div class="issue"><strong>${escape(i.code.replaceAll("_", " "))}</strong>${escape(i.message)}</div>`).join("")}<form id="step-editor"><label for="step-name">Step name</label><input id="step-name" name="name" value="${escape(s.name)}"><div class="two-col"><div><label for="kind">Action adapter</label><select id="kind" name="kind">${Object.entries(
          state.actions,
        )
          .map(
            ([k, a]) =>
              `<option value="${k}" ${s.kind === k ? "selected" : ""}>${escape(a.label)}</option>`,
          )
          .join(
            "",
          )}</select></div><div><label for="parent">Runs after</label><select id="parent" name="parent_id"><option value="">Trigger / no parent</option>${w.definition.steps
          .filter((n) => n.id !== s.id)
          .map(
            (n) =>
              `<option value="${escape(n.id)}" ${s.parent_id === n.id ? "selected" : ""}>Step ${escape(n.id)} · ${escape(n.name || n.kind)}</option>`,
          )
          .join(
            "",
          )}</select></div></div>${parameterEditor(s.kind, s.params)}<p class="field-hint">Use <code>{{1__field}}</code> or <code>{{=gives["1"]["field"]}}</code> for outputs. Whole-field references preserve numbers, booleans and objects.</p>${s.kind === "webhook" ? "" : fieldShelf(w.fixtures[0]?.input, w.definition.steps.find((n) => n.parent_id == null)?.id)}<div id="adapter-help">${adapterHelp(s.kind)}</div><div class="source-label">Source: ${escape(s.source_app || "Native action")} · ${escape(s.source_action || s.kind)}<br>Original versions remain available after edits.</div>${s.source_params ? `<details><summary>View imported parameters</summary><pre class="json-view">${escape(pretty(s.source_params))}</pre></details>` : ""}<div class="panel-footer"><button type="button" class="quiet danger" data-action="remove-step">Remove step</button><button class="primary">${s.review_required ? "Approve mapping & save" : "Save new version"}</button></div></form>`
      : "No steps."
  }</section></div>`;
}
function adapterHelp(kind) {
  const descriptions = {
    http: 'Set method, url, payload_type, headers and data. Put bearer credentials in headers.Authorization as {"$env":"SERVICE_TOKEN"}. Live destinations must be in ALLOWED_HOSTS.',
    slack:
      "Provide channel, text and connection. Posting needs chat:write. Optional public-channel joining needs channels:join and records a separate receipt. Private channels must invite the bot.",
    sheets_append: 'Map columns by letter and use the exported numeric tab ID. A metadata read resolves its title before appending. Review USER_ENTERED parsing and provide a fresh Google access token with Sheets scope.',
    sheets_update: 'Map columns by letter and specify a positive row number. Only mapped cells are updated. Numeric tab IDs resolve through metadata. Review cell interpretation and fresh Google credentials.',
    airtable:
      "Provide base, table, fields and connection. Use a fresh Airtable personal access token with write permission for this base. The output is a single record with id and fields.",
    airtable_find: 'Select an Airtable account with record-read access to this base. Review the search field or formula, miss behavior and multiple-match policy.',
    airtable_update: 'Select an Airtable account with record-write access to this base. Map a record ID and only the fields you want to update.',
    transform:
      "The fields object becomes this step’s output. This is a deterministic field mapper, not arbitrary JavaScript execution.",
    filter:
      "Scalar continue rules only. AND within a group, OR between groups. Unsupported date and line-item rules stay blocked.",
    webhook:
      "Receives a JSON object through a bearer-authenticated endpoint. Use an Idempotency-Key for every event.",
    unsupported:
      "Choose a supported adapter and map its parameters explicitly. The source action is retained for review.",
  };
  return `<div class="hintbox">${escape(descriptions[kind] || descriptions.unsupported)}</div>`;
}
function parameterEditor(kind, p, raw = false) {
  const json = `<label for="params">Action parameters · JSON</label><textarea id="params" name="params" rows="12" spellcheck="false">${escape(pretty(p))}</textarea>`;
  let fields = "";
  const input = (key, label, value) =>
    `<label for="param-${key}">${label}</label><input id="param-${key}" name="p_${key}" value="${escape(value)}">`;
  const area = (key, label, value) =>
    `<label for="param-${key}">${label}</label><textarea id="param-${key}" name="p_${key}" rows="5" spellcheck="false">${escape(typeof value === "string" ? value : pretty(value))}</textarea>`;
  if (kind === "webhook")
    fields = input('child_key', 'Child object key · optional', p.child_key || '') + '<p class="field-hint">Leave empty to receive the full object. Selecting an array holds the run. Configure bearer authentication under Deployment.</p>';
  if (kind === "slack")
    fields =
      accountSelector(kind,p,state,selected) +
      input("channel", "Channel ID", p.channel) +
      area("text", "Message text", p.text || "") +
      input("thread_ts", "Thread timestamp · optional", p.thread_ts || "") +
      `<label><input type="checkbox" name="p_join_channel" ${p.join_channel ? 'checked' : ''}> Join the public channel before posting</label><p class="field-hint">Requires channels:join. Joining and delivery have separate receipts.</p>`;
  if (kind === "airtable")
    fields =
      accountSelector(kind,p,state,selected) +
      input("base", "Base ID", p.base) +
      input("table", "Table name or ID", p.table) +
      area("fields", "Record fields · JSON", p.fields || {});
  if (['sheets_append','sheets_update'].includes(kind))
    fields = accountSelector(kind,p,state,selected) +
      input('spreadsheet','Spreadsheet ID',p.spreadsheet || '') +
      input('sheet_id','Numeric tab ID',p.sheet_id ?? '') +
      (kind === 'sheets_update' ? input('row','Row number',p.row ?? '') : '') +
      area('columns','Columns by letter · JSON',p.columns || {}) +
      `<label for="param-value-input">Cell interpretation</label><select id="param-value-input" name="p_value_input">${['USER_ENTERED','RAW'].map(v=>`<option ${p.value_input===v?'selected':''}>${v}</option>`).join('')}</select><p class="field-hint">USER_ENTERED lets Sheets interpret formulas, dates and numbers. RAW keeps supplied values. Test against the spreadsheet locale.</p>`;
  if (['airtable_find','airtable_update','slack_join','sheets_resolve'].includes(kind)) {
    const {connection,...details}=p;
    fields=accountSelector(kind,p,state,selected)+area('details','Action settings · JSON',details);
  }
  if (kind === "transform")
    fields = area("fields", "Output fields · JSON", p.fields || {});
  if (kind === "http")
    fields =
      `<label for="param-method">Method</label><select id="param-method" name="p_method">${["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => `<option ${m === (p.method || current.definition.steps.find((s) => s.id === selected)?.source_action || "POST").toUpperCase() ? "selected" : ""}>${m}</option>`).join("")}</select>` +
      input("url", "Destination URL", p.url || "") +
      `<label for="param-payload">Payload encoding</label><select id="param-payload" name="p_payload_type">${["json", "form", "raw"].map((v) => `<option ${v === (p.payload_type || "json") ? "selected" : ""}>${v}</option>`).join("")}</select>` +
      area("headers", "Headers · JSON", p.headers || {}) +
      area(
        "data",
        "Body · JSON or raw text",
        p.payload_type === "raw" ? p.data || "" : pretty(p.data || {}),
      );
  if (
    kind === "filter" &&
    Array.isArray(p.filter_criteria) &&
    p.filter_criteria.every((c) => c.action === "continue")
  )
    fields = `<p class="field-hint">Rules within a group must all match. Any matching group continues the workflow.</p>${p.filter_criteria.map((c, i) => `<div class="rule-editor"><div class="two-col"><div>${input("key_" + i, "Mapped value", c.key)}</div><div><label for="param-match-${i}">Comparison</label><select id="param-match-${i}" name="p_match_${i}">${["iexact", "icontains", "igreater", "iless", "istartswith", "iendswith", "boolean"].map((m) => `<option ${m === c.match ? "selected" : ""}>${m}</option>`).join("")}</select></div></div><div class="two-col"><div>${input("value_" + i, "Compare with", c.value)}</div><div>${input("group_" + i, "Group number", c.group)}</div></div></div>`).join("")}<button type="button" class="quiet" data-action="add-rule">＋ Add condition</button>`;
  return `<div id="parameter-editor" data-mode="${fields && !raw ? "guided" : "raw"}">${fields && !raw ? fields : json}${fields ? `<button type="button" class="quiet" data-action="parameter-mode">${raw ? "Use guided fields" : "Edit parameters as JSON"}</button>` : ""}</div>`;
}
function readParameters(form) {
  const data = new FormData(form),
    kind = data.get("kind"),
    s = current.definition.steps.find((n) => n.id === selected);
  if (document.querySelector("#parameter-editor").dataset.mode === "raw")
    return JSON.parse(data.get("params"));
  const base = document.querySelector("#parameter-editor").dataset.base
    ? JSON.parse(document.querySelector("#parameter-editor").dataset.base)
    : structuredClone(s.params);
  if (kind === "webhook") return data.get('p_child_key') ? { child_key: data.get('p_child_key') } : {};
  if (kind === "transform") return { fields: JSON.parse(data.get("p_fields")) };
  if (kind === "slack")
    return {
      ...base,
      connection: data.get("p_connection"),
      channel: data.get("p_channel"),
      text: data.get("p_text"),
      join_channel: data.has('p_join_channel'),
      ...(data.get("p_thread_ts")
        ? { thread_ts: data.get("p_thread_ts") }
        : {}),
    };
  if (kind === "airtable")
    return {
      connection: data.get("p_connection"),
      base: data.get("p_base"),
      table: data.get("p_table"),
      fields: JSON.parse(data.get("p_fields")),
    };
  if (['sheets_append','sheets_update'].includes(kind))
    return { connection:data.get('p_connection'), spreadsheet:data.get('p_spreadsheet'), sheet_id:data.get('p_sheet_id'),
      columns:JSON.parse(data.get('p_columns')),value_input:data.get('p_value_input'),
      ...(kind==='sheets_update'?{row:data.get('p_row')}:{}) };
  if (['airtable_find','airtable_update','slack_join','sheets_resolve'].includes(kind))
    return {...JSON.parse(data.get('p_details')),connection:data.get('p_connection')};
  if (kind === "http")
    return {
      ...base,
      method: data.get("p_method"),
      url: data.get("p_url"),
      payload_type: data.get("p_payload_type"),
      headers: JSON.parse(data.get("p_headers")),
      data:
        data.get("p_payload_type") === "raw"
          ? data.get("p_data")
          : JSON.parse(data.get("p_data")),
    };
  if (kind === "filter")
    return {
      filter_criteria: Array.from(
        form.querySelectorAll('[name^="p_key_"]'),
      ).map((el, i) => ({
        key: el.value,
        match: data.get("p_match_" + i),
        value: data.get("p_value_" + i),
        group: Number(data.get("p_group_" + i)),
        action: "continue",
      })),
    };
  return base;
}
function testsView() {
  const w = current;
  return `<div class="split"><section class="panel"><div class="flow-head"><h2>Behavioral fixtures</h2><button class="primary" data-action="check" ${!w.ready || !w.fixtures.length ? "disabled" : ""}>Run all tests</button></div><p class="muted">Check the outcome and the exact outgoing request bodies. Every test runs in mock mode.</p>${
    w.fixtures
      .map((f) => {
        const c = w.checks.find((c) => c.fixture_id === f.id);
        return `<div class="fixture"><div><h3>${escape(f.name)}</h3><p>Expect ${escape(f.expected_status)} · ${f.expected_requests == null ? "Outcome only" : f.expected_requests.length + " exact request receipts"}</p></div><div class="actions">${c ? `<button class="quiet" data-run="${c.run_id}">${pill(c.passed ? "passed" : "failed", c.passed ? "Passed" : "Failed")}</button>` : pill("review", "Not tested")}<button class="quiet" data-fixture="${f.id}">View</button></div></div>`;
      })
      .join("") ||
    '<div class="empty">Add a representative event, a filtered event and an edge case.</div>'
  }<button class="quiet" data-action="fixture">＋ Add test case</button></section><section class="panel"><h2>Test before you cut over.</h2><div class="deploy-item"><span class="number">1</span><div><h3>Start with known inputs</h3><p>Use redacted events from your original workflow, or write your own fixtures.</p></div></div><div class="deploy-item"><span class="number">2</span><div><h3>Compare the actual requests</h3><p>Inspect URLs, methods, field types and bodies. A passing mock is not proof of production API compatibility.</p></div></div><div class="deploy-item"><span class="number">3</span><div><h3>Keep edge cases in the suite</h3><p>Missing fields and filtered events should not produce external writes. Saving a new version requires testing again.</p></div></div><div class="hintbox">Activation requires every fixture to pass on the current version, including a successful fixture with expected outgoing requests.</div></section></div>`;
}
function codeView() {
  const w = current;
  return `<div class="code-bar"><div><strong>workflow.mjs</strong><span class="count">Native JavaScript · version ${w.version}</span></div><div class="actions"><button data-action="copy-code" ${!w.code ? "disabled" : ""}>Copy code</button><a class="button-link" href="/api/workflows/${w.id}/bundle" ${!w.code ? "hidden" : ""}>Download runnable project ↗</a></div></div>${w.code ? `<pre class="code-panel">${escape(w.code)}</pre><div class="end-note">The generated function is the code the runner executes. The bundle includes the runtime, SQLite journal, encrypted vault, Docker setup and environment template. Credentials are never included. You can edit workflow.mjs in your own deployment.</div>` : `<section class="panel"><h2>Conversion needs review.</h2><p class="muted">Resolve the following issues before generating executable code.</p>${w.plan.issues.map((i) => `<div class="issue">${i.step_id ? "Step " + escape(i.step_id) + " · " : ""}${escape(i.message)}</div>`).join("")}</section>`}`;
}
function runsTable(runs, global = false) {
  return `<section class="table-panel"><table><thead><tr><th>${global ? "Workflow" : "Run"}</th><th>Outcome</th><th>Version / mode</th><th>Started</th><th></th></tr></thead><tbody>${runs.map((r) => `<tr><td>${global ? `<strong>${escape(r.name)}</strong>` : ""}<button class="quiet mono" data-run="${r.id}">${r.id.slice(0, 8)}</button>${r.error ? `<small>${escape(r.error)}</small>` : ""}</td><td>${pill(r.status)}</td><td class="mono">v${r.version} · ${escape(r.mode)}</td><td>${date(r.created_at)}</td><td><button class="quiet" data-run="${r.id}">Inspect →</button></td></tr>`).join("") || `<tr><td colspan="5" class="empty"><h3>No runs yet.</h3>Replay an event or run the test suite. Every execution is recorded here.</td></tr>`}</tbody></table></section><div class="end-note">Completed steps are reused when resuming a held run. Uncertain writes require a verified destination receipt before they can continue.</div>`;
}
async function allRuns() {
  const runs = await api("/runs");
  frame(
    `<div class="heading"><div><div class="eyebrow">Operations</div><h1>Run journal</h1><p>Inspect outcomes and recover held work without repeating completed steps.</p></div><button data-action="refresh">Refresh</button></div>${runsTable(runs, true)}`,
    "Run history",
  );
}
function deployView() {
  const w = current,
    connected = new Set(state.connections.map((c) => c.binding));
  return `<div class="split"><section class="panel"><h2>Prepare your deployment.</h2><div class="deploy-item"><span class="number">1</span><div><h3>Choose your accounts</h3><p>Reuse a saved account across these steps. Use different accounts when workspaces or permissions differ.</p>${w.bindings.map(b => {
  const account=state.connections.find(c=>c.binding===b),steps=w.definition.steps.filter(s=>s.params.connection===b);
  const provider=steps.length&&providerFor(steps[0].kind,state.providers);
  return `<div class="fixture"><div><strong>${escape(account?.label||state.providers[provider]?.label||'Custom API credential')}</strong><small>${steps.length?'Steps '+steps.map(s=>s.id).join(', '):escape(b)} · ${account?'Stored locally':'Account not assigned'}</small></div><button class="quiet" data-connect="${escape(b)}">${account?'Change account':'Choose account'}</button></div>`;
}).join('') || "<p>No accounts required.</p>"}</div></div><div class="deploy-item"><span class="number">2</span><div><h3>Pass your test suite</h3><p>${w.checks.filter((c) => c.passed).length} of ${w.fixtures.length} fixtures passed on v${w.version}. Review the requests before switching traffic.</p><button data-tab="tests">Open test cases</button></div></div><div class="deploy-item"><span class="number">3</span><div><h3>Choose where it runs</h3><p>Activate a tested version in this control room, or download the project and run it on your own server.</p><div class="actions"><button class="primary" data-action="activate" ${!w.ready ? "disabled" : ""}>Activate in mock mode</button>${state.live_enabled ? '<button data-action="activate-live">Activate live</button>' : ""}${w.active_version ? '<button data-action="pause">Pause webhook</button>' : ""}</div></div></div></section><section class="panel"><h2>Own the runtime.</h2><p class="muted">A portable Node.js project with no Zapier service dependency.</p><div class="hintbox"><strong>Included in the download</strong><p>Editable workflow · reviewed adapters · durable run journal · bearer authentication · idempotency · Docker Compose · environment template</p></div>${w.ready ? `<a href="/api/workflows/${w.id}/bundle">Download owned-workflow.tar.gz ↗</a>` : '<p class="muted">Resolve conversion issues to unlock the bundle.</p>'}<div class="end-note">Third-party API and infrastructure fees still apply. Fewer Zapier tasks produce a cash saving only if your retained pricing tier also falls.</div><h3>Webhook endpoint</h3><p class="muted">Each workflow has a separate bearer token. Requests need an Idempotency-Key header.</p><button data-action="endpoint">Show endpoint & token</button><div class="hintbox">Live execution is ${state.live_enabled ? "enabled" : "disabled"} on this installation. ${state.live_enabled ? "Approved hosts: " + escape(state.hosts.join(", ")) : "Set ENABLE_LIVE=true and ALLOWED_HOSTS in the server environment after sandbox validation."}</div></section></div>`;
}
function renderConnections() {
  frame(connectionsPage(state,date), "Connected accounts");
}
function dialog(content) {
  modal.innerHTML = content;
  modal.showModal();
}
const closeButton = '<button type="button" data-action="close">Cancel</button>';
function connectionDialog(binding = "") {
  const existing=state.connections.find(c=>c.binding===binding);
  const source=page==='migrations'&&current?.definition.steps.find(s=>s.params.connection===binding);
  if(source){dialog(assignmentForm(current,state,source.id));return;}
  dialog(connectionForm(state,{existing,binding,provider:existing?.provider||'custom'}));
}
function fixtureDialog() {
  dialog(
    `<form id="fixture-form"><h2>Add a behavioral test</h2><label for="fixture-name">Name</label><input id="fixture-name" name="name" required placeholder="Approved expense"><label for="fixture-input">Input event</label><textarea id="fixture-input" name="input" required spellcheck="false">${escape(pretty(current.fixtures[0]?.input || { status: "ready", reference: "example-001", amount: 25 }))}</textarea><label for="fixture-status">Expected outcome</label><select id="fixture-status" name="expected_status"><option>succeeded</option><option>filtered</option><option>held</option></select><label for="expected-requests">Expected outgoing requests</label><textarea id="expected-requests" name="expected_requests" spellcheck="false" rows="5" placeholder='[{"step_id":"3","method":"POST","url":"https://…","body":"…"}]'>[]</textarea><p class="field-hint">Match method, URL and serialized body exactly. Use [] when no request should occur. Blank checks only the outcome.</p><details><summary>Response recordings and output assertions</summary><label for="fixture-responses">API response bodies by step ID · JSON</label><textarea id="fixture-responses" name="responses" spellcheck="false" placeholder='${escape(pretty({ 3: { records: [{ id: "rec_example", fields: { Name: "Example" } }] } }))}'></textarea><label for="fixture-outputs">Expected outputs by step ID · JSON</label><textarea id="fixture-outputs" name="expected_outputs" spellcheck="false" placeholder='${escape(pretty({ 2: { output: "example" } }))}'></textarea><p class="field-hint">Use anonymized API response bodies to exercise found, missing and error outcomes. These are replayed only in mock mode.</p></details><div class="actions">${closeButton}<button class="primary">Save test</button></div></form>`,
  );
}
function replayDialog() {
  dialog(
    `<form id="replay-form"><div class="eyebrow">Mock execution · no external effects</div><h2>Replay an event.</h2><p>The generated code runs against deterministic API responses. Inspect the exact requests it produces.</p><label for="input-event">JSON input</label><textarea id="input-event" name="input" required rows="10" spellcheck="false">${escape(pretty(current.fixtures[0]?.input || { status: "ready", reference: "example-001", amount: 25 }))}</textarea><label for="idem">Idempotency key</label><input id="idem" name="key" value="${crypto.randomUUID()}" required><div class="actions">${closeButton}<button class="primary">Run mock replay</button></div></form>`,
  );
}
async function showRun(id) {
  const r = await api("/runs/" + id);
  dialog(
    `<div class="eyebrow">Run ${r.id.slice(0, 8)} · v${r.version} · ${escape(r.mode)}</div><h2>Execution receipt ${pill(r.status)}</h2>${r.error ? `<div class="issue">${escape(r.error)}</div>` : ""}<div class="metric-line"><span><strong>Started</strong>${date(r.created_at)}</span><span><strong>Finished</strong>${date(r.finished_at)}</span></div><details><summary>Input event</summary><pre class="json-view">${escape(pretty(r.input))}</pre></details><div class="steps-list">${r.steps.map((s) => `<details class="run-step" ${s.status !== "succeeded" ? "open" : ""}><summary><span>Step ${escape(s.step_id)} · ${escape(s.kind)}</span>${pill(s.status)}</summary>${s.error ? `<div class="issue">${escape(s.error)}</div>` : ""}${s.request ? `<h4>Outgoing request · credentials redacted</h4><pre>${escape(pretty(s.request))}</pre>` : ""}<h4>Recorded output</h4><pre>${escape(pretty(s.output))}</pre>${s.status === "uncertain" ? `<button data-reconcile="${r.id}" data-reconcile-step="${escape(s.step_id)}">Record verified destination receipt</button>` : ""}</details>`).join("")}</div><div class="actions"><button data-action="close">Close</button>${r.status === "held" ? `<button class="primary" data-resume="${r.id}" ${r.steps.some((s) => s.status === "uncertain") ? "disabled" : ""}>Resume held run</button>` : ""}</div>`,
  );
}
async function updateDefinition(definition) {
  current = await api("/workflows/" + current.id, {
    method: "PUT",
    body: JSON.stringify({ definition, version: current.version }),
  });
  await refreshState();
  renderWorkflow();
}
function defaultParams(kind, s) {
  const trigger =
      current.definition.steps.find((n) => n.parent_id == null)?.id || "1",
    ref = (field) => "{{" + trigger + "__" + field + "}}";
  return {
    webhook: {},
    filter: {
      filter_criteria: [
        {
          group: 0,
          key: ref("status"),
          value: "ready",
          match: "iexact",
          action: "continue",
        },
      ],
    },
    transform: { fields: { reference: ref("reference") } },
    http: {
      method: "POST",
      url: "https://api.example.test/events",
      payload_type: "json",
      headers: { Authorization: { $env: "SERVICE_TOKEN" } },
      data: { reference: ref("reference") },
    },
    slack: {
      connection: "SLACK_TOKEN",
      channel: s?.params?.channel || "",
      text: s?.params?.text || ref("reference"),
    },
    airtable: {
      connection: "AIRTABLE_TOKEN",
      base: s?.params?.applicationId || "",
      table: s?.params?.tableName || "",
      fields: s?.params?.fields || { Reference: ref("reference") },
    },
    unsupported: {},
  }[kind];
}
document.addEventListener("click", async (e) => {
  const button = e.target.closest("button,a,tr[data-workflow]");
  if (!button || button.disabled) return;
  try {
    if (button.dataset.reference) {
      const field =
        lastMappingField &&
        document.querySelector("#step-editor").contains(lastMappingField)
          ? lastMappingField
          : null;
      if (!field) {
        notice("Focus a mapping field first.", true);
        return;
      }
      const jsonField = [
        "param-fields",
        "param-headers",
        "param-data",
        "params",
      ].includes(field.id);
      const reference = jsonField
        ? JSON.stringify(button.dataset.reference).slice(1, -1)
        : button.dataset.reference;
      field.setRangeText(
        reference,
        field.selectionStart,
        field.selectionEnd,
        "end",
      );
      field.focus();
      field.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (button.dataset.workflow) {
      tab = "steps";
      selected = null;
      location.hash = "workflow/" + button.dataset.workflow;
      return;
    }
    if (button.dataset.agentApply) {
      const result = await post(
        "/agent/runs/" + button.dataset.agentApply + "/apply",
        {},
      );
      location.hash = "workflow/" + result.workflow_id;
      return;
    }
    if (button.dataset.agentCancel) {
      await post("/agent/runs/" + button.dataset.agentCancel + "/cancel", {});
      notice("Stopping the local agent.");
      return;
    }
    if (button.dataset.action === "agent-example") {
      const result = await post("/agent/example", {});
      location.hash = "agent/source/" + result.workflow_id;
      return;
    }
    if (button.dataset.tab) {
      tab = button.dataset.tab;
      renderWorkflow();
      return;
    }
    if (button.dataset.step) {
      selected = button.dataset.step;
      renderWorkflow();
      if (matchMedia("(max-width: 1100px)").matches) {
        document.querySelector(".workflow-area .panel")?.scrollIntoView({
          block: "start",
          behavior: "instant",
        });
      }
      return;
    }
    if (button.dataset.run) {
      await showRun(button.dataset.run);
      return;
    }
    if (button.dataset.connect !== undefined) {
      connectionDialog(button.dataset.connect);
      return;
    }
    if (button.dataset.addAccount) {
      dialog(connectionForm(state,{provider:button.dataset.addAccount,stepId:button.dataset.accountStep||'',workflowId:button.dataset.accountStep?current.id:''}));
      return;
    }
    if(button.dataset.manualAccount){dialog(connectionForm(state,{provider:button.dataset.manualAccount,stepId:button.dataset.accountStep||'',manual:true}));return;}
    if(button.dataset.oauthSettings){dialog(oauthSettingsForm(state,button.dataset.oauthSettings));return;}
    if(button.dataset.oauthReconnect){const existing=state.connections.find(c=>c.binding===button.dataset.oauthReconnect);dialog(oauthConnectForm(state,{provider:existing.provider,existing}));return;}
    if (button.dataset.editAccount) {
      dialog(connectionForm(state,{existing:state.connections.find(c=>c.binding===button.dataset.editAccount)}));
      return;
    }
    if (button.dataset.assignAccount) {
      dialog(assignmentForm(current,state,button.dataset.assignAccount));
      return;
    }
    if (button.dataset.disconnect) {
      dialog(
        `<form id="disconnect-form"><h2>Remove connection?</h2><p>Live runs requiring ${escape(button.dataset.disconnect)} will be held. Completed receipts are retained.</p><input type="hidden" name="binding" value="${escape(button.dataset.disconnect)}"><div class="actions">${closeButton}<button class="danger">Remove</button></div></form>`,
      );
      return;
    }
    if (button.dataset.restoreVersion) {
      current = await post("/workflows/" + current.id + "/version", {
        version: Number(button.dataset.restoreVersion),
      });
      modal.close();
      renderWorkflow();
      notice(
        "Restored as draft v" +
          current.version +
          ". Re-run fixtures before activation.",
      );
      return;
    }
    if (button.dataset.fixture) {
      const f = current.fixtures.find((f) => f.id === button.dataset.fixture);
      dialog(
        `<h2>${escape(f.name)}</h2><p>Expected outcome: ${escape(f.expected_status)}</p><h3>Input</h3><pre class="json-view">${escape(pretty(f.input))}</pre><h3>Expected outgoing requests</h3><pre class="json-view">${escape(pretty(f.expected_requests))}</pre><h3>Response fixtures</h3><pre class="json-view">${escape(pretty(f.responses))}</pre><h3>Expected outputs</h3><pre class="json-view">${escape(pretty(f.expected_outputs))}</pre><div class="actions"><button data-action="close">Close</button></div>`,
      );
      return;
    }
    if (button.dataset.resume) {
      button.disabled = true;
      const r = await post("/runs/" + button.dataset.resume + "/resume");
      modal.close();
      await route();
      await showRun(r.id);
      return;
    }
    if (button.dataset.reconcile) {
      dialog(
        `<form id="reconcile-form"><h2>Reconcile an uncertain write.</h2><p>Inspect the destination first. Record its verified response only if the original operation completed. This marks the step as succeeded and prevents it from being sent again.</p><input type="hidden" name="run" value="${button.dataset.reconcile}"><input type="hidden" name="step_id" value="${escape(button.dataset.reconcileStep)}"><label for="receipt">Verified destination output · JSON object</label><textarea id="receipt" name="output" required placeholder='{"id":"verified-record-id"}'></textarea><div class="actions">${closeButton}<button class="primary">Record receipt</button></div></form>`,
      );
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action === "close") {
      modal.close();
      return;
    }
    if (action === "logout") {
      await api("/session", { method: "DELETE" });
      login();
      return;
    }
    if (action === "refresh") {
      await route();
      return;
    }
    if (action === "next" || action === "previous") {
      offset += action === "next" ? 100 : -100;
      await migrations();
      return;
    }
    if (action === "import") {
      dialog(
        `<form id="import-form"><div class="eyebrow">Migration intake</div><h2>Upload a Zap export.</h2><p>Import a single workflow, a backup containing a zaps array, or a ZIP containing zapfile.json. Existing workflows stay separate. Up to 50 MB and 10,000 workflows.</p><label for="export-file">JSON or ZIP file</label><input type="file" id="export-file" name="file" accept="application/json,application/zip,.json,.zip"><details><summary>Or paste export JSON</summary><label for="export-json">Export JSON</label><textarea id="export-json" name="json" spellcheck="false" rows="10" placeholder='{"zaps": […]}'></textarea></details><div class="hintbox">This import stays on your server. Credentials become required bindings. Unsupported actions remain visible for review. No data is sent to an AI provider.</div><div class="actions">${closeButton}<button class="primary">Import & analyze</button></div></form>`,
      );
      return;
    }
    if (action === "new" || action === "rename") {
      dialog(
        `<form id="${action}-form"><h2>${action === "new" ? "Create a workflow" : "Rename workflow"}</h2><label for="workflow-name">Name</label><input id="workflow-name" name="name" required maxlength="200" value="${action === "rename" ? escape(current.name) : ""}" placeholder="Invoice review & notification"><div class="actions">${closeButton}<button class="primary">${action === "new" ? "Create" : "Save new version"}</button></div></form>`,
      );
      return;
    }
    if (action === "connection") {
      connectionDialog();
      return;
    }
    if (action === "fixture") {
      fixtureDialog();
      return;
    }
    if (action === "replay") {
      replayDialog();
      return;
    }
    if (action === "check") {
      button.disabled = true;
      button.textContent = "Running tests…";
      current = await post("/workflows/" + current.id + "/check");
      renderWorkflow();
      notice(
        current.checks.every((c) => c.passed)
          ? "All fixtures passed in mock mode."
          : "Some fixtures failed. Inspect their receipts.",
        current.checks.some((c) => !c.passed),
      );
      return;
    }
    if (action === "copy-code") {
      await navigator.clipboard.writeText(current.code);
      notice("Generated code copied.");
      return;
    }
    if (action === "versions") {
      dialog(
        `<h2>Version history</h2><p>Restoring creates a new draft version. An active deployment keeps its pinned version until you activate again.</p>${current.versions.map((v) => `<div class="fixture"><div><h3>Version ${v.version}</h3><p>${date(v.created_at)}</p></div>${v.version === current.version ? pill("ready", "Current draft") : `<button data-restore-version="${v.version}">Restore as draft</button>`}</div>`).join("")}<div class="actions"><button data-action="close">Close</button></div>`,
      );
      return;
    }
    if (action === "endpoint") {
      const endpoint = await api("/workflows/" + current.id + "/endpoint");
      dialog(
        `<h2>Webhook configuration</h2><p>Use this token only for this workflow. Do not place it in public repositories.</p><label>Endpoint</label><input readonly value="${escape(endpoint.url)}"><label>Bearer token</label><input readonly type="password" value="${escape(endpoint.token)}" id="endpoint-token"><button class="quiet" data-action="reveal-token">Reveal token</button><pre class="json-view">Authorization: Bearer YOUR_TOKEN\nIdempotency-Key: UNIQUE_EVENT_ID\nContent-Type: application/json</pre><div class="actions"><button data-action="close">Close</button></div>`,
      );
      return;
    }
    if (action === "reveal-token") {
      const field = document.querySelector("#endpoint-token");
      field.type = field.type === "password" ? "text" : "password";
      button.textContent =
        field.type === "password" ? "Reveal token" : "Hide token";
      return;
    }
    if (action === "activate" || action === "activate-live") {
      current = await post("/workflows/" + current.id + "/activate", {
        mode: action === "activate" ? "mock" : "live",
      });
      renderWorkflow();
      notice(
        "Version " +
          current.version +
          " activated in " +
          current.mode +
          " mode.",
      );
      return;
    }
    if (action === "pause") {
      current = await post("/workflows/" + current.id + "/pause");
      renderWorkflow();
      notice("Webhook paused.");
      return;
    }
    if (action === "add-step") {
      const d = structuredClone(current.definition),
        id = String(Math.max(0, ...d.steps.map((n) => Number(n.id))) + 1);
      d.steps.push({
        id,
        parent_id: d.steps.at(-1)?.id || null,
        name: "Map output fields",
        kind: "transform",
        source_app: "Native",
        source_action: "transform",
        params: defaultParams("transform"),
      });
      await updateDefinition(d);
      selected = id;
      renderWorkflow();
      return;
    }
    if (action === "parameter-mode") {
      const form = document.querySelector("#step-editor"),
        kind = form.elements.kind.value,
        p = readParameters(form),
        raw =
          document.querySelector("#parameter-editor").dataset.mode !== "raw";
      document.querySelector("#parameter-editor").outerHTML = parameterEditor(
        kind,
        p,
        raw,
      );
      document.querySelector("#parameter-editor").dataset.base =
        JSON.stringify(p);
      return;
    }
    if (action === "add-rule") {
      const form = document.querySelector("#step-editor"),
        p = readParameters(form);
      p.filter_criteria.push({
        group: 0,
        key: "",
        value: "",
        match: "iexact",
        action: "continue",
      });
      document.querySelector("#parameter-editor").outerHTML = parameterEditor(
        "filter",
        p,
      );
      return;
    }
    if (action === "remove-step") {
      const d = structuredClone(current.definition);
      if (d.steps.some((s) => s.parent_id === selected))
        throw Error("Reassign child steps before removing their parent.");
      d.steps = d.steps.filter((s) => s.id !== selected);
      selected = d.steps[0]?.id;
      await updateDefinition(d);
      return;
    }
  } catch (error) {
    notice(error.message, true);
    button.disabled = false;
    if (button.dataset.action === "check") button.textContent = "Run all tests";
  }
});
document.addEventListener("change", (e) => {
  if(e.target.id==='connection-provider'){
    const provider=e.target.value,p=state.providers[provider];
    e.target.form.querySelector('h2').textContent='Add '+p.label+' account';
    document.querySelector('#credential-help').innerHTML=credentialHelp(provider,state.providers);
    document.querySelector('#account-secret-label').textContent=p.credential;
    document.querySelector('#account-secret').placeholder=p.placeholder;
  }
  if (e.target.id === "kind") {
    const s = current.definition.steps.find((n) => n.id === selected);
    const p = defaultParams(e.target.value, s);
    document.querySelector("#parameter-editor").outerHTML = parameterEditor(
      e.target.value,
      p,
    );
    document.querySelector("#parameter-editor").dataset.base =
      JSON.stringify(p);
    document.querySelector("#adapter-help").innerHTML = adapterHelp(
      e.target.value,
    );
    notice(
      "Review the adapter parameters before saving. Original parameters remain in the previous version.",
    );
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("tr[data-workflow]")) {
    tab = "steps";
    location.hash = "workflow/" + e.target.dataset.workflow;
  }
});
let searchTimer;
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    search = e.target.value;
    offset = 0;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const caret = e.target.selectionStart;
      await migrations();
      const input = document.querySelector("#search");
      input.focus();
      input.setSelectionRange(caret, caret);
    }, 250);
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target,
    data = new FormData(form),
    submit = form.querySelector('button:not([type="button"])');
  if (submit) submit.disabled = true;
  try {
    if (form.id === "agent-form") {
      const job = await post("/agent/runs", {
        workflow_id: data.get("workflow_id") || undefined,
        version: Number(data.get("version")) || undefined,
        description: String(data.get("description") || ""),
        fixtures: JSON.parse(data.get("fixtures") || "[]"),
      });
      location.hash = "agent/run/" + job.id;
    }
    if (form.id === "login") {
      await post("/session", { token: data.get("token") });
      await route();
    }
    if (form.id === "import-form") {
      const file = data.get("file");
      if (file.size > 50 * 1024 * 1024) throw Error("File exceeds 50 MB.");
      let text = String(data.get("json") || "").trim(),
        payload;
      if (!text) {
        if (!file.size) throw Error("Choose a file or paste the export JSON.");
        let timeout;
        try {
          text = await Promise.race([
            file.name.toLowerCase().endsWith(".zip")
              ? file.arrayBuffer()
              : file.text(),
            new Promise((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(
                    Error(
                      "The browser could not read this file. Paste the export JSON instead.",
                    ),
                  ),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      if (text instanceof ArrayBuffer) {
        const bytes = new Uint8Array(text);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 32768)
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        payload = { archive_base64: btoa(binary) };
      } else payload = JSON.parse(text);
      const result = await post("/import", payload);
      modal.close();
      await route();
      notice(
        `${result.imported} imported${result.existing ? ", " + result.existing + " already present" : ""}. ${result.ready} structurally ready to test.`,
      );
    }
    if (form.id === "new-form") {
      const result = await post("/import", {
        zaps: [
          {
            id: crypto.randomUUID(),
            title: data.get("name"),
            nodes: {
              1: {
                id: 1,
                parent_id: null,
                selected_api: "WebHookAPI",
                action: "hook",
                params: {},
              },
            },
          },
        ],
      });
      modal.close();
      tab = "steps";
      selected = null;
      location.hash = "workflow/" + result.ids[0];
    }
    if (form.id === "rename-form") {
      const d = structuredClone(current.definition);
      d.name = data.get("name");
      await updateDefinition(d);
      modal.close();
    }
    if (form.id === "step-editor") {
      const d = structuredClone(current.definition),
        s = d.steps.find((s) => s.id === selected);
      s.name = data.get("name");
      s.parent_id = data.get("parent_id") || null;
      s.kind = data.get("kind");
      s.params = readParameters(form);
      s.review_required = false;
      await updateDefinition(d);
      notice(
        "Saved version " +
          current.version +
          ". Run tests against this version.",
      );
    }
    if (form.id === "connection-form") {
      const saved=await post("/connections", Object.fromEntries(data));
      modal.close();
      await refreshState();
      if(data.get('target_step')){
        dialog(assignmentForm(current,state,data.get('target_step')));
        document.querySelector('#assign-binding').value=saved.binding;
      }else await route();
      notice("Account saved. Reuse it across your workflow steps.");
    }
    if(form.id==='oauth-settings-form'){
      const provider=data.get('provider');
      await post('/oauth/clients/'+provider,{client_id:data.get('client_id'),client_secret:data.get('client_secret'),redirect_uri:data.get('redirect_uri'),pkce:data.has('pkce'),scopes:data.getAll('scopes')});
      modal.close();await route();notice('OAuth app saved. You can now connect accounts when the callback origin is available.');
    }
    if(form.id==='oauth-connect-form'){
      const provider=data.get('provider'),flow=await post('/oauth/start/'+provider,{label:data.get('label')||'',binding:data.get('binding')||null,workflow_id:data.get('workflow_id')||null,step_id:data.get('step_id')||null});
      location.assign(flow.authorization_url);
    }
    if(form.id==='assign-account-form'){
      current=await post('/workflows/'+current.id+'/connections',{version:Number(data.get('version')),binding:data.get('binding'),step_ids:data.getAll('step_ids')});
      modal.close();await refreshState();renderWorkflow();notice('Account assigned in draft v'+current.version+'. Rerun your fixtures before activation.');
    }
    if (form.id === "disconnect-form") {
      await api("/connections", {
        method: "DELETE",
        body: JSON.stringify({ binding: data.get("binding") }),
      });
      modal.close();
      await route();
    }
    if (form.id === "fixture-form") {
      current = await post("/workflows/" + current.id + "/fixtures", {
        name: data.get("name"),
        input: JSON.parse(data.get("input")),
        expected_status: data.get("expected_status"),
        responses: data.get("responses")?.trim()
          ? JSON.parse(data.get("responses"))
          : null,
        expected_outputs: data.get("expected_outputs")?.trim()
          ? JSON.parse(data.get("expected_outputs"))
          : null,
        expected_requests: data.get("expected_requests").trim()
          ? JSON.parse(data.get("expected_requests"))
          : null,
      });
      modal.close();
      renderWorkflow();
    }
    if (form.id === "replay-form") {
      const r = await post("/workflows/" + current.id + "/replay", {
        input: JSON.parse(data.get("input")),
        key: data.get("key"),
      });
      modal.close();
      current = await api("/workflows/" + current.id);
      renderWorkflow();
      await showRun(r.id);
    }
    if (form.id === "reconcile-form") {
      const r = await post("/runs/" + data.get("run") + "/reconcile", {
        step_id: data.get("step_id"),
        output: JSON.parse(data.get("output")),
      });
      modal.close();
      await showRun(r.id);
    }
  } catch (error) {
    notice(error.message, true);
  } finally {
    if (submit) submit.disabled = false;
  }
});
window.addEventListener("hashchange", route);
route();

let lastMappingField;
document.addEventListener("focusin", (e) => {
  if (e.target.matches('#step-editor textarea, #step-editor input[name^="p_"]'))
    lastMappingField = e.target;
});
