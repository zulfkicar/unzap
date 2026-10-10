// Import proposals preserve source parameters and require a human mapping review.
// Unknown options never disappear into an apparently successful conversion.
import { extendedProposal } from "./extended-adapters.js";
export function propose(node, params) {
  const extended = extendedProposal(node, params);
  if (extended) return extended;
  const app = String(node.selected_api || ""),
    id = String(node.id);
  if (
    /^Slack(?:CLI)?API(?:@|$)/.test(app) &&
    node.action === "_zap_raw_request"
  ) {
    if (
      Object.keys(params).some(
        (k) =>
          !["method", "url", "body", "headers", "fail_on_errors"].includes(k),
      ) ||
      String(params.method).toUpperCase() !== "POST" ||
      params.url !== "https://slack.com/api/chat.postMessage" ||
      params.fail_on_errors === false ||
      params.fail_on_errors === "false"
    )
      return null;
    if (
      params.headers &&
      Object.entries(params.headers).some(
        ([k, v]) =>
          k.toLowerCase() !== "content-type" || v !== "application/json",
      )
    )
      return null;
    let body;
    try {
      body =
        typeof params.body === "string" ? JSON.parse(params.body) : params.body;
    } catch {
      return null;
    }
    const allowed = [
      "channel",
      "text",
      "thread_ts",
      "blocks",
      "attachments",
      "username",
      "icon_url",
      "icon_emoji",
      "unfurl_links",
      "unfurl_media",
      "reply_broadcast",
    ];
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !body.channel ||
      !body.text ||
      Object.keys(body).some((k) => !allowed.includes(k))
    )
      return null;
    return {
      kind: "slack",
      params: { ...body, connection: `SLACK_STEP_${id}_TOKEN` },
      review_required: true,
      review_notes:
        "Review this explicit chat.postMessage mapping, thread timestamp and rich message fields. Use a fresh bot token. Custom names/icons require the appropriate Slack permissions. Check downstream output references against the API receipt.",
    };
  }
  if (
    /^Airtable(?:CLI)?API(?:@|$)/.test(app) &&
    node.action === "createRecord"
  ) {
    const allowed = Object.keys(params).every(
      (k) =>
        ["applicationId", "tableName", "fields"].includes(k) ||
        k.startsWith("fields__"),
    );
    if (!allowed || !params.applicationId || !params.tableName) return null;
    const fields =
      params.fields ||
      Object.fromEntries(
        Object.entries(params)
          .filter(([k]) => k.startsWith("fields__"))
          .map(([k, v]) => [k.slice(8), v]),
      );
    if (!Object.keys(fields).length) return null;
    return {
      kind: "airtable",
      params: {
        base: params.applicationId,
        table: params.tableName,
        connection: `AIRTABLE_STEP_${id}_TOKEN`,
        fields,
      },
      review_required: true,
      review_notes:
        "Check the destination table, field types and linked-record IDs. A Zapier text value may need conversion to a number, boolean or array before the Airtable API accepts it.",
    };
  }
  if (
    /^Slack(?:CLI)?API(?:@|$)/.test(app) &&
    ["channel_message", "private_channel_message"].includes(node.action)
  ) {
    const keys = [
      "channel",
      "text",
      "as_bot",
      "add_edit_link",
      "unfurl",
      "link_names",
      "reply_broadcast",
    ];
    const bool = (v) => v === true || v === "true" || v === "yes";
    if (
      Object.keys(params).some((k) => !keys.includes(k)) ||
      !params.channel ||
      params.text == null ||
      params.as_bot === "false" ||
      bool(params.add_edit_link) ||
      bool(params.link_names) ||
      bool(params.reply_broadcast)
    )
      return null;
    return {
      kind: "slack",
      params: {
        channel: params.channel,
        text: params.text,
        connection: `SLACK_STEP_${id}_TOKEN`,
        ...(params.unfurl !== undefined ? { unfurl: bool(params.unfurl) } : {}),
      },
      review_required: true,
      review_notes:
        "Check the channel and use a bot token with chat:write. Review downstream output references because Zapier and Slack API output shapes can differ.",
    };
  }
  return null;
}
