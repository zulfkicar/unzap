import { formatterIssue } from "./logic.js";
import { sheetsProposal } from './sheets.js';
const yes = (v) =>
  v === true || ["true", "yes"].includes(String(v).toLowerCase());
const empty = (v) => v == null || v === "" || v === false;
export function extendedProposal(n, p) {
  const sheets = sheetsProposal(n, p);
  if (sheets) return sheets;
  const app = String(n.selected_api || ""),
    id = String(n.id);
  if (
    /^WebHook(?:CLI)?API(?:@|$)/.test(app) &&
    ["get", "post", "put", "custom"].includes(n.action)
  ) {
    const known = [
      "url",
      "method",
      "headers",
      "data",
      "payload_type",
      "unflatten",
      "wrap_in_array",
      "auth",
      "file",
      "as_json",
      "json_key",
      "pass_through",
    ];
    if (
      Object.keys(p).some((k) => !known.includes(k)) ||
      !empty(p.file) ||
      yes(p.pass_through) ||
      yes(p.as_json) ||
      !empty(p.json_key)
    )
      return null;
    if (!p.url) return null;
    const method = String(p.method || n.action).toUpperCase();
    if (method !== "GET" && p.data === undefined) return null;
    return {
      kind: "http",
      params: {
        url: p.url,
        method,
        ...(p.data !== undefined ? { data: p.data } : {}),
        ...(p.headers ? { headers: p.headers } : {}),
        ...(p.auth ? { auth: p.auth } : {}),
        payload_type: p.payload_type || "json",
        unflatten: yes(p.unflatten),
        wrap_in_array: yes(p.wrap_in_array),
      },
    };
  }
  if (
    /^WebHook(?:CLI)?API(?:@|$)/.test(app) &&
    n.parent_id == null &&
    ["hook", "hook_v2"].includes(n.action) &&
    Object.keys(p).every(k => ['key', 'Pick off a Child Key'].includes(k))
  )
    {
      const key = p.key || p['Pick off a Child Key'];
      if (key !== undefined && key !== null && typeof key !== 'string') return null;
      if (p.key && p['Pick off a Child Key'] && p.key !== p['Pick off a Child Key']) return null;
      return { kind: "webhook", params: key ? { child_key: key } : {} };
    }
  if (
    /^Slack(?:CLI)?API(?:@|$)/.test(app) &&
    ["channel_message", "private_channel_message"].includes(n.action)
  ) {
    const known = [
      "channel",
      "text",
      "as_bot",
      "add_edit_link",
      "unfurl",
      "link_names",
      "reply_broadcast",
      "username",
      "icon",
      "icon_url",
      "thread_ts",
      "image_url",
      "file",
      "post_at",
      "add_app_to_channel",
    ];
    if (
      Object.keys(p).some((k) => !known.includes(k)) ||
      !p.channel ||
      p.text == null ||
      String(p.as_bot) === "false" ||
      yes(p.add_edit_link) ||
      (yes(p.reply_broadcast) && !p.thread_ts) ||
      (n.action === 'private_channel_message' && yes(p.add_app_to_channel)) ||
      !empty(p.file) ||
      !empty(p.post_at)
    )
      return null;
    const mapped = {
      channel: p.channel,
      text: p.text,
      connection: `SLACK_STEP_${id}_TOKEN`,
    };
    if (yes(p.add_app_to_channel)) mapped.join_channel = true;
    if (p.unfurl !== undefined) mapped.unfurl = yes(p.unfurl);
    if (p.link_names !== undefined)
      mapped.link_names = yes(p.link_names) ? 1 : 0;
    if (p.reply_broadcast !== undefined)
      mapped.reply_broadcast = yes(p.reply_broadcast);
    if (p.username) mapped.username = p.username;
    if (p.thread_ts) mapped.thread_ts = p.thread_ts;
    if (p.icon_url || String(p.icon || "").startsWith("https://"))
      mapped.icon_url = p.icon_url || p.icon;
    else if (p.icon) mapped.icon_emoji = p.icon;
    if (p.image_url) mapped.attachments = [{ image_url: p.image_url }];
    return {
      kind: "slack",
      params: mapped,
      review_required: true,
      review_notes:
        "Verify bot identity and message output. Channel joining requires channels:join and posts require chat:write. Custom names/icons need chat:write.customize. Private-channel joining, Zapier backlinks, scheduled posts and file uploads remain unsupported.",
    };
  }
  if (app === "BranchingAPI" && n.action === "branch" && !Object.keys(p).length)
    return { kind: "paths", params: {} };
  if (app === "BranchingAPI" && n.action === "filter") {
    const allowed = [
      "emoji",
      "color",
      "filter_criteria",
      "ignore_dependency_errors",
      "path_eval_index",
      "path_eval_stage",
      "savedFilterCriteria",
      "formerTitle",
      "isAlwaysRun",
    ];
    if (
      Object.keys(p).some((k) => !allowed.includes(k)) ||
      yes(p.ignore_dependency_errors)
    )
      return null;
    const mode =
      p.path_eval_stage !== undefined
        ? yes(p.isAlwaysRun)
          ? "always"
          : "fallback"
        : "rules";
    if (
      p.path_eval_stage !== undefined &&
      ![1, 9].includes(Number(p.path_eval_stage))
    )
      return null;
    if (mode === "rules" && !p.filter_criteria?.length) return null;
    return {
      kind: "path",
      ...(p.path_eval_index == null && mode !== "fallback"
        ? {
            review_required: true,
            review_notes:
              "This older export has no explicit path order. Review sibling execution order before generating code.",
          }
        : {}),
      params: {
        mode,
        order: Number(p.path_eval_index ?? 0),
        ...(mode === "rules" ? { filter_criteria: p.filter_criteria } : {}),
      },
    };
  }
  if (/^ZapierFormatter(?:CLI)?API(?:@|$)/.test(app) && !formatterIssue(p))
    return { kind: "formatter", params: p };
  if (/^Airtable(?:CLI)?API(?:@|$)/.test(app)) {
    const common = {
      base: p.applicationId,
      table: p.tableName,
      connection: `AIRTABLE_STEP_${id}_TOKEN`,
    };
    if (!common.base || !common.table) return null;
    if (n.action === "updateRecord") {
      if (
        Object.keys(p).some(
          (k) =>
            ![
              "applicationId",
              "tableName",
              "rowId",
              "appendAttachments",
              "fields",
            ].includes(k) && !k.startsWith("fields__"),
        ) ||
        yes(p.appendAttachments) ||
        !p.rowId
      )
        return null;
      const fields =
        p.fields ||
        Object.fromEntries(
          Object.entries(p)
            .filter(([k]) => k.startsWith("fields__"))
            .map(([k, v]) => [k.slice(8), v]),
        );
      if (!Object.keys(fields).length) return null;
      return {
        kind: "airtable_update",
        params: { ...common, record: p.rowId, fields },
        review_required: true,
        review_notes:
          "Check destination field types and update record ID against a sandbox receipt.",
      };
    }
    if (n.action === "findRecord") {
      if (
        Object.keys(p).some(
          (k) =>
            ![
              "applicationId",
              "tableName",
              "isExactMatch",
              "_zap_search_success_on_miss",
              "searchByValue",
              "searchByField",
              "viewName",
              "searchCriteria",
              "_zap_search_multiple_results",
            ].includes(k),
        )
      )
        return null;
      if (
        p._zap_search_multiple_results &&
        !["first", "halt"].includes(p._zap_search_multiple_results)
      )
        return null;
      if (
        !p.searchCriteria &&
        (!p.searchByField || p.searchByValue === undefined)
      )
        return null;
      return {
        kind: "airtable_find",
        params: {
          ...common,
          ...(p.searchCriteria
            ? { formula: p.searchCriteria }
            : {
                field: p.searchByField,
                value: p.searchByValue,
                exact: yes(p.isExactMatch),
              }),
          ...(p.viewName ? { view: p.viewName } : {}),
          on_missing: yes(p._zap_search_success_on_miss) ? "continue" : "hold",
          multiple: p._zap_search_multiple_results || "first",
        },
        review_required: true,
        review_notes:
          "Verify search field identity or formula, miss handling, and flattened output fields against actual receipts.",
      };
    }
  }
  return null;
}
